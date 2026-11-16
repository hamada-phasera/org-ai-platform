import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/prisma', () => ({ prisma: {} }));

const { tenantDbFrom, TenantViolationError, runAsTenant, currentTenant, tenantOf } = await import('../index');

function fakeClient() {
  const c = {
    task: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async (a: unknown) => a) },
    taskLog: { create: vi.fn(async () => ({})) },
    organization: { findUnique: vi.fn(async () => ({ id: 'org-A' })) },
    user: { findMany: vi.fn() },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(c)),
  };
  return c;
}

describe('tenantDbFrom', () => {
  it('テナントモデルの呼び出しに orgId を差し込んで素のクライアントに渡す', async () => {
    const raw = fakeClient();
    const db = tenantDbFrom(raw, 'org-A');
    await db.task.findUnique({ where: { id: 't-1' } });
    expect(raw.task.findUnique).toHaveBeenCalledWith({ where: { id: 't-1', orgId: 'org-A' } });
    await db.task.findMany();
    expect(raw.task.findMany).toHaveBeenCalledWith({ where: { orgId: 'org-A' } });
  });

  it('子モデルは書き換えずに渡す', async () => {
    const raw = fakeClient();
    const db = tenantDbFrom(raw, 'org-A');
    await db.taskLog.create({ data: { taskId: 't', message: 'm' } });
    expect(raw.taskLog.create).toHaveBeenCalledWith({ data: { taskId: 't', message: 'm' } });
  });

  it('User は出さない（型にも無い）', () => {
    const db = tenantDbFrom(fakeClient(), 'org-A') as unknown as Record<string, unknown>;
    expect(db.user).toBeUndefined();
  });

  it('interactive transaction の tx にも同じスコープが掛かる（設計書 §15-2）', async () => {
    const raw = fakeClient();
    const db = tenantDbFrom(raw, 'org-A');
    await db.$transaction(async (tx) => {
      await tx.task.create({ data: { title: 'x' } as never });
      expect(tx.orgId).toBe('org-A');
    });
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(raw.task.create).toHaveBeenCalledWith({ data: { title: 'x', orgId: 'org-A' } });
  });

  it('別組織を名指しした create は DB に届く前に止まる', async () => {
    const raw = fakeClient();
    const db = tenantDbFrom(raw, 'org-A');
    expect(() => db.task.create({ data: { orgId: 'org-B' } as never })).toThrow(TenantViolationError);
    expect(raw.task.create).not.toHaveBeenCalled();
  });

  it('orgId が空ならクライアントを作らない', () => {
    expect(() => tenantDbFrom(fakeClient(), '')).toThrow(TenantViolationError);
  });
});

describe('テナントコンテキスト', () => {
  it('runAsTenant の中（非同期の継続を含む）で currentTenant が取れ、外では取れない', async () => {
    expect(currentTenant()).toBeUndefined();
    await runAsTenant({ orgId: 'org-A', userId: null, role: null, source: 'scheduler', db: {} as never }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTenant()?.orgId).toBe('org-A');
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('tenantOf は requireAuth を通っていないリクエストで例外にする（黙って素通りしない）', () => {
    expect(() => tenantOf({} as never)).toThrow(TenantViolationError);
    expect(tenantOf({ tenant: { orgId: 'org-A' } } as never).orgId).toBe('org-A');
  });
});
