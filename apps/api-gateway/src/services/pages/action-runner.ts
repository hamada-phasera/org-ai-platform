// 業務ページのアクション実行（docs/design/custom-pages.md §5.2）。
//
// 順番は固定（途中で落ちたら n8n には届かない）:
//   1 認証・組織 / 2 契約 … ルートの requireAuth（submit は POST なので「閲覧のみ」は 402）
//   3 ページ解決 … tenantDb の (orgId, slug)、見え方、actionId が定義にあり種類が合う。満たさなければ 404
//   4 レート制限 … IP ごとはルートの config.rateLimit。組織ごとは org-throttle（429 RATE_LIMITED）
//   5 プラン上限 … submit だけ。当月の PageActionLog の件数（429 PAGE_ACTION_LIMIT）
//   6 入力検証 … buildInputSchema（.strict()）。body はルートの bodyLimit（定義が許す最大の入力が収まる 96KB）まで
//   7 二重送信 … PageActionLog を requestId で先に作る（unique 違反は 409 DUPLICATE_REQUEST）
//   8 接続判定 … サンプルモード → sampleData／n8n 未設定 → 503 PAGE_NOT_CONNECTED
//   9 n8n 呼び出し … URL は `${n8nUrl}/webhook/pages/<orgId>/<hook>` だけ（K2）。リダイレクトは追わない
//  10 応答検証 … query は projectQueryResult、submit は pageSubmitResponseSchema
//  11 記録 … submit の PageActionLog を確定。ログに入力値・応答本文は出さない（T15）
//
// フォールバックはしない（K8）。n8n が無ければ「未接続」を正直に返す。

import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  PAGE_ACTION_ID_PATTERN,
  PAGE_SLUG_PATTERN,
  buildInputSchema,
  pageDefinitionSchema,
  pageSubmitResponseSchema,
  projectQueryResult,
  type PageAction,
  type PageDefinition,
  type ProjectedQueryResult,
  type UserRole,
} from '@org-ai/shared-types';
import { config } from '../../config/env';
import type { TenantDb } from '../../tenancy/tenant-db';
import { createLogger } from '../../utils/logger';
import { orgEntitlement } from '../org-entitlement';
import { canViewPage, pageUsageOf, planOf } from './access';
import { describeIssues } from './upsert';
import { takeOrgActionSlot, type PageActionKind } from './org-throttle';
import { SAMPLE_SUBMIT_MESSAGE, isSamplePage, sampleQueryResponse } from './sample';

const log = createLogger('pages');

/** n8n の応答の上限（T8） */
export const PAGE_RESPONSE_MAX_BYTES = 256 * 1024;
/**
 * submit の body の上限（ルートの bodyLimit。§5.2 の 6・K50）。
 * 定義が許す最大の入力（textarea 2000 字 × 12 項目、UTF-8 で 1 字 3 バイト＝約 70KB）に項目名と外枠を足しても収まる値。
 * 定義どおりの正しい入力が 413 にならないことをテストで固定している（page-actions.route.test.ts）。
 */
export const PAGE_SUBMIT_BODY_LIMIT = 96 * 1024;

export type ActionOutcome<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } => ({
  ok: false,
  status,
  code,
  message,
});

const NOT_FOUND = () => fail(404, 'NOT_FOUND', 'ページが見つかりません');
const RATE_LIMITED = () => fail(429, 'RATE_LIMITED', 'リクエストが多すぎます。しばらく待ってからもう一度お試しください。');
const NOT_CONNECTED = () => fail(503, 'PAGE_NOT_CONNECTED', 'このページの連携先（n8n）が未接続です。');
const UPSTREAM_FAILED = () =>
  fail(502, 'PAGE_UPSTREAM_FAILED', '連携先から応答がありませんでした。しばらくしてからもう一度お試しください。');
const UPSTREAM_TIMEOUT = () => fail(504, 'PAGE_UPSTREAM_TIMEOUT', '連携先の応答が時間内に返りませんでした。');
const INVALID_RESPONSE = () => fail(502, 'PAGE_INVALID_RESPONSE', '連携先の応答が定義と合いません。');

// ── n8n の呼び出し ─────────────────────────────────────────

/**
 * 呼び出す URL。ベースは環境変数だけ、定義から入るのは hook（英小文字・数字・ハイフン）だけ（K2・T2・T3）。
 * hook はスキーマで縛っているが、ここでももう一度確かめる（壊れた行で別のパスに届かないように）。
 */
export function buildPageHookUrl(baseUrl: string, orgId: string, hook: string): string {
  if (!PAGE_SLUG_PATTERN.test(hook)) throw new Error('invalid page hook');
  if (!orgId) throw new Error('orgId is required');
  return `${baseUrl.replace(/\/+$/, '')}/webhook/pages/${encodeURIComponent(orgId)}/${hook}`;
}

export type HookFailure = 'FAILED' | 'TIMEOUT' | 'INVALID_RESPONSE';
export type HookResult = { ok: true; json: unknown; durationMs: number } | { ok: false; reason: HookFailure; durationMs: number };

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

class ResponseTooLarge extends Error {}

/** Content-Type が JSON で、256KB 以内なら JSON を返す。それ以外は null（読むのをやめる） */
async function readJsonLimited(res: Response, maxBytes: number): Promise<{ value: unknown } | null> {
  const type = (res.headers.get('content-type') ?? '').trim().toLowerCase();
  const declared = Number(res.headers.get('content-length'));
  if (!/^application\/json(\s*;|$)/.test(type) || (Number.isFinite(declared) && declared > maxBytes) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLarge();
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof ResponseTooLarge) return null;
    throw e;
  }
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

export interface CallPageHookArgs {
  url: string;
  body: unknown;
  /** query は接続エラーのときだけ 1 回やり直す。submit はやり直さない（二重実行を避ける） */
  retryOnConnectionError: boolean;
  timeoutMs?: number;
}

/** n8n の Webhook を 1 回（query は接続エラー時にもう 1 回）叩く。失敗の理由だけを返し、本文は返さない */
export async function callPageHook(args: CallPageHookArgs): Promise<HookResult> {
  const started = Date.now();
  const timeoutMs = args.timeoutMs ?? config.pageActionTimeoutMs;
  const attempts = args.retryOnConnectionError ? 2 : 1;
  const done = (r: { ok: true; json: unknown } | { ok: false; reason: HookFailure }): HookResult => ({
    ...r,
    durationMs: Date.now() - started,
  });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      res = await fetch(args.url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-org-ai-token': config.n8nWebhookAuthToken },
        body: JSON.stringify(args.body),
      });
    } catch (e) {
      if (isTimeout(e)) return done({ ok: false, reason: 'TIMEOUT' });
      if (attempt < attempts) continue; // 接続エラー（とリダイレクト）だけやり直す
      return done({ ok: false, reason: 'FAILED' });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return done({ ok: false, reason: 'FAILED' });
    }
    try {
      const parsed = await readJsonLimited(res, PAGE_RESPONSE_MAX_BYTES);
      return parsed ? done({ ok: true, json: parsed.value }) : done({ ok: false, reason: 'INVALID_RESPONSE' });
    } catch (e) {
      return done({ ok: false, reason: isTimeout(e) ? 'TIMEOUT' : 'FAILED' });
    }
  }
  return done({ ok: false, reason: 'FAILED' });
}

function hookFailureOutcome(reason: HookFailure): { ok: false; status: number; code: string; message: string } {
  if (reason === 'TIMEOUT') return UPSTREAM_TIMEOUT();
  if (reason === 'INVALID_RESPONSE') return INVALID_RESPONSE();
  return UPSTREAM_FAILED();
}

// ── 3. ページ解決 ───────────────────────────────────────────

export interface PageActionContext {
  db: TenantDb;
  userId: string;
  role: UserRole | null;
  slug: string;
  actionId: string;
}

interface ResolvedAction {
  page: { id: string; slug: string; version: number; sampleData: unknown };
  definition: PageDefinition;
  /** n8n の hook を持つアクションだけ（flow_query / flow_submit は業務フローの結果ページの経路。canvas-home.md §6.3） */
  action: Extract<PageAction, { kind: 'query' | 'submit' }>;
}

async function resolveAction(ctx: PageActionContext, kind: PageActionKind): Promise<ActionOutcome<ResolvedAction>> {
  if (!PAGE_SLUG_PATTERN.test(ctx.slug) || !PAGE_ACTION_ID_PATTERN.test(ctx.actionId)) return NOT_FOUND();
  const page = await ctx.db.customPage.findUnique({
    where: { orgId_slug: { orgId: ctx.db.orgId, slug: ctx.slug } },
    select: { id: true, slug: true, status: true, minRole: true, version: true, definition: true, sampleData: true },
  });
  if (!page || !canViewPage(page, ctx.role)) return NOT_FOUND();
  const def = pageDefinitionSchema.safeParse(page.definition);
  if (!def.success) {
    log.warn(`保存済みの定義がスキーマに合いません slug=${ctx.slug} version=${page.version}`);
    return fail(500, 'PAGE_INVALID_DEFINITION', 'ページの定義が壊れています。管理者に再登録を依頼してください。');
  }
  const actions = def.data.actions;
  const action = Object.prototype.hasOwnProperty.call(actions, ctx.actionId) ? actions[ctx.actionId] : undefined;
  // flow_* はここでは扱わない（hook が無い＝n8n に送らない）
  if (!action || (action.kind !== 'query' && action.kind !== 'submit') || action.kind !== kind) return NOT_FOUND();
  return {
    ok: true,
    data: { page: { id: page.id, slug: page.slug, version: page.version, sampleData: page.sampleData }, definition: def.data, action },
  };
}

/**
 * n8n へ送る本文。メールアドレス・氏名は送らない（T15）。
 * readOnly は「閲覧のみ」（解約・トライアル切れ）の組織か。query は閲覧のみでも通す（K6）ので、
 * ワークフロー側はこれが true のとき LLM や外部への送信をせず、保存済みのデータを返すだけにする（構築規約 §9・K50）。
 * submit は requireAuth が 402 で止めるので常に false。
 */
function hookBody(
  ctx: PageActionContext,
  kind: PageActionKind,
  plan: string,
  input: Record<string, unknown>,
  requestId: string,
  readOnly: boolean,
): Record<string, unknown> {
  return {
    orgId: ctx.db.orgId,
    page: ctx.slug,
    action: ctx.actionId,
    kind,
    input,
    actor: { userId: ctx.userId, role: ctx.role },
    plan,
    requestId,
    readOnly,
    aiEngineUrl: config.aiEngineUrl,
  };
}

// ── query ──────────────────────────────────────────────────

export type PageQueryData = ProjectedQueryResult & { sample: boolean };

export async function runPageQuery(ctx: PageActionContext): Promise<ActionOutcome<PageQueryData>> {
  const resolved = await resolveAction(ctx, 'query');
  if (!resolved.ok) return resolved;
  const { page, definition, action } = resolved.data;

  if (!takeOrgActionSlot(ctx.db.orgId, 'query')) return RATE_LIMITED();

  if (isSamplePage(page)) {
    return { ok: true, data: { ...projectQueryResult(definition, ctx.actionId, sampleQueryResponse(page, ctx.actionId)), sample: true } };
  }
  if (!config.n8nConfigured) return NOT_CONNECTED();

  const plan = await planOf(ctx.db);
  const readOnly = (await orgEntitlement(ctx.db)).access === 'read_only';
  const result = await callPageHook({
    url: buildPageHookUrl(config.n8nUrl, ctx.db.orgId, action.hook),
    body: hookBody(ctx, 'query', plan, {}, randomUUID(), readOnly),
    retryOnConnectionError: true,
  });
  if (!result.ok) {
    log.warn(`業務ページの取得に失敗 org=${ctx.db.orgId} slug=${ctx.slug} action=${ctx.actionId} reason=${result.reason} ms=${result.durationMs}`);
    return hookFailureOutcome(result.reason);
  }
  const projected = projectQueryResult(definition, ctx.actionId, result.json);
  if (projected.blocks.some((b) => 'error' in b)) {
    log.warn(`業務ページの応答が定義と合いません org=${ctx.db.orgId} slug=${ctx.slug} action=${ctx.actionId}`);
  }
  return { ok: true, data: { ...projected, sample: false } };
}

// ── submit ─────────────────────────────────────────────────

export const pageSubmitBodySchema = z
  .object({
    input: z.record(z.unknown()).default({}),
    requestId: z.string().uuid(),
    origin: z
      .object({
        blockIndex: z.number().int().min(0).max(99),
        itemIndex: z.number().int().min(0).max(99).optional(),
      })
      .strict(),
  })
  .strict();

export interface PageSubmitData {
  ok: boolean;
  message?: string;
  sample: boolean;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

export async function runPageSubmit(ctx: PageActionContext & { body: unknown }): Promise<ActionOutcome<PageSubmitData>> {
  // 3
  const resolved = await resolveAction(ctx, 'submit');
  if (!resolved.ok) return resolved;
  const { page, definition, action } = resolved.data;

  // 4
  if (!takeOrgActionSlot(ctx.db.orgId, 'submit')) return RATE_LIMITED();

  // 5
  const plan = await planOf(ctx.db);
  const usage = await pageUsageOf(ctx.db, plan);
  if (usage.blocked) {
    return fail(429, 'PAGE_ACTION_LIMIT', `今月の実行回数の上限（${usage.limit.toLocaleString('ja-JP')} 回）に達しました。来月 1 日（日本時間 9 時）に戻ります。`);
  }

  // 6
  const body = pageSubmitBodySchema.safeParse(ctx.body ?? {});
  if (!body.success) return fail(400, 'VALIDATION_ERROR', describeIssues(body.error.issues));
  const inputSchema = buildInputSchema(definition, ctx.actionId, body.data.origin);
  if (!inputSchema) return fail(400, 'VALIDATION_ERROR', '送信元の部品がこの操作と合いません');
  const input = inputSchema.safeParse(body.data.input);
  if (!input.success) return fail(400, 'VALIDATION_ERROR', describeIssues(input.error.issues));
  const values = input.data as Record<string, unknown>;

  // 8（サンプル）: n8n を呼ばず、記録も数えもしない
  const sample = isSamplePage(page);
  if (sample) return { ok: true, data: { ok: true, message: SAMPLE_SUBMIT_MESSAGE, sample: true } };

  // 7
  let logId: string;
  try {
    const row = await ctx.db.pageActionLog.create({
      data: {
        orgId: ctx.db.orgId,
        pageId: page.id,
        slug: page.slug,
        actionId: ctx.actionId,
        pageVersion: page.version,
        actorId: ctx.userId,
        requestId: body.data.requestId,
        status: 'PENDING',
        inputKeys: Object.keys(values),
      },
      select: { id: true },
    });
    logId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return fail(409, 'DUPLICATE_REQUEST', 'この送信はすでに受け付けています');
    throw e;
  }

  // 8（未接続）: n8n に届いていないので数えない（記録を消す）
  if (!config.n8nConfigured) {
    await ctx.db.pageActionLog.deleteMany({ where: { id: logId } });
    return NOT_CONNECTED();
  }

  // 9〜11: 記録を PENDING のまま残さない（DB の一時的な失敗などで途中で例外が出たら FAILED で確定する。L2）
  const started = Date.now();
  let finalized = false;
  try {
    // 9
    const result = await callPageHook({
      url: buildPageHookUrl(config.n8nUrl, ctx.db.orgId, action.hook),
      body: hookBody(ctx, 'submit', plan, values, body.data.requestId, false),
      retryOnConnectionError: false,
    });

    // 10
    let outcome: ActionOutcome<PageSubmitData>;
    let status: 'OK' | 'FAILED' | 'TIMEOUT' | 'INVALID_RESPONSE';
    if (!result.ok) {
      status = result.reason;
      outcome = hookFailureOutcome(result.reason);
    } else {
      const parsed = pageSubmitResponseSchema.safeParse(result.json);
      if (!parsed.success) {
        status = 'INVALID_RESPONSE';
        outcome = INVALID_RESPONSE();
      } else {
        // n8n が { ok: false } と返したときは業務上の失敗。記録は FAILED、利用者には n8n の文言を返す
        status = parsed.data.ok ? 'OK' : 'FAILED';
        outcome = { ok: true, data: { ok: parsed.data.ok, ...(parsed.data.message ? { message: parsed.data.message } : {}), sample: false } };
      }
    }

    // 11
    await ctx.db.pageActionLog.updateMany({ where: { id: logId }, data: { status, durationMs: result.durationMs } });
    finalized = true;
    if (status !== 'OK') {
      log.warn(`業務ページの送信が失敗 org=${ctx.db.orgId} slug=${ctx.slug} action=${ctx.actionId} status=${status} ms=${result.durationMs}`);
    }
    return outcome;
  } finally {
    if (!finalized) {
      // n8n に届いたかどうかは分からない。件数には数えたまま（K35）、状態だけ FAILED で確定する
      log.warn(`業務ページの送信の記録を確定できませんでした org=${ctx.db.orgId} slug=${ctx.slug} action=${ctx.actionId} log=${logId}`);
      await ctx.db.pageActionLog
        .updateMany({ where: { id: logId, status: 'PENDING' }, data: { status: 'FAILED', durationMs: Date.now() - started } })
        .catch(() => undefined);
    }
  }
}
