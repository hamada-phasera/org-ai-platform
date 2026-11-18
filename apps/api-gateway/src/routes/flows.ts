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
import { FLOW_SAVE_RATE_LIMIT } from '../middleware/rate-limit';
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

/**
 * 業務フロー（docs/design/canvas-home.md §7.1）。prefix: `/api/flows`。このチャンクは取得・保存まで（実行はチャンク 5）。
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
}
