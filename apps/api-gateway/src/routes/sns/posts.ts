import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { dispatchGenerationTask } from '../../services/generation-dispatch';
import { buildSnsMessages, type SnsGenInputs } from './format';
import { groupDraftsByDate, type CalendarTask } from './calendar';

/**
 * SNS投稿 下書き生成 & 承認待ちキュー（N-1 / N-2）— n8n 統合設計 D1 準拠。
 *
 * 【最重要・厳守】SNSへの実投稿は一切実装しない。ここでできるのは
 *   下書き生成 → 承認待ち(PENDING_APPROVAL) → 承認/却下(状態遷移のみ) → 予約(scheduledAt) まで。
 * 承認しても投稿はされない。既存の POST /tasks/:id/approve は承認時に
 * dispatchQueuedTask() で実行に回すため **絶対に流用しない**。
 *
 * 生成は Task(taskType='sns', status='QUEUED') を作成して 202 を返し、
 * dispatchGenerationTask（n8n 加速 + AI Engine フォールバック）が実行する。
 * 完了時の後処理（finalizeGenerationOutput）がドラフトを整形して
 * **PENDING_APPROVAL** に遷移させる（DONE にはしない = 勝手に実行されない）。
 * AILog は ai-engine `/llm/chat` の集中ロギングで記録（本ルートの重複 aILog.create は廃止）。
 */

const SNS_DEPARTMENT = 'MARKETING'; // 実 enum に 'SNS' は無い。SNS=マーケ機能として MARKETING に集約。
const SNS_TASK_TYPE = 'sns';

const platformEnum = z.enum(['twitter', 'instagram', 'linkedin']);

const generateSchema = z.object({
  platform: platformEnum,
  topic: z.string().min(1).max(500),
  tone: z.string().max(100).optional(),
  keywords: z.string().max(1000).optional(),
  hashtagCount: z.number().int().min(0).max(30).optional(),
});

const rejectSchema = z.object({ reason: z.string().max(500).optional() });
const scheduleSchema = z.object({
  scheduledAt: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日付が不正です' }),
});

type AuthPayload = { orgId: string; sub?: string; email?: string };

export async function snsPostsRoutes(app: FastifyInstance): Promise<void> {
  // ── N-1: 投稿下書き生成（非同期 Task 化・D1） ─────────────
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const { platform, topic, tone, keywords, hashtagCount } = parsed.data;
    const inputs: SnsGenInputs = { topic, tone, keywords, hashtagCount };
    const messages = buildSnsMessages(platform, inputs);
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';

    const task = await prisma.task.create({
      data: {
        orgId: payload.orgId,
        title: `SNS下書き(${platform}): ${topic.slice(0, 40)}`,
        status: 'QUEUED',
        department: SNS_DEPARTMENT,
        taskType: SNS_TASK_TYPE,
        input: JSON.stringify({ platform, ...inputs }),
      },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'SNS下書き生成をキューに投入しました', level: 'INFO' },
    });

    // 生成完了時に finalizeGenerationOutput が PENDING_APPROVAL に遷移させる（投稿はしない）
    dispatchGenerationTask(task, {
      taskType: 'sns',
      systemPrompt,
      userPrompt,
      jsonMode: true,
      userEmail: payload.email ?? null,
    }).catch((e) => request.log.error({ err: e }, '[sns/posts] dispatch failed'));

    return reply.code(202).send({ success: true, data: { taskId: task.id, status: 'QUEUED', platform } });
  });

  // ── N-2: 承認待ちキュー（read） ──────────────────────
  app.get('/queue', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const tasks = await prisma.task.findMany({
      where: { orgId: payload.orgId, taskType: SNS_TASK_TYPE, status: 'PENDING_APPROVAL' },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: tasks });
  });

  // ── N-3: コンテンツカレンダー（下書きを日付にグルーピング） ──
  app.get('/calendar', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const tasks = (await prisma.task.findMany({
      where: { orgId: payload.orgId, taskType: SNS_TASK_TYPE },
      orderBy: { createdAt: 'desc' },
    })) as unknown as CalendarTask[]; // Prisma Task → カレンダー最小形（groupDraftsByDate が必要フィールドのみ参照）
    return reply.send({ success: true, data: { days: groupDraftsByDate(tasks) } });
  });

  // ── N-2: 承認/却下（状態遷移のみ・dispatch/投稿はしない） ──
  async function loadPendingSnsTask(orgId: string, taskId: string) {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== orgId || task.taskType !== SNS_TASK_TYPE) {
      return { ok: false as const, code: 404, body: { code: 'NOT_FOUND', message: 'SNS下書きが見つかりません' } };
    }
    if (task.status !== 'PENDING_APPROVAL') {
      return {
        ok: false as const,
        code: 409,
        body: { code: 'INVALID_STATE', message: `承認待ちではありません(現在: ${task.status})` },
      };
    }
    return { ok: true as const, task };
  }

  app.post('/:taskId/approve', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { taskId } = request.params as { taskId: string };
    const found = await loadPendingSnsTask(payload.orgId, taskId);
    if (!found.ok) {
      return reply.code(found.code).send({ success: false, error: found.body });
    }
    // 状態を APPROVED にするだけ。投稿・実行(dispatch)は一切行わない。
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'APPROVED',
        approvalData: JSON.stringify({
          state: 'APPROVED',
          reviewedBy: payload.sub ?? null,
          reviewedAt: new Date().toISOString(),
        }),
      },
    });
    return reply.send({ success: true, data: updated });
  });

  app.post('/:taskId/reject', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { taskId } = request.params as { taskId: string };
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const found = await loadPendingSnsTask(payload.orgId, taskId);
    if (!found.ok) {
      return reply.code(found.code).send({ success: false, error: found.body });
    }
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'REJECTED',
        approvalData: JSON.stringify({
          state: 'REJECTED',
          reviewedBy: payload.sub ?? null,
          reviewedAt: new Date().toISOString(),
          reason: parsed.data.reason ?? null,
        }),
      },
    });
    return reply.send({ success: true, data: updated });
  });

  // ── N-3: 下書きを日付にひも付け（scheduledAt 設定・メタデータのみ／投稿はしない） ──
  app.patch('/:taskId/schedule', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { taskId } = request.params as { taskId: string };
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId || task.taskType !== SNS_TASK_TYPE) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'SNS下書きが見つかりません' } });
    }
    // 正式カラム Task.scheduledAt に保存（SNS#S4 消化。投稿準備 cron が status と組で走査する）。
    // 既存 UI との互換のため output(下書きJSON) にも複製する。status は変えない・投稿もしない。
    let draft: Record<string, unknown> = {};
    try {
      draft = task.output ? (JSON.parse(task.output) as Record<string, unknown>) : {};
    } catch {
      draft = {};
    }
    draft.scheduledAt = parsed.data.scheduledAt;
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: { scheduledAt: new Date(parsed.data.scheduledAt), output: JSON.stringify(draft) },
    });
    return reply.send({ success: true, data: updated });
  });
}
