import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';

// 定期のきっかけ（docs/design/canvas-home.md チャンク 6・§5.5・K57）を実 Postgres で通す。
//   定期のフローを保存 → ScheduledTask が 1 行（flowId・UTC の時・JST の曜日）→ dispatcher を並行で 3 回 → 実行は 1 つ
//   → 手動に戻すと行が消える。外部には接続しない（fetch はモック）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

const SCHEDULE_DEF = {
  nodes: [
    { id: 'tick', type: 'trigger', label: '定期', config: { mode: 'schedule', frequency: 'weekly', hourJst: 8, dayOfWeek: 1 } },
    { id: 'page', type: 'output', label: '結果', config: { kind: 'page', values: { at: '{{run.date}}' } } },
  ],
  edges: [{ from: 'tick', to: 'page' }],
};
const MANUAL_DEF = {
  nodes: [
    { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } },
    { id: 'page', type: 'output', label: '結果', config: { kind: 'page', values: {} } },
  ],
  edges: [{ from: 'go', to: 'page' }],
};

describe.skipIf(!hasTestDatabase)('業務フローの定期のきっかけ（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let flowId: string;
  let queue: typeof import('../../src/services/flows/queue');
  const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }));

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
    a = await registerCompany(app, 'sched-a@example.com', 'A 社');
    const created = await app.inject({ method: 'POST', url: '/api/flows', headers: a.headers, payload: { name: '週報' } });
    flowId = created.json().data.flow.id as string;
  });

  afterAll(async () => {
    if (queue) await vi.waitFor(() => expect(queue.activeFlowRuns()).toBe(0), { timeout: 5000 }).catch(() => undefined);
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  it('保存で 1 行できる → dispatcher の並行 3 回でも実行は 1 つ → 手動に戻すと消える', async () => {
    const put = (definition: unknown, baseVersion: number) =>
      app.inject({ method: 'PUT', url: `/api/flows/${flowId}`, headers: a.headers, payload: { definition, layout: {}, baseVersion } });
    expect((await put(SCHEDULE_DEF, 1)).statusCode).toBe(200);
    const rows = await db!.prisma.scheduledTask.findMany({ where: { flowId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: a.orgId, hourUtc: 23, dayOfWeek: 1, frequency: 'weekly', enabled: true, taskType: 'flow' });

    const { claimAndEnqueueScheduledTask } = await import('../../src/services/schedule-dispatcher');
    // 2026-11-22（日）23:05 UTC ＝ 月曜 08:05 JST
    const at = new Date('2026-11-22T23:05:00Z');
    const results = await Promise.all([1, 2, 3].map(() => claimAndEnqueueScheduledTask(rows[0].id, at)));
    expect(results.filter((r) => r.enqueued)).toHaveLength(1);
    await vi.waitFor(() => expect(queue.activeFlowRuns()).toBe(0), { timeout: 5000 });
    const runs = await db!.prisma.flowRun.findMany({ where: { flowId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', actorId: null, orgId: a.orgId });
    await vi.waitFor(async () => expect((await db!.prisma.flowRun.findUniqueOrThrow({ where: { id: runs[0].id } })).status).toBe('SUCCEEDED'), {
      timeout: 5000,
    });

    expect((await put(MANUAL_DEF, 2)).statusCode).toBe(200);
    expect(await db!.prisma.scheduledTask.count({ where: { flowId } })).toBe(0);
  });
});
