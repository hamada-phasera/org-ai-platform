// LINE 受信箱メッセージ API（prefix /api/inbox/messages、requireAuth）。
// 一覧 / 下書き再生成 / 承認送信 / 却下。実送信は承認 (approve) のみが adapter 経由で行う。
// 他 org / 不存在はすべて 404（routes/sns/posts.ts の loadPendingSnsTask と同じ流儀）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { getChannelAdapter } from '../../services/inbox/adapter';
import { generateInboxDraft } from '../../services/inbox/draft-generator';

type AuthPayload = { orgId: string; sub?: string };

export type InboxAction = 'regenerate' | 'approve' | 'reject';

// 状態遷移ガード（pure・テスト対象）。
// - regenerate: 下書きを作り直せるのは未送信・未却下の間だけ
// - approve:    下書きがある（or 生成失敗して手書きする）行 + push 失敗のリトライ
// - reject:     未送信の行のみ（SENT の取り消しは不可）
const ALLOWED_TRANSITIONS: Record<InboxAction, readonly string[]> = {
  regenerate: ['RECEIVED', 'DRAFTED', 'DRAFT_FAILED'],
  approve: ['DRAFTED', 'DRAFT_FAILED', 'SEND_FAILED'],
  reject: ['RECEIVED', 'DRAFTED', 'DRAFT_FAILED'],
};

export function assertTransition(current: string, action: InboxAction): boolean {
  return ALLOWED_TRANSITIONS[action].includes(current);
}

const listQuerySchema = z.object({
  status: z.string().max(50).optional(),
  connectionId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const approveSchema = z.object({ replyText: z.string().min(1).max(5000) });
const rejectSchema = z.object({ reason: z.string().max(500).optional() });

export async function inboxMessagesRoutes(app: FastifyInstance): Promise<void> {
  // 自 org のメッセージだけを引く。他 org / 不存在は区別せず 404。
  async function loadMessage(orgId: string, id: string) {
    const msg = await prisma.inboundMessage.findUnique({ where: { id } });
    if (!msg || msg.orgId !== orgId) return null;
    return msg;
  }

  // ── 一覧: GET /?status=&connectionId=&limit=50 ──────────────
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const { status, connectionId } = parsed.data;
    const take = Math.min(parsed.data.limit ?? 50, 100);
    const messages = await prisma.inboundMessage.findMany({
      where: {
        orgId: payload.orgId,
        ...(status ? { status } : {}),
        ...(connectionId ? { connectionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return reply.send({ success: true, data: messages });
  });

  // ── 下書き再生成 ──────────────────────────────────────────
  app.post('/:id/regenerate', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { id } = request.params as { id: string };
    const msg = await loadMessage(payload.orgId, id);
    if (!msg) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'メッセージが見つかりません' } });
    }
    if (!assertTransition(msg.status, 'regenerate')) {
      return reply.code(409).send({
        success: false,
        error: { code: 'INVALID_STATE', message: `この状態では再生成できません(現在: ${msg.status})` },
      });
    }
    await generateInboxDraft(id, { allowRegenerate: true });
    const updated = await prisma.inboundMessage.findUnique({ where: { id } });
    return reply.send({ success: true, data: updated });
  });

  // ── 承認 = LINE push 送信（唯一の実送信経路） ──────────────
  app.post('/:id/approve', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { id } = request.params as { id: string };
    const parsed = approveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const msg = await loadMessage(payload.orgId, id);
    if (!msg) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'メッセージが見つかりません' } });
    }
    if (!assertTransition(msg.status, 'approve')) {
      return reply.code(409).send({
        success: false,
        error: { code: 'INVALID_STATE', message: `この状態では承認できません(現在: ${msg.status})` },
      });
    }
    const connection = msg.connectionId
      ? await prisma.channelConnection.findUnique({ where: { id: msg.connectionId } })
      : null;
    if (!connection) {
      return reply.code(409).send({
        success: false,
        error: { code: 'INVALID_STATE', message: 'LINE 接続が削除されているため送信できません' },
      });
    }

    const adapter = getChannelAdapter(msg.provider);
    const result = await adapter.sendReply(connection, msg, parsed.data.replyText);
    if (!result.ok) {
      await prisma.inboundMessage.update({
        where: { id },
        data: {
          status: 'SEND_FAILED',
          lastError: `LINE push failed (status=${result.status}): ${result.body}`.slice(0, 500),
        },
      });
      return reply.code(502).send({
        success: false,
        error: { code: 'LINE_PUSH_FAILED', message: 'LINE への送信に失敗しました。再度承認するとリトライします。' },
      });
    }

    const updated = await prisma.inboundMessage.update({
      where: { id },
      data: {
        status: 'SENT',
        replyText: parsed.data.replyText,
        repliedAt: new Date(),
        repliedBy: payload.sub ?? null,
        lastError: null,
      },
    });

    // push 数のセルフカウント（LINE 無料枠 200 通/月の目安表示用・best-effort）。
    // pushCountMonth が今月でなければ 1 にリセット（月替りの lazy リセット）。
    try {
      const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
      await prisma.channelConnection.update({
        where: { id: connection.id },
        data:
          connection.pushCountMonth === currentMonth
            ? { monthlyPushCount: { increment: 1 } }
            : { monthlyPushCount: 1, pushCountMonth: currentMonth },
      });
    } catch (e) {
      request.log.error({ err: e }, '[inbox/messages] monthlyPushCount の更新に失敗');
    }

    return reply.send({ success: true, data: updated });
  });

  // ── 却下（状態遷移のみ・送信しない） ──────────────────────
  app.post('/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { id } = request.params as { id: string };
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const msg = await loadMessage(payload.orgId, id);
    if (!msg) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'メッセージが見つかりません' } });
    }
    if (!assertTransition(msg.status, 'reject')) {
      return reply.code(409).send({
        success: false,
        error: { code: 'INVALID_STATE', message: `この状態では却下できません(現在: ${msg.status})` },
      });
    }
    const updated = await prisma.inboundMessage.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: parsed.data.reason ?? null },
    });
    return reply.send({ success: true, data: updated });
  });
}
