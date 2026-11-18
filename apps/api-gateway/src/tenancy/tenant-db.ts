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
// ■ RLS Phase 2a（`RLS_MODE=on`。docs/design/multi-tenancy.md §RLS Phase 2a）
//   RLS_MODELS（AILog / RiskEvent / FileChunk / MessageEmbedding）の操作と raw SQL を、
//   `set_config('app.org_id', orgId, true)` と同じトランザクションで流す。is_local=true なので値はコミットで消え、
//   プールの接続に残らない（SET は使わない）。包み方はクライアントの種類で 3 通り:
//     top      … 素のクライアント。`$transaction([set_config, 本体])`（batch transaction。往復は BEGIN/set/本体/COMMIT）
//     tx-set   … このファイルの `$transaction(fn)` の中。開始直後に 1 回だけ set_config 済みなので何もしない
//     tx-bare  … 外から渡された interactive transaction の tx（tenantDbFrom(tx, orgId)）。本体の直前に set_config を流す
//   それ以外の表は包まない（2a ではポリシーが flow_app への素通しなので、往復を増やさない）。
//   off（既定）のときは今までと 1 バイトも変わらない。
//
// ■ 型
//   テナントモデルと子モデル、それに Organization（id = orgId の1行だけ）だけを見せる。
//   User / BillingEvent は型から外してあるので、`db.user` と書くとコンパイルが通らない。

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { config } from '../config/env';
import { CHILD_MODELS, ORG_ROOT_MODEL, RLS_MODELS, TENANT_MODELS, delegateKey } from './tenant-models';
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
  | 'auditEvent'
  | 'customPage'
  | 'pageToken'
  | 'pageActionLog';
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

/** RLS の包み方（上の説明を参照） */
type RlsKind = 'top' | 'tx-set' | 'tx-bare';

const RLS_SET: ReadonlySet<string> = new Set(RLS_MODELS);

/** `SELECT set_config('app.org_id', orgId, true)`（Prisma の遅延クエリのまま返す） */
export function setOrgQuery(base: RawClient, orgId: string): unknown {
  const q = base.$queryRaw as (sql: Prisma.Sql) => unknown;
  return q.call(base, Prisma.sql`SELECT set_config('app.org_id', ${orgId}, true)`);
}

/** 本体のクエリ（遅延）を、組織を設定したトランザクションの中で流す */
function runWithOrg(base: RawClient, kind: RlsKind, orgId: string, query: () => unknown): unknown {
  if (kind === 'tx-set' || config.rlsMode !== 'on') return query();
  if (kind === 'tx-bare') {
    return (async () => {
      await setOrgQuery(base, orgId);
      return query();
    })();
  }
  const batch = base.$transaction as (qs: unknown[]) => Promise<unknown[]>;
  return batch.call(base, [setOrgQuery(base, orgId), query()]).then((r) => r[1]);
}

function scopedDelegate(base: RawClient, model: string, orgId: string, scoped: boolean, kind: RlsKind): unknown {
  const key = delegateKey(model);
  const rls = RLS_SET.has(model);
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
        const call = (args?: Record<string, unknown>) =>
          (fn as (a: unknown) => unknown).call(delegate, scopeArgs(model, op, args, orgId));
        if (!rls) return call;
        return (args?: Record<string, unknown>) => runWithOrg(base, kind, orgId, () => call(args));
      },
    },
  );
}

function build(base: RawClient, orgId: string, kind: RlsKind): TenantTx {
  if (!orgId) throw new TenantViolationError('orgId が空のテナントクライアントは作れません');
  const client: Record<string, unknown> = {};
  for (const m of TENANT_MODELS) {
    Object.defineProperty(client, delegateKey(m), { get: () => scopedDelegate(base, m, orgId, true, kind), enumerable: true });
  }
  // 子モデルは書き換えない（I2 は呼び出し側の規律。親をこのクライアントで取ってから触る）
  for (const m of CHILD_MODELS) {
    Object.defineProperty(client, delegateKey(m), { get: () => scopedDelegate(base, m, orgId, false, kind), enumerable: true });
  }
  Object.defineProperty(client, delegateKey(ORG_ROOT_MODEL), {
    get: () => scopedDelegate(base, ORG_ROOT_MODEL, orgId, true, kind),
    enumerable: true,
  });
  // raw SQL は書き換えられない。使ってよいファイルはアーキテクチャテストで固定し、
  // どれも "orgId" か "Organization" を条件に含むことを検査している。
  // RLS_MODE=on では、どの表を触るかを読まずに全部 set_config と同じトランザクションに入れる
  for (const k of ['$queryRaw', '$executeRaw'] as const) {
    Object.defineProperty(client, k, {
      get: () => {
        const fn = base[k] as ((...a: unknown[]) => unknown) | undefined;
        if (!fn) return undefined;
        return (...a: unknown[]) => runWithOrg(base, kind, orgId, () => fn.apply(base, a));
      },
    });
  }
  Object.defineProperty(client, 'orgId', { value: orgId, enumerable: true });
  return client as unknown as TenantTx;
}

/** 素のクライアントを指定して作る（テストと、systemDb の tx から作りたい場合用）。 */
export function tenantDbFrom(base: unknown, orgId: string): TenantDb {
  const raw = base as RawClient;
  // $transaction を持たない＝interactive transaction の tx を渡された
  const kind: RlsKind = typeof raw.$transaction === 'function' ? 'top' : 'tx-bare';
  const client = build(raw, orgId, kind) as TenantDb;
  Object.defineProperty(client, '$transaction', {
    value: <T>(fn: (tx: TenantTx) => Promise<T>, options?: Record<string, unknown>) => {
      const tx = raw.$transaction as (f: (t: RawClient) => Promise<T>, o?: unknown) => Promise<T>;
      return tx.call(
        raw,
        async (rawTx: RawClient) => {
          // 開始直後に 1 回だけ。以後この tx の中の操作は包まない（同じ接続・同じトランザクション）
          if (config.rlsMode === 'on') await setOrgQuery(rawTx, orgId);
          return fn(build(rawTx, orgId, 'tx-set'));
        },
        options,
      );
    },
  });
  return client;
}

/** orgId で絞ったクライアント。ルートは `request.tenant.db`（= これ）だけを使う。 */
export function tenantDb(orgId: string): TenantDb {
  return tenantDbFrom(prisma, orgId);
}
