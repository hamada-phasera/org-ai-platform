// テナントスコープ付きクライアント `tenantDb(orgId)`（docs/design/multi-tenancy.md §7.1.2）。
//
// ■ 何をするか
//   `db.task.findUnique({ where: { id } })` を `prisma.task.findUnique({ where: { id, orgId } })` に、
//   `db.task.create({ data })` を `data.orgId = orgId` 付きに書き換えて素の Prisma に渡す。
//   書き換えの中身は scope.ts の純粋関数 scopeArgs（ここは配線だけ）。
//
// ■ なぜ Prisma の `$extends` ではなく薄い Proxy にしたか（設計書からの変更点）
//   1. 既存テストは `utils/prisma` を素のオブジェクト（vi.fn の集まり）でモックしている。
//      `$extends` だとモックにも拡張の仕組みが要るが、Proxy なら同じモックがそのまま使える。
//   2. interactive transaction（`$transaction(async (tx) => …)`）の `tx` にも確実に同じスコープを掛けられる
//      （`$extends` が 5.22 で tx に伝わるかは設計書 §15-2 で要確認だった。ここでは自分で包むので問題にならない）。
//   3. リクエストごとに作っても getter を持つ小さなオブジェクト1つで、接続もクライアントも増えない。
//   Phase 2（RLS）で `set_config('app.org_id', …)` を挟むときも、ここ（call の手前）だけを差し替えればよい。
//
// ■ 型
//   テナントモデルと子モデル、それに Organization（id = orgId の1行だけ）だけを見せる。
//   User / BillingEvent は型から外してあるので、`db.user` と書くとコンパイルが通らない。

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { CHILD_MODELS, ORG_ROOT_MODEL, TENANT_MODELS, delegateKey } from './tenant-models';
import { scopeArgs, TenantViolationError } from './scope';

type TenantDelegateKey =
  | 'chatSession'
  | 'task'
  | 'uploadedFile'
  | 'scheduledTask'
  | 'agent'
  | 'project'
  | 'vendor'
  | 'costEntry'
  | 'deal'
  | 'providerConnection'
  | 'channelConnection'
  | 'inboundMessage'
  | 'invitation'
  | 'membership'
  | 'aILog'
  | 'riskEvent'
  | 'fileChunk'
  | 'messageEmbedding'
  | 'capability'
  | 'capabilityGap'
  | 'executionLog'
  | 'auditEvent';
type ChildDelegateKey = 'message' | 'taskLog' | 'requiredCredential';

/** テナントクライアント（トランザクションの中で使う形）。 */
export type TenantTx = Pick<PrismaClient, TenantDelegateKey | ChildDelegateKey | 'organization' | '$queryRaw' | '$executeRaw'> & {
  /** このクライアントが絞っている組織 */
  readonly orgId: string;
};

/** テナントクライアント。 */
export type TenantDb = TenantTx & {
  /** interactive transaction。`tx` にも同じ orgId のスコープが掛かる */
  $transaction<T>(fn: (tx: TenantTx) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
};

/** Prisma の素のクライアント（またはトランザクションの tx）として最低限必要な形。 */
type RawClient = Record<string, unknown>;

function scopedDelegate(base: RawClient, model: string, orgId: string, scoped: boolean): unknown {
  const key = delegateKey(model);
  return new Proxy(
    {},
    {
      get(_t, op) {
        if (typeof op !== 'string') return undefined;
        const delegate = base[key] as Record<string, unknown> | undefined;
        if (!delegate) throw new TenantViolationError(`${model} はこのクライアントにありません`);
        const fn = delegate[op];
        if (typeof fn !== 'function') return fn;
        if (!scoped) return (fn as (...a: unknown[]) => unknown).bind(delegate);
        return (args?: Record<string, unknown>) =>
          (fn as (a: unknown) => unknown).call(delegate, scopeArgs(model, op, args, orgId));
      },
    },
  );
}

function build(base: RawClient, orgId: string): TenantTx {
  if (!orgId) throw new TenantViolationError('orgId が空のテナントクライアントは作れません');
  const client: Record<string, unknown> = {};
  for (const m of TENANT_MODELS) {
    Object.defineProperty(client, delegateKey(m), { get: () => scopedDelegate(base, m, orgId, true), enumerable: true });
  }
  // 子モデルは書き換えない（I2 は呼び出し側の規律。親をこのクライアントで取ってから触る）
  for (const m of CHILD_MODELS) {
    Object.defineProperty(client, delegateKey(m), { get: () => scopedDelegate(base, m, orgId, false), enumerable: true });
  }
  Object.defineProperty(client, delegateKey(ORG_ROOT_MODEL), {
    get: () => scopedDelegate(base, ORG_ROOT_MODEL, orgId, true),
    enumerable: true,
  });
  // raw SQL は書き換えられない。使ってよいファイルはアーキテクチャテストで固定し、
  // どれも "orgId" か "Organization" を条件に含むことを検査している
  for (const k of ['$queryRaw', '$executeRaw'] as const) {
    Object.defineProperty(client, k, {
      get: () => {
        const fn = base[k] as ((...a: unknown[]) => unknown) | undefined;
        return fn ? fn.bind(base) : undefined;
      },
    });
  }
  Object.defineProperty(client, 'orgId', { value: orgId, enumerable: true });
  return client as unknown as TenantTx;
}

/** 素のクライアントを指定して作る（テストと、systemDb の tx から作りたい場合用）。 */
export function tenantDbFrom(base: unknown, orgId: string): TenantDb {
  const raw = base as RawClient;
  const client = build(raw, orgId) as TenantDb;
  Object.defineProperty(client, '$transaction', {
    value: <T>(fn: (tx: TenantTx) => Promise<T>, options?: Record<string, unknown>) => {
      const tx = raw.$transaction as (f: (t: RawClient) => Promise<T>, o?: unknown) => Promise<T>;
      return tx.call(raw, (rawTx: RawClient) => fn(build(rawTx, orgId)), options);
    },
  });
  return client;
}

/** orgId で絞ったクライアント。ルートは `request.tenant.db`（= これ）だけを使う。 */
export function tenantDb(orgId: string): TenantDb {
  return tenantDbFrom(prisma, orgId);
}
