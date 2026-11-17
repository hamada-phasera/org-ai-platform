import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, type Registered } from './app';
import { sampleUpsert } from '../pages/fixtures';

// 業務ページの取得・管理 API と登録トークン（docs/design/custom-pages.md チャンク 3）を、本番と同じ buildApp の配線と
// 実 Postgres で通す。
//   オーナーがトークン発行 → n8n が同じ定義を同時に 2 回登録しても 1 行 → 2 回目は changed: false
//   → 管理者が公開 → 一覧・定義に出る（hook は返らない）→ 梅のページ数上限で 403
//   → B のトークンで同じ slug を登録しても A は変わらない → 失効したトークンは 401
// アクション実行（data / actions）の通しはチャンク 4。外部への通信は無い（fetch は 503 を返す偽物）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

describe.skipIf(!hasTestDatabase)('業務ページの API（実 Postgres・buildApp）', () => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let a: Registered;
  let b: Registered;
  let tokenA: string;
  let tokenAId: string;
  let tokenB: string;

  beforeAll(async () => {
    restoreEnv = setEnv({
      // 決済は未設定（トライアル中でも書き込みを止めない環境）。上限はトライアル＝梅
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_STARTER_MONTHLY: undefined,
      APP_BASE_URL: 'https://app.example.com',
      N8N_URL: undefined,
      N8N_CLOUD_URL: undefined,
      RLS_MODE: 'off',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    db = await createTestDatabase();
    app = await buildIntegrationApp();
    a = await registerCompany(app, 'pages-a@example.com', 'A 社');
    b = await registerCompany(app, 'pages-b@example.com', 'B 社');
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
  });

  const register = (token: string, slug: string, body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/webhooks/n8n/pages/${slug}`, headers: { 'x-page-token': token }, payload: body as object });

  it('オーナーが登録トークンを発行する（DB にはハッシュだけ）', async () => {
    const resA = await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: a.headers, payload: { label: 'n8n' } });
    expect(resA.statusCode).toBe(201);
    tokenA = resA.json().data.token;
    tokenAId = resA.json().data.id;
    const resB = await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: b.headers, payload: { label: 'n8n' } });
    tokenB = resB.json().data.token;
    const rows = await db!.prisma.pageToken.findMany();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(tokenA);
  });

  it('同じ定義を同時に 2 回登録しても 1 行。もう 1 回は changed: false', async () => {
    const [r1, r2] = await Promise.all([register(tokenA, 'inquiries', sampleUpsert()), register(tokenA, 'inquiries', sampleUpsert())]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(await db!.prisma.customPage.count({ where: { orgId: a.orgId } })).toBe(1);

    const again = await register(tokenA, 'inquiries', sampleUpsert());
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ version: 1, changed: false, status: 'DRAFT', url: 'https://app.example.com/p/inquiries' });
    const audit = await db!.prisma.auditEvent.findMany({ where: { orgId: a.orgId, action: 'page.upsert' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBeNull();
    expect((audit[0].meta as Record<string, unknown>).registrarId).toBe(tokenAId);
  });

  it('管理者（オーナー）が公開すると一覧と定義に出る。hook は返らない', async () => {
    const patch = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: a.headers, payload: { status: 'PUBLISHED' } });
    expect(patch.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/pages', headers: a.headers });
    expect(list.json().data).toEqual([{ slug: 'inquiries', title: '問い合わせ', icon: 'inbox', status: 'PUBLISHED' }]);
    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: a.headers });
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toMatchObject({ connection: 'not_configured', usage: { used: 0, limit: 300 } });
    expect(page.body).not.toContain('inquiries-list');
    expect(page.body).not.toContain('hook');
  });

  it('梅（トライアル）はページ 1 つまで。2 つ目は 403、既存の更新は通る', async () => {
    const res = await register(tokenA, 'orders', sampleUpsert());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PAGE_LIMIT_REACHED');
    const update = await register(tokenA, 'inquiries', sampleUpsert({ title: '受付' }));
    expect(update.json().data).toMatchObject({ changed: true, version: 1, status: 'PUBLISHED' });
  });

  it('B のトークンで同じ slug を登録すると B に作られ、A は変わらない。互いに見えない', async () => {
    const before = await db!.prisma.customPage.findMany({ where: { orgId: a.orgId } });
    const res = await register(tokenB, 'inquiries', sampleUpsert({ title: 'B の窓口' }));
    expect(res.statusCode).toBe(201);
    expect(await db!.prisma.customPage.findMany({ where: { orgId: a.orgId } })).toEqual(before);

    const aView = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: a.headers });
    expect(aView.json().data.title).toBe('受付');
    // B のは下書きなので、B のオーナーには見えるが A の一覧には出ない
    const aList = await app.inject({ method: 'GET', url: '/api/pages', headers: a.headers });
    expect(aList.body).not.toContain('B の窓口');
  });

  it('失効したトークンは即 401。共有トークンでは登録できない', async () => {
    const revoke = await app.inject({ method: 'DELETE', url: `/api/pages/tokens/${tokenAId}`, headers: a.headers });
    expect(revoke.statusCode).toBe(200);
    expect((await register(tokenA, 'inquiries', sampleUpsert())).statusCode).toBe(401);
    const shared = await app.inject({
      method: 'PUT', url: '/api/webhooks/n8n/pages/inquiries',
      headers: { 'x-webhook-token': 'org-ai-n8n-secret-token' }, payload: sampleUpsert(),
    });
    expect(shared.statusCode).toBe(401);
  });
});
