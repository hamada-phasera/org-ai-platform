/* eslint-disable @typescript-eslint/no-explicit-any -- 応答の JSON を読むテスト */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { DEFAULT_CANVAS_LAYOUT, FLOW_LIMITS, FLOW_TEMPLATES, cloneFlowTemplate } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { orgRow, userAndMembership } from '../pages/fixtures';

// ホームキャンバスと業務フローの取得・保存 API（docs/design/canvas-home.md §7.1・チャンク 4）。
// 本物の requireAuth / requireRole / tenantDb を通し、DB だけを偽 Prisma に差し替える。外部（n8n 等）は呼ばない。

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
const { canvasRoutes } = await import('../../src/routes/canvas');
const { flowRoutes } = await import('../../src/routes/flows');

const SECRET = 'flows-route-test-secret-32-chars-long!!';
const now = new Date('2026-11-10T00:00:00Z');
const PROPOSAL = FLOW_TEMPLATES.proposal;

function flowRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'フロー', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: null, templateVersion: null,
    version: 1, schemaVersion: 1, definition: PROPOSAL.definition, definitionHash: 'h', layout: PROPOSAL.layout,
    createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    ...over,
  };
}

function seed(plan = 'PRO'): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-admin', 'org-A', 'ADMIN'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A', { plan }), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    canvas: [],
    flow: [
      flowRow({ id: 'flow-mine', orgId: 'org-A', slug: 'mine', name: '自作' }),
      flowRow({ id: 'flow-owner', orgId: 'org-A', slug: 'owner-only', name: '経営', minRole: 'OWNER' }),
      flowRow({ id: 'flow-B', orgId: 'org-B', slug: 'proposal', name: 'B提案', templateKey: 'proposal' }),
    ],
    flowVersion: [],
    flowRun: [],
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
  await a.register(canvasRoutes, { prefix: '/api/canvas' });
  await a.register(flowRoutes, { prefix: '/api/flows' });
  await a.ready();
  return a;
}
const as = (sub: string, orgId = 'org-A') => ({ authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER' })}` });
const OWNER = () => as('u-owner');
const ADMIN = () => as('u-admin');
const MEMBER = () => as('u-member');

const ENV_KEYS = ['N8N_URL', 'N8N_CLOUD_URL', 'N8N_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fake = seed();
  fetchMock.mockClear();
  clearMembershipCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  if (!app) app = await build();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

const audits = (action: string) => fake.rows('auditEvent').filter((e) => e.action === action);
const flowsOfA = () => fake.rows('flow').filter((f) => f.orgId === 'org-A');

describe('GET /api/canvas', () => {
  it('行が無い組織には既定の配置（version 0）が返り、DB には何も書かない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canvas', headers: MEMBER() });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.layout).toEqual(DEFAULT_CANVAS_LAYOUT);
    expect(d.version).toBe(0);
    expect(d.isDefault).toBe(true);
    expect(fake.rows('canvas')).toHaveLength(0);
  });

  it('フローの一覧は見られるものだけ（メンバーにオーナー限定は出ない・他組織は出ない）', async () => {
    const m = (await app.inject({ method: 'GET', url: '/api/canvas', headers: MEMBER() })).json().data.flows.map((f: any) => f.id);
    expect(m).toEqual(['flow-mine']);
    const o = (await app.inject({ method: 'GET', url: '/api/canvas', headers: OWNER() })).json().data.flows.map((f: any) => f.id);
    expect(o).toEqual(['flow-mine', 'flow-owner']);
  });

  it('認証なしは 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/canvas' })).statusCode).toBe(401);
  });
});

describe('PUT /api/canvas', () => {
  const layout = () => JSON.parse(JSON.stringify(DEFAULT_CANVAS_LAYOUT));

  it('ADMIN は保存でき、版が 1 → 2 と進む。監査が残る', async () => {
    const l = layout();
    l.nodes[0].x = 33.4;
    const r1 = await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: l, baseVersion: 0 } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data).toEqual({ version: 1, changed: true });
    expect((fake.rows('canvas')[0].layout as any).nodes[0].x).toBe(33);
    const r2 = await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: { ...l, edges: [] }, baseVersion: 1 } });
    expect(r2.json().data.version).toBe(2);
    expect(audits('canvas.update')).toHaveLength(2);
  });

  it('同じ内容は版を上げない', async () => {
    await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: layout(), baseVersion: 0 } });
    const r = await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: layout(), baseVersion: 1 } });
    expect(r.json().data).toEqual({ version: 1, changed: false });
  });

  it('古い版での保存は 409 CANVAS_CONFLICT（上書きしない）', async () => {
    await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: layout(), baseVersion: 0 } });
    const before = fake.snapshot();
    const r = await app.inject({ method: 'PUT', url: '/api/canvas', headers: OWNER(), payload: { layout: { ...layout(), edges: [] }, baseVersion: 0 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CANVAS_CONFLICT');
    expect(fake.snapshot()).toBe(before);
  });

  it('メンバーは 403', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/canvas', headers: MEMBER(), payload: { layout: layout(), baseVersion: 0 } });
    expect(r.statusCode).toBe(403);
    expect(fake.rows('canvas')).toHaveLength(0);
  });

  it('外部 URL・javascript: の行き先は 400', async () => {
    for (const to of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/admin']) {
      const l = layout();
      l.nodes[0].target = { kind: 'link', to };
      const r = await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: l, baseVersion: 0 } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('他組織・存在しないフローを指すノードは 400（T1）', async () => {
    for (const flowId of ['flow-B', 'nope']) {
      const l = layout();
      l.nodes[1].target = { kind: 'flow', flowId };
      const r = await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: l, baseVersion: 0 } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('CANVAS_INVALID_TARGET');
    }
    const l = layout();
    l.nodes[1].target = { kind: 'flow', flowId: 'flow-mine' };
    expect((await app.inject({ method: 'PUT', url: '/api/canvas', headers: ADMIN(), payload: { layout: l, baseVersion: 0 } })).statusCode).toBe(200);
  });
});

describe('POST /api/flows/from-template', () => {
  it('テンプレートをそのまま複製して作り、キャンバスのノードを flow に書き換える（201）', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal', canvasNodeId: 'proposal' },
    });
    expect(r.statusCode).toBe(201);
    const d = r.json().data;
    expect(d.created).toBe(true);
    expect(d.canvasUpdated).toBe(true);
    const row = fake.rows('flow').find((f) => f.id === d.flow.id)!;
    expect(row.orgId).toBe('org-A');
    expect(row.slug).toBe('proposal');
    expect(row.definition).toEqual(cloneFlowTemplate('proposal').definition);
    expect(row.templateVersion).toBe(PROPOSAL.version);
    expect(fake.rows('flowVersion').filter((v) => v.flowId === row.id)).toHaveLength(1);
    const canvas = fake.rows('canvas').find((c) => c.orgId === 'org-A')!;
    const node = (canvas.layout as any).nodes.find((n: any) => n.id === 'proposal');
    expect(node.target).toEqual({ kind: 'flow', flowId: row.id });
    expect(audits('flow.create')).toHaveLength(1);
    expect(audits('flow.create')[0].meta).toEqual({ flowId: row.id, slug: 'proposal', version: 1 });
  });

  it('2 回押してもフローは 1 つ（2 回目は 200・created: false）。B の同じ slug には触れない', async () => {
    const p = { templateKey: 'proposal', canvasNodeId: 'proposal' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: p }),
      app.inject({ method: 'POST', url: '/api/flows/from-template', headers: OWNER(), payload: p }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().data.flow.id).toBe(b.json().data.flow.id);
    expect(flowsOfA().filter((f) => f.slug === 'proposal')).toHaveLength(1);
    expect(fake.rows('flow').find((f) => f.id === 'flow-B')!.orgId).toBe('org-B');
  });

  it('sns_post の slug は sns-post', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'sns_post' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.flow.slug).toBe('sns-post');
    expect(r.json().data.canvasUpdated).toBe(false);
  });

  it('未知のテンプレート・違うテンプレートのノードは書き換えない', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'x' } })).statusCode).toBe(400);
    const r = await app.inject({
      method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'estimate', canvasNodeId: 'proposal' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.canvasUpdated).toBe(false);
    expect(fake.rows('canvas')).toHaveLength(0);
  });

  it('LLM も n8n も呼ばない（fetch 0 回）', async () => {
    await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'invoice' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('既にあるフローが自分より上の役割限定なら、キャンバスを書き換えずに 404（レビュー指摘 11）', async () => {
    fake.rows('flow').push(flowRow({ id: 'flow-p-owner', orgId: 'org-A', slug: 'proposal', name: '提案', templateKey: 'proposal', minRole: 'OWNER' }));
    const before = JSON.stringify(fake.rows('canvas'));
    const r = await app.inject({
      method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal', canvasNodeId: 'proposal' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.stringify(fake.rows('canvas'))).toBe(before);
    expect(audits('canvas.update')).toHaveLength(0);
    const owner = await app.inject({
      method: 'POST', url: '/api/flows/from-template', headers: OWNER(), payload: { templateKey: 'proposal', canvasNodeId: 'proposal' },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.canvasUpdated).toBe(true);
  });

  it('メンバーは 403', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: MEMBER(), payload: { templateKey: 'proposal' } });
    expect(r.statusCode).toBe(403);
    expect(flowsOfA()).toHaveLength(2);
  });

  it('フロー数の上限で 403 FLOW_LIMIT_REACHED。既にあるテンプレートは上限でも返す', async () => {
    fake = seed('STARTER');
    // 梅は 3 つ。既に 2 つあるので 1 つ作ると上限
    expect((await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal' } })).statusCode).toBe(201);
    expect(flowsOfA()).toHaveLength(FLOW_LIMITS.STARTER.maxFlows);
    const r = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'estimate' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FLOW_LIMIT_REACHED');
    const again = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal' } });
    expect(again.statusCode).toBe(200);
    const empty = await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: '新規' } });
    expect(empty.statusCode).toBe(403);
    expect(flowsOfA()).toHaveLength(FLOW_LIMITS.STARTER.maxFlows);
  });
});

describe('POST /api/flows（空のフロー）', () => {
  it('きっかけ → 出力 の 2 ノードで作る', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: '日報', icon: 'clipboard-list' } });
    expect(r.statusCode).toBe(201);
    const row = fake.rows('flow').find((f) => f.id === r.json().data.flow.id)!;
    expect((row.definition as any).nodes.map((n: any) => n.type)).toEqual(['trigger', 'output']);
    expect(row.slug).toMatch(/^f-[a-z0-9-]+$/);
  });

  it('テンプレートの slug・使用中の slug・自分より上の minRole は断る', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: 'x', slug: 'proposal' } })).statusCode).toBe(400);
    const dup = await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: 'x', slug: 'mine' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('FLOW_SLUG_TAKEN');
    expect((await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: 'x', minRole: 'OWNER' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/flows', headers: ADMIN(), payload: { name: 'x', extra: 1 } })).statusCode).toBe(400);
  });
});

describe('GET /api/flows と /api/flows/:id', () => {
  it('一覧は minRole を満たすものだけ。利用状況つき', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/flows', headers: MEMBER() });
    expect(r.json().data.flows.map((f: any) => f.id)).toEqual(['flow-mine']);
    expect(r.json().data.usage.flows).toEqual({ count: 2, limit: FLOW_LIMITS.PRO.maxFlows });
    expect(r.json().data.usage.runs.used).toBe(0);
  });

  it('定義・配置・版・編集できるか・接続を返す。n8n の URL は入らない', async () => {
    process.env.N8N_URL = 'https://n8n.secret.example';
    const r = await app.inject({ method: 'GET', url: '/api/flows/flow-mine', headers: ADMIN() });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.definition).toEqual(PROPOSAL.definition);
    expect(d.valid).toBe(true);
    expect(d.canEdit).toBe(true);
    expect(d.connection).toEqual({ n8n: 'ok' });
    expect(r.body).not.toContain('n8n.secret.example');
    const m = await app.inject({ method: 'GET', url: '/api/flows/flow-mine', headers: MEMBER() });
    expect(m.json().data.canEdit).toBe(false);
  });

  it('役割不足・他組織・形の違う id はすべて 404', async () => {
    for (const [url, h] of [
      ['/api/flows/flow-owner', MEMBER()],
      ['/api/flows/flow-owner', ADMIN()],
      ['/api/flows/flow-B', OWNER()],
      ['/api/flows/..%2Fx', OWNER()],
    ] as const) {
      const r = await app.inject({ method: 'GET', url, headers: h });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
    }
  });
});

describe('PUT /api/flows/:id', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    definition: cloneFlowTemplate('proposal').definition,
    layout: PROPOSAL.layout,
    baseVersion: 1,
    ...over,
  });

  it('定義が変われば版 +1・FlowVersion が 1 行・監査。位置だけなら版は上がらない', async () => {
    const def = cloneFlowTemplate('proposal').definition;
    (def.nodes[1] as any).label = '作文';
    const r = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ definition: def }) });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ version: 2, changed: true });
    expect(fake.rows('flowVersion').filter((v) => v.flowId === 'flow-mine').map((v) => v.version)).toEqual([2]);
    expect(audits('flow.update')[0].meta).toMatchObject({ flowId: 'flow-mine', slug: 'mine', version: 2 });
    expect(JSON.stringify(audits('flow.update')[0].meta)).not.toContain('作文');

    const moved = { ...PROPOSAL.layout, form: { x: 50, y: 0 }, ghost: { x: 1, y: 1 } };
    const r2 = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ definition: def, layout: moved, baseVersion: 2 }) });
    expect(r2.json().data).toMatchObject({ version: 2, changed: true, changedFields: ['layout'] });
    const row = fake.rows('flow').find((f) => f.id === 'flow-mine')!;
    expect((row.layout as any).form).toEqual({ x: 50, y: 0 });
    expect((row.layout as any).ghost).toBeUndefined();
  });

  it('同じ内容は何も書かない', async () => {
    // 最初の保存でハッシュが入る
    await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body() });
    const before = fake.snapshot();
    const v = fake.rows('flow').find((f) => f.id === 'flow-mine')!.version as number;
    const r = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ baseVersion: v }) });
    expect(r.json().data.changed).toBe(false);
    expect(fake.snapshot()).toBe(before);
  });

  it('古い版は 409 FLOW_CONFLICT', async () => {
    const before = fake.snapshot();
    const r = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ baseVersion: 7 }) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('FLOW_CONFLICT');
    expect(fake.snapshot()).toBe(before);
  });

  it('壊れた定義（循環・未知の型・承認なしの送信）は 400 FLOW_INVALID_DEFINITION で場所を返す', async () => {
    const loop = cloneFlowTemplate('proposal').definition;
    loop.edges.push({ from: 'doc', to: 'draft' });
    const unknown = cloneFlowTemplate('proposal').definition as any;
    unknown.nodes[1] = { id: 'draft', type: 'code', label: 'x', config: { js: 'process.exit()' } };
    const send = cloneFlowTemplate('proposal').definition as any;
    send.nodes[3] = { id: 'doc', type: 'output', label: '送信', config: { kind: 'notify', channel: 'email', body: 'x' } };
    send.edges = [{ from: 'form', to: 'draft' }, { from: 'draft', to: 'doc' }, { from: 'form', to: 'check' }];
    for (const def of [loop, unknown, send]) {
      const r = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ definition: def }) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('FLOW_INVALID_DEFINITION');
      expect(Array.isArray(r.json().error.issues)).toBe(true);
    }
    expect(fake.rows('flow').find((f) => f.id === 'flow-mine')!.version).toBe(1);
  });

  it('メンバーは 403、オーナー限定のフローは ADMIN に 404、自分より上の minRole は 403', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: MEMBER(), payload: body() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/flows/flow-owner', headers: ADMIN(), payload: body() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ minRole: 'OWNER' }) })).statusCode).toBe(403);
  });

  it('21 版目以降は古い版を消す（直近 20 版）', async () => {
    let def = cloneFlowTemplate('proposal').definition;
    for (let v = 1; v <= 22; v++) {
      def = JSON.parse(JSON.stringify(def));
      (def.nodes[2] as any).config.message = `確認 ${v}`;
      const r = await app.inject({ method: 'PUT', url: '/api/flows/flow-mine', headers: ADMIN(), payload: body({ definition: def, baseVersion: v }) });
      expect(r.statusCode).toBe(200);
    }
    const versions = fake.rows('flowVersion').filter((v) => v.flowId === 'flow-mine').map((v) => v.version as number);
    expect(versions).toHaveLength(20);
    expect(Math.min(...versions)).toBe(4);
    expect(Math.max(...versions)).toBe(23);
  });
});

describe('PATCH /api/flows/:id', () => {
  it('無効にすると flow.disable の監査、版は上がらない', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/flows/flow-mine', headers: ADMIN(), payload: { enabled: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.version).toBe(1);
    expect(fake.rows('flow').find((f) => f.id === 'flow-mine')!.enabled).toBe(false);
    expect(audits('flow.disable')).toHaveLength(1);
    expect(audits('flow.update')).toHaveLength(0);
  });

  it('1 ノードの文字項目は変えられ、版が上がる。構造の項目・無い項目は 400', async () => {
    const ok = await app.inject({
      method: 'PATCH', url: '/api/flows/flow-mine', headers: ADMIN(),
      payload: { baseVersion: 1, node: { id: 'check', label: '社長確認', config: { message: '出してよいですか' } } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.version).toBe(2);
    const node = (fake.rows('flow').find((f) => f.id === 'flow-mine')!.definition as any).nodes.find((n: any) => n.id === 'check');
    expect(node).toMatchObject({ label: '社長確認', config: { message: '出してよいですか' } });

    for (const n of [
      { id: 'draft', config: { op: 'classify' } },
      { id: 'check', config: { nothing: 'x' } },
      { id: 'nope', label: 'x' },
      { id: 'draft', config: { instruction: '{{ doc.taskId }}' } },
      // スマホの許可リスト（K76）の外: AI の入力（式の差し込み）は文字でも PC だけ（レビュー指摘 12）
      { id: 'draft', config: { input: '{{form.customerName}}' } },
    ]) {
      const r = await app.inject({ method: 'PATCH', url: '/api/flows/flow-mine', headers: ADMIN(), payload: { baseVersion: 2, node: n } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('node には baseVersion が要り、古い版は 409', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/flows/flow-mine', headers: ADMIN(), payload: { node: { id: 'check', label: 'x' } } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'PATCH', url: '/api/flows/flow-mine', headers: ADMIN(), payload: { baseVersion: 9, node: { id: 'check', label: 'x' } } });
    expect(r.statusCode).toBe(409);
  });
});

describe('DELETE /api/flows/:id', () => {
  it('フロー・版・結果ページ・定期を消し、実行履歴は残す。キャンバスのノードはテンプレートに戻る', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal', canvasNodeId: 'proposal' },
    });
    const id = created.json().data.flow.id as string;
    fake.rows('customPage').push({ id: 'pg', orgId: 'org-A', slug: 'r', flowId: id });
    fake.rows('scheduledTask').push({ id: 'st', orgId: 'org-A', flowId: id });
    fake.rows('flowRun').push({ id: 'run', orgId: 'org-A', flowId: id, requestId: 'r1', status: 'SUCCEEDED', createdAt: new Date() });

    const r = await app.inject({ method: 'DELETE', url: `/api/flows/${id}`, headers: ADMIN() });
    expect(r.statusCode).toBe(200);
    expect(fake.rows('flow').find((f) => f.id === id)).toBeUndefined();
    expect(fake.rows('flowVersion').filter((v) => v.flowId === id)).toHaveLength(0);
    expect(fake.rows('customPage')).toHaveLength(0);
    expect(fake.rows('scheduledTask')).toHaveLength(0);
    expect(fake.rows('flowRun')).toHaveLength(1);
    const node = (fake.rows('canvas')[0].layout as any).nodes.find((n: any) => n.id === 'proposal');
    expect(node.target).toEqual({ kind: 'template', templateKey: 'proposal' });
    expect(audits('flow.delete')).toHaveLength(1);
    // 消した後にもう一度押せば作り直せる
    const again = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: ADMIN(), payload: { templateKey: 'proposal' } });
    expect(again.statusCode).toBe(201);
  });

  it('メンバーは 403、オーナー限定は ADMIN に 404', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/flows/flow-mine', headers: MEMBER() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/flows/flow-owner', headers: ADMIN() })).statusCode).toBe(404);
    expect(flowsOfA()).toHaveLength(2);
  });
});

describe('閲覧のみ（解約・トライアル切れ）の組織', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    Object.assign(fake.rows('organization').find((o) => o.id === 'org-A')!, {
      subscriptionStatus: 'canceled',
      trialEndsAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('表示は通り、作成・保存・削除・キャンバスの保存は 402', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/canvas', headers: OWNER() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/flows/flow-mine', headers: OWNER() })).statusCode).toBe(200);
    const before = fake.snapshot();
    const reqs = [
      { method: 'POST' as const, url: '/api/flows/from-template', payload: { templateKey: 'proposal' } },
      { method: 'POST' as const, url: '/api/flows', payload: { name: 'x' } },
      { method: 'PATCH' as const, url: '/api/flows/flow-mine', payload: { enabled: false } },
      { method: 'DELETE' as const, url: '/api/flows/flow-mine' },
      { method: 'PUT' as const, url: '/api/canvas', payload: { layout: DEFAULT_CANVAS_LAYOUT, baseVersion: 0 } },
    ];
    for (const r of reqs) {
      const res = await app.inject({ ...r, headers: OWNER() });
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    }
    expect(fake.snapshot()).toBe(before);
  });
});
