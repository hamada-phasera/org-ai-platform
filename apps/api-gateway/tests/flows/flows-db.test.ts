import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakePrisma } from '../helpers/fake-prisma';

// ホームキャンバスと業務フローの表（Canvas / Flow / FlowVersion / FlowRun）がテナントクライアントで絞られること
// （docs/design/canvas-home.md §5.8・T1）と、偽 Prisma が一意制約（P2002）と既定値を再現すること（チャンク 4〜6 のルート・
// ランナーのテストの土台）。実 Postgres での一意制約・Cascade は tests/integration/canvas-flows.int.test.ts。

vi.mock('../../src/utils/prisma', () => ({ prisma: {} }));
const { tenantDbFrom, TenantViolationError, TENANT_MODELS, CHILD_MODELS } = await import('../../src/tenancy');
const { AUDIT_ACTIONS } = await import('../../src/services/audit');

const DEF = { nodes: [], edges: [] };

function seed(): FakePrisma {
  return new FakePrisma({
    organization: [{ id: 'org-A' }, { id: 'org-B' }],
    canvas: [{ id: 'canvas-B', orgId: 'org-B', layout: { nodes: [], edges: [] }, version: 2 }],
    flow: [
      { id: 'flow-B', orgId: 'org-B', slug: 'proposal', name: '提案書', definition: DEF, definitionHash: 'h-b', templateKey: 'proposal' },
    ],
    flowVersion: [{ id: 'fv-B', flowId: 'flow-B', version: 1, definition: DEF }],
    flowRun: [
      { id: 'run-B', orgId: 'org-B', flowId: 'flow-B', flowSlug: 'proposal', flowVersion: 1, definition: DEF, trigger: 'manual',
        requestId: 'req-1', status: 'SUCCEEDED', createdAt: new Date() },
    ],
  });
}

let fake: FakePrisma;
beforeEach(() => {
  fake = seed();
});

describe('業務フローの表とテナントクライアント', () => {
  it('3 表がテナントモデル、FlowVersion が子モデル', () => {
    expect(TENANT_MODELS).toEqual(expect.arrayContaining(['Canvas', 'Flow', 'FlowRun']));
    expect(CHILD_MODELS).toContain('FlowVersion');
  });

  it('組織 A のクライアントからは B のキャンバス・フロー・実行が見えない', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    expect(await db.canvas.findUnique({ where: { orgId: 'org-A' } })).toBeNull();
    expect(await db.canvas.findMany()).toEqual([]);
    expect(await db.flow.findMany()).toEqual([]);
    expect(await db.flow.findUnique({ where: { id: 'flow-B' } })).toBeNull();
    expect(await db.flowRun.findUnique({ where: { id: 'run-B' } })).toBeNull();
    expect(await db.flowRun.count()).toBe(0);
  });

  it('複合キー・orgId で B を名指しすると DB に届く前に止まる', () => {
    const db = tenantDbFrom(fake, 'org-A');
    expect(() => db.flow.findUnique({ where: { orgId_slug: { orgId: 'org-B', slug: 'proposal' } } })).toThrow(TenantViolationError);
    expect(() => db.canvas.findUnique({ where: { orgId: 'org-B' } })).toThrow(TenantViolationError);
    expect(() => db.flowRun.findUnique({ where: { orgId_requestId: { orgId: 'org-B', requestId: 'req-1' } } })).toThrow(
      TenantViolationError,
    );
  });

  it('B の行を更新・削除できず、B の orgId で作れない', async () => {
    const before = fake.snapshot();
    const db = tenantDbFrom(fake, 'org-A');
    await expect(db.flow.update({ where: { id: 'flow-B' }, data: { name: '乗っ取り' } })).rejects.toMatchObject({ code: 'P2025' });
    expect(await db.flowRun.updateMany({ where: { id: 'run-B', status: 'SUCCEEDED' }, data: { status: 'QUEUED' } })).toEqual({ count: 0 });
    expect(await db.flow.deleteMany({ where: { id: 'flow-B' } })).toEqual({ count: 0 });
    expect(await db.canvas.deleteMany()).toEqual({ count: 0 });
    expect(() =>
      db.flow.create({ data: { orgId: 'org-B', slug: 'x', name: 'x', definition: DEF, definitionHash: 'h' } }),
    ).toThrow(TenantViolationError);
    expect(fake.snapshot()).toBe(before);
  });

  it('作ると orgId が自動で付き、既定値が schema.prisma と同じ', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    const flow = await db.flow.create({ data: { orgId: 'org-A', slug: 'proposal', name: '提案書', definition: DEF, definitionHash: 'h-a' } });
    expect(flow).toMatchObject({ orgId: 'org-A', enabled: true, minRole: 'MEMBER', icon: 'file-text', version: 1, schemaVersion: 1, layout: {} });
    const run = await db.flowRun.create({
      data: { orgId: 'org-A', flowId: flow.id, flowSlug: 'proposal', flowVersion: 1, definition: DEF, trigger: 'manual', requestId: 'req-1' },
    });
    expect(run).toMatchObject({ orgId: 'org-A', status: 'QUEUED', partCalls: 0, aiCalls: 0, taskId: null, steps: {}, input: {} });
    const canvas = await db.canvas.create({ data: { orgId: 'org-A', layout: { nodes: [], edges: [] } } });
    expect(canvas).toMatchObject({ orgId: 'org-A', version: 1 });
  });

  it('偽 Prisma も一意制約を再現する（同じ組織の slug・requestId・キャンバス・版・taskId）。別の組織とは衝突しない', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    const base = { orgId: 'org-A', flowSlug: 'proposal', flowVersion: 1, definition: DEF, trigger: 'manual' } as const;
    // B と同じ slug・requestId でも A なら作れる
    const flow = await db.flow.create({ data: { orgId: 'org-A', slug: 'proposal', name: '提案書', definition: DEF, definitionHash: 'h' } });
    await db.flowRun.create({ data: { ...base, flowId: flow.id, requestId: 'req-1' } });

    await expect(db.flow.create({ data: { orgId: 'org-A', slug: 'proposal', name: '二つ目', definition: DEF, definitionHash: 'h' } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(db.flowRun.create({ data: { ...base, flowId: flow.id, requestId: 'req-1' } })).rejects.toMatchObject({ code: 'P2002' });
    await db.canvas.create({ data: { orgId: 'org-A', layout: {} } });
    await expect(db.canvas.create({ data: { orgId: 'org-A', layout: {} } })).rejects.toMatchObject({ code: 'P2002' });
    await db.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: DEF } });
    await expect(db.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: DEF } })).rejects.toMatchObject({ code: 'P2002' });

    // taskId は NULL なら何行でも、同じ値は 1 行だけ
    await db.flowRun.create({ data: { ...base, flowId: flow.id, requestId: 'req-2' } });
    await db.flowRun.create({ data: { ...base, flowId: flow.id, requestId: 'req-3', taskId: 'task-1' } });
    await expect(db.flowRun.create({ data: { ...base, flowId: flow.id, requestId: 'req-4', taskId: 'task-1' } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('キュー: QUEUED → RUNNING の条件付き updateMany は 1 回だけ取れる（atomic claim の形）', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    const run = await db.flowRun.create({
      data: { orgId: 'org-A', flowId: 'f', flowSlug: 'proposal', flowVersion: 1, definition: DEF, trigger: 'manual', requestId: 'req-q' },
    });
    const claim = () => db.flowRun.updateMany({ where: { id: run.id, status: 'QUEUED' }, data: { status: 'RUNNING' } });
    expect(await claim()).toEqual({ count: 1 });
    expect(await claim()).toEqual({ count: 0 });
  });

  it('監査アクションにキャンバスとフローの 6 つがある', () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['canvas.update', 'flow.create', 'flow.update', 'flow.delete', 'flow.enable', 'flow.disable']),
    );
  });
});
