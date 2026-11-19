/* eslint-disable @typescript-eslint/no-explicit-any -- 応答の JSON を読むテスト */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { cloneFlowTemplate } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { orgRow, userAndMembership } from '../pages/fixtures';

// 承認ノード・部品ノード（n8n / capability）・運営リンク（docs/design/canvas-home.md §7.4・§8・チャンク 6）。
// 本物の requireAuth / tenantDb / ランナー / キューを通し、DB は偽 Prisma、n8n と ai-engine は fetch のモック、
// 既存の capability の実行（resolveAndExecute）はモックに差し替える。外部には接続しない。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const resolveMock = vi.fn();
vi.mock('../../src/services/capability-resolver', () => ({
  resolveAndExecute: (input: unknown) => resolveMock(input),
}));

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const aiOk = (content: string): Response => json({ content, model: 'm', tokens_used: 1, latency_ms: 1, pii_detected: false });
let fetchImpl: FetchImpl = async () => aiOk('下書き');
const fetchMock = vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init));
vi.stubGlobal('fetch', fetchMock);

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { flowRoutes } = await import('../../src/routes/flows');
const { taskRoutes } = await import('../../src/routes/tasks');
const { flowQueueTuning, activeFlowRuns } = await import('../../src/services/flows/queue');
const { advanceRun } = await import('../../src/services/flows/runner');
const { clearPartEditorCache } = await import('../../src/services/n8n/part-editor');
const { jobs } = await import('../../src/services/lifecycle-core');

const SECRET = 'flow-parts-route-test-secret-32-chars!!';
const now = new Date();
const N8N = 'http://n8n.test';

function flowRow(over: Record<string, unknown>): Record<string, unknown> {
  const t = cloneFlowTemplate('proposal');
  return {
    name: 'フロー', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: null, templateVersion: null,
    version: 1, schemaVersion: 1, definition: t.definition, definitionHash: 'h', layout: {},
    createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    ...over,
  };
}

const manual = { id: 'go', type: 'trigger', label: '手動', config: { mode: 'manual' } };

/** 手動 → 通知（Slack）。確認ノードは置かない（ランナーが必ず止める） */
const NOTIFY_DEF = {
  nodes: [manual, { id: 'tell', type: 'output', label: '通知', config: { kind: 'notify', channel: 'slack', to: '#general', body: '{{run.id}} を送ります' } }],
  edges: [{ from: 'go', to: 'tell' }],
};
/** 手動 → PDF（n8n・竹以上）→ ページ */
const PDF_DEF = {
  nodes: [
    manual,
    { id: 'pdf', type: 'part', label: 'PDF', config: { part: 'pdf_make', input: { title: '見積', body: '本文 {{run.id}}' } } },
    { id: 'page', type: 'output', label: '結果', config: { kind: 'page', values: { link: '{{pdf.url}}' } } },
  ],
  edges: [{ from: 'go', to: 'pdf' }, { from: 'pdf', to: 'page' }],
};
/** 手動 → 文書（Google ドキュメント・capability） */
const DOC_DEF = {
  nodes: [manual, { id: 'doc', type: 'part', label: '文書', config: { part: 'google_doc', input: { title: '議事録', content: '本文' } } }],
  edges: [{ from: 'go', to: 'doc' }],
};
/** フォーム → 確認 → メール（外へ送る部品）。確認ノードの後でも、送る直前にもう一度中身を見せて止まる */
const EMAIL_DEF = {
  nodes: [
    { id: 'form', type: 'trigger', label: 'フォーム', config: { mode: 'form', fields: [{ key: 'to', label: '宛先', type: 'email', required: true }] } },
    { id: 'ok', type: 'approval', label: '確認', config: { message: '送ってよいですか' } },
    { id: 'mail', type: 'part', label: 'メール', config: { part: 'email_send', input: { to: '{{form.to}}', subject: 'ご案内', body: '本文です' } } },
  ],
  edges: [{ from: 'form', to: 'ok' }, { from: 'ok', to: 'mail' }],
};

function seed(plan = 'PRO'): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A', { plan, name: 'A 社' }), orgRow('org-B', { plan: 'PRO' })],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    flow: [
      flowRow({ id: 'flow-notify', orgId: 'org-A', slug: 'notify', definition: NOTIFY_DEF }),
      flowRow({ id: 'flow-pdf', orgId: 'org-A', slug: 'pdf', definition: PDF_DEF }),
      flowRow({ id: 'flow-doc', orgId: 'org-A', slug: 'doc', definition: DOC_DEF }),
      flowRow({ id: 'flow-mail', orgId: 'org-A', slug: 'mail', definition: EMAIL_DEF }),
      flowRow({ id: 'flow-pdf-B', orgId: 'org-B', slug: 'pdf', definition: PDF_DEF }),
    ],
    flowVersion: [],
    flowRun: [],
    task: [],
    taskLog: [],
    capability: [
      { id: 'cap-slack', orgId: 'org-A', name: 'notify_slack', kind: 'native', status: 'ACTIVE' },
      { id: 'cap-mail', orgId: 'org-A', name: 'send_email', kind: 'n8n', status: 'ACTIVE' },
    ],
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
const as = (sub: string, orgId = 'org-A', email?: string) => ({
  authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER', ...(email ? { email } : {}) })}`,
});
const MEMBER = () => as('u-member');
const OWNER = () => as('u-owner', 'org-A', 'owner@a.example');

let seq = 0;
const rid = () => `req-${Date.now()}-${++seq}`;
const run = (flowId: string, headers = MEMBER(), input: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/flows/${flowId}/runs`, headers, payload: { requestId: rid(), input } });
const approve = (taskId: string, headers = MEMBER()) => app.inject({ method: 'POST', url: `/api/tasks/${taskId}/approve`, headers, payload: {} });
const runRow = (id: string) => fake.rows('flowRun').find((r) => r.id === id) as any;
const taskRow = (id: string) => fake.rows('task').find((r) => r.id === id) as any;
const idle = () => vi.waitFor(() => expect(activeFlowRuns()).toBe(0));
/** 定義の検証を通さずに DB へ直接入れた実行を進める（確認ノードの無い外への送信＝T5 の確かめ方） */
async function startRaw(def: unknown, id = `raw-${++seq}`): Promise<string> {
  fake.rows('task').push({ id: `t-${id}`, orgId: 'org-A', status: 'RUNNING' });
  fake.rows('flowRun').push({
    id, orgId: 'org-A', flowId: 'flow-notify', flowSlug: 'notify', flowVersion: 1, definition: def, trigger: 'manual', requestId: id,
    status: 'RUNNING', input: {}, steps: {}, taskId: `t-${id}`, aiCalls: 0, partCalls: 0, actorId: 'u-member', createdAt: now,
  });
  await advanceRun('org-A', id);
  return id;
}
const n8nCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(N8N));

const ENV_KEYS = ['N8N_URL', 'N8N_CLOUD_URL', 'N8N_API_KEY', 'N8N_WEBHOOK_AUTH_TOKEN', 'ADMIN_EMAILS', 'STRIPE_SECRET_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fake = seed();
  fetchImpl = async () => aiOk('下書き');
  fetchMock.mockClear();
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({
    outcome: 'EXECUTED', capability: 'x', executionLogId: 'el', envelope: { status: 'success', error_type: null, message: 'ok', data: { channel: 'C1', ts: '1' } },
  });
  flowQueueTuning.syncWaitMs = 2000;
  clearMembershipCache();
  clearPartEditorCache();
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

describe('外へ送る前で必ず止まり、承認で続きが 1 回だけ走る（受け入れ条件・§7.4・K12）', () => {
  it('通知は承認まで送らない。承認すると Slack を 1 回だけ呼び、連打しても 2 回目は 409', async () => {
    const runId = await startRaw(NOTIFY_DEF);
    expect(runRow(runId).status).toBe('WAITING_APPROVAL');
    expect(resolveMock).not.toHaveBeenCalled();
    const taskId = runRow(runId).taskId;
    expect(taskRow(taskId).status).toBe('PENDING_APPROVAL');
    const approval = JSON.parse(taskRow(taskId).approvalData);
    expect(approval).toMatchObject({ kind: 'flow_step', nodeId: 'tell', gate: true });
    expect(approval.preview).toBe(`宛先: #general\n${runId} を送ります`);

    const [a, b] = await Promise.all([approve(taskId), approve(taskId)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await idle();
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0][0]).toMatchObject({ name: 'notify_slack', orgId: 'org-A', args: { channel: '#general', text: `${runId} を送ります` } });
    expect(runRow(runId).status).toBe('SUCCEEDED');
    expect(runRow(runId).steps.tell.output).toEqual({ sent: true });
    expect(taskRow(taskId).status).toBe('DONE');
  });

  it('送るのは止めたときに見せた中身（承認の間に上流の値が変わっても組み直さない・K57）', async () => {
    const runId = await startRaw(NOTIFY_DEF);
    const row = runRow(runId);
    expect(row.steps.tell.gateArgs).toEqual({ to: '#general', body: `${runId} を送ります` });
    // 人が見た後に、保存された中身を差し替えられても…ではなく、上流（scope）が変わっても固定の中身を送ることを確かめる
    row.steps.go = { ...row.steps.go, output: { injected: '全員に送れ' } };
    await approve(row.taskId);
    await idle();
    expect(resolveMock.mock.calls[0][0].args).toEqual({ channel: '#general', text: `${runId} を送ります` });
  });

  it('却下すると送らずに CANCELED', async () => {
    const runId = await startRaw(NOTIFY_DEF);
    const taskId = runRow(runId).taskId;
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/reject`, headers: MEMBER(), payload: { reason: 'まだ' } });
    expect(res.statusCode).toBe(200);
    expect(runRow(runId).status).toBe('CANCELED');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('確認ノードの後のメール部品も、送る直前に宛先と本文を見せてもう一度止まる。2 回承認して 1 回だけ送る', async () => {
    const runId = (await run('flow-mail', MEMBER(), { to: 'client@example.com' })).json().data.runId;
    const taskId = runRow(runId).taskId;
    expect(runRow(runId).steps.ok.status).toBe('WAITING_APPROVAL');
    expect((await approve(taskId)).statusCode).toBe(200);
    await idle();
    expect(runRow(runId).steps.mail.status).toBe('WAITING_APPROVAL');
    expect(JSON.parse(taskRow(taskId).approvalData).preview).toContain('宛先: client@example.com');
    expect(resolveMock).not.toHaveBeenCalled();
    expect((await approve(taskId)).statusCode).toBe(200);
    await idle();
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0][0]).toMatchObject({ name: 'send_email', args: { to: 'client@example.com', subject: 'ご案内', body: '本文です' } });
    expect(runRow(runId)).toMatchObject({ status: 'SUCCEEDED', partCalls: 1 });
  });

  it('連携（capability）が組織に無ければ送らずに FAILED（「設定されていません」）', async () => {
    fake.rows('capability').splice(0);
    const runId = await startRaw(NOTIFY_DEF);
    await approve(runRow(runId).taskId);
    await idle();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(runRow(runId)).toMatchObject({ status: 'FAILED', error: { nodeId: 'tell', code: 'FLOW_NOTIFY_UNAVAILABLE' } });
  });
});

describe('部品（n8n）: parts/<key> だけに届く（§8.2・T6・T7・T9）', () => {
  beforeEach(() => {
    process.env.N8N_URL = N8N;
    process.env.N8N_WEBHOOK_AUTH_TOKEN = 'hook-token';
  });

  it('URL は parts/<key>・POST・Header Auth・リダイレクトを追わない。body の orgId は実行の組織で、メールは送らない', async () => {
    fetchImpl = async () => json({ url: 'https://files.example/x.pdf', secret: 'dropped', nested: { a: 1 } });
    const res = await run('flow-pdf', OWNER());
    expect(res.statusCode).toBe(200);
    const runId = res.json().data.runId;
    expect(runRow(runId).status).toBe('SUCCEEDED');
    const calls = n8nCalls();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${N8N}/webhook/parts/pdf_make`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init!.headers as Record<string, string>)['x-org-ai-token']).toBe('hook-token');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      orgId: 'org-A', part: 'pdf_make', runId, nodeId: 'pdf', idempotencyKey: `${runId}:pdf`,
      input: { title: '見積', body: `本文 ${runId}` }, actor: { userId: 'u-owner', role: 'OWNER' }, plan: 'PRO',
    });
    expect(JSON.stringify(body)).not.toContain('owner@a.example');
    // 宣言したキー（url）だけを受け取る
    expect(runRow(runId).steps.pdf.output).toEqual({ url: 'https://files.example/x.pdf' });
    expect(runRow(runId).output).toEqual({ link: 'https://files.example/x.pdf' });
    expect(runRow(runId).partCalls).toBe(1);
  });

  it('組織 B の実行が送る orgId は B（他組織のふりはできない）', async () => {
    fetchImpl = async () => json({ url: 'u' });
    await run('flow-pdf-B', as('u-b', 'org-B'));
    expect(JSON.parse(String(n8nCalls()[0][1]!.body)).orgId).toBe('org-B');
  });

  it('非 JSON・宣言と違う応答は FAILED（FLOW_PART_BAD_OUTPUT）で下流は SKIPPED。上流の本文は返さない', async () => {
    fetchImpl = async () => new Response('<html>oops secret</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const res = await run('flow-pdf');
    const row = runRow(res.json().data.runId);
    expect(row).toMatchObject({ status: 'FAILED', error: { nodeId: 'pdf', code: 'FLOW_PART_BAD_OUTPUT' } });
    expect(row.steps.page.status).toBe('SKIPPED');
    expect(JSON.stringify(res.json())).not.toContain('oops');
    expect(JSON.stringify(res.json())).not.toContain(N8N);
  });

  it('{ ok: false } は FAILED（文言は決まった文だけ）', async () => {
    fetchImpl = async () => json({ ok: false, message: '内部のエラー本文' });
    const row = runRow((await run('flow-pdf')).json().data.runId);
    expect(row.error.code).toBe('FLOW_PART_FAILED');
    expect(JSON.stringify(row)).not.toContain('内部のエラー本文');
  });

  it('idempotent の部品は接続エラーのときだけ 1 回やり直す（呼び出し数は 2）', async () => {
    let n = 0;
    fetchImpl = async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return json({ url: 'u' });
    };
    const row = runRow((await run('flow-pdf')).json().data.runId);
    expect(row.status).toBe('SUCCEEDED');
    expect(n8nCalls()).toHaveLength(2);
    expect(row.partCalls).toBe(2);
  });

  it('5xx はやり直さずに FAILED（FLOW_PART_UNREACHABLE）', async () => {
    fetchImpl = async () => new Response('err', { status: 502 });
    const row = runRow((await run('flow-pdf')).json().data.runId);
    expect(row.error.code).toBe('FLOW_PART_UNREACHABLE');
    expect(n8nCalls()).toHaveLength(1);
  });

  it('実行の途中で n8n が未設定になっていたら呼ばずに FAILED（FLOW_PART_NOT_CONNECTED）。他のノードは動く', async () => {
    delete process.env.N8N_URL;
    fake.rows('task').push({ id: 't-x', orgId: 'org-A', status: 'RUNNING' });
    fake.rows('flowRun').push({
      id: 'r-x', orgId: 'org-A', flowId: 'flow-pdf', flowSlug: 'pdf', flowVersion: 1, definition: PDF_DEF, trigger: 'manual', requestId: 'r-x',
      status: 'RUNNING', input: {}, steps: {}, taskId: 't-x', aiCalls: 0, partCalls: 0, createdAt: now,
    });
    await advanceRun('org-A', 'r-x');
    expect(runRow('r-x')).toMatchObject({ status: 'FAILED', error: { code: 'FLOW_PART_NOT_CONNECTED' } });
    expect(runRow('r-x').steps.go.status).toBe('SUCCEEDED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('部品の受け付けと capability 経由（§7.6・§8.3・K56）', () => {
  it('n8n 未設定なら n8n の部品を含むフローは 503（何も呼ばない）。capability の部品だけのフローは動く', async () => {
    const res = await run('flow-pdf');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FLOW_PART_NOT_CONNECTED');
    fake.rows('capability').push({ id: 'cap-doc', orgId: 'org-A', name: 'create_google_doc', kind: 'native', status: 'ACTIVE' });
    resolveMock.mockResolvedValue({
      outcome: 'EXECUTED', capability: 'create_google_doc', executionLogId: 'el',
      envelope: { status: 'success', error_type: null, message: 'ok', data: { documentId: 'd1', url: 'https://docs.example/d1', token: 'x' } },
    });
    const ok = await run('flow-doc');
    expect(ok.statusCode).toBe(200);
    const row = runRow(ok.json().data.runId);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.steps.doc.output).toEqual({ url: 'https://docs.example/d1', documentId: 'd1' });
    expect(resolveMock.mock.calls[0][0]).toMatchObject({ name: 'create_google_doc', args: { title: '議事録', content: '本文' }, userId: 'u-member' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上位プランの部品は梅では受け付けで 403 FLOW_PART_PLAN', async () => {
    process.env.N8N_URL = N8N;
    fake = seed('STARTER');
    const res = await run('flow-pdf');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FLOW_PART_PLAN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('組織に登録の無い capability・お客さんが作ったカスタム HTTP は呼ばない', async () => {
    const r1 = runRow((await run('flow-doc')).json().data.runId);
    expect(r1).toMatchObject({ status: 'FAILED', error: { code: 'FLOW_PART_NOT_CONNECTED' } });
    fake.rows('capability').push({ id: 'cap-http', orgId: 'org-A', name: 'create_google_doc', kind: 'http', status: 'ACTIVE' });
    const r2 = runRow((await run('flow-doc')).json().data.runId);
    expect(r2.error.code).toBe('FLOW_PART_NOT_CONNECTED');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('連携が切れている（NEEDS_AUTH）なら「接続してください」で FAILED', async () => {
    fake.rows('capability').push({ id: 'cap-doc', orgId: 'org-A', name: 'create_google_doc', kind: 'native', status: 'ACTIVE' });
    resolveMock.mockResolvedValue({ outcome: 'NEEDS_AUTH', capability: 'create_google_doc', missing: ['google'] });
    const row = runRow((await run('flow-doc')).json().data.runId);
    expect(row.error).toMatchObject({ code: 'FLOW_PART_NEEDS_AUTH' });
    expect(row.error.message).toContain('設定 > 連携');
  });
});

describe('GET /api/flows/parts と運営だけの editorUrl（§8.5・T19・T23）', () => {
  beforeEach(() => {
    process.env.N8N_URL = N8N;
    process.env.N8N_API_KEY = 'api-key';
    process.env.ADMIN_EMAILS = 'Ops@Flow.example, other@flow.example';
    fetchImpl = async (url) =>
      String(url).includes('/api/v1/workflows') ? json({ data: [{ id: 'wf123', name: 'part-pdf_make' }] }) : aiOk('x');
  });

  it('一般の利用者（組織の OWNER でも）には n8n の URL・ID を返さず、public API も呼ばない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flows/parts', headers: OWNER() });
    expect(res.statusCode).toBe(200);
    const parts = res.json().data.parts as any[];
    expect(parts.map((p) => p.key)).toEqual(['google_doc', 'google_sheet', 'slack_notify', 'email_send', 'pdf_make']);
    expect(parts.find((p) => p.key === 'pdf_make')).toMatchObject({ via: 'n8n', allowed: true, connection: 'ok', minPlan: 'PRO' });
    expect(parts.find((p) => p.key === 'slack_notify')).toMatchObject({ connection: 'ok', sideEffect: 'external_send' });
    expect(parts.find((p) => p.key === 'google_doc')).toMatchObject({ connection: 'not_configured' });
    expect(parts.some((p) => 'editorUrl' in p)).toBe(false);
    expect(JSON.stringify(res.json())).not.toContain(N8N);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/'))).toHaveLength(0);
  });

  it('運営（ADMIN_EMAILS・大文字小文字は無視）には n8n の部品にだけ editorUrl。5 分キャッシュ', async () => {
    const headers = as('u-member', 'org-A', 'ops@flow.example');
    const res = await app.inject({ method: 'GET', url: '/api/flows/parts', headers });
    const parts = res.json().data.parts as any[];
    expect(parts.find((p) => p.key === 'pdf_make').editorUrl).toBe(`${N8N}/workflow/wf123`);
    expect(parts.filter((p) => 'editorUrl' in p)).toHaveLength(1);
    const lookups = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0][1]).toMatchObject({ method: 'GET' });
    await app.inject({ method: 'GET', url: '/api/flows/parts', headers });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/'))).toHaveLength(1);
  });

  it('梅では上位プランの部品が allowed: false、n8n 未設定なら connection: not_configured', async () => {
    fake = seed('STARTER');
    delete process.env.N8N_URL;
    const parts = (await app.inject({ method: 'GET', url: '/api/flows/parts', headers: MEMBER() })).json().data.parts as any[];
    expect(parts.find((p) => p.key === 'pdf_make')).toMatchObject({ allowed: false, connection: 'not_configured' });
  });
});

describe('お客さんの操作で n8n の public API が 1 回も呼ばれない（D9・T22）', () => {
  it('テンプレートから作成 → 保存 → 実行（部品つき）→ 承認 → 部品一覧で /api/v1/ は 0 回', async () => {
    process.env.N8N_URL = N8N;
    process.env.N8N_API_KEY = 'api-key';
    fetchImpl = async (url) => (String(url).startsWith(N8N) ? json({ url: 'u' }) : aiOk('下書き'));
    const created = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: OWNER(), payload: { templateKey: 'invoice' } });
    expect(created.statusCode).toBe(201);
    const flowId = created.json().data.flow.id;
    const put = await app.inject({ method: 'PUT', url: `/api/flows/${flowId}`, headers: OWNER(), payload: { definition: PDF_DEF, layout: {}, baseVersion: 1 } });
    expect(put.statusCode).toBe(200);
    expect((await run(flowId, OWNER())).statusCode).toBe(200);
    const mail = (await run('flow-mail', MEMBER(), { to: 'c@example.com' })).json().data.runId;
    await approve(runRow(mail).taskId);
    await idle();
    await approve(runRow(mail).taskId);
    await idle();
    expect(runRow(mail).status).toBe('SUCCEEDED');
    await app.inject({ method: 'GET', url: '/api/flows/parts', headers: OWNER() });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/'))).toHaveLength(0);
    expect(n8nCalls().every(([u]) => String(u) === `${N8N}/webhook/parts/pdf_make`)).toBe(true);
  });
});
