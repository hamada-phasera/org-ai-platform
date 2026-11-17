import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PAGE_SLUG_PATTERN, pageUpsertSchema } from '@org-ai/shared-types';
import { runAsTenant, tenantDb, type TenantDb } from '../tenancy';
import { config } from '../config/env';
import { sendError } from '../utils/http-error';
import { createLogger, errorMessage } from '../utils/logger';
import { PAGE_REGISTER_RATE_LIMIT } from '../middleware/rate-limit';
import { orgEntitlement } from '../services/org-entitlement';
import { readOnlyMessageOf } from '../services/entitlement';
import { planOf } from '../services/pages/access';
import { PageServiceError, deletePage, describeIssues, upsertPage } from '../services/pages/upsert';
import { resolvePageToken, touchPageToken, type ResolvedPageToken } from '../services/pages/page-token';

/**
 * n8n からの業務ページの登録。prefix: `/api/webhooks/n8n/pages`。docs/design/custom-pages.md §5.3
 *
 * - 認証はヘッダ `x-page-token`（組織ごとの登録トークン）だけ。**組織はトークンが決める**（body の orgId は受けない。K4）。
 *   既存の共有トークン（x-webhook-token）では通らない（T7: 共有トークンが漏れてもページ定義は書き換えられない）。
 * - 失敗は理由を問わず一律 401（存在する・失効済み・形が違う を区別させない。T6）。
 * - `/api/webhooks` は契約チェックの対象外なので、書き込み（PUT / DELETE）の入口で orgEntitlement を見る（T12）。
 * - 組織が決まったら runAsTenant + tenantDb(orgId)。素の prisma はトークンの逆引き（page-token.ts）だけ。
 */

const log = createLogger('n8n-pages');

const UNAUTHORIZED_MESSAGE = '登録トークンが無効です';

function slugOf(params: unknown): string | null {
  const slug = (params as { slug?: unknown }).slug;
  return typeof slug === 'string' && PAGE_SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * トークンを確かめ、その組織のコンテキストで fn を走らせる。
 * write = true なら契約（閲覧のみ）も見る。
 */
async function withPageToken(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { write: boolean },
  fn: (db: TenantDb, token: ResolvedPageToken) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  const token = await resolvePageToken(request.headers['x-page-token']);
  if (!token) return sendError(reply, 401, 'UNAUTHORIZED', UNAUTHORIZED_MESSAGE);

  return runAsTenant({ orgId: token.orgId, userId: null, role: null, source: 'n8n-page' }, async () => {
    const db = tenantDb(token.orgId);
    if (opts.write) {
      const decision = await orgEntitlement(db);
      if (decision.access === 'read_only') {
        return sendError(reply, 402, 'SUBSCRIPTION_REQUIRED', readOnlyMessageOf(decision.reason));
      }
    }
    try {
      await touchPageToken(db, token.tokenId);
    } catch (e) {
      // 最終使用時刻は表示用。書けなくても登録は止めない（値は出さず id だけ）
      log.warn(`lastUsedAt を更新できませんでした token=${token.tokenId}: ${errorMessage(e)}`);
    }
    try {
      return await fn(db, token);
    } catch (e) {
      if (e instanceof PageServiceError) return sendError(reply, e.status, e.code, e.message);
      throw e;
    }
  });
}

export async function n8nPageRoutes(app: FastifyInstance): Promise<void> {
  const routeConfig = { config: { rateLimit: PAGE_REGISTER_RATE_LIMIT } };

  /** その組織の n8n 製のページ一覧（n8n 側の差分確認用） */
  app.get('/', routeConfig, async (request, reply) =>
    withPageToken(request, reply, { write: false }, async (db) => {
      const rows = await db.customPage.findMany({
        where: { source: 'N8N' },
        select: { slug: true, version: true, status: true, updatedAt: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return reply.send({ success: true, data: rows });
    }),
  );

  /** upsert（slug 単位で冪等。2 回目以降は changed: false） */
  app.put('/:slug', { ...routeConfig, bodyLimit: 64 * 1024 }, async (request, reply) =>
    withPageToken(request, reply, { write: true }, async (db, token) => {
      const slug = slugOf(request.params);
      if (!slug) return sendError(reply, 400, 'VALIDATION_ERROR', 'slug: 英小文字・数字・ハイフン（1〜40 文字）');
      const parsed = pageUpsertSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));

      const result = await upsertPage(db, {
        slug,
        input: parsed.data,
        source: 'N8N',
        plan: await planOf(db),
        actorId: null,
        registrarId: token.tokenId,
      });
      return reply.code(result.created ? 201 : 200).send({
        success: true,
        data: {
          slug: result.slug,
          version: result.version,
          status: result.status,
          changed: result.changed,
          url: `${config.appBaseUrl}/p/${result.slug}`,
        },
      });
    }),
  );

  /** 削除（無ければ 200 { deleted: false }＝冪等） */
  app.delete('/:slug', routeConfig, async (request, reply) =>
    withPageToken(request, reply, { write: true }, async (db, token) => {
      const slug = slugOf(request.params);
      if (!slug) return sendError(reply, 400, 'VALIDATION_ERROR', 'slug: 英小文字・数字・ハイフン（1〜40 文字）');
      const result = await deletePage(db, { slug, source: 'N8N', actorId: null, registrarId: token.tokenId });
      return reply.send({ success: true, data: result });
    }),
  );
}
