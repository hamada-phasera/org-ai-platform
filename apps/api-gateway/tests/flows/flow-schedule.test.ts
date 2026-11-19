/* eslint-disable @typescript-eslint/no-explicit-any -- 応答の JSON を読むテスト */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { cloneFlowTemplate } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { orgRow, userAndMembership } from '../pages/fixtures';

// 定期のきっかけ（docs/design/canvas-home.md §5.5・K45・K57・チャンク 6）。保存で ScheduledTask を同期し、
// 既存の schedule-dispatcher（atomic claim・契約チェック）が flowId の行をランナーへ渡す。外部には接続しない。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: 'x' }), { status: 200 }));
vi.stubGlobal('fetch', fetchMock);

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { flowRoutes } = await import('../../src/routes/flows');
const { scheduledTaskRoutes } = await import('../../src/routes/scheduled-tasks');
const { activeFlowRuns } = await import('../../src/services/flows/queue');
const { claimAndEnqueueScheduledTask, enqueueDueScheduledTasks } = await import('../../src/services/schedule-dispatcher');
const { jobs } = await import('../../src/services/lifecycle-core');

const SECRET = 'flow-schedule-test-secret-32-chars!!!!';
const now = new Date();

/** 定期（毎週月曜 8 時 JST）→ 結果ページ */
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

function seed(): FakePrisma {
  const people = [userAndMembership('u-owner', 'org-A', 'OWNER'), userAndMembership('u-b', 'org-B', 'OWNER')];
  const t = cloneFlowTemplate('proposal');
  return new FakePrisma({
    organization: [orgRow('org-A', { plan: 'PRO' }), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    flow: [
      {
        id: 'flow-1', orgId: 'org-A', slug: 'weekly', name: '週報', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: null,
        templateVersion: null, version: 1, schemaVersion: 1, definition: MANUAL_DEF, definitionHash: 'h', layout: t.layout,
        createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
      },
    ],
    flowVersion: [],
    flowRun: [],
    task: [],
    taskLog: [],
    scheduledTask: [
      { id: 'st-legacy', orgId: 'org-A', title: '日報', department: 'GENERAL', taskType: 'report', input: '', frequency: 'daily', hourUtc: 0, dayOfWeek: null, dayOfMonth: null, enabled: true, lastRunAt: null, agentId: null, flowId: null, createdAt: now },
    ],
    customPage: [],
    auditEvent: [],
  });
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(flowRoutes, { prefix: '/api/flows' });
  await a.register(scheduledTaskRoutes, { prefix: '/api/scheduled-tasks' });
  await a.ready();
  return a;
}
const OWNER = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: 'u-owner', orgId: 'org-A', role: 'OWNER' })}` });
const flowSchedules = () => fake.rows('scheduledTask').filter((r) => r.flowId) as any[];
const put = (definition: unknown, baseVersion: number) =>
  app.inject({ method: 'PUT', url: '/api/flows/flow-1', headers: OWNER(), payload: { definition, layout: {}, baseVersion } });

beforeEach(async () => {
  fake = seed();
  fetchMock.mockClear();
  clearMembershipCache();
  jobs.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  if (!app) app = await build();
});
afterEach(async () => {
  await vi.waitFor(() => expect(activeFlowRuns()).toBe(0));
  vi.restoreAllMocks();
});

describe('保存で ScheduledTask を同期する（§5.5）', () => {
  it('定期にすると 1 行（hourUtc は UTC、曜日は日本時間）。無効にすると enabled=false、手動に戻すと消える', async () => {
    expect((await put(SCHEDULE_DEF, 1)).statusCode).toBe(200);
    expect(flowSchedules()).toHaveLength(1);
    expect(flowSchedules()[0]).toMatchObject({ orgId: 'org-A', flowId: 'flow-1', title: '週報', taskType: 'flow', frequency: 'weekly', hourUtc: 23, dayOfWeek: 1, enabled: true });

    const off = await app.inject({ method: 'PATCH', url: '/api/flows/flow-1', headers: OWNER(), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(flowSchedules()[0].enabled).toBe(false);

    const changed = JSON.parse(JSON.stringify(SCHEDULE_DEF));
    changed.nodes[0].config = { mode: 'schedule', frequency: 'daily', hourJst: 12 };
    expect((await put(changed, 2)).statusCode).toBe(200);
    expect(flowSchedules()).toHaveLength(1);
    expect(flowSchedules()[0]).toMatchObject({ frequency: 'daily', hourUtc: 3, dayOfWeek: null, enabled: false });

    expect((await put(MANUAL_DEF, 3)).statusCode).toBe(200);
    expect(flowSchedules()).toHaveLength(0);
    expect(fake.rows('scheduledTask').map((r) => r.id)).toEqual(['st-legacy']);
  });

  it('フローを消すと定期も消える', async () => {
    await put(SCHEDULE_DEF, 1);
    expect((await app.inject({ method: 'DELETE', url: '/api/flows/flow-1', headers: OWNER() })).statusCode).toBe(200);
    expect(flowSchedules()).toHaveLength(0);
  });

  it('定期タスクの一覧・編集・削除の API からフローの行は触れない（409 FLOW_MANAGED）', async () => {
    await put(SCHEDULE_DEF, 1);
    const id = flowSchedules()[0].id;
    const list = await app.inject({ method: 'GET', url: '/api/scheduled-tasks', headers: OWNER() });
    expect(list.json().data.map((r: any) => r.id)).toEqual(['st-legacy']);
    const patch = await app.inject({ method: 'PATCH', url: `/api/scheduled-tasks/${id}`, headers: OWNER(), payload: { hourUtc: 5 } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('FLOW_MANAGED');
    expect((await app.inject({ method: 'DELETE', url: `/api/scheduled-tasks/${id}`, headers: OWNER() })).statusCode).toBe(409);
    expect(flowSchedules()[0].hourUtc).toBe(23);
  });
});

describe('dispatcher が flowId の行をランナーへ渡す（§5.5・§7.3）', () => {
  // 2026-11-22（日）23:00 UTC ＝ 2026-11-23（月）08:00 JST
  const monday8Jst = new Date('2026-11-22T23:10:00Z');

  it('その時間帯に 1 回だけ実行を受け付けて走らせる（trigger=schedule・requestId は時間帯で決まる・actorId なし）', async () => {
    await put(SCHEDULE_DEF, 1);
    expect(await enqueueDueScheduledTasks(monday8Jst)).toBe(1);
    await vi.waitFor(() => expect(activeFlowRuns()).toBe(0));
    const runs = fake.rows('flowRun') as any[];
    expect(runs).toHaveLength(1);
    const hourStart = new Date('2026-11-22T23:00:00Z').getTime();
    expect(runs[0]).toMatchObject({ orgId: 'org-A', flowId: 'flow-1', trigger: 'schedule', actorId: null, requestId: `sched:flow-1:${hourStart}` });
    await vi.waitFor(() => expect((fake.rows('flowRun')[0] as any).status).toBe('SUCCEEDED'));
    // 同じ時間帯の 2 回目（n8n の dispatcher と gateway の tick の併走）は claim で止まる
    const id = flowSchedules()[0].id;
    expect(await claimAndEnqueueScheduledTask(id, new Date(monday8Jst.getTime() + 60_000))).toEqual({ enqueued: false, reason: 'already_ran' });
    expect(fake.rows('flowRun')).toHaveLength(1);
  });

  it('日本時間で曜日が違えば発火しない（UTC では月曜でも JST では火曜）', async () => {
    await put(SCHEDULE_DEF, 1);
    expect(await enqueueDueScheduledTasks(new Date('2026-11-23T23:10:00Z'))).toBe(0);
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('フローが無効なら発火しない（flow_gone）', async () => {
    await put(SCHEDULE_DEF, 1);
    const st = flowSchedules()[0];
    // 行だけ有効のまま残っていても、フローの enabled を発火の直前にもう一度見る
    (fake.rows('flow')[0] as any).enabled = false;
    expect(await claimAndEnqueueScheduledTask(st.id, monday8Jst)).toEqual({ enqueued: false, reason: 'flow_gone' });
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('月間の実行数が上限なら受け付けない（flow_rejected）', async () => {
    await put(SCHEDULE_DEF, 1);
    const st = flowSchedules()[0];
    const rows = fake.rows('flowRun');
    for (let i = 0; i < 3000; i += 1) rows.push({ id: `old-${i}`, orgId: 'org-A', flowId: 'x', status: 'SUCCEEDED', startedAt: now, partCalls: 0, createdAt: now, requestId: `o-${i}` });
    expect(await claimAndEnqueueScheduledTask(st.id, new Date())).toEqual({ enqueued: false, reason: 'flow_rejected' });
    expect(fake.rows('flowRun').filter((r) => (r as any).trigger === 'schedule')).toHaveLength(0);
  });
});
