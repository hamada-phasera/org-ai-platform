import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PAGE_DEFINITION_LIMITS,
  PAGE_ICONS,
  PAGE_SLUG_PATTERN,
  PAGE_STATUSES,
  hasRoleAtLeast,
  hasControlChars,
  pageDefinitionSchema,
  pageUpsertSchema,
  toPublicPageDefinition,
  type UserRole,
} from '@org-ai/shared-types';
import { authOf } from '../tenancy';
import { requireAdmin, requireAuth, requireOwner } from '../middleware/auth';
import { config } from '../config/env';
import { sendError } from '../utils/http-error';
import { createLogger } from '../utils/logger';
import { recordAudit } from '../services/audit';
import { canManagePage, canViewPage, pageUsageOf, planOf } from '../services/pages/access';
import { PageServiceError, deletePage, describeIssues, upsertPage } from '../services/pages/upsert';
import { issuePageToken, listPageTokens, revokePageToken } from '../services/pages/page-token';
import { PAGE_SUBMIT_BODY_LIMIT, runPageQuery, runPageSubmit, type ActionOutcome } from '../services/pages/action-runner';
import { isSamplePage } from '../services/pages/sample';
import { PAGE_ACTION_RATE_LIMIT } from '../middleware/rate-limit';

/**
 * 業務ページ（利用者向け・JWT）。prefix: `/api/pages`。docs/design/custom-pages.md §5.1
 *
 * - 見えないページ（他組織・下書き・役割不足）は**すべて 404 `NOT_FOUND`**（存在を漏らさない。T1・T14）。
 * - 定義を返すときは `toPublicPageDefinition` を通し、**`hook` は返さない**（T17）。
 * - データ取得（`GET /:slug/data/:actionId`）と送信（`POST /:slug/actions/:actionId`）は services/pages/action-runner.ts
 *   （§5.2 の 11 段階）。GET なので取得は「閲覧のみ」の組織でも通り、送信（POST）は 402。
 * - 書き込み（PATCH / PUT / DELETE / POST）は requireAuth が「閲覧のみ」の組織を 402 で止める（既存の仕組み）。
 */

const log = createLogger('pages');

const NOT_FOUND_MESSAGE = 'ページが見つかりません';

const patchSchema = z
  .object({
    status: z.enum(PAGE_STATUSES).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    minRole: z.enum(['MEMBER', 'ADMIN', 'OWNER']).optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(PAGE_DEFINITION_LIMITS.titleMax)
      .refine((v) => !hasControlChars(v), '制御文字は使えません')
      .optional(),
    icon: z.enum(PAGE_ICONS).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, '変更する項目がありません');

const issueTokenSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .refine((v) => !hasControlChars(v), '制御文字は使えません'),
  })
  .strict();

function slugOf(params: unknown): string | null {
  const slug = (params as { slug?: unknown }).slug;
  return typeof slug === 'string' && PAGE_SLUG_PATTERN.test(slug) ? slug : null;
}

function sendOutcome<T>(reply: FastifyReply, outcome: ActionOutcome<T>): FastifyReply {
  if (!outcome.ok) return sendError(reply, outcome.status, outcome.code, outcome.message);
  return reply.send({ success: true, data: outcome.data });
}

function connectionOf(page: { sampleData?: unknown }): 'ok' | 'not_configured' | 'sample' {
  if (isSamplePage(page)) return 'sample';
  return config.n8nConfigured ? 'ok' : 'not_configured';
}

function sendServiceError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof PageServiceError) return sendError(reply, e.status, e.code, e.message);
  throw e;
}

/** 自分より上の役割を minRole に付けさせない（付けた瞬間に自分が管理できなくなる＝誤操作で消えたように見える） */
function minRoleAllowed(minRole: UserRole | undefined, role: UserRole | null): boolean {
  return minRole === undefined || (!!role && hasRoleAtLeast(role, minRole));
}

const LIST_SELECT = { slug: true, title: true, icon: true, status: true, minRole: true, sortOrder: true, createdAt: true } as const;

/** sortOrder → createdAt の順（Prisma の orderBy に加えて、ここでも並べて結果を固定する） */
function byOrder<T extends { sortOrder: number; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  /** ナビ用の一覧。MEMBER には公開済みかつ minRole を満たすものだけ、ADMIN 以上には下書きも */
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const rows = await db.customPage.findMany({
      select: LIST_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const data = byOrder(rows)
      .filter((p) => canViewPage(p, role))
      .map((p) => ({ slug: p.slug, title: p.title, icon: p.icon, status: p.status }));
    return reply.send({ success: true, data });
  });

  /** 設定画面用の一覧（管理者以上）。管理できるページだけ（minRole が自分より上のものは出さない） */
  app.get('/admin/list', { preHandler: requireAdmin }, async (request, reply) => {
    const { db, role } = authOf(request);
    const rows = await db.customPage.findMany({
      select: { ...LIST_SELECT, version: true, source: true, updatedAt: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const plan = await planOf(db);
    const pages = byOrder(rows).filter((p) => canManagePage(p, role));
    const usage = await pageUsageOf(db, plan);
    return reply.send({
      success: true,
      data: {
        pages: pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          icon: p.icon,
          status: p.status,
          minRole: p.minRole,
          sortOrder: p.sortOrder,
          version: p.version,
          source: p.source,
          updatedAt: p.updatedAt,
        })),
        // ページ数は組織全体（見えないページも上限には数える）
        pageCount: rows.length,
        plan,
        usage,
        // 構築者が Webhook のパス（pages/<orgId>/<hook>）に書く組織 ID
        orgId: db.orgId,
        connection: config.n8nConfigured ? 'ok' : 'not_configured',
      },
    });
  });

  // ── 登録トークン（オーナーのみ） ──

  app.get('/tokens', { preHandler: requireOwner }, async (request, reply) => {
    const { db } = authOf(request);
    return reply.send({ success: true, data: await listPageTokens(db) });
  });

  /** 発行。**生トークンはこの応答にだけ出る**（ログにも監査にも出さない） */
  app.post('/tokens', { preHandler: requireOwner }, async (request, reply) => {
    const { db, sub } = authOf(request);
    const parsed = issueTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    try {
      const issued = await issuePageToken(db, { label: parsed.data.label, actorId: sub });
      return reply.code(201).send({
        success: true,
        data: { ...issued, registerUrlBase: `${config.apiGatewayUrl.replace(/\/+$/, '')}/api/webhooks/n8n/pages` },
      });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  app.delete('/tokens/:id', { preHandler: requireOwner }, async (request, reply) => {
    const { db, sub } = authOf(request);
    const { id } = request.params as { id: string };
    try {
      await revokePageToken(db, { id, actorId: sub });
      return reply.send({ success: true, data: { revoked: true } });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  // ── ページ ──

  /** 定義と状態。hook は返さない */
  app.get('/:slug', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const slug = slugOf(request.params);
    if (!slug) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const page = await db.customPage.findUnique({
      where: { orgId_slug: { orgId: db.orgId, slug } },
      select: {
        slug: true, title: true, icon: true, status: true, minRole: true, version: true, definition: true, sampleData: true, updatedAt: true,
      },
    });
    if (!page || !canViewPage(page, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    /* 保存前に検証しているが、スキーマが厳しくなった後の古い行もありうる。壊れた定義は描画させない */
    const def = pageDefinitionSchema.safeParse(page.definition);
    if (!def.success) {
      log.warn(`保存済みの定義がスキーマに合いません slug=${slug} version=${page.version}`);
      return sendError(reply, 500, 'PAGE_INVALID_DEFINITION', 'ページの定義が壊れています。管理者に再登録を依頼してください。');
    }
    const usage = await pageUsageOf(db, await planOf(db));
    return reply.send({
      success: true,
      data: {
        slug: page.slug,
        title: page.title,
        icon: page.icon,
        status: page.status,
        minRole: page.minRole,
        version: page.version,
        updatedAt: page.updatedAt,
        definition: toPublicPageDefinition(def.data),
        connection: connectionOf(page),
        usage,
      },
    });
  });

  // ── アクション（§5.2）。IP ごと 60 回/分、組織ごとの窓は action-runner の中 ──

  /** query を実行し、定義に照らして切り詰めた結果だけを返す（K12） */
  app.get(
    '/:slug/data/:actionId',
    { preHandler: requireAuth, config: { rateLimit: PAGE_ACTION_RATE_LIMIT } },
    async (request, reply) => {
      const { db, role, sub } = authOf(request);
      const { slug, actionId } = request.params as { slug: string; actionId: string };
      return sendOutcome(reply, await runPageQuery({ db, role, userId: sub, slug, actionId }));
    },
  );

  /** submit を実行。body `{ input, requestId, origin: { blockIndex, itemIndex? } }`（16KB まで。超えたら 413） */
  app.post(
    '/:slug/actions/:actionId',
    { preHandler: requireAuth, bodyLimit: PAGE_SUBMIT_BODY_LIMIT, config: { rateLimit: PAGE_ACTION_RATE_LIMIT } },
    async (request, reply) => {
      const { db, role, sub } = authOf(request);
      const { slug, actionId } = request.params as { slug: string; actionId: string };
      return sendOutcome(reply, await runPageSubmit({ db, role, userId: sub, slug, actionId, body: request.body }));
    },
  );

  /** 公開・並び・役割・タイトル・アイコンだけ変える（定義は変えない） */
  app.patch('/:slug', { preHandler: requireAdmin }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const slug = slugOf(request.params);
    if (!slug) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    if (!minRoleAllowed(parsed.data.minRole, role)) {
      return sendError(reply, 403, 'FORBIDDEN', '自分より上の役割だけが見られるページにはできません');
    }

    const page = await db.customPage.findUnique({
      where: { orgId_slug: { orgId: db.orgId, slug } },
      select: { id: true, status: true, minRole: true, title: true, icon: true, sortOrder: true, version: true },
    });
    if (!page || !canManagePage(page, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    const changes = Object.fromEntries(
      Object.entries(parsed.data).filter(([k, v]) => v !== undefined && v !== (page as Record<string, unknown>)[k]),
    );
    if (Object.keys(changes).length > 0) {
      await db.customPage.updateMany({ where: { id: page.id }, data: { ...changes, updatedBy: sub } });
      const meta = { slug, version: page.version, changed: Object.keys(changes) };
      if (changes.status !== undefined) {
        await recordAudit(db, {
          action: changes.status === 'PUBLISHED' ? 'page.publish' : 'page.unpublish',
          actorId: sub,
          targetType: 'custom_page',
          targetId: page.id,
          meta,
        });
      }
      if (Object.keys(changes).some((k) => k !== 'status')) {
        await recordAudit(db, { action: 'page.upsert', actorId: sub, targetType: 'custom_page', targetId: page.id, meta });
      }
    }
    const next = { ...page, ...changes };
    return reply.send({
      success: true,
      data: {
        slug,
        status: next.status,
        minRole: next.minRole,
        title: next.title,
        icon: next.icon,
        sortOrder: next.sortOrder,
        version: page.version,
        changed: Object.keys(changes).length > 0,
      },
    });
  });

  /** 定義の手動 upsert（source = MANUAL。v1 は API だけ。画面は作らない＝設計書 K18） */
  app.put('/:slug', { preHandler: requireAdmin, bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const slug = slugOf(request.params);
    if (!slug) return sendError(reply, 400, 'VALIDATION_ERROR', 'slug は英小文字・数字・ハイフン（1〜40 文字）');
    const parsed = pageUpsertSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
    if (!minRoleAllowed(parsed.data.minRole, role)) {
      return sendError(reply, 403, 'FORBIDDEN', '自分より上の役割だけが見られるページにはできません');
    }
    const existing = await db.customPage.findUnique({
      where: { orgId_slug: { orgId: db.orgId, slug } },
      select: { status: true, minRole: true },
    });
    if (existing && !canManagePage(existing, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    try {
      const result = await upsertPage(db, { slug, input: parsed.data, source: 'MANUAL', plan: await planOf(db), actorId: sub });
      return reply.code(result.created ? 201 : 200).send({
        success: true,
        data: { slug: result.slug, version: result.version, status: result.status, changed: result.changed },
      });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });

  app.delete('/:slug', { preHandler: requireAdmin }, async (request, reply) => {
    const { db, role, sub } = authOf(request);
    const slug = slugOf(request.params);
    if (!slug) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    const page = await db.customPage.findUnique({
      where: { orgId_slug: { orgId: db.orgId, slug } },
      select: { status: true, minRole: true },
    });
    if (!page || !canManagePage(page, role)) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    try {
      const res = await deletePage(db, { slug, source: 'MANUAL', actorId: sub });
      if (!res.deleted) return sendError(reply, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
      return reply.send({ success: true, data: { deleted: true } });
    } catch (e) {
      return sendServiceError(reply, e);
    }
  });
}
