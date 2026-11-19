import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, truncateAll, type TestDatabase } from './setup';

// ホームキャンバスと業務フローの表（設計書 docs/design/canvas-home.md §5、チャンク 3 の受け入れ条件）を実 Postgres で確かめる。
//   - マイグレーションが当たり、4 表・2 列・索引がある。既定値が設計どおり
//   - 一意制約が**同時実行でも**効く: Canvas(orgId) / Flow(orgId, slug) / FlowRun(orgId, requestId)
//     （ほかに FlowVersion(flowId, version)・FlowRun(taskId)・CustomPage(flowId)）
//   - QUEUED → RUNNING の条件付き updateMany を並行で取って 1 回だけ取れる（簡易キューの atomic claim）
//   - Cascade: 組織を消すと Canvas / Flow / FlowRun / FlowVersion が消える。フローを消すと版・結果ページ・定期の行が消え、
//     実行の記録は残る（FlowRun.flowId は FK ではない＝当月の件数をすり抜けさせない。K25）
// アプリの配線を通す通し（テンプレートから作成 → 実行 → 承認）はチャンク 4〜6 で足す。

const DEF = { nodes: [{ id: 'start', type: 'trigger', label: '開始', config: { mode: 'manual' } }], edges: [] } as Prisma.InputJsonValue;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

function expectOneWinner(results: PromiseSettledResult<unknown>[]): void {
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of results) if (r.status === 'rejected') expect(isUniqueViolation(r.reason)).toBe(true);
}

describe.skipIf(!hasTestDatabase)('キャンバスと業務フローの表（実 Postgres）', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await truncateAll(db.prisma);
    await db.prisma.organization.createMany({ data: [{ id: 'org-A', name: 'A' }, { id: 'org-B', name: 'B' }] });
  });

  const flow = (orgId: string, slug = 'proposal') => ({
    orgId,
    slug,
    name: '提案書',
    templateKey: 'proposal',
    templateVersion: 1,
    definition: DEF,
    definitionHash: `h-${orgId}-${slug}`,
  });
  const run = (orgId: string, requestId: string, flowId = 'flow-x', extra: Partial<Prisma.FlowRunUncheckedCreateInput> = {}) => ({
    orgId,
    flowId,
    flowSlug: 'proposal',
    flowVersion: 1,
    definition: DEF,
    trigger: 'manual',
    actorId: 'u-1',
    requestId,
    ...extra,
  });

  it('4 表・2 列と索引がマイグレーションで作られ、既定値が設計どおり', async () => {
    const idx = await db.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('Canvas', 'Flow', 'FlowVersion', 'FlowRun', 'CustomPage', 'ScheduledTask') ORDER BY indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'Canvas_orgId_key',
        'Flow_orgId_slug_key',
        'Flow_orgId_updatedAt_idx',
        'FlowVersion_flowId_version_key',
        'FlowRun_orgId_requestId_key',
        'FlowRun_taskId_key',
        'FlowRun_orgId_createdAt_idx',
        'FlowRun_orgId_flowId_createdAt_idx',
        'FlowRun_status_createdAt_idx',
        'CustomPage_flowId_key',
        'ScheduledTask_flowId_idx',
      ]),
    );

    const f = await db.prisma.flow.create({ data: flow('org-A') });
    expect(f).toMatchObject({ enabled: true, minRole: 'MEMBER', icon: 'file-text', version: 1, schemaVersion: 1, layout: {} });
    const r = await db.prisma.flowRun.create({ data: run('org-A', 'r-1', f.id) });
    expect(r).toMatchObject({ status: 'QUEUED', input: {}, steps: {}, output: null, error: null, partCalls: 0, aiCalls: 0, taskId: null });
    const c = await db.prisma.canvas.create({ data: { orgId: 'org-A', layout: { nodes: [], edges: [] } } });
    expect(c.version).toBe(1);
  });

  it('同じテンプレートを並行で作っても同じ組織のフローは 1 つ（片方は P2002）。別の組織なら同じ slug を持てる', async () => {
    expectOneWinner(await Promise.allSettled(Array.from({ length: 4 }, () => db.prisma.flow.create({ data: flow('org-A') }))));
    await db.prisma.flow.create({ data: flow('org-B') });
    expect(await db.prisma.flow.count({ where: { slug: 'proposal' } })).toBe(2);
  });

  it('同じ requestId の並行の受け付けは実行 1 つ（二重実行を DB で止める）。別の組織の同じ requestId は別物', async () => {
    expectOneWinner(await Promise.allSettled(Array.from({ length: 5 }, () => db.prisma.flowRun.create({ data: run('org-A', 'req-x') }))));
    await db.prisma.flowRun.create({ data: run('org-B', 'req-x') });
    expect(await db.prisma.flowRun.count({ where: { requestId: 'req-x' } })).toBe(2);
  });

  it('キャンバスは組織に 1 枚（並行の作成でも 1 行）', async () => {
    const layout = { nodes: [], edges: [] };
    expectOneWinner(
      await Promise.allSettled(Array.from({ length: 3 }, () => db.prisma.canvas.create({ data: { orgId: 'org-A', layout } }))),
    );
    await db.prisma.canvas.create({ data: { orgId: 'org-B', layout } });
    expect(await db.prisma.canvas.count()).toBe(2);
  });

  it('版は (flowId, version) で一意。taskId は NULL なら何行でも、同じ値は 1 行。結果ページはフロー 1 つに 1 つ', async () => {
    const f = await db.prisma.flow.create({ data: flow('org-A') });
    await db.prisma.flowVersion.create({ data: { flowId: f.id, version: 1, definition: DEF } });
    await expect(db.prisma.flowVersion.create({ data: { flowId: f.id, version: 1, definition: DEF } })).rejects.toSatisfy(isUniqueViolation);

    await db.prisma.flowRun.create({ data: run('org-A', 'r-1', f.id) });
    await db.prisma.flowRun.create({ data: run('org-A', 'r-2', f.id) });
    await db.prisma.flowRun.create({ data: run('org-A', 'r-3', f.id, { taskId: 'task-1' }) });
    await expect(db.prisma.flowRun.create({ data: run('org-A', 'r-4', f.id, { taskId: 'task-1' }) })).rejects.toSatisfy(isUniqueViolation);

    const page = (slug: string, flowId: string | null) => ({
      orgId: 'org-A', slug, title: '提案書', source: flowId ? 'FLOW' : 'N8N', definition: { blocks: [], actions: {} }, definitionHash: slug, flowId,
    });
    await db.prisma.customPage.create({ data: page('a', null) });
    await db.prisma.customPage.create({ data: page('b', null) });
    await db.prisma.customPage.create({ data: page('c', f.id) });
    await expect(db.prisma.customPage.create({ data: page('d', f.id) })).rejects.toSatisfy(isUniqueViolation);
  });

  it('QUEUED を並行で取りに行っても RUNNING にできるのは 1 回だけ（atomic claim）', async () => {
    const r = await db.prisma.flowRun.create({ data: run('org-A', 'r-claim') });
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.prisma.flowRun.updateMany({ where: { id: r.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date(), lockedAt: new Date() } }),
      ),
    );
    expect(claims.reduce((n, c) => n + c.count, 0)).toBe(1);
  });

  it('フローを消すと版・結果ページ・定期の行が消え、実行の記録は残る（flowId は FK ではない）', async () => {
    const f = await db.prisma.flow.create({ data: flow('org-A') });
    await db.prisma.flowVersion.create({ data: { flowId: f.id, version: 1, definition: DEF } });
    await db.prisma.customPage.create({
      data: { orgId: 'org-A', slug: 'proposal', title: '提案書', source: 'FLOW', definition: { blocks: [], actions: {} }, definitionHash: 'h', flowId: f.id },
    });
    await db.prisma.scheduledTask.create({
      data: { orgId: 'org-A', title: '提案書', department: 'GENERAL', taskType: 'flow', input: '', frequency: 'daily', hourUtc: 0, flowId: f.id },
    });
    await db.prisma.flowRun.create({ data: run('org-A', 'r-1', f.id) });

    await db.prisma.flow.delete({ where: { id: f.id } });
    expect(
      await Promise.all([
        db.prisma.flowVersion.count(),
        db.prisma.customPage.count({ where: { orgId: 'org-A' } }),
        db.prisma.scheduledTask.count({ where: { orgId: 'org-A' } }),
        db.prisma.flowRun.count({ where: { orgId: 'org-A' } }),
      ]),
    ).toEqual([0, 0, 0, 1]);
  });

  it('組織を消すとキャンバス・フロー・版・実行が消え、他の組織の行は残る（Cascade）', async () => {
    for (const orgId of ['org-A', 'org-B']) {
      await db.prisma.canvas.create({ data: { orgId, layout: { nodes: [], edges: [] } } });
      const f = await db.prisma.flow.create({ data: flow(orgId) });
      await db.prisma.flowVersion.create({ data: { flowId: f.id, version: 1, definition: DEF } });
      await db.prisma.flowRun.create({ data: run(orgId, 'r-1', f.id) });
    }
    await db.prisma.organization.delete({ where: { id: 'org-A' } });

    const counts = async (orgId: string) =>
      Promise.all([
        db.prisma.canvas.count({ where: { orgId } }),
        db.prisma.flow.count({ where: { orgId } }),
        db.prisma.flowVersion.count({ where: { flow: { orgId } } }),
        db.prisma.flowRun.count({ where: { orgId } }),
      ]);
    expect(await counts('org-A')).toEqual([0, 0, 0, 0]);
    expect(await counts('org-B')).toEqual([1, 1, 1, 1]);
    expect(await db.prisma.flowVersion.count()).toBe(1);
  });
});
