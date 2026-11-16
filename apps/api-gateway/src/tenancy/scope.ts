// テナントクライアントの中身: Prisma の引数に orgId を差し込む純粋関数。
// DB 無しでテストできるよう、Prisma 本体から切り離してある（§11.1）。

import { ORG_ROOT_MODEL, isTenantModel } from './tenant-models';

/** テナントの境界を越えようとした（プログラムの誤り）。ルートからは 500 として見える。 */
export class TenantViolationError extends Error {
  constructor(message: string) {
    super(`[tenancy] ${message}`);
    this.name = 'TenantViolationError';
  }
}

/** where を条件にする読み取り / 一括操作。where に orgId を AND で足す。 */
const WHERE_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);
/** 一意キーで1行を指す操作。where に orgId を並べる（Prisma 5 の extendedWhereUnique）。 */
const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);
const CREATE_OPS = new Set(['create', 'createMany']);
/** data を持つ更新。data.orgId を拒否する（I1: orgId は作った後に変わらない）。 */
const UPDATE_DATA_OPS = new Set(['update', 'updateMany']);

export const SCOPED_OPERATIONS: ReadonlySet<string> = new Set([
  ...WHERE_OPS,
  ...UNIQUE_OPS,
  ...CREATE_OPS,
  'upsert',
]);

type Args = Record<string, unknown> | undefined;
type Where = Record<string, unknown>;

/**
 * where に「列 = orgId」を足す。
 *
 * 形は `{ ...where, [col]: orgId }`（トップレベルのキーは AND で効くので、
 * `OR: [{ orgId: 'B' }]` のような抜け道を混ぜられても、外側の orgId = A が必ず効く。T7）。
 * 設計書は `{ AND: [where, { orgId }] }` だったが、既存テストが `where.orgId` を見ているのと、
 * Prisma が出す SQL が同じなので、平らに並べる形にした。
 *
 *   * where[col] が無い / 同じ値 → 並べる
 *   * where[col] が別の文字列 → TenantViolationError（他テナントを名指しするのはバグ）
 *   * where[col] がフィルタ（{ in: [...] } など）→ AND で包んで両方を効かせる
 */
function scopeWhere(where: unknown, col: string, orgId: string): Where {
  const w = (where ?? {}) as Where;
  const current = w[col];
  if (current === undefined || current === orgId) return { ...w, [col]: orgId };
  if (typeof current === 'string') {
    throw new TenantViolationError(`別の組織 (${col}=${current}) を指定しています`);
  }
  return { AND: [w, { [col]: orgId }] };
}

/** 複合一意キー（`orgId_name: { orgId, name }` など）の orgId も照合する。 */
function checkCompoundKeys(where: Where, orgId: string): void {
  for (const [k, v] of Object.entries(where)) {
    if (!k.includes('_') || !v || typeof v !== 'object') continue;
    const inner = (v as Record<string, unknown>).orgId;
    if (inner !== undefined && inner !== orgId) {
      throw new TenantViolationError(`別の組織 (${k}.orgId=${String(inner)}) を指定しています`);
    }
  }
}

function scopeCreateData(model: string, data: unknown, orgId: string): Record<string, unknown> {
  const d = { ...((data ?? {}) as Record<string, unknown>) };
  if ('org' in d) {
    // relation 経由（org: { connect }）は検査しきれないので使わせない。scalar の orgId を使う
    throw new TenantViolationError(`${model}.create で org リレーションは使えません（orgId は自動で付きます）`);
  }
  if (d.orgId !== undefined && d.orgId !== orgId) {
    throw new TenantViolationError(`${model} を別の組織 (${String(d.orgId)}) に作ろうとしています`);
  }
  d.orgId = orgId;
  return d;
}

function rejectOrgChange(model: string, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;
  if ('orgId' in d || 'org' in d) {
    throw new TenantViolationError(`${model} の orgId は変更できません（I1）`);
  }
}

/**
 * テナントモデルの引数に orgId を差し込む。テナントモデル以外はそのまま返す。
 * Organization は `id = orgId` で絞る（作成・削除は不可）。
 */
export function scopeArgs(model: string, operation: string, args: Args, orgId: string): Args {
  if (!orgId) throw new TenantViolationError('orgId が空です');

  if (model === ORG_ROOT_MODEL) return scopeOrgRoot(operation, args, orgId);
  if (!isTenantModel(model)) return args;

  if (!SCOPED_OPERATIONS.has(operation)) {
    throw new TenantViolationError(`${model}.${operation} はテナントクライアントでは使えません`);
  }
  const a: Record<string, unknown> = { ...(args ?? {}) };

  if (UPDATE_DATA_OPS.has(operation)) rejectOrgChange(model, a.data);

  if (WHERE_OPS.has(operation)) {
    a.where = scopeWhere(a.where, 'orgId', orgId);
    return a;
  }
  if (UNIQUE_OPS.has(operation)) {
    checkCompoundKeys((a.where ?? {}) as Where, orgId);
    a.where = scopeWhere(a.where, 'orgId', orgId);
    return a;
  }
  if (operation === 'create') {
    a.data = scopeCreateData(model, a.data, orgId);
    return a;
  }
  if (operation === 'createMany') {
    const rows = Array.isArray(a.data) ? a.data : [a.data];
    a.data = rows.map((r) => scopeCreateData(model, r, orgId));
    return a;
  }
  // upsert
  checkCompoundKeys((a.where ?? {}) as Where, orgId);
  rejectOrgChange(model, a.update);
  a.where = scopeWhere(a.where, 'orgId', orgId);
  a.create = scopeCreateData(model, a.create, orgId);
  return a;
}

const ORG_ROOT_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'update']);

function scopeOrgRoot(operation: string, args: Args, orgId: string): Args {
  if (!ORG_ROOT_OPS.has(operation)) {
    throw new TenantViolationError(`Organization.${operation} はテナントクライアントでは使えません`);
  }
  const a: Record<string, unknown> = { ...(args ?? {}) };
  if (operation === 'update') rejectIdChange(a.data);
  a.where = scopeWhere(a.where, 'id', orgId);
  return a;
}

function rejectIdChange(data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;
  if ('id' in d) throw new TenantViolationError('Organization.id は変更できません');
}
