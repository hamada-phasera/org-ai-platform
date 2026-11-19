/* eslint-disable @typescript-eslint/no-explicit-any -- 応答の JSON を読むテスト */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { cloneFlowTemplate, defaultFlowPageDefinition, flowMonthStartUtc, type FlowDefinition } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { HEADING_DEFINITION, orgRow, pageRow, userAndMembership } from '../pages/fixtures';

// 業務フローの結果ページ（docs/design/canvas-home.md §3.5・§6.3・チャンク 9）。
// 出力ビルダーの取得・保存（/api/flows/:id/page）と、/p/:slug の flow_query / flow_submit。
// 本物の requireAuth / tenantDb / ランナー / キューを通し、DB だけを偽 Prisma に。n8n・LLM には接続しない（fetch はモック）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));
const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
vi.stubGlobal('fetch', fetchMock);

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { flowRoutes } = await import('../../src/routes/flows');
const { pageRoutes } = await import('../../src/routes/pages');
const { flowQueueTuning, activeFlowRuns } = await import('../../src/services/flows/queue');
const { jobs } = await import('../../src/services/lifecycle-core');

const SECRET = 'flow-page-route-test-secret-32-chars!!';
const now = new Date();

/** フォーム（金額）→ 分岐 → yes: 出力（ページ）/ no: 商談の一覧。AI も承認も無い */
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
} as unknown as FlowDefinition;

function flowRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: '分岐', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: null, templateVersion: null,
    version: 1, schemaVersion: 1, definition: BRANCH_DEF, definitionHash: 'h', layout: {},
    createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    ...over,
  };
}

function seed(plan = 'STARTER'): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-admin', 'org-A', 'ADMIN'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A', { plan, name: 'A 社' }), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    flow: [
      flowRow({ id: 'flow-a', orgId: 'org-A', slug: 'branch' }),
      flowRow({ id: 'flow-owner', orgId: 'org-A', slug: 'owner-only', minRole: 'OWNER' }),
      flowRow({ id: 'flow-p', orgId: 'org-A', slug: 'proposal', name: '提案書', templateKey: 'proposal', definition: cloneFlowTemplate('proposal').definition }),
      flowRow({ id: 'flow-B', orgId: 'org-B', slug: 'branch' }),
    ],
    flowVersion: [],
    flowRun: [],
    task: [],
    taskLog: [],
    deal: [],
    // 梅のページ上限（1）をすでに使っている（結果ページは数えない＝K15）
    customPage: [pageRow({ id: 'page-n8n', orgId: 'org-A', slug: 'inquiries', definition: HEADING_DEFINITION })],
    pageActionLog: [],
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
  await a.register(pageRoutes, { prefix: '/api/pages' });
  await a.ready();
  return a;
}
const as = (sub: string, orgId = 'org-A') => ({ authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER' })}` });
const OWNER = () => as('u-owner');
const ADMIN = () => as('u-admin');
const MEMBER = () => as('u-member');
const B = () => as('u-b', 'org-B');

const uuid = () => globalThis.crypto.randomUUID();
const pageOf = (flowId: string) => fake.rows('customPage').find((p) => p.flowId === flowId) as any;
const idle = () => vi.waitFor(() => expect(activeFlowRuns()).toBe(0));

function savePage(flowId: string, body: Record<string, unknown>, headers = ADMIN()) {
  return app.inject({ method: 'PUT', url: `/api/flows/${flowId}/page`, headers, payload: body });
}
async function createDefaultPage(flowId = 'flow-a', def: FlowDefinition = BRANCH_DEF, name = '分岐') {
  const res = await savePage(flowId, { definition: defaultFlowPageDefinition(def, name) }, OWNER());
  expect(res.statusCode).toBe(201);
  return res.json().data;
}
function submit(slug: string, input: Record<string, unknown>, headers = MEMBER(), blockIndex = 1) {
  return app.inject({
    method: 'POST',
    url: `/api/pages/${slug}/actions/run`,
    headers,
    payload: { input, requestId: uuid(), origin: { blockIndex } },
  });
}

const ENV_KEYS = ['N8N_URL', 'N8N_CLOUD_URL', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fake = seed();
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

describe('GET /api/flows/:id/page（出力ビルダーが開くもの）', () => {
  it('ページが無ければ null と最初の案・選べるデータ・プレビューの値', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flows/flow-a/page', headers: ADMIN() });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.page).toBeNull();
    expect(d.draft.blocks[1]).toMatchObject({ type: 'form', action: 'run', fields: [{ key: 'amount' }] });
    expect(d.sources.map((s: any) => s.key)).toEqual(['size', 'runs']);
    expect(d.preview).toEqual({ raw: { size: null, runs: [] }, hasRun: false });
  });
  it('MEMBER は 403（requireAdmin）。役割の足りないフロー・他組織は 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/flows/flow-a/page', headers: MEMBER() })).statusCode).toBe(403);
    for (const [url, h] of [
      ['/api/flows/flow-owner/page', ADMIN()],
      ['/api/flows/flow-a/page', B()],
    ] as const) {
      const res = await app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('PUT /api/flows/:id/page（出力ビルダーの保存）', () => {
  it('最初の保存でページができる（source=FLOW・公開・役割はフローと同じ）。梅のページ上限に数えない', async () => {
    const data = await createDefaultPage();
    expect(data).toMatchObject({ slug: 'branch', version: 1, status: 'PUBLISHED', created: true });
    const page = pageOf('flow-a');
    expect(page).toMatchObject({ orgId: 'org-A', source: 'FLOW', flowId: 'flow-a', minRole: 'MEMBER', title: '分岐' });
    expect(fake.rows('auditEvent').some((e: any) => e.action === 'page.upsert' && e.meta.flowId === 'flow-a')).toBe(true);

    // 設定画面のページ数にも数えない
    const list = await app.inject({ method: 'GET', url: '/api/pages/admin/list', headers: ADMIN() });
    expect(list.json().data.pageCount).toBe(1);
    expect(list.json().data.pages.find((p: any) => p.slug === 'branch')).toMatchObject({ source: 'FLOW', flowId: 'flow-a' });
  });

  it('フォームの項目はきっかけの項目で上書きされる（二重に定義しない）', async () => {
    const def = defaultFlowPageDefinition(BRANCH_DEF, 'x');
    (def.blocks[1] as any).fields = [{ key: 'other', label: '別', type: 'text' }];
    const res = await savePage('flow-a', { definition: def });
    expect(res.statusCode).toBe(201);
    expect(pageOf('flow-a').definition.blocks[1].fields).toEqual([{ key: 'amount', label: '金額', type: 'number', required: true }]);
  });

  it('フローの出力に無いキー・n8n のアクション・行の操作は 400 FLOW_PAGE_INVALID（issues 付き）', async () => {
    const def = defaultFlowPageDefinition(BRANCH_DEF, 'x');
    const bad1 = { ...def, blocks: [...def.blocks, { type: 'kpi', items: [{ label: '秘密', source: { action: 'result', key: 'secret' } }] }] };
    const r1 = await savePage('flow-a', { definition: bad1 });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe('FLOW_PAGE_INVALID');
    expect(r1.json().error.issues[0].message).toContain('secret');

    const bad2 = { blocks: [{ type: 'kpi', items: [{ label: 'x', source: { action: 'q', key: 'size' } }] }], actions: { q: { kind: 'query', hook: 'pages-hook' } } };
    const r2 = await savePage('flow-a', { definition: bad2 });
    expect(r2.statusCode).toBe(400);
    expect(pageOf('flow-a')).toBeUndefined();
  });

  it('版が違えば 409（他人の保存を上書きしない）。同じ内容なら版は上がらない', async () => {
    await createDefaultPage();
    const def = defaultFlowPageDefinition(BRANCH_DEF, '分岐');
    const stale = await savePage('flow-a', { definition: def, baseVersion: 9 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('FLOW_PAGE_CONFLICT');
    const same = await savePage('flow-a', { definition: def, baseVersion: 1 });
    expect(same.json().data).toMatchObject({ version: 1, changed: false });
    const changed = await savePage('flow-a', { definition: { ...def, blocks: def.blocks.slice(0, 2) }, baseVersion: 1 });
    expect(changed.json().data).toMatchObject({ version: 2, changed: true });
  });

  it('MEMBER は保存できない（403）。他組織のフローにも作れない（404）', async () => {
    const def = defaultFlowPageDefinition(BRANCH_DEF, 'x');
    expect((await savePage('flow-a', { definition: def }, MEMBER())).statusCode).toBe(403);
    expect((await savePage('flow-a', { definition: def }, B())).statusCode).toBe(404);
    expect(fake.rows('customPage').filter((p) => p.source === 'FLOW')).toHaveLength(0);
  });

  it('slug が業務ページと重なれば <slug>-out にする', async () => {
    fake.rows('customPage').push(pageRow({ id: 'page-dup', orgId: 'org-A', slug: 'branch', definition: HEADING_DEFINITION }));
    const data = await createDefaultPage();
    expect(data.slug).toBe('branch-out');
  });
});

describe('/p/:slug の flow_query / flow_submit（受け入れ条件: ページのフォームからフローが走り、1 回だけ数える）', () => {
  it('フォームから実行 → 完了。FlowRun が 1 行（trigger=page）、PageActionLog は書かない。結果と履歴が読める。n8n は呼ばない', async () => {
    await createDefaultPage();
    const got = await app.inject({ method: 'GET', url: '/api/pages/branch', headers: MEMBER() });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.connection).toBe('ok');
    expect(got.json().data.definition.actions).toEqual({ result: { kind: 'flow_query' }, run: { kind: 'flow_submit' } });
    expect(got.json().data.usage).toMatchObject({ used: 0, limit: 300 });

    const res = await submit('branch', { amount: 500 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ ok: true, status: 'SUCCEEDED', message: '完了しました', sample: false });
    const runs = fake.rows('flowRun');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ orgId: 'org-A', flowId: 'flow-a', trigger: 'page', actorId: 'u-member', status: 'SUCCEEDED' });
    expect(fake.rows('pageActionLog')).toHaveLength(0);

    const data = await app.inject({ method: 'GET', url: '/api/pages/branch/data/result', headers: MEMBER() });
    expect(data.statusCode).toBe(200);
    const blocks = data.json().data.blocks;
    expect(blocks.find((b: any) => b.type === 'kpi').values).toEqual({ 0: '大口 500' });
    const history = blocks.find((b: any) => b.type === 'table');
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].cells).toMatchObject({ status: '完了', size: '大口 500' });

    // 月間実行数にだけ 1 回数える
    const again = await app.inject({ method: 'GET', url: '/api/pages/branch', headers: MEMBER() });
    expect(again.json().data.usage.used).toBe(1);
    expect((fetchMock.mock.calls as unknown[][]).some(([u]) => String(u).includes('/webhook/'))).toBe(false);
  });

  it('入力の検査（必須・型）は 400。定義に無い項目も 400', async () => {
    await createDefaultPage();
    expect((await submit('branch', {})).statusCode).toBe(400);
    expect((await submit('branch', { amount: 'x' })).statusCode).toBe(400);
    expect((await submit('branch', { amount: 1, extra: 'y' })).statusCode).toBe(400);
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('月間実行数の上限で 429 FLOW_RUN_LIMIT（ページの上限ではなくフローの上限）', async () => {
    await createDefaultPage();
    const month = flowMonthStartUtc(new Date());
    for (let i = 0; i < 300; i++) {
      fake.rows('flowRun').push({
        id: `old-${i}`, orgId: 'org-A', flowId: 'flow-a', flowSlug: 'branch', flowVersion: 1, definition: {}, trigger: 'manual',
        actorId: null, requestId: `old-${i}`, status: 'SUCCEEDED', input: {}, steps: {}, output: null, error: null,
        partCalls: 0, aiCalls: 0, taskId: null, lockedAt: null, startedAt: month, finishedAt: month, durationMs: 1, createdAt: month,
      });
    }
    const res = await submit('branch', { amount: 1 });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('FLOW_RUN_LIMIT');
    // 閲覧（flow_query）は止めない
    expect((await app.inject({ method: 'GET', url: '/api/pages/branch/data/result', headers: MEMBER() })).statusCode).toBe(200);
  });

  it('同じ requestId の二重送信は 409', async () => {
    await createDefaultPage();
    const payload = { input: { amount: 1 }, requestId: uuid(), origin: { blockIndex: 1 } };
    const first = await app.inject({ method: 'POST', url: '/api/pages/branch/actions/run', headers: MEMBER(), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/pages/branch/actions/run', headers: MEMBER(), payload });
    expect(second.statusCode).toBe(409);
    expect(fake.rows('flowRun')).toHaveLength(1);
  });

  it('フローが見えない役割なら、ページが見えても取得・実行は 404', async () => {
    await createDefaultPage('flow-owner');
    const page = pageOf('flow-owner');
    page.minRole = 'MEMBER';
    expect((await app.inject({ method: 'GET', url: `/api/pages/${page.slug}/data/result`, headers: MEMBER() })).statusCode).toBe(404);
    expect((await submit(page.slug, { amount: 1 })).statusCode).toBe(404);
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('他組織からは見えない・叩けない。A のページの flowId が B のフローを指していても B は走らない', async () => {
    await createDefaultPage();
    expect((await app.inject({ method: 'GET', url: '/api/pages/branch', headers: B() })).statusCode).toBe(404);
    expect((await submit('branch', { amount: 1 }, B())).statusCode).toBe(404);
    pageOf('flow-a').flowId = 'flow-B';
    expect((await submit('branch', { amount: 1 })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/pages/branch/data/result', headers: MEMBER() })).statusCode).toBe(404);
    expect(fake.rows('flowRun')).toHaveLength(0);
  });

  it('結果ページの定義は手動の upsert・削除で触れない（409）。公開・役割の変更（PATCH）は通る', async () => {
    await createDefaultPage();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/pages/branch',
      headers: ADMIN(),
      payload: { title: '上書き', definition: HEADING_DEFINITION },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe('PAGE_SOURCE_CONFLICT');
    expect((await app.inject({ method: 'DELETE', url: '/api/pages/branch', headers: ADMIN() })).statusCode).toBe(409);
    const patch = await app.inject({ method: 'PATCH', url: '/api/pages/branch', headers: ADMIN(), payload: { status: 'DRAFT' } });
    expect(patch.statusCode).toBe(200);
    expect(pageOf('flow-a').source).toBe('FLOW');
  });

  it('梅で結果ページがあっても、手動の業務ページは 1 つ目として作れる（結果ページを数えない）', async () => {
    fake.rows('customPage').splice(0);
    await createDefaultPage();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/pages/manual-one',
      headers: ADMIN(),
      payload: { title: '手動', definition: HEADING_DEFINITION },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('フローの保存に結果ページが追従する', () => {
  it('きっかけの項目を変えるとページのフォームも変わり、版が上がる。役割を上げるとページも上がる', async () => {
    await createDefaultPage();
    const def = JSON.parse(JSON.stringify(BRANCH_DEF));
    def.nodes[0].config.fields.push({ key: 'note', label: 'メモ', type: 'text' });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/flows/flow-a',
      headers: ADMIN(),
      payload: { definition: def, layout: {}, baseVersion: 1, minRole: 'ADMIN' },
    });
    expect(put.statusCode).toBe(200);
    const page = pageOf('flow-a');
    expect(page.version).toBe(2);
    expect(page.definition.blocks[1].fields.map((f: any) => f.key)).toEqual(['amount', 'note']);
    expect(page.minRole).toBe('ADMIN');
  });

  it('フローを消すと結果ページも消える', async () => {
    await createDefaultPage();
    const del = await app.inject({ method: 'DELETE', url: '/api/flows/flow-a', headers: ADMIN() });
    expect(del.statusCode).toBe(200);
    expect(pageOf('flow-a')).toBeUndefined();
  });

  it('提案書テンプレート（出力ノード無し）でも、履歴と実行フォームのページが作れる', async () => {
    const res = await savePage('flow-p', { definition: defaultFlowPageDefinition(cloneFlowTemplate('proposal').definition, '提案書') });
    expect(res.statusCode).toBe(201);
    expect(pageOf('flow-p').definition.blocks.map((b: any) => b.type)).toEqual(['heading', 'form', 'table']);
  });
});
