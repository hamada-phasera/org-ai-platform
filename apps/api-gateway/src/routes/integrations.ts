// セルフサーブ連携の管理 API（prefix /api/integrations、requireAdmin）。
// ⚠️ accessTokenEnc / refreshTokenEnc は絶対にレスポンスへ含めない（sanitize 必須）。
// ⚠️ ログにもトークン（平文・暗号文とも）を出さない。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAdmin } from '../middleware/auth';
import { sealSecret } from '../services/secret-box';
import { authTest } from '../services/adapters/slack-client';
import { revokeGoogleToken } from '../services/google-auth';
import { syncRequiredCredentialStatus } from '../services/integration-sync';

type AuthPayload = { orgId: string; sub?: string };

// xoxb 限定: xoxp（ユーザートークン）の誤貼付を入口で弾く
const slackSchema = z.object({
  botToken: z.string().regex(/^xoxb-/, 'Bot トークン（xoxb- で始まる）を貼り付けてください').max(300),
});

const PROVIDERS = ['slack', 'google'] as const;

/** 暗号文カラムを落とした公開形。レスポンスは必ずこれを通す。 */
function sanitize(conn: {
  id: string;
  orgId: string;
  provider: string;
  scopes: string | null;
  externalAccountId: string | null;
  displayName: string | null;
  status: string;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: conn.id,
    orgId: conn.orgId,
    provider: conn.provider,
    scopes: conn.scopes,
    externalAccountId: conn.externalAccountId,
    displayName: conn.displayName,
    status: conn.status,
    lastCheckedAt: conn.lastCheckedAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // ── 一覧 ─────────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const connections = await prisma.providerConnection.findMany({
      where: { orgId: payload.orgId },
      orderBy: { provider: 'asc' },
    });
    return reply.send({ success: true, data: connections.map(sanitize) });
  });

  // ── Slack 接続（Bot トークン貼付） ───────────────────
  app.post('/slack', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = slackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const botToken = parsed.data.botToken.trim();

    const info = await authTest(botToken);
    if (!info) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'INVALID_SLACK_TOKEN',
          message: 'Slack トークンを検証できませんでした。Bot User OAuth Token を確認してください。',
        },
      });
    }
    if (!info.scopes.includes('chat:write')) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'MISSING_SCOPE',
          message: 'このトークンに chat:write スコープがありません。Slack アプリの Bot Token Scopes に chat:write を追加して再インストールしてください。',
        },
      });
    }
    // chat:write.public 欠如は保存は許すが警告を返す（公開チャンネルへは /invite が必要になる）
    const warning = info.scopes.includes('chat:write.public')
      ? null
      : 'chat:write.public スコープが無いため、ボットを招待していないチャンネルへは投稿できません。';

    const saved = await prisma.providerConnection.upsert({
      where: { orgId_provider: { orgId: payload.orgId, provider: 'slack' } },
      create: {
        orgId: payload.orgId,
        provider: 'slack',
        accessTokenEnc: sealSecret(botToken),
        scopes: info.scopes.join(' '),
        externalAccountId: info.teamId,
        displayName: info.teamName || info.teamId,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
      update: {
        accessTokenEnc: sealSecret(botToken),
        scopes: info.scopes.join(' '),
        externalAccountId: info.teamId,
        displayName: info.teamName || info.teamId,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
    });
    await syncRequiredCredentialStatus(payload.orgId, 'slack', 'CONNECTED');
    return reply.code(201).send({ success: true, data: { ...sanitize(saved), warning } });
  });

  // ── 解除 ─────────────────────────────────────────────
  app.delete('/:provider', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { provider } = request.params as { provider: string };
    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: '不明なプロバイダです' } });
    }
    const conn = await prisma.providerConnection.findUnique({
      where: { orgId_provider: { orgId: payload.orgId, provider } },
    });
    if (!conn) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '接続が見つかりません' } });
    }
    if (provider === 'google') {
      // best-effort revoke（失敗しても解除は続行）
      await revokeGoogleToken(conn.accessTokenEnc);
    }
    await prisma.providerConnection.delete({ where: { id: conn.id } });
    await syncRequiredCredentialStatus(payload.orgId, provider as 'slack' | 'google', 'DISCONNECTED');
    return reply.send({ success: true, data: { provider } });
  });
}
