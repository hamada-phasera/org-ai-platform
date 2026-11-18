import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';
import { sampleUpsert } from '../pages/fixtures';

// 業務ページのアクション実行（docs/design/custom-pages.md チャンク 4）を、buildApp の配線と実 Postgres で通す。
//   登録 → 公開 → 取得（n8n は偽の fetch）→ 送信 → 当月の件数
//   同じ requestId を並行で 2 回 → n8n には 1 回だけ（(orgId, requestId) の unique が効く）
//   B のメンバーは A のページのアクションに触れず、A の送信が B の件数に数えられない
// 外部への通信は無い（fetch は偽物。n8n.test 以外は 503）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

const N8N = 'https://n8n.test';

describe.skipIf(!hasTestDatabase)('業務ページのアクション（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  const n8nCalls: { url: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    restoreEnv = setEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_STARTER_MONTHLY: undefined,
      N8N_URL: N8N,
      N8N_CLOUD_URL: undefined,
      PAGES_SAMPLE_MODE: undefined,
      RLS_MODE: 'off',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(`${N8N}/webhook/pages/`)) return new Response('{}', { status: 503 });
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        n8nCalls.push({ url, body });
        // 並行送信の検査で、2 本が同時に n8n に居る時間を作る
        await new Promise((r) => setTimeout(r, 30));
        const payload = url.endsWith('/inquiries-list')
          ? { open: 2, month: 5, rows: [{ id: 'r1', date: '2026-11-01', name: '佐藤', subject: '見積', status: '未対応', extra: 'x' }] }
          : { ok: true, message: '登録しました' };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    db = await createTestDatabase();
    app = await buildIntegrationApp();
    a = await registerCompany(app, 'pages-act-a@example.com', 'A 社');
    b = await registerCompany(app, 'pages-act-b@example.com', 'B 社');

    const tok = await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: a.headers, payload: { label: 'n8n' } });
    const reg = await app.inject({
      method: 'PUT', url: '/api/webhooks/n8n/pages/inquiries',
      headers: { 'x-page-token': tok.json().data.token }, payload: sampleUpsert({ status: 'PUBLISHED' }),
    });
    expect(reg.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  const submitBody = (requestId = randomUUID()) => ({
    input: { name: '佐藤', subject: '見積', tel: '', body: '' },
    requestId,
    origin: { blockIndex: 2 },
  });

  it('取得は pages/<A の orgId>/inquiries-list に届き、宣言した列だけが返る。記録はしない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/inquiries/data/list', headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.blocks[0].values).toEqual({ 0: 2, 1: 5 });
    expect(res.body).not.toContain('extra');
    expect(n8nCalls.at(-1)!.url).toBe(`${N8N}/webhook/pages/${encodeURIComponent(a.orgId)}/inquiries-list`);
    expect(n8nCalls.at(-1)!.body.orgId).toBe(a.orgId);
    expect(await db!.prisma.pageActionLog.count()).toBe(0);
  });

  it('送信すると PageActionLog が OK で 1 行（値は残らない）。当月の件数が 1 になる', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/inquiries/actions/create', headers: a.headers, payload: submitBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, message: '登録しました', sample: false });
    const rows = await db!.prisma.pageActionLog.findMany({ where: { orgId: a.orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'OK', actionId: 'create', slug: 'inquiries' });
    expect(rows[0]!.durationMs).not.toBeNull();
    expect(JSON.stringify(rows)).not.toContain('佐藤');

    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: a.headers });
    expect(page.json().data.usage).toMatchObject({ used: 1, limit: 300 });
  });

  it('同じ requestId を並行で 2 回送っても n8n には 1 回だけ（片方は 409）', async () => {
    const before = n8nCalls.length;
    const payload = submitBody();
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/pages/inquiries/actions/create', headers: a.headers, payload }),
      app.inject({ method: 'POST', url: '/api/pages/inquiries/actions/create', headers: a.headers, payload }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    expect(n8nCalls.length - before).toBe(1);
    expect(await db!.prisma.pageActionLog.count({ where: { orgId: a.orgId, requestId: payload.requestId } })).toBe(1);
  });

  it('B のメンバーは A のページのアクションに触れない（404・n8n に届かない・記録も無い）', async () => {
    const before = n8nCalls.length;
    const q = await app.inject({ method: 'GET', url: '/api/pages/inquiries/data/list', headers: b.headers });
    const s = await app.inject({ method: 'POST', url: '/api/pages/inquiries/actions/create', headers: b.headers, payload: submitBody() });
    expect([q.statusCode, s.statusCode]).toEqual([404, 404]);
    expect(n8nCalls.length).toBe(before);
    expect(await db!.prisma.pageActionLog.count({ where: { orgId: b.orgId } })).toBe(0);
  });
});
