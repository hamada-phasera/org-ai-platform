/* eslint-disable @typescript-eslint/no-explicit-any -- 応答の JSON を読むテスト */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { FLOW_TEMPLATES, cloneFlowTemplate } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { orgRow, userAndMembership } from '../pages/fixtures';

// 業務フローの実行（docs/design/canvas-home.md §7・チャンク 5）。本物の requireAuth / tenantDb / ランナー / キューを通し、
// DB だけを偽 Prisma に、ai-engine を fetch のモックに差し替える。n8n・LLM には接続しない。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
const aiOk = (content: string): Response =>
  new Response(JSON.stringify({ content, model: 'm', tokens_used: 1, latency_ms: 1, pii_detected: false }), { status: 200 });
let fetchImpl: FetchImpl = async () => aiOk('提案書の下書き本文');
const fetchMock = vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init));
vi.stubGlobal('fetch', fetchMock);

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { flowRoutes } = await import('../../src/routes/flows');
const { taskRoutes } = await import('../../src/routes/tasks');
const { flowQueueTuning, recoverFlowRuns, activeFlowRuns } = await import('../../src/services/flows/queue');
const { advanceRun } = await import('../../src/services/flows/runner');
const { DATA_FENCE } = await import('../../src/services/flows/nodes/ai');
const { jobs } = await import('../../src/services/lifecycle-core');

const SECRET = 'flow-runs-route-test-secret-32-chars!!';
const now = new Date();

function flowRow(over: Record<string, unknown>): Record<string, unknown> {
  const t = cloneFlowTemplate('proposal');
  return {
    name: '提案書', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: 'proposal', templateVersion: 1,
    version: 1, schemaVersion: 1, definition: t.definition, definitionHash: 'h', layout: t.layout,
    createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    ...over,
  };
}

/** 分岐とデータと出力（ページ）だけのフロー（AI も承認も無い）。yes → ページ、no → 商談の一覧 */
const BRANCH_DEF = {
  nodes: [
    { id: 'form', type: 'trigger', label: 'フォーム', config: { mode: 'form', fields: [{ key: 'amount', label: '金額', type: 'number', required: true }] } },
    { id: 'big', type: 'branch', label: '大口', config: { left: '{{form.amount}}', op: 'gt', right: 100 } },
    { id: 'yes', type: 'output', label: '大', config: { kind: 'page', values: { size: '大口 {{form.amount}}' } } },
    { id: 'deals', type: 'data', label: '商談', config: { resource: 'deal', op: 'list', limit: 5 } },
  ],
  edges: [
    { from: 'form', to: 'big' },
    { from: 'big', to: 'yes', when: 'yes' },
    { from: 'big', to: 'deals', when: 'no' },
  ],
};

function seed(plan = 'STARTER', extraRuns: Record<string, unknown>[] = []): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-admin', 'org-A', 'ADMIN'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-member2', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A', { plan, name: 'A 社' }), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    flow: [
      flowRow({ id: 'flow-p', orgId: 'org-A', slug: 'proposal' }),
      flowRow({ id: 'flow-branch', orgId: 'org-A', slug: 'branch', name: '分岐', templateKey: null, definition: BRANCH_DEF }),
      flowRow({ id: 'flow-off', orgId: 'org-A', slug: 'off', enabled: false }),
      flowRow({ id: 'flow-owner', orgId: 'org-A', slug: 'owner-only', minRole: 'OWNER' }),
      flowRow({ id: 'flow-B', orgId: 'org-B', slug: 'proposal' }),
    ],
    flowVersion: [],
    flowRun: extraRuns,
    task: [],
    taskLog: [],
    deal: [
      { id: 'deal-1', orgId: 'org-A', title: '外壁', company: '〇〇建設', amount: 50, stage: 'LEAD', createdAt: now },
      { id: 'deal-B', orgId: 'org-B', title: 'B の商談', company: 'B', amount: 1, stage: 'LEAD', createdAt: now },
    ],
    project: [{ id: 'proj-B', orgId: 'org-B', code: 'B1', name: 'B 工事', status: 'ORDERED', contractAmount: 0, createdAt: now }],
    costEntry: [],
    customPage: [],
    scheduledTask: [],
    auditEvent: [],
  });
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(flowRoutes, { prefix: '/api/flows' });
  await a.register(taskRoutes, { prefix: '/api/tasks' });
  await a.ready();
  return a;
}
const as = (sub: string, orgId = 'org-A') => ({ authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER' })}` });
const OWNER = () => as('u-owner');
const ADMIN = () => as('u-admin');
const MEMBER = () => as('u-member');
const B = () => as('u-b', 'org-B');

let seq = 0;
const rid = () => `req-${Date.now()}-${++seq}`;
const PROPOSAL_INPUT = { customerName: '〇〇建設', background: '老朽化', requirements: '外壁', budget: '500万' };

function run(flowId: string, headers = MEMBER(), body: Record<string, unknown> = { input: PROPOSAL_INPUT }) {
  return app.inject({ method: 'POST', url: `/api/flows/${flowId}/runs`, headers, payload: { requestId: rid(), ...body } });
}
const runRow = (id: string) => fake.rows('flowRun').find((r) => r.id === id) as any;
const taskRow = (id: string) => fake.rows('task').find((r) => r.id === id) as any;
const idle = () => vi.waitFor(() => expect(activeFlowRuns()).toBe(0));

const ENV_KEYS = ['N8N_URL', 'N8N_CLOUD_URL', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fake = seed();
  fetchImpl = async () => aiOk('提案書の下書き本文');
  fetchMock.mockClear();
  flowQueueTuning.syncWaitMs = 2000;
  clearMembershipCache();
  jobs.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  if (!app) app = await build();
});
afterEach(async () => {
  await idle();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('提案書テンプレートを n8n 無しで最後まで（受け入れ条件）', () => {
  it('フォーム → AI → 確認で止まり（200・承認待ち）、承認すると文書が成果物（Task DONE）になる', async () => {
    const res = await run('flow-p');
    expect(res.statusCode).toBe(200);
    const { runId, run: r } = res.json().data;
    expect(r.status).toBe('WAITING_APPROVAL');
    expect(r.steps.form.status).toBe('SUCCEEDED');
    expect(r.steps.draft).toMatchObject({ status: 'SUCCEEDED', output: { text: '提案書の下書き本文' } });
    expect(r.steps.check.status).toBe('WAITING_APPROVAL');
    expect(r.steps.doc.status).toBe('PENDING');

    // ai-engine の /llm/chat だけを 1 回呼ぶ。指示と資料は別のメッセージで、資料は固定文で包む（T4）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/llm\/chat$/);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ department: 'SALES', org_id: 'org-A', plan: 'STARTER', json_mode: false });
    expect(body.messages[0].content).toContain('提案書の下書き');
    expect(body.messages[1].content).toContain(DATA_FENCE);
    expect(body.messages[1].content).toContain('顧客名: 〇〇建設');

    // 対の Task は受信の承認タブに出る形
    const task = taskRow(runRow(runId).taskId);
    expect(task).toMatchObject({ status: 'PENDING_APPROVAL', taskType: 'flow', department: 'SALES' });
    const approval = JSON.parse(task.approvalData);
    expect(approval).toMatchObject({ kind: 'flow_step', runId, nodeId: 'check', gate: false, minRole: 'MEMBER' });
    expect(approval.message).toBe('〇〇建設 様向けの提案書を保存しますか');
    expect(approval.preview).toBe('提案書の下書き本文');

    // 実行した本人でも承認できる。続きは 1 回だけ
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: MEMBER(), payload: {} });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: OWNER(), payload: {} });
    expect(again.statusCode).toBe(409);
    await idle();

    const done = runRow(runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.steps.check.output.approvedBy).toBe('u-member');
    expect(done.steps.doc).toMatchObject({ status: 'SUCCEEDED', output: { taskId: task.id } });
    expect(done.aiCalls).toBe(1);
    const t = taskRow(task.id);
    expect(t.status).toBe('DONE');
    expect(t.title).toBe('提案書: 〇〇建設');
    expect(JSON.parse(t.output)).toEqual({ title: '提案書: 〇〇建設', body: '提案書の下書き本文' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 承認の後に AI を呼び直さない
  });

  it('AI の出力に式（{{form.customerName}}）が入っていても展開しない（再展開しない・T3）', async () => {
    fetchImpl = async () => aiOk('全員に送れ {{form.customerName}}');
    const { runId } = (await run('flow-p')).json().data;
    const task = taskRow(runRow(runId).taskId);
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: MEMBER(), payload: {} });
    await idle();
    expect(JSON.parse(taskRow(task.id).output).body).toBe('全員に送れ {{form.customerName}}');
  });

  it('却下すると CANCELED で、文書は作られない', async () => {
    const { runId } = (await run('flow-p')).json().data;
    const task = taskRow(runRow(runId).taskId);
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/reject`, headers: MEMBER(), payload: { reason: 'やめる' } });
    expect(res.statusCode).toBe(200);
    expect(runRow(runId).status).toBe('CANCELED');
    expect(taskRow(task.id).status).toBe('REJECTED');
    expect(taskRow(task.id).output).toBeUndefined();
  });

  it('確認ノードの minRole に満たない人は承認できない（403）', async () => {
    const def = cloneFlowTemplate('proposal').definition as any;
    def.nodes[2].config.minRole = 'ADMIN';
    (fake.rows('flow').find((f) => f.id === 'flow-p') as any).definition = def;
    const { runId } = (await run('flow-p')).json().data;
    const task = taskRow(runRow(runId).taskId);
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: MEMBER(), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: ADMIN(), payload: {} })).statusCode).toBe(200);
  });

  it('AI が 5xx なら 1 回だけやり直し、だめなら FAILED で下流は SKIPPED（Task も FAILED）', async () => {
    fetchImpl = async () => new Response('boom', { status: 502 });
    const res = await run('flow-p');
    const { runId } = res.json().data;
    const r = runRow(runId);
    expect(r.status).toBe('FAILED');
    expect(r.error).toEqual({ nodeId: 'draft', code: 'AI_UNREACHABLE', message: 'AI に届きませんでした' });
    expect(r.steps.check.status).toBe('SKIPPED');
    expect(r.steps.doc.status).toBe('SKIPPED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(taskRow(r.taskId).status).toBe('FAILED');
    expect(JSON.stringify(res.json())).not.toContain('boom'); // 上流の本文は返さない
  });
});

describe('受け付け（§7.2・§7.6）', () => {
  it('同じ requestId の二重実行は 409 DUPLICATE_REQUEST（実行は 1 つ）', async () => {
    const payload = { requestId: 'same-request-1', input: PROPOSAL_INPUT };
    const r1 = await app.inject({ method: 'POST', url: '/api/flows/flow-p/runs', headers: MEMBER(), payload });
    const r2 = await app.inject({ method: 'POST', url: '/api/flows/flow-p/runs', headers: MEMBER(), payload });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('DUPLICATE_REQUEST');
    expect(fake.rows('flowRun')).toHaveLength(1);
    expect(fake.rows('task')).toHaveLength(1);
  });

  it('フォームの必須・知らない項目は 400（issues 付き）。実行も Task も作らない', async () => {
    const r1 = await run('flow-p', MEMBER(), { input: { background: 'x' } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.issues[0].path).toEqual(['customerName']);
    const r2 = await run('flow-p', MEMBER(), { input: { ...PROPOSAL_INPUT, extra: 1 } });
    expect(r2.statusCode).toBe(400);
    expect((await run('flow-p', MEMBER(), { requestId: 'x', input: PROPOSAL_INPUT })).statusCode).toBe(400);
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('8 秒（ここでは短く）で終わらなければ 202 と runId。終われば GET /runs/:runId で結果', async () => {
    flowQueueTuning.syncWaitMs = 30;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchImpl = async () => {
      await gate;
      return aiOk('遅い下書き');
    };
    const res = await run('flow-p');
    expect(res.statusCode).toBe(202);
    const { runId } = res.json().data;
    expect(runRow(runId).status).toBe('RUNNING');
    release();
    await vi.waitFor(() => expect(runRow(runId).status).toBe('WAITING_APPROVAL'));
    const got = await app.inject({ method: 'GET', url: `/api/flows/runs/${runId}`, headers: MEMBER() });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.steps.draft.output.text).toBe('遅い下書き');
  });

  it('組織の同時実行数（梅 2）を超えた分は QUEUED のまま。空けば自動で着手する', async () => {
    flowQueueTuning.syncWaitMs = 20;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchImpl = async () => {
      await gate;
      return aiOk('x');
    };
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await run('flow-p')).json().data.runId);
    expect(ids.map((id) => runRow(id).status)).toEqual(['RUNNING', 'RUNNING', 'QUEUED']);
    release();
    await vi.waitFor(() => expect(ids.map((id) => runRow(id).status)).toEqual(['WAITING_APPROVAL', 'WAITING_APPROVAL', 'WAITING_APPROVAL']));
  });

  it('当月の実行数が上限なら 429 FLOW_RUN_LIMIT（閲覧は通る）', async () => {
    const used = Array.from({ length: 300 }, (_, i) => ({
      id: `old-${i}`, orgId: 'org-A', flowId: 'flow-p', flowSlug: 'proposal', flowVersion: 1, definition: {}, trigger: 'form',
      requestId: `old-${i}`, status: 'SUCCEEDED', createdAt: now, startedAt: now,
    }));
    fake = seed('STARTER', used);
    const res = await run('flow-p');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('FLOW_RUN_LIMIT');
    expect((await app.inject({ method: 'GET', url: '/api/flows/flow-p/runs', headers: MEMBER() })).statusCode).toBe(200);
  });

  it('QUEUED が組織で 20 件あれば 429 FLOW_BUSY', async () => {
    const queued = Array.from({ length: 20 }, (_, i) => ({
      id: `q-${i}`, orgId: 'org-A', flowId: 'flow-p', flowSlug: 'proposal', flowVersion: 1, definition: {}, trigger: 'form',
      requestId: `q-${i}`, status: 'QUEUED', createdAt: now,
    }));
    fake = seed('MAX', queued);
    // 回収の着手を待たせない（同時実行の空きを 0 にする）
    for (let i = 0; i < 8; i += 1) {
      fake.rows('flowRun').push({ id: `r-${i}`, orgId: 'org-A', flowId: 'flow-p', flowSlug: 'p', flowVersion: 1, definition: {}, trigger: 'form', requestId: `r-${i}`, status: 'RUNNING', createdAt: now, lockedAt: now });
    }
    const res = await run('flow-p');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('FLOW_BUSY');
  });

  it('無効なフローは 409 FLOW_DISABLED。オーナー限定はメンバーに 404。他組織は 404', async () => {
    expect((await run('flow-off')).json().error.code).toBe('FLOW_DISABLED');
    expect((await run('flow-owner')).statusCode).toBe(404);
    expect((await run('flow-B')).statusCode).toBe(404);
    expect((await run('flow-owner', OWNER())).statusCode).toBe(200);
  });

  it('n8n の部品を含むフローは n8n 未設定なら 503 FLOW_PART_NOT_CONNECTED（何も呼ばない）', async () => {
    fake = seed('PRO');
    const def = {
      nodes: [
        { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } },
        { id: 'pdf', type: 'part', label: 'PDF', config: { part: 'pdf_make', input: { title: 't', body: 'b' } } },
      ],
      edges: [{ from: 'go', to: 'pdf' }],
    };
    fake.rows('flow').push(flowRow({ id: 'flow-part', orgId: 'org-A', slug: 'part', definition: def }));
    const res = await run('flow-part', MEMBER(), { input: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FLOW_PART_NOT_CONNECTED');
    expect(JSON.stringify(res.json())).not.toMatch(/https?:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('分岐とデータ（§6.2・§6.5）', () => {
  it('大口（yes）なら反対側は SKIPPED。ページの出力が FlowRun.output に入り、Task は成果物にしない', async () => {
    const res = await run('flow-branch', MEMBER(), { input: { amount: 500 } });
    const r = res.json().data.run;
    expect(r.status).toBe('SUCCEEDED');
    expect(r.steps.big.output).toEqual({ result: true });
    expect(r.steps.deals.status).toBe('SKIPPED');
    expect(r.output).toEqual({ size: '大口 500' });
    expect(taskRow(r.taskId).status).toBe('DONE');
    expect(taskRow(r.taskId).output).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('小口（no）ならデータの一覧（自組織の商談だけ）が表として出る', async () => {
    const r = (await run('flow-branch', MEMBER(), { input: { amount: 1 } })).json().data.run;
    expect(r.status).toBe('SUCCEEDED');
    expect(r.steps.yes.status).toBe('SKIPPED');
    expect(r.output).toBeNull();
    expect(r.steps.deals.output).toEqual({ rows: [{ id: 'deal-1', title: '外壁', company: '〇〇建設', amount: 50, stage: 'LEAD' }], count: 1 });
  });
});

describe('履歴・取り消し・分離', () => {
  it('履歴は新しい順・自組織のフローだけ。B から A の実行は 404', async () => {
    const { runId } = (await run('flow-p')).json().data;
    const list = await app.inject({ method: 'GET', url: '/api/flows/flow-p/runs', headers: MEMBER() });
    expect(list.json().data.runs.map((x: any) => x.id)).toEqual([runId]);
    expect(list.json().data.runs[0].steps).toBeUndefined();
    // 誰が（同じ組織の所属の名前だけ）
    expect(list.json().data.runs[0].actorName).toBe('u-member');
    expect((await app.inject({ method: 'GET', url: `/api/flows/runs/${runId}`, headers: B() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/flows/runs/${runId}/cancel`, headers: B() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/flows/flow-p/runs', headers: B() })).statusCode).toBe(404);
  });

  it('承認待ちは本人か ADMIN 以上だけ取り消せる。終わったものは 409', async () => {
    const { runId } = (await run('flow-p')).json().data;
    expect((await app.inject({ method: 'POST', url: `/api/flows/runs/${runId}/cancel`, headers: as('u-member2') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/flows/runs/${runId}/cancel`, headers: MEMBER() })).statusCode).toBe(200);
    expect(runRow(runId).status).toBe('CANCELED');
    expect(taskRow(runRow(runId).taskId).status).toBe('REJECTED');
    expect((await app.inject({ method: 'POST', url: `/api/flows/runs/${runId}/cancel`, headers: ADMIN() })).statusCode).toBe(409);
  });
});

describe('回収（§7.2 の 6）', () => {
  const base = { flowId: 'flow-p', flowSlug: 'proposal', flowVersion: 1, definition: FLOW_TEMPLATES.proposal.definition, trigger: 'form' };

  it('心拍が 2 分途絶えた RUNNING は FAILED（INTERRUPTED）。新しいものは巻き込まない。承認待ち 7 日超は EXPIRED', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    fake.rows('task').push({ id: 't-stale', orgId: 'org-A', status: 'RUNNING' }, { id: 't-wait', orgId: 'org-B', status: 'PENDING_APPROVAL' });
    fake.rows('flowRun').push(
      { ...base, id: 'stale', orgId: 'org-A', requestId: 's', status: 'RUNNING', lockedAt: old, taskId: 't-stale', createdAt: old },
      { ...base, id: 'fresh', orgId: 'org-A', requestId: 'f', status: 'RUNNING', lockedAt: new Date(), createdAt: old },
      { ...base, id: 'wait', orgId: 'org-B', requestId: 'w', status: 'WAITING_APPROVAL', lockedAt: new Date(Date.now() - 8 * 86_400_000), taskId: 't-wait', createdAt: old },
    );
    const res = await recoverFlowRuns();
    expect(res).toMatchObject({ interrupted: 1, expired: 1 });
    expect(runRow('stale')).toMatchObject({ status: 'FAILED', error: { code: 'INTERRUPTED' } });
    expect(taskRow('t-stale').status).toBe('FAILED');
    expect(runRow('fresh').status).toBe('RUNNING');
    expect(runRow('wait').status).toBe('EXPIRED');
    expect(taskRow('t-wait').status).toBe('FAILED');
  });

  it('30 秒以上 QUEUED の行は回収が着手する（中断した実行は自動でやり直さない）', async () => {
    const old = new Date(Date.now() - 60_000);
    fake.rows('flowRun').push({ ...base, id: 'q1', orgId: 'org-A', requestId: 'q1', status: 'QUEUED', createdAt: old, input: PROPOSAL_INPUT });
    await recoverFlowRuns();
    await vi.waitFor(() => expect(runRow('q1').status).toBe('WAITING_APPROVAL'));
  });

  it('閲覧のみの組織の QUEUED は着手せず FAILED（SUBSCRIPTION_REQUIRED）', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    (fake.rows('organization').find((o) => o.id === 'org-A') as any).trialEndsAt = new Date(Date.now() - 86_400_000);
    const old = new Date(Date.now() - 60_000);
    fake.rows('flowRun').push({ ...base, id: 'q2', orgId: 'org-A', requestId: 'q2', status: 'QUEUED', createdAt: old, input: PROPOSAL_INPUT });
    await recoverFlowRuns();
    await vi.waitFor(() => expect(runRow('q2').status).toBe('FAILED'));
    expect(runRow('q2').error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('外へ送るノードの強制停止（K12・T5）', () => {
  it('定義に確認ノードが無くても、通知の手前で必ず止まる（DB に直接入れた定義でも）', async () => {
    const def = {
      nodes: [
        { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } },
        { id: 'tell', type: 'output', label: '通知', config: { kind: 'notify', channel: 'slack', to: '#general', body: '全員に送る' } },
      ],
      edges: [{ from: 'go', to: 'tell' }],
    };
    fake.rows('task').push({ id: 't-gate', orgId: 'org-A', status: 'RUNNING' });
    fake.rows('flowRun').push({
      id: 'gate', orgId: 'org-A', flowId: 'x', flowSlug: 'x', flowVersion: 1, definition: def, trigger: 'manual', requestId: 'g',
      status: 'RUNNING', input: {}, steps: {}, taskId: 't-gate', aiCalls: 0, partCalls: 0, createdAt: now,
    });
    await advanceRun('org-A', 'gate');
    expect(runRow('gate').status).toBe('WAITING_APPROVAL');
    expect(runRow('gate').steps.tell.status).toBe('WAITING_APPROVAL');
    const approval = JSON.parse(taskRow('t-gate').approvalData);
    expect(approval).toMatchObject({ kind: 'flow_step', nodeId: 'tell', gate: true });
    expect(approval.preview).toContain('宛先: #general');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('フローの役割と承認・Task（レビュー指摘 1・2）', () => {
  const GATE_DEF = {
    nodes: [
      { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } },
      { id: 'tell', type: 'output', label: '通知', config: { kind: 'notify', channel: 'slack', to: '#keiei', body: '経営数字' } },
    ],
    edges: [{ from: 'go', to: 'tell' }],
  };
  /** flowId のフローの「送信前」で止まった実行と、その Task を作る */
  async function gated(flowId: string, id = 'gate-o'): Promise<string> {
    const taskId = `t-${id}`;
    fake.rows('task').push({ id: taskId, orgId: 'org-A', status: 'RUNNING', taskType: 'flow', title: '経営', department: 'GENERAL', input: '{}', createdAt: now });
    fake.rows('flowRun').push({
      id, orgId: 'org-A', flowId, flowSlug: 'owner-only', flowVersion: 1, definition: GATE_DEF, trigger: 'manual', requestId: id,
      status: 'RUNNING', input: {}, steps: {}, taskId, aiCalls: 0, partCalls: 0, createdAt: now,
    });
    await advanceRun('org-A', id);
    expect(taskRow(taskId).status).toBe('PENDING_APPROVAL');
    return taskId;
  }
  const approveAs = (taskId: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/tasks/${taskId}/approve`, headers, payload: {} });
  const rejectAs = (taskId: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/tasks/${taskId}/reject`, headers, payload: {} });

  it('オーナー限定のフローの送信前の承認・却下は、MEMBER・ADMIN に 404（存在を漏らさない）。OWNER は通る', async () => {
    const taskId = await gated('flow-owner');
    expect((await approveAs(taskId, MEMBER())).statusCode).toBe(404);
    expect((await approveAs(taskId, ADMIN())).statusCode).toBe(404);
    expect((await rejectAs(taskId, MEMBER())).statusCode).toBe(404);
    expect(runRow('gate-o').status).toBe('WAITING_APPROVAL');
    expect((await approveAs(taskId, OWNER())).statusCode).toBe(200);
  });

  it('承認に要る役割は max(フローの minRole, ノードの minRole)。ADMIN 限定のフローの確認ノード（MEMBER）も MEMBER は通せない', async () => {
    (fake.rows('flow').find((f) => f.id === 'flow-p') as any).minRole = 'ADMIN';
    const { runId } = (await run('flow-p', ADMIN())).json().data;
    const task = taskRow(runRow(runId).taskId);
    expect(JSON.parse(task.approvalData).minRole).toBe('MEMBER');
    expect((await approveAs(task.id, MEMBER())).statusCode).toBe(404);
    expect((await approveAs(task.id, ADMIN())).statusCode).toBe(200);
  });

  it('フローが消えた実行の承認は ADMIN 以上だけ', async () => {
    const taskId = await gated('flow-gone', 'gate-gone');
    expect((await approveAs(taskId, MEMBER())).statusCode).toBe(404);
    expect((await approveAs(taskId, ADMIN())).statusCode).toBe(200);
  });

  it('オーナー限定のフローの Task は、MEMBER の一覧・単体・ログに出ない（受信・成果物も同じ API）', async () => {
    const taskId = await gated('flow-owner');
    const list = await app.inject({ method: 'GET', url: '/api/tasks?status=PENDING_APPROVAL&taskType=flow', headers: MEMBER() });
    expect(list.json().data.map((t: any) => t.id)).not.toContain(taskId);
    const all = await app.inject({ method: 'GET', url: '/api/tasks', headers: ADMIN() });
    expect(all.json().data.map((t: any) => t.id)).not.toContain(taskId);
    expect(JSON.stringify(all.json())).not.toContain('#keiei');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: MEMBER() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/logs`, headers: MEMBER(), payload: { message: 'x' } })).statusCode).toBe(404);
    const mine = await app.inject({ method: 'GET', url: '/api/tasks', headers: OWNER() });
    expect(mine.json().data.map((t: any) => t.id)).toContain(taskId);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: OWNER() })).statusCode).toBe(200);
  });

  it('フローの Task は汎用の PATCH・DELETE・承認データの無い approve を 409 FLOW_MANAGED で断る（見えない人には 404）', async () => {
    const taskId = await gated('flow-owner');
    const patch = await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}`, headers: OWNER(), payload: { status: 'QUEUED', output: 'x' } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('FLOW_MANAGED');
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}`, headers: MEMBER(), payload: { status: 'QUEUED' } })).statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/tasks/${taskId}`, headers: OWNER() });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('FLOW_MANAGED');
    expect(taskRow(taskId)).toMatchObject({ status: 'PENDING_APPROVAL' });

    const loose = 't-loose';
    fake.rows('task').push({ id: loose, orgId: 'org-A', status: 'RUNNING', taskType: 'flow', title: 'x', department: 'GENERAL', input: '{}', createdAt: now });
    const ap = await approveAs(loose, OWNER());
    expect(ap.statusCode).toBe(409);
    expect(ap.json().error.code).toBe('FLOW_MANAGED');
    expect(taskRow(loose).status).toBe('RUNNING');
  });
});

describe('データノードの守り（T14）', () => {
  it('原価は必ず DRAFT。他組織の工事は指せない', async () => {
    const def = {
      nodes: [
        { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } },
        {
          id: 'cost', type: 'data', label: '原価',
          config: { resource: 'cost_entry', op: 'create', values: { projectId: '{{run.id}}', category: 'MATERIAL', amount: '1000', incurredOn: '2026-11-01' } },
        },
      ],
      edges: [{ from: 'go', to: 'cost' }],
    };
    fake.rows('project').push({ id: 'proj-A', orgId: 'org-A', code: 'A1', name: 'A 工事', status: 'ORDERED', contractAmount: 0, createdAt: now });
    const mk = (id: string, projectId: string) => {
      const d = JSON.parse(JSON.stringify(def));
      d.nodes[1].config.values.projectId = projectId;
      fake.rows('flowRun').push({ id, orgId: 'org-A', flowId: 'x', flowSlug: 'x', flowVersion: 1, definition: d, trigger: 'manual', requestId: id, status: 'RUNNING', input: {}, steps: {}, aiCalls: 0, partCalls: 0, createdAt: now });
    };
    mk('c-ok', 'proj-A');
    mk('c-other', 'proj-B');
    await advanceRun('org-A', 'c-ok');
    await advanceRun('org-A', 'c-other');
    expect(runRow('c-ok').status).toBe('SUCCEEDED');
    const entries = fake.rows('costEntry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ orgId: 'org-A', projectId: 'proj-A', status: 'DRAFT', amount: 1000, taxAmount: 0 });
    expect(runRow('c-other')).toMatchObject({ status: 'FAILED', error: { code: 'FLOW_DATA_NOT_FOUND' } });
  });
});
