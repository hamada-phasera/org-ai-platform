import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';

// 業務フローの結果ページ（docs/design/canvas-home.md チャンク 9）を、本番と同じ buildApp の配線と実 Postgres で通す。
//   空のフローを作る → 出力ビルダーの最初の保存を 3 人が同時に押してもページは 1 つ（flowId の unique）
//   → 梅でも手動の業務ページを作れる（結果ページは数えない）→ /p/:slug のボタンでフローが走り、FlowRun 1 行・PageActionLog 0 行
//   → flow_query で履歴が読める → B からは 404。外部への通信は無い（fetch は 503 の偽物。n8n・LLM を呼ばない）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

describe.skipIf(!hasTestDatabase)('業務フローの結果ページ（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  let flowId: string;
  let slug: string;
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
    a = await registerCompany(app, 'result-a@example.com', 'A 社');
    b = await registerCompany(app, 'result-b@example.com', 'B 社');
    const created = await app.inject({ method: 'POST', url: '/api/flows', headers: a.headers, payload: { name: '受付', slug: 'reception' } });
    expect(created.statusCode).toBe(201);
    flowId = created.json().data.flow.id;
    fetchMock.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  it('最初の保存を同時に 3 回押してもページは 1 つ（他は 409）', async () => {
    const info = await app.inject({ method: 'GET', url: `/api/flows/${flowId}/page`, headers: a.headers });
    expect(info.statusCode).toBe(200);
    const draft = info.json().data.draft;
    const press = () => app.inject({ method: 'PUT', url: `/api/flows/${flowId}/page`, headers: a.headers, payload: { definition: draft } });
    const results = await Promise.all([press(), press(), press()]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(201);
    expect(codes.slice(1).every((c) => c === 409 || c === 200)).toBe(true);
    const pages = await db!.prisma.customPage.findMany({ where: { orgId: a.orgId, source: 'FLOW' } });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ flowId, status: 'PUBLISHED', slug: 'reception' });
    slug = pages[0]!.slug;
  });

  it('梅でも手動の業務ページを 1 つ目として作れる（結果ページはページ数に数えない）', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/pages/manual-one',
      headers: a.headers,
      payload: { title: '手動', definition: { blocks: [{ type: 'heading', text: '見出し' }], actions: {} } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('ボタンからフローが走り、FlowRun 1 行（trigger=page）・PageActionLog 0 行。履歴が読める', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${slug}/actions/run`,
      headers: a.headers,
      payload: { input: {}, requestId: globalThis.crypto.randomUUID(), origin: { blockIndex: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ ok: true, status: 'SUCCEEDED' });
    await vi.waitFor(async () => {
      const runs = await db!.prisma.flowRun.findMany({ where: { orgId: a.orgId } });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: 'page', status: 'SUCCEEDED', flowId });
    });
    expect(await db!.prisma.pageActionLog.count({ where: { orgId: a.orgId } })).toBe(0);

    const data = await app.inject({ method: 'GET', url: `/api/pages/${slug}/data/result`, headers: a.headers });
    expect(data.statusCode).toBe(200);
    const table = data.json().data.blocks.find((x: { type: string }) => x.type === 'table');
    expect(table.rows).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B からは結果ページ・出力ビルダーとも 404', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/pages/${slug}`, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/flows/${flowId}/page`, headers: b.headers })).statusCode).toBe(404);
  });
});
