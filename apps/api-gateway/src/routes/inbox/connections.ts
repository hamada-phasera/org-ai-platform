// LINE 公式アカウント接続の管理 API（prefix /api/inbox/connections、requireOwner）。
// ⚠️ channelSecretEnc / accessTokenEnc は絶対にレスポンスへ含めない（sanitizeConnection 必須）。
// ⚠️ ログにも secret / token（平文・暗号文とも）を出さない。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireOwner } from '../../middleware/auth';
import { sealSecret } from '../../services/secret-box';
import { getBotInfo } from '../../services/inbox/line-client';
import { getChannelAdapter } from '../../services/inbox/adapter';

type AuthPayload = { orgId: string; sub?: string };

const createSchema = z.object({
  channelSecret: z.string().min(1).max(200),
  accessToken: z.string().min(1).max(500),
  displayName: z.string().max(100).optional(),
});

/** 暗号文カラムを落とした公開形。レスポンスは必ずこれを通す。 */
function sanitizeConnection(conn: {
  id: string;
  orgId: string;
  provider: string;
  channelId: string;
  displayName: string | null;
  status: string;
  monthlyPushCount: number;
  pushCountMonth: string | null;
  lastEventAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: conn.id,
    orgId: conn.orgId,
    provider: conn.provider,
    channelId: conn.channelId,
    displayName: conn.displayName,
    status: conn.status,
    monthlyPushCount: conn.monthlyPushCount,
    pushCountMonth: conn.pushCountMonth,
    lastEventAt: conn.lastEventAt,
    lastCheckedAt: conn.lastCheckedAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

export async function inboxConnectionsRoutes(app: FastifyInstance): Promise<void> {
  // ── 接続登録: 資格情報を LINE API で検証してから暗号化保存 ──
  app.post('/', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const { channelSecret, accessToken, displayName } = parsed.data;

    // GET /v2/bot/info が通れば accessToken は有効。userId が webhook の destination になる。
    const botInfo = await getBotInfo(accessToken);
    if (!botInfo) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'INVALID_LINE_CREDENTIALS',
          message: 'LINE の資格情報を検証できませんでした。チャネルアクセストークンを確認してください。',
        },
      });
    }

    try {
      const created = await prisma.channelConnection.create({
        data: {
          orgId: payload.orgId,
          provider: 'line',
          channelId: botInfo.userId,
          displayName: displayName ?? botInfo.displayName,
          channelSecretEnc: sealSecret(channelSecret),
          accessTokenEnc: sealSecret(accessToken),
        },
      });
      return reply.code(201).send({ success: true, data: sanitizeConnection(created) });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        return reply.code(409).send({
          success: false,
          error: { code: 'CONFLICT', message: 'この LINE チャンネルは既に登録されています' },
        });
      }
      throw e;
    }
  });

  // ── 一覧（quota は best-effort で LINE 実測値を添える） ──────
  app.get('/', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const connections = await prisma.channelConnection.findMany({
      where: { orgId: payload.orgId },
      orderBy: { createdAt: 'desc' },
    });

    const webhookUrl = `${process.env.API_GATEWAY_URL ?? 'http://localhost:4000'}/api/webhooks/line`;

    // LINE API はテナント毎に別トークンなので並列 + allSettled（1 接続の失敗が一覧を壊さない）
    const quotaResults = await Promise.allSettled(
      connections.map((conn) => getChannelAdapter(conn.provider).fetchQuotaUsage(conn)),
    );

    const now = new Date();
    const data = await Promise.all(
      connections.map(async (conn, i) => {
        const settled = quotaResults[i];
        const quotaUsage = settled.status === 'fulfilled' ? settled.value : null;
        if (quotaUsage !== null) {
          try {
            await prisma.channelConnection.update({
              where: { id: conn.id },
              data: { lastCheckedAt: now },
            });
          } catch (e) {
            request.log.error({ err: e }, '[inbox/connections] lastCheckedAt の更新に失敗');
          }
        }
        return {
          ...sanitizeConnection(conn),
          quotaUsage,
          webhookUrl,
        };
      }),
    );

    return reply.send({ success: true, data });
  });

  // ── 削除（InboundMessage は FK SetNull で残る） ─────────────
  app.delete('/:id', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { id } = request.params as { id: string };
    const conn = await prisma.channelConnection.findUnique({ where: { id } });
    if (!conn || conn.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '接続が見つかりません' } });
    }
    await prisma.channelConnection.delete({ where: { id } });
    return reply.send({ success: true, data: { id } });
  });
}
