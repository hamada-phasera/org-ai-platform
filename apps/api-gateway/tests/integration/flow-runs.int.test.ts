import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';

// 業務フローの実行（docs/design/canvas-home.md チャンク 5・D2/D5・T17）を、本番と同じ buildApp の配線と実 Postgres で通す。
//   テンプレートから作成 → 実行（確認で止まる）→ 承認 → 成果物（Task DONE）→ 月間件数
//   同じ requestId の並行 → 実行 1 つ／同じ QUEUED の並行の着手 → 1 回だけ／承認の並行 → 続きは 1 回
// ai-engine は fetch のモック（/llm/chat だけ 200）。n8n・LLM には接続しない。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

const aiOk = (): Response =>
  new Response(JSON.stringify({ content: '提案書の本文', model: 'm', tokens_used: 1, latency_ms: 1, pii_detected: false }), { status: 200 });

describe.skipIf(!hasTestDatabase)('業務フローの実行（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  let flowId: string;
  const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/llm/chat') ? aiOk() : new Response('{}', { status: 503 })));
  const INPUT = { customerName: '〇〇建設', requirements: '外壁' };
  let queue: typeof import('../../src/services/flows/queue');

  const waitIdle = () => vi.waitFor(() => expect(queue.activeFlowRuns()).toBe(0), { timeout: 5000 });

  beforeAll(async () => {
    restoreEnv = setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_STARTER_MONTHLY: undefined,
      N8N_URL: undefined,
      N8N_CLOUD_URL: undefined,
      RLS_MODE: 'off',
    });
    vi.stubGlobal('fetch', fetchMock);
    db = await createTestDatabase();
    app = await buildIntegrationApp();
    queue = await import('../../src/services/flows/queue');
    a = await registerCompany(app, 'runs-a@example.com', 'A 社');
    b = await registerCompany(app, 'runs-b@example.com', 'B 社');
    const created = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: a.headers, payload: { templateKey: 'proposal' } });
    flowId = created.json().data.flow.id as string;
    fetchMock.mockClear();
  });

  afterAll(async () => {
    if (queue) await waitIdle().catch(() => undefined);
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  it('実行 → 確認で止まる → 承認 → 文書が成果物になり、月間件数に 1 つ数える', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/flows/${flowId}/runs`, headers: a.headers, payload: { requestId: 'int-run-0001', input: INPUT } });
    expect(res.statusCode).toBe(200);
    const runId = res.json().data.runId as string;
    expect(res.json().data.run.status).toBe('WAITING_APPROVAL');
    const run = await db!.prisma.flowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.orgId).toBe(a.orgId);
    const task = await db!.prisma.task.findUniqueOrThrow({ where: { id: run.taskId! } });
    expect(task.status).toBe('PENDING_APPROVAL');

    // 承認を並行で 3 回 → 続きは 1 回だけ（T17）
    const approve = () => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: a.headers, payload: {} });
    const codes = (await Promise.all([approve(), approve(), approve()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    await waitIdle();

    const done = await db!.prisma.flowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(done.status).toBe('SUCCEEDED');
    const t = await db!.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('DONE');
    expect(JSON.parse(t.output!)).toEqual({ title: '提案書: 〇〇建設', body: '提案書の本文' });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/llm/chat'))).toHaveLength(1);

    const usage = await app.inject({ method: 'GET', url: `/api/flows/${flowId}`, headers: a.headers });
    expect(usage.json().data.usage.runs.used).toBe(1);
    // B からは見えない
    expect((await app.inject({ method: 'GET', url: `/api/flows/runs/${runId}`, headers: b.headers })).statusCode).toBe(404);
  });

  it('同じ requestId を並行で 3 回送っても実行は 1 つ（残りは 409）', async () => {
    const send = () =>
      app.inject({ method: 'POST', url: `/api/flows/${flowId}/runs`, headers: a.headers, payload: { requestId: 'int-run-dup1', input: INPUT } });
    const codes = (await Promise.all([send(), send(), send()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    expect(await db!.prisma.flowRun.count({ where: { orgId: a.orgId, requestId: 'int-run-dup1' } })).toBe(1);
    expect(await db!.prisma.task.count({ where: { orgId: a.orgId, taskType: 'flow' } })).toBe(2);
    await waitIdle();
  });

  it('同じ QUEUED の行を並行で取りに行っても 1 回だけ着手する（atomic claim）', async () => {
    const run = await db!.prisma.flowRun.create({
      data: {
        orgId: b.orgId, flowId: 'x', flowSlug: 'x', flowVersion: 1, trigger: 'manual', requestId: 'int-claim-1', status: 'QUEUED',
        definition: { nodes: [{ id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } }, { id: 'out', type: 'output', label: '出力', config: { kind: 'page', values: { a: 'x' } } }], edges: [{ from: 'go', to: 'out' }] },
      },
    });
    const claim = () => db!.prisma.flowRun.updateMany({ where: { id: run.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    const counts = (await Promise.all([claim(), claim(), claim(), claim()])).map((r) => r.count);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
  });

  it('心拍の途絶えた RUNNING は回収で FAILED。B の行は B の行のまま（orgId は変わらない）', async () => {
    const run = await db!.prisma.flowRun.create({
      data: {
        orgId: b.orgId, flowId: 'x', flowSlug: 'x', flowVersion: 1, trigger: 'manual', requestId: 'int-stale-1', status: 'RUNNING',
        definition: {}, lockedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const res = await queue.recoverFlowRuns();
    expect(res.interrupted).toBeGreaterThanOrEqual(1);
    const after = await db!.prisma.flowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect(after.orgId).toBe(b.orgId);
    expect((after.error as { code: string }).code).toBe('INTERRUPTED');
  });

  it('保持期間の掃除: プランの日数を過ぎた終わった実行だけ消える。組織ごとのプラン・承認待ちは残る（指摘 5）', async () => {
    await db!.prisma.organization.update({ where: { id: b.orgId }, data: { plan: 'MAX' } });
    const DAY = 86_400_000;
    const mk = (orgId: string, requestId: string, status: string, days: number) =>
      db!.prisma.flowRun.create({
        data: { orgId, flowId: 'x', flowSlug: 'x', flowVersion: 1, trigger: 'manual', requestId, status, definition: {}, createdAt: new Date(Date.now() - days * DAY) },
      });
    const aOld = await mk(a.orgId, 'int-purge-a-old', 'SUCCEEDED', 61);
    const aWait = await mk(a.orgId, 'int-purge-a-wait', 'WAITING_APPROVAL', 61);
    const bMid = await mk(b.orgId, 'int-purge-b-mid', 'SUCCEEDED', 200);
    const bOld = await mk(b.orgId, 'int-purge-b-old', 'FAILED', 400);
    const res = await queue.purgeFlowHistory();
    expect(res.deleted).toBe(2);
    const left = (await db!.prisma.flowRun.findMany({ where: { id: { in: [aOld.id, aWait.id, bMid.id, bOld.id] } }, select: { id: true } })).map((r) => r.id);
    expect(left.sort()).toEqual([aWait.id, bMid.id].sort());
  });
});
