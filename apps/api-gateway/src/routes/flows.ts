import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  FLOW_DEFINITION_LIMITS,
  FLOW_SLUG_PATTERN,
  FLOW_TEMPLATE_KEYS,
  PAGE_ICONS,
  flowDefinitionSchema,
  flowLayoutSchema,
  flowNodeIdSchema,
  hasControlChars,
  type FlowDefinition,
} from '@org-ai/shared-types';
import { authOf } from '../tenancy';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { config } from '../config/env';
import { FLOW_RUN_RATE_LIMIT, FLOW_SAVE_RATE_LIMIT } from '../middleware/rate-limit';
import { sendBodyTooLargeAsError, sendError } from '../utils/http-error';
import { createLogger } from '../utils/logger';
import { describeIssues } from '../services/pages/upsert';
import { FLOW_ID_PATTERN, canManageFlow, canViewFlow, minRoleAllowed } from '../services/flows/access';
import { flowUsageOf, planOf } from '../services/flows/limits';
import {
  FLOW_SELECT,
  FlowServiceError,
  applyNodeTextPatch,
  createEmptyFlow,
  createFlowFromTemplate,
  deleteFlow,
  writeFlow,
  type FlowRow,
} from '../services/flows/store';
import type { TenantDb } from '../tenancy/tenant-db';
import { hasRoleAtLeast, isFlowRunFinal } from '@org-ai/shared-types';
import { FlowRunInputError, acceptRun, cancelRun, flowQueueTuning, pumpOrg } from '../services/flows/queue';
import { waitForRunSettled } from '../services/flows/runner';

/**
 * 業務フロー（docs/design/canvas-home.md §7.1）。prefix: `/api/flows`。取得・保存（チャンク 4）と実行（チャンク 5）。
 *
 * - 見えないフロー（他組織・役割不足）は**すべて 404 `NOT_FOUND`**（存在を漏らさない。T1・T15）。
 * - 編集は ADMIN 以上かつ minRole を満たすもの。自分より上の minRole は付けられない（T15）。
 * - 書き込みは requireAuth が「閲覧のみ」の組織を 402 で止める（既存の仕組み。T16）。
 * - フローの作成・保存は n8n の public API を呼ばない（D9・T22。architecture.test.ts で固定）。
 */

const log = createLogger('flows');

const NOT_FOUND_MESSAGE = 'フローが見つかりません';
/** 定義 64KB ＋ 位置。本文はその倍まで（T11） */
const FLOW_BODY_LIMIT = 128 * 1024;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(FLOW_DEFINITION_LIMITS.nameMax)
  .refine((v) => !hasControlChars(v), '制御文字は使えません');
const minRoleSchema = z.enum(['MEMBER', 'ADMIN', 'OWNER']);
const iconSchema = z.enum(PAGE_ICONS);

const fromTemplateSchema = z
  .object({ templateKey: z.enum(FLOW_TEMPLATE_KEYS), canvasNodeId: flowNodeIdSchema.optional() })
  .strict();

const createSchema = z
  .object({
    name: nameSchema,
    icon: iconSchema.optional(),
    slug: z.string().regex(FLOW_SLUG_PATTERN, 'slug は英小文字・数字・ハイフン（1〜40 文字）').optional(),
    minRole: minRoleSchema.optional(),
  })
  .strict();

const putSchema = z
  .object({
    definition: z.unknown(),
    layout: flowLayoutSchema,
    name: nameSchema.optional(),
    icon: iconSchema.optional(),
    minRole: minRoleSchema.optional(),
    baseVersion: z.number().int().min(1),
  })
  .strict();

const nodeTextSchema = z
  .string()
  .max(FLOW_DEFINITION_LIMITS.documentBodyMax);

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: nameSchema.optional(),
    icon: iconSchema.optional(),
    minRole: minRoleSchema.optional(),
    /** 1 ノードの文字項目だけ（スマホの簡単な変更）。構造は変えられない */
    node: z
      .object({
        id: flowNodeIdSchema,
        label: z.string().max(FLOW_DEFINITION_LIMITS.labelMax).optional(),
        config: z.record(z.string().max(40), nodeTextSchema).refine((r) => Object.keys(r).length <= 5, '項目は 5 つまでです').optional(),
      })
      .strict()
      .optional(),
    /** node を変えるときは必須（他人の編集の上に古い文字を書かない） */
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'baseVersion'), '変更する項目がありません')
  .refine((v) => v.node === undefined || v.baseVersion !== undefined, '版（baseVersion）が要ります');


const RUN_NOT_FOUND = '実行が見つかりません';
/** web が実行ごとに作る UUID（定期は sched:<flowId>:<時刻>） */
const requestIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{8,100}$/, 'requestId の形ではありません');
const runBodySchema = z.object({ input: z.record(z.unknown()).optional(), requestId: requestIdSchema }).strict();
const runListQuerySchema = z.object({ cursor: z.string().regex(FLOW_ID_PATTERN).optional() }).strict();
const RUN_PAGE = 20;

const RUN_SUMMARY_SELECT = {
  id: true, flowId: true, flowSlug: true, flowVersion: true, trigger: true, actorId: true, status: true,
  error: true, taskId: true, startedAt: true, finishedAt: true, durationMs: true, createdAt: true,
} as const;
const RUN_DETAIL_SELECT = { ...RUN_SUMMARY_SELECT, input: true, steps: true, output: true, aiCalls: true, partCalls: true } as const;

interface RunSummaryRow {
  id: string;
  flowId: string;
  actorId: string | null;
  status: string;
  taskId: string | null;
}

/** 実行を見てよいか。フローが見えること（消えたフローの実行は ADMIN 以上か実行した本人） */
async function canSeeRun(db: TenantDb, run: RunSummaryRow, role: Parameters<typeof canViewFlow>[1], sub: string): Promise<boolean> {
  const flow = await loadFlow(db, run.flowId);
  if (flow) return canViewFlow(flow, role);
  return run.actorId === sub || (!!role && hasRoleAtLeast(role, 'ADMIN'));
}

function idOf(params: unknown): string | null {
  const id = (params as { id?: unknown }).id;
  return typeof id === 'string' && FLOW_ID_PATTERN.test(id) ? id : null;
}

async function loadFlow(db: TenantDb, id: string): Promise<FlowRow | null> {
  return (await db.flow.findUnique({ where: { id }, select: FLOW_SELECT })) as FlowRow | null;
}

function sendServiceError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof FlowServiceError) return sendError(reply, e.status, e.code, e.message);
  throw e;
}

/** 部品（n8n 経由）がつながっているか。n8n の URL・ID は返さない（T19） */
function connectionOf(): { n8n: 'ok' | 'not_configured' } {
  return { n8n: config.n8nConfigured ? 'ok' : 'not_configured' };
}

const summaryOf = (f: FlowRow) => ({
  id: f.id,
  slug: f.slug,
  name: f.name,
  icon: f.icon,
  enabled: f.enabled,
  minRole: f.minRole,
  templateKey: f.templateKey,
  version: f.version,
  updatedAt: f.updatedAt,
});

export async function flowRoutes(app: FastifyInstance): Promise<void> {
  sendBodyTooLargeAsError(app, 'フローが大きすぎます。ノードや文字を減らしてください。');
  const save = { rateLimit: FLOW_SAVE_RATE_LIMIT };

  /** 一覧（minRole を満たすものだけ）。上限の表示用にフロー数は組織全体で数える */
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const rows = (await db.flow.findMany({ select: FLOW_SELECT, orderBy: { createdAt: 'asc' } })) as FlowRow[];
    const usage = await flowUsageOf(db, await planOf(db));
    return reply.send({
      success: true,
      data: { flows: rows.filter((f) => canViewFlow(f, role)).map(summaryOf), usage },
    });
  });

  /** テンプレートから作る。既にあればそれを返す（200・created: false）。作ったら 201 */
  app.post('/from-template', { preHandler: requireAdmin, config: save }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const parsed = fromTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    try {
      const res = await createFlowFromTemplate(db, { ...parsed.data, plan: await planOf(db), actorId: sub });
      // 既にあったフローが自分より上の役割限定なら、存在を漏らさない
      if (!res.created && !canViewFlow(res.flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
      return reply
        .code(res.created ? 201 : 200)
        .send({ success: true, data: { flow: summaryOf(res.flow), created: res.created, canvasUpdated: res.canvasUpdated } });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  /** 空のフロー（きっかけ → 出力）を作る */
  app.post('/', { preHandler: requireAdmin, config: save }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    if (!minRoleAllowed(parsed.data.minRole, role)) {
      return sendError(reply, 403, 'FORBIDDEN', '自分より上の役割だけが使えるフローにはできません');
    }
    try {
      const flow = await createEmptyFlow(db, { ...parsed.data, plan: await planOf(db), actorId: sub });
      return reply.code(201).send({ success: true, data: { flow: summaryOf(flow) } });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  /** 定義・配置・版・利用状況・部品の接続 */
  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canViewFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    /* 保存前に検証しているが、スキーマが厳しくなった後の古い行もありうる。編集で直せるよう定義は返し、印を付ける */
    const valid = flowDefinitionSchema.safeParse(flow.definition).success;
    if (!valid) log.warn(`保存済みの定義がスキーマに合いません flowId=${flow.id} version=${flow.version}`);
    return reply.send({
      success: true,
      data: {
        ...summaryOf(flow),
        templateVersion: flow.templateVersion,
        definition: flow.definition,
        layout: flow.layout ?? {},
        valid,
        canEdit: canManageFlow(flow, role),
        usage: await flowUsageOf(db, await planOf(db)),
        connection: connectionOf(),
      },
    });
  });

  /** 保存。検証 → 定義が変われば版 +1。baseVersion が違えば 409 FLOW_CONFLICT */
  app.put('/:id', { preHandler: requireAdmin, bodyLimit: FLOW_BODY_LIMIT, config: save }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canManageFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const parsed = putSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    const def = flowDefinitionSchema.safeParse(parsed.data.definition);
    if (!def.success) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'FLOW_INVALID_DEFINITION',
          message: describeIssues(def.error.issues),
          // web がノードに印を付けるための場所（値は入れない）
          issues: def.error.issues.slice(0, 20).map((i) => ({ path: i.path, message: i.message })),
        },
      });
    }
    const { name, icon, minRole, layout, baseVersion } = parsed.data;
    if (!minRoleAllowed(minRole, role)) return sendError(reply, 403, 'FORBIDDEN', '自分より上の役割だけが使えるフローにはできません');
    try {
      const res = await writeFlow(db, {
        flow,
        definition: def.data as FlowDefinition,
        layout,
        fields: { name, icon, minRole },
        baseVersion,
        actorId: sub,
      });
      return reply.send({ success: true, data: res });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  /** 有効/無効・名前・アイコン・役割と、1 ノードの文字項目だけ */
  app.patch('/:id', { preHandler: requireAdmin, config: save }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canManageFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    const { node, baseVersion, ...fields } = parsed.data;
    if (!minRoleAllowed(fields.minRole, role)) {
      return sendError(reply, 403, 'FORBIDDEN', '自分より上の役割だけが使えるフローにはできません');
    }
    try {
      let definition: FlowDefinition | undefined;
      if (node) {
        const current = flowDefinitionSchema.safeParse(flow.definition);
        if (!current.success) {
          return sendError(reply, 409, 'FLOW_INVALID_DEFINITION', 'フローの定義が古い形です。パソコンのフロー画面で直してください。');
        }
        const next = flowDefinitionSchema.safeParse(applyNodeTextPatch(current.data as FlowDefinition, node));
        if (!next.success) return sendError(reply, 400, 'FLOW_INVALID_DEFINITION', describeIssues(next.error.issues));
        definition = next.data as FlowDefinition;
      }
      const res = await writeFlow(db, { flow, definition, fields, baseVersion: baseVersion ?? flow.version, actorId: sub });
      return reply.send({ success: true, data: res });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  /** フロー・版・定期・結果ページを消す。実行履歴は残す */
  app.delete('/:id', { preHandler: requireAdmin, config: save }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canManageFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const deleted = await deleteFlow(db, { flow, actorId: sub });
    if (!deleted) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    return reply.send({ success: true, data: { deleted: true } });
  });

  // ── 実行（チャンク 5。§7.2） ─────────────────────────────

  /**
   * 実行。`{ input, requestId }`。受け付けたら空きがあれば着手し、最大 8 秒だけ完了を待つ（K10）。
   * 止まった（終わった・承認待ち）なら 200 で状態、まだなら 202 で runId（web は GET /runs/:runId を取りに行く）。
   */
  app.post('/:id/runs', { preHandler: requireAuth, config: { rateLimit: FLOW_RUN_RATE_LIMIT } }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canViewFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const parsed = runBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    const trigger = (flow.definition as { nodes?: { type?: string; config?: { mode?: string } }[] } | null)?.nodes?.find((n) => n.type === 'trigger');
    let accepted: { runId: string };
    try {
      accepted = await acceptRun(db, {
        flow,
        input: parsed.data.input ?? {},
        requestId: parsed.data.requestId,
        trigger: trigger?.config?.mode === 'form' ? 'form' : 'manual',
        actorId: sub,
        plan: await planOf(db),
      });
    } catch (e) {
      if (e instanceof FlowRunInputError) {
        return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: e.message, issues: e.issues } });
      }
      return sendServiceError(reply, e);
    }
    const settled = waitForRunSettled(accepted.runId, flowQueueTuning.syncWaitMs);
    await pumpOrg(db.orgId);
    await settled;
    const run = await db.flowRun.findUnique({ where: { id: accepted.runId }, select: RUN_DETAIL_SELECT });
    const done = !!run && (isFlowRunFinal(run.status) || run.status === 'WAITING_APPROVAL');
    return reply.code(done ? 200 : 202).send({ success: true, data: { runId: accepted.runId, run } });
  });

  /** 履歴（新しい順・20 件ずつ。`?cursor=<runId>` で続き） */
  app.get('/:id/runs', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const id = idOf(request.params);
    if (!id) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const flow = await loadFlow(db, id);
    if (!flow || !canViewFlow(flow, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const q = runListQuerySchema.safeParse(request.query ?? {});
    if (!q.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(q.error.issues));
    const rows = await db.flowRun.findMany({
      where: { flowId: flow.id },
      select: RUN_SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RUN_PAGE + 1,
      ...(q.data.cursor ? { cursor: { id: q.data.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, RUN_PAGE);
    return reply.send({
      success: true,
      data: { runs: page, nextCursor: rows.length > RUN_PAGE ? page[page.length - 1]?.id ?? null : null },
    });
  });

  /** 1 回分の状態とステップ結果（web が 2 秒おきに取りに行く） */
  app.get('/runs/:runId', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const runId = (request.params as { runId?: unknown }).runId;
    if (typeof runId !== 'string' || !FLOW_ID_PATTERN.test(runId)) return sendError(reply, 404, 'NOT_FOUND', RUN_NOT_FOUND);
    const run = await db.flowRun.findUnique({ where: { id: runId }, select: RUN_DETAIL_SELECT });
    if (!run || !(await canSeeRun(db, run, role, sub))) return sendError(reply, 404, 'NOT_FOUND', RUN_NOT_FOUND);
    return reply.send({ success: true, data: run });
  });

  /** 待ち・承認待ちを取り消す（実行した本人か ADMIN 以上）。走っている実行は 409 */
  app.post('/runs/:runId/cancel', { preHandler: requireAuth, config: { rateLimit: FLOW_RUN_RATE_LIMIT } }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const runId = (request.params as { runId?: unknown }).runId;
    if (typeof runId !== 'string' || !FLOW_ID_PATTERN.test(runId)) return sendError(reply, 404, 'NOT_FOUND', RUN_NOT_FOUND);
    const run = await db.flowRun.findUnique({ where: { id: runId }, select: RUN_SUMMARY_SELECT });
    if (!run || !(await canSeeRun(db, run, role, sub))) return sendError(reply, 404, 'NOT_FOUND', RUN_NOT_FOUND);
    if (run.actorId !== sub && !(role && hasRoleAtLeast(role, 'ADMIN'))) {
      return sendError(reply, 403, 'FORBIDDEN', '実行した本人か管理者だけが取り消せます');
    }
    if (!(await cancelRun(db, run))) return sendError(reply, 409, 'INVALID_STATE', '待ち・承認待ちの実行だけ取り消せます');
    return reply.send({ success: true, data: { canceled: true } });
  });
}
