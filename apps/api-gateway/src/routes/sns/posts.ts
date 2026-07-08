import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import {
  PLATFORM_CONSTRAINTS,
  buildSnsMessages,
  normalizeHashtags,
  validatePost,
  type SnsDraft,
  type SnsGenInputs,
} from './format';
import { groupDraftsByDate, type CalendarTask } from './calendar';

/**
 * SNS投稿 下書き生成 & 承認待ちキュー（N-1 / N-2）。
 *
 * 【最重要・厳守】SNSへの実投稿は一切実装しない。ここでできるのは
 *   下書き生成 → 承認待ち(PENDING_APPROVAL) → 承認/却下(状態遷移のみ) まで。
 * 承認しても投稿はされない。既存の POST /tasks/:id/approve は承認時に
 * dispatchQueuedTask() で実行に回すため **絶対に流用しない**（本ファイルは dispatch を import しない）。
 *
 * LLM は AI Engine `/llm/chat` 経由（規約準拠）。`/llm/chat` は AILog を書かないので
 * 本ルートで prisma.aILog.create する（integration-requests 参照）。
 * 下書きは `Task(department='MARKETING', taskType='sns', status='PENDING_APPROVAL', output=JSON)` として保存し、
 * 既存フロントの deliverable 'sns' レンダラにそのまま載る。
 * ルート登録(index.ts)は統合フェーズ(B)。prefix 例: `/api/sns/posts`。
 */

interface LLMChatResponse {
  content: string;
  model: string;
  tokens_used: number;
  latency_ms: number;
  pii_detected: boolean;
}

const SNS_DEPARTMENT = 'MARKETING'; // 実 enum に 'SNS' は無い。SNS=マーケ機能として MARKETING に集約。
const SNS_TASK_TYPE = 'sns';

const platformEnum = z.enum(['twitter', 'instagram', 'linkedin']);

const generateSchema = z.object({
  platform: platformEnum,
  topic: z.string().min(1).max(500),
  tone: z.string().max(100).optional(),
  keywords: z.string().max(1000).optional(),
  hashtagCount: z.number().int().min(0).max(30).optional(),
  persist: z.boolean().optional(),
});

const rejectSchema = z.object({ reason: z.string().max(500).optional() });
const scheduleSchema = z.object({
  scheduledAt: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日付が不正です' }),
});

type AuthPayload = { orgId: string; sub?: string };

/** LLM 応答本文から {content, hashtags} を取り出す。JSON でなければ全文を content 扱い。 */
function parseDraftBody(raw: string): { content: string; hashtags: string[] } {
  try {
    const j = JSON.parse(raw) as { content?: unknown; hashtags?: unknown };
    if (typeof j.content === 'string' && j.content.trim()) {
      const tags = Array.isArray(j.hashtags) ? (j.hashtags as unknown[]).map(String) : [];
      return { content: j.content, hashtags: tags };
    }
  } catch {
    /* JSON でない場合は全文を本文として扱う（フォールバック） */
  }
  return { content: raw, hashtags: [] };
}

export async function snsPostsRoutes(app: FastifyInstance): Promise<void> {
  // ── N-1: 投稿下書き生成 ──────────────────────────────
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
    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';
    const messages = buildSnsMessages(platform, inputs);

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
    let res: Response;
    try {
      res = await fetch(`${aiEngineUrl}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          department: SNS_DEPARTMENT,
          org_id: payload.orgId,
          plan,
          json_mode: true,
          user_email: (request.user as { email?: string }).email ?? null, // 松竹梅ルーティング
        }),
      });
    } catch (e) {
      request.log.error({ err: e }, '[sns/posts] ai-engine unreachable');
      return reply.code(502).send({
        success: false,
        error: { code: 'AI_ENGINE_UNAVAILABLE', message: 'AI エンジンに接続できません。' },
      });
    }

    const text = await res.text();
    if (!res.ok) {
      return reply.code(res.status >= 500 ? 502 : res.status).send({
        success: false,
        error: { code: 'LLM_UPSTREAM_ERROR', message: text.slice(0, 800) },
      });
    }

    let llm: LLMChatResponse;
    try {
      llm = JSON.parse(text) as LLMChatResponse;
    } catch {
      return reply.code(502).send({
        success: false,
        error: { code: 'LLM_BAD_RESPONSE', message: 'AI エンジンの応答を解釈できませんでした。' },
      });
    }

    const body = parseDraftBody(llm.content ?? '');
    const hashtags = normalizeHashtags(body.hashtags).slice(0, PLATFORM_CONSTRAINTS[platform].maxHashtags ?? undefined);
    const draft: SnsDraft = { platform, content: body.content, hashtags };
    const validation = validatePost(platform, draft.content, draft.hashtags);
    const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';

    // AILog（必須・best-effort）
    try {
      await prisma.aILog.create({
        data: {
          orgId: payload.orgId,
          department: SNS_DEPARTMENT,
          provider: 'anthropic',
          model: llm.model,
          inputText: userPrompt.slice(0, 4000),
          outputText: (llm.content ?? '').slice(0, 4000),
          tokens: llm.tokens_used ?? null,
          latencyMs: llm.latency_ms ?? null,
          riskScore: null,
        },
      });
    } catch (e) {
      request.log.error({ err: e }, '[sns/posts] AILog 記録に失敗');
    }

    // 承認待ち Task として保存（既定 true）。※投稿はしない。承認は別途キューで。
    let taskId: string | null = null;
    if (parsed.data.persist !== false) {
      try {
        const task = await prisma.task.create({
          data: {
            orgId: payload.orgId,
            title: `SNS下書き(${platform}): ${topic.slice(0, 40)}`,
            status: 'PENDING_APPROVAL',
            department: SNS_DEPARTMENT,
            taskType: SNS_TASK_TYPE,
            input: JSON.stringify(inputs),
            output: JSON.stringify(draft),
          },
        });
        taskId = task.id;
      } catch (e) {
        request.log.error({ err: e }, '[sns/posts] 下書き Task 保存に失敗');
      }
    }

    return reply.send({ success: true, data: { draft, validation, taskId, model: llm.model } });
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
    // 既存 output(下書きJSON)に scheduledAt を差し込む。status は変えない・投稿もしない。
    let draft: Record<string, unknown> = {};
    try {
      draft = task.output ? (JSON.parse(task.output) as Record<string, unknown>) : {};
    } catch {
      draft = {};
    }
    draft.scheduledAt = parsed.data.scheduledAt;
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: { output: JSON.stringify(draft) },
    });
    return reply.send({ success: true, data: updated });
  });
}
