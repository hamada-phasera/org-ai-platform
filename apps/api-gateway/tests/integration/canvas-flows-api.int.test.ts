import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { FLOW_LIMITS, cloneFlowTemplate } from '@org-ai/shared-types';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';

// キャンバスとフローの取得・保存 API（docs/design/canvas-home.md チャンク 4・D2）を、本番と同じ buildApp の配線と実 Postgres で通す。
//   行が無い組織に既定の配置 → 「提案書」を 2 人が同時に押してもフロー 1 つ・キャンバスの行も 1 つ
//   → 編集（版 +1・FlowVersion）→ 古い版は 409 → 梅のフロー数上限で 403 → B からは 404 → 削除でキャンバスが戻る
// 外部への通信は無い（fetch は 503 を返す偽物。LLM・n8n を呼ばないことも確かめる）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

describe.skipIf(!hasTestDatabase)('キャンバスとフローの API（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  let flowId: string;
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
    a = await registerCompany(app, 'canvas-a@example.com', 'A 社');
    b = await registerCompany(app, 'canvas-b@example.com', 'B 社');
    fetchMock.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  it('行が無い組織には既定の配置（version 0）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canvas', headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ version: 0, isDefault: true, flows: [] });
    expect(await db!.prisma.canvas.count()).toBe(0);
  });

  it('「提案書」を同時に 2 回押してもフローは 1 つ、キャンバスも 1 行で行き先が flow になる（D2）', async () => {
    const press = () =>
      app.inject({
        method: 'POST', url: '/api/flows/from-template', headers: a.headers, payload: { templateKey: 'proposal', canvasNodeId: 'proposal' },
      });
    const results = await Promise.all([press(), press(), press()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    const ids = new Set(results.map((r) => r.json().data.flow.id));
    expect(ids.size).toBe(1);
    flowId = [...ids][0] as string;
    expect(await db!.prisma.flow.count({ where: { orgId: a.orgId } })).toBe(1);
    expect(await db!.prisma.flowVersion.count({ where: { flowId } })).toBe(1);
    const canvas = await db!.prisma.canvas.findMany({ where: { orgId: a.orgId } });
    expect(canvas).toHaveLength(1);
    const node = (canvas[0].layout as { nodes: { id: string; target: unknown }[] }).nodes.find((n) => n.id === 'proposal');
    expect(node?.target).toEqual({ kind: 'flow', flowId });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('編集すると版が上がり、古い版の保存は 409', async () => {
    const def = cloneFlowTemplate('proposal').definition;
    def.nodes[1].label = '作文';
    const put = (baseVersion: number) =>
      app.inject({ method: 'PUT', url: `/api/flows/${flowId}`, headers: a.headers, payload: { definition: def, layout: {}, baseVersion } });
    const ok = await put(1);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.version).toBe(2);
    expect(await db!.prisma.flowVersion.count({ where: { flowId } })).toBe(2);
    def.nodes[1].label = '別案';
    const stale = await put(1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('FLOW_CONFLICT');
  });

  it('B からは A のフローが 404 で、書き換えられない', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/flows/${flowId}`, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/flows/${flowId}`, headers: b.headers })).statusCode).toBe(404);
    expect(await db!.prisma.flow.count({ where: { id: flowId } })).toBe(1);
  });

  it('トライアル（梅）はフロー数の上限で 403 FLOW_LIMIT_REACHED', async () => {
    const created: number[] = [];
    for (const templateKey of ['estimate', 'invoice', 'sns_post']) {
      const r = await app.inject({ method: 'POST', url: '/api/flows/from-template', headers: a.headers, payload: { templateKey } });
      created.push(r.statusCode);
    }
    expect(created).toEqual([201, 201, 403]);
    expect(await db!.prisma.flow.count({ where: { orgId: a.orgId } })).toBe(FLOW_LIMITS.STARTER.maxFlows);
  });

  it('消すとキャンバスのノードはテンプレートに戻り、監査が残る', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/flows/${flowId}`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const canvas = await app.inject({ method: 'GET', url: '/api/canvas', headers: a.headers });
    const node = canvas.json().data.layout.nodes.find((n: { id: string }) => n.id === 'proposal');
    expect(node.target).toEqual({ kind: 'template', templateKey: 'proposal' });
    const actions = (await db!.prisma.auditEvent.findMany({ where: { orgId: a.orgId, action: { startsWith: 'flow.' } } })).map((e) => e.action);
    expect(actions.sort()).toEqual(['flow.create', 'flow.create', 'flow.create', 'flow.delete', 'flow.update']);
  });
});
