import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';
import { SAMPLE_PAGE_SLUG, seedSamplePages } from '../../../../packages/db-schema/prisma/seed-pages';

// 業務ページのシード（docs/design/custom-pages.md チャンク 7・DoD D1）を、実 Postgres と buildApp の配線で通す。
//   seed → PAGES_SAMPLE_MODE=true（n8n は未設定）→ /p/inquiries の KPI・表・フォーム・ボタンのデータが出る
//   送信はサンプルの文言で返り、記録も数えもしない。n8n にも外にも一度も通信しない
//   他の組織からは seed のページは見えない

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

describe.skipIf(!hasTestDatabase)('業務ページのシードとサンプルモード（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }));

  beforeAll(async () => {
    restoreEnv = setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_STARTER_MONTHLY: undefined,
      N8N_URL: undefined,
      N8N_CLOUD_URL: undefined,
      PAGES_SAMPLE_MODE: 'true',
      RLS_MODE: 'off',
    });
    vi.stubGlobal('fetch', fetchMock);
    db = await createTestDatabase();
    app = await buildIntegrationApp();
    a = await registerCompany(app, 'pages-seed-a@example.com', 'A 社');
    b = await registerCompany(app, 'pages-seed-b@example.com', 'B 社');
    expect(await seedSamplePages(db.prisma, a.orgId)).toBe('created');
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  it('seed は何度実行しても 1 行（2 回目は unchanged）', async () => {
    expect(await seedSamplePages(db!.prisma, a.orgId)).toBe('unchanged');
    expect(await db!.prisma.customPage.count({ where: { orgId: a.orgId, slug: SAMPLE_PAGE_SLUG } })).toBe(1);
  });

  it('メンバーのナビに出て、ページは sample として開ける（hook と sampleData は返さない）', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/pages', headers: a.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([expect.objectContaining({ slug: 'inquiries', title: '問い合わせ', status: 'PUBLISHED' })]);

    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: a.headers });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.connection).toBe('sample');
    expect(page.json().data.definition.blocks.map((x: { type: string }) => x.type)).toEqual(['kpi', 'table', 'form', 'buttons']);
    expect(page.body).not.toContain('inquiries-list');
    expect(page.body).not.toContain('inq-001');
  });

  it('データは n8n 無しで KPI と表になる（本番と同じ切り詰めを通る）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/inquiries/data/list', headers: a.headers });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.sample).toBe(true);
    expect(data.blocks[0]).toMatchObject({ type: 'kpi', values: { 0: 3, 1: 12 } });
    expect(data.blocks[1].type).toBe('table');
    expect(data.blocks[1].rows).toHaveLength(5);
    expect(data.blocks[1].rows[0]).toMatchObject({ id: 'inq-001', cells: { name: '山田建設' } });
  });

  it('フォーム・行の操作・ボタンはサンプルの文言で返り、記録も数えもしない', async () => {
    const send = (actionId: string, input: Record<string, unknown>, origin: Record<string, number>) =>
      app.inject({
        method: 'POST', url: `/api/pages/inquiries/actions/${actionId}`, headers: a.headers,
        payload: { input, requestId: randomUUID(), origin },
      });
    const results = await Promise.all([
      send('create', { name: '佐藤', subject: '見積', tel: '', body: '' }, { blockIndex: 2 }),
      send('done', { rowId: 'inq-001' }, { blockIndex: 1 }),
      send('remind', {}, { blockIndex: 3, itemIndex: 0 }),
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ ok: true, sample: true });
    }
    expect(await db!.prisma.pageActionLog.count()).toBe(0);
    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: a.headers });
    expect(page.json().data.usage).toMatchObject({ used: 0 });
  });

  it('サンプルでも入力検証は本番と同じ（必須の空は 400）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/pages/inquiries/actions/create', headers: a.headers,
      payload: { input: { name: '', subject: '' }, requestId: randomUUID(), origin: { blockIndex: 2 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('B の組織からは A の seed ページは見えない（一覧に無く、すべて 404）', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/pages', headers: b.headers });
    expect(list.json().data).toEqual([]);
    for (const url of ['/api/pages/inquiries', '/api/pages/inquiries/data/list']) {
      expect((await app.inject({ method: 'GET', url, headers: b.headers })).statusCode).toBe(404);
    }
  });

  it('n8n にも外にも一度も通信していない', () => {
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
