// テナントコンテキスト（docs/design/multi-tenancy.md §7.1.1）。
//
// ■ 使い分け
//   * ハンドラは `tenantOf(request)`（= request.tenant）を**明示的に**使う。
//     暗黙の ALS が空のときに素通りする事故を避けるため、DB への経路は引数で渡す。
//   * AsyncLocalStorage は横断的な関心事にだけ使う:
//       - aiEngineHeaders() が X-Org-Id を付ける
//       - リクエストの外で続く処理（void runAgentTask(...) など）に org を引き継ぐ
//       - ログに orgId を載せる
//   * システム経路（スケジューラ・webhook・回収）は org が決まった時点で runAsTenant で包む。

import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserRole } from '@org-ai/shared-types';
import { tenantDb, type TenantDb } from './tenant-db';
import { TenantViolationError } from './scope';

export type TenantSource =
  | 'http'
  | 'line-webhook'
  | 'stripe-webhook'
  | 'n8n-callback'
  | 'scheduler'
  | 'recovery';

export interface TenantContext {
  orgId: string;
  /** システム経路では null */
  userId: string | null;
  /** Membership.role（システム経路では null）。**権限判定はこれだけを使う** */
  role: UserRole | null;
  source: TenantSource;
  /** tenantDb(orgId) */
  db: TenantDb;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireAuth が組み立てる。認証の無いルートでは null */
    tenant: TenantContext | null;
  }
}

/** リクエスト（またはジョブ）ごとの入れ物。requireAuth が後から tenant を埋める。 */
interface Slot {
  tenant?: TenantContext;
}
const als = new AsyncLocalStorage<Slot>();

export function makeTenantContext(ctx: Omit<TenantContext, 'db'> & { db?: TenantDb }): TenantContext {
  return { ...ctx, db: ctx.db ?? tenantDb(ctx.orgId) };
}

/** org を決めた処理を包む。中で起動した非同期処理（Promise の継続）にも同じ org が伝わる。 */
export function runAsTenant<T>(ctx: Omit<TenantContext, 'db'> & { db?: TenantDb }, fn: () => Promise<T>): Promise<T> {
  return als.run({ tenant: makeTenantContext(ctx) }, fn);
}

/** 現在のテナント（ALS）。コンテキストの外なら undefined。 */
export function currentTenant(): TenantContext | undefined {
  return als.getStore()?.tenant;
}

/**
 * requireAuth の中から、以降のハンドラ（と、そこから起動される処理）にコンテキストを載せる。
 * 入れ物は registerTenantContext の onRequest フックがリクエストごとに作る。
 * 入れ物が無い（フックを付けていないテスト用の app など）ときは何もしない＝他のリクエストに漏らさない。
 */
export function enterTenant(ctx: TenantContext): void {
  const slot = als.getStore();
  if (slot) slot.tenant = ctx;
}

const kResource = Symbol('flowTenantResource');

/**
 * Fastify にテナントコンテキストを配線する（index.ts でルートより先に呼ぶ）。
 *
 *   onRequest     … リクエストごとに空の入れ物で ALS を開始する
 *   preValidation … 本文の読み取り（stream のイベント）で ALS が外れるので、ここで入れ物の文脈に戻す
 *                   （@fastify/request-context と同じ手当て）
 *
 * これで preHandler（requireAuth）が入れた tenant が、ハンドラとそこから起動した非同期処理に伝わる。
 */
export function registerTenantContext(app: FastifyInstance): void {
  app.decorateRequest('tenant', null);
  app.addHook('onRequest', (request, _reply, done) => {
    als.run({}, () => {
      (request as unknown as Record<symbol, AsyncResource>)[kResource] = new AsyncResource('flow-tenant');
      done();
    });
  });
  app.addHook('preValidation', (request, _reply, done) => {
    const res = (request as unknown as Record<symbol, AsyncResource | undefined>)[kResource];
    if (res) res.runInAsyncScope(done, request.raw);
    else done();
  });
}

/**
 * ハンドラ用。requireAuth を通ったリクエストのテナントを返す。
 * 無ければ（preHandler の付け忘れ）例外 = 500。黙って別の経路に落ちないようにする。
 */
export function tenantOf(request: FastifyRequest): TenantContext {
  const t = (request as { tenant?: TenantContext | null }).tenant;
  if (!t) throw new TenantViolationError('テナントが解決されていません（requireAuth が付いていない？）');
  return t;
}

/** ハンドラで使う「誰が・どの組織として・どのクライアントで」。request.user の型キャストの置き換え。 */
export interface RequestAuth {
  orgId: string;
  /** User.id */
  sub: string;
  /** Membership.role（判定に使ってよいのはこれだけ） */
  role: UserRole | null;
  /** JWT の email（ADMIN_EMAILS の判定に使う。本人が名乗った値ではなく、発行時に DB から入れた値） */
  email: string | undefined;
  db: TenantDb;
}

/** requireAuth を通ったリクエストの認証情報。tenantOf と同じく、無ければ例外。 */
export function authOf(request: FastifyRequest): RequestAuth {
  const t = tenantOf(request);
  const jwt = (request.user ?? {}) as { email?: string };
  return { orgId: t.orgId, sub: t.userId ?? '', role: t.role, email: jwt.email, db: t.db };
}
