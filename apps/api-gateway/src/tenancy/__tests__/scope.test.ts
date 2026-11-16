import { describe, it, expect } from 'vitest';
import { scopeArgs, TenantViolationError } from '../scope';
import { TENANT_MODELS } from '../tenant-models';

// docs/design/multi-tenancy.md §11.1 T1〜T7

const A = 'org-A';
const WHERE_OPS = ['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'];

describe('T1: where を取る操作には orgId が AND で入る', () => {
  const cases = TENANT_MODELS.flatMap((m) => WHERE_OPS.map((op) => [m, op] as const));
  it.each(cases)('%s.%s', (model, op) => {
    const out = scopeArgs(model, op, { where: { status: 'X' } }, A)!;
    expect(out.where).toEqual({ status: 'X', orgId: A });
  });

  it('where が無くても orgId が付く', () => {
    expect(scopeArgs('Task', 'count', undefined, A)).toEqual({ where: { orgId: A } });
    expect(scopeArgs('Task', 'findMany', {}, A)).toEqual({ where: { orgId: A } });
  });

  it('同じ orgId を書いてあればそのまま', () => {
    expect(scopeArgs('Task', 'findMany', { where: { orgId: A } }, A)!.where).toEqual({ orgId: A });
  });

  it('orgId のフィルタ（in など）は AND で包んで両方効かせる', () => {
    const out = scopeArgs('Task', 'findMany', { where: { orgId: { in: [A, 'org-B'] } } }, A)!;
    expect(out.where).toEqual({ AND: [{ orgId: { in: [A, 'org-B'] } }, { orgId: A }] });
  });

  it('⚠️ 別の orgId を名指しするのはバグとして止める', () => {
    expect(() => scopeArgs('Task', 'findMany', { where: { orgId: 'org-B' } }, A)).toThrow(TenantViolationError);
  });
});

describe('T2: 一意キーの操作は { id, orgId } になる', () => {
  it.each(['findUnique', 'findUniqueOrThrow', 'update', 'delete'])('%s', (op) => {
    const out = scopeArgs('Task', op, { where: { id: 't-1' }, ...(op === 'update' ? { data: { title: 'x' } } : {}) }, A)!;
    expect(out.where).toEqual({ id: 't-1', orgId: A });
  });

  it('複合一意キーの orgId が別組織なら止める', () => {
    expect(() =>
      scopeArgs('Capability', 'findUnique', { where: { orgId_name: { orgId: 'org-B', name: 'x' } } }, A),
    ).toThrow(TenantViolationError);
    const ok = scopeArgs('Capability', 'findUnique', { where: { orgId_name: { orgId: A, name: 'x' } } }, A)!;
    expect(ok.where).toEqual({ orgId_name: { orgId: A, name: 'x' }, orgId: A });
  });
});

describe('T3/T4: create', () => {
  it('T4: orgId を省けば付ける', () => {
    expect(scopeArgs('Task', 'create', { data: { title: 'x' } }, A)!.data).toEqual({ title: 'x', orgId: A });
  });
  it('T3: 別の orgId なら TenantViolationError', () => {
    expect(() => scopeArgs('Task', 'create', { data: { orgId: 'org-B' } }, A)).toThrow(TenantViolationError);
  });
  it('org リレーション経由（connect）は使わせない', () => {
    expect(() => scopeArgs('Task', 'create', { data: { org: { connect: { id: 'org-B' } } } }, A)).toThrow(
      TenantViolationError,
    );
  });
  it('createMany は各行に付ける / 別組織の行が1つでもあれば止める', () => {
    const out = scopeArgs('FileChunk', 'createMany', { data: [{ c: 1 }, { c: 2, orgId: A }] }, A)!;
    expect(out.data).toEqual([{ c: 1, orgId: A }, { c: 2, orgId: A }]);
    expect(() => scopeArgs('FileChunk', 'createMany', { data: [{ c: 1 }, { orgId: 'org-B' }] }, A)).toThrow();
  });
  it('呼び出し元の引数は書き換えない（新しいオブジェクトを返す）', () => {
    const data = { title: 'x' };
    scopeArgs('Task', 'create', { data }, A);
    expect(data).toEqual({ title: 'x' });
  });
});

describe('T5: orgId は変えられない（I1）', () => {
  it.each(['update', 'updateMany'])('%s の data.orgId は拒否', (op) => {
    expect(() => scopeArgs('Task', op, { where: { id: 't' }, data: { orgId: A } }, A)).toThrow(TenantViolationError);
  });
  it('upsert の update.orgId も拒否', () => {
    expect(() =>
      scopeArgs('Task', 'upsert', { where: { id: 't' }, create: {}, update: { orgId: 'org-B' } }, A),
    ).toThrow(TenantViolationError);
  });
});

describe('T6: upsert', () => {
  it('where と create の両方に orgId が付く', () => {
    const out = scopeArgs(
      'ProviderConnection',
      'upsert',
      { where: { orgId_provider: { orgId: A, provider: 'slack' } }, create: { provider: 'slack' }, update: { x: 1 } },
      A,
    )!;
    expect(out.where).toEqual({ orgId_provider: { orgId: A, provider: 'slack' }, orgId: A });
    expect(out.create).toEqual({ provider: 'slack', orgId: A });
    expect(out.update).toEqual({ x: 1 });
  });
});

describe('T7: OR などの抜け道', () => {
  it('OR に別組織を混ぜても、外側の orgId = A が必ず効く', () => {
    const out = scopeArgs('Task', 'findMany', { where: { OR: [{ orgId: 'org-B' }, { id: 'x' }] } }, A)!;
    expect(out.where).toEqual({ OR: [{ orgId: 'org-B' }, { id: 'x' }], orgId: A });
  });
  it('NOT に orgId を入れても同じ', () => {
    const out = scopeArgs('Task', 'deleteMany', { where: { NOT: { orgId: A } } }, A)!;
    expect(out.where).toEqual({ NOT: { orgId: A }, orgId: A });
  });
});

describe('Organization（テナントそのもの）', () => {
  it('id = orgId の1行だけ', () => {
    expect(scopeArgs('Organization', 'findUnique', { where: { id: A } }, A)!.where).toEqual({ id: A });
    expect(scopeArgs('Organization', 'findFirst', {}, A)!.where).toEqual({ id: A });
  });
  it('別の組織を名指しすると止める', () => {
    expect(() => scopeArgs('Organization', 'findUnique', { where: { id: 'org-B' } }, A)).toThrow(TenantViolationError);
    expect(() => scopeArgs('Organization', 'update', { where: { id: 'org-B' }, data: {} }, A)).toThrow();
  });
  it.each(['create', 'delete', 'deleteMany', 'updateMany', 'upsert', 'findMany'])('%s は使えない', (op) => {
    expect(() => scopeArgs('Organization', op, {}, A)).toThrow(TenantViolationError);
  });
});

describe('そのほか', () => {
  it('テナントモデル以外（子モデル）は書き換えない', () => {
    const args = { where: { sessionId: 's' } };
    expect(scopeArgs('Message', 'findMany', args, A)).toBe(args);
  });
  it('orgId が空なら作らせない', () => {
    expect(() => scopeArgs('Task', 'findMany', {}, '')).toThrow(TenantViolationError);
  });
  it('未知の操作は通さない（fail-closed）', () => {
    expect(() => scopeArgs('Task', 'findRaw', {}, A)).toThrow(TenantViolationError);
  });
});
