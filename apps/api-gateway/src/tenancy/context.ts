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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
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

const als = new AsyncLocalStorage<TenantContext>();

export function makeTenantContext(ctx: Omit<TenantContext, 'db'> & { db?: TenantDb }): TenantContext {
  return { ...ctx, db: ctx.db ?? tenantDb(ctx.orgId) };
}

/** org を決めた処理を包む。中で起動した非同期処理（Promise の継続）にも同じ org が伝わる。 */
export function runAsTenant<T>(ctx: Omit<TenantContext, 'db'> & { db?: TenantDb }, fn: () => Promise<T>): Promise<T> {
  return als.run(makeTenantContext(ctx), fn);
}

/** 現在のテナント（ALS）。コンテキストの外なら undefined。 */
export function currentTenant(): TenantContext | undefined {
  return als.getStore();
}

/** requireAuth の中から、以降のハンドラ（と、そこから起動される処理）にコンテキストを載せる。 */
export function enterTenant(ctx: TenantContext): void {
  als.enterWith(ctx);
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
