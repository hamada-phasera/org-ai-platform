import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { PLAN_LIMITS, storageQuotaBytes } from '@org-ai/shared-types';
import { FakeStripe, signedWebhook } from '../helpers/fake-stripe';
import { applyRlsPhase2a, createTestDatabase, hasTestDatabase, setEnv, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, upload } from './app';

// DoD の通しテスト（計画書チャンク 9 の受け入れ条件 2）。実 Postgres + 本物のルートで、
//   A 社が登録 → B 社が登録 → A が B のファイル id を引いても 404
//   → A が容量上限まで入れると次が拒否 → A が竹を契約（偽 webhook）→ 同じファイルが入る
//   → A の AILog を上限まで積むと /me/usage が over
//   → A のトライアルを過去にして未契約に戻すと書き込み 402（閲覧と決済の経路は通る）
// RLS_MODE=on の回（計画書チャンク 11 の受け入れ条件 4）は、phase2a.sql を当てて gateway の接続を flow_app に替える。
// テストの準備・確認（db.prisma）は所有者のまま（RLS を素通り）。
// ⚠️ Stripe はメモリ内の偽物（tests/helpers/fake-stripe.ts）。Stripe 以外の宛先（ai-engine・埋め込み）は 503 で返る。

let db: TestDatabase | undefined;
/** RLS_MODE=on の回だけ: gateway が使う flow_app の接続 */
let appPrisma: PrismaClient | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return appPrisma ?? db.prisma;
  },
}));

const stripe = new FakeStripe({
  price_s_m: { unit_amount: 9800, currency: 'jpy' },
  price_p_m: { unit_amount: 19800, currency: 'jpy' },
});

// ⚠️ 秘密情報らしい文字列をソースに置かない（push 保護に引っかかる）。実行時に組み立てる
const WEBHOOK_SECRET = ['whsec', 'flow-int-only'].join('_');
const MB = 1024 * 1024;

describe.skipIf(!hasTestDatabase).each(['off', 'on'] as const)('DoD の通し（実 Postgres・偽 Stripe・RLS_MODE=%s）', (rlsMode) => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let filesDir: string;

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'flow-int-files-'));
    restoreEnv = setEnv({
      STRIPE_SECRET_KEY: ['sk', 'test', 'flow'].join('_'),
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_STARTER_MONTHLY: 'price_s_m',
      STRIPE_PRICE_PRO_MONTHLY: 'price_p_m',
      APP_BASE_URL: 'https://app.example.com',
      BILLING_TRIAL_DAYS: undefined,
      FILES_DIR: filesDir,
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      EMBEDDING_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      RLS_MODE: rlsMode,
    });
    vi.stubGlobal('fetch', stripe.fetch);
    db = await createTestDatabase();
    if (rlsMode === 'on') appPrisma = (await applyRlsPhase2a(db)).app;
    app = await buildIntegrationApp();
  });

  afterAll(async () => {
    await app?.close();
    // 応答の後に走る索引づくりを待ってから DB を消す
    const { drain, jobs } = await import('../../src/services/lifecycle-core');
    await drain(jobs, { budgetMs: 5_000, pollMs: 20, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    await appPrisma?.$disconnect();
    appPrisma = undefined;
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
    rmSync(filesDir, { recursive: true, force: true });
  });

  it('本番と同じ配線（buildApp）: /ready が実 DB に届き、登録にレート制限が掛かり', async () => {
    // saas-review #5c: 以前の統合用アプリはレート制限・起動チェック・health を通っていなかった
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wiring-check@example.invalid', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
    // @fastify/rate-limit がログインの上限（AUTH_RATE_LIMIT = 10/分）で数えている
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    // 定期実行（n8n の一覧）も登録されている（トークンが無ければ 401）
    const jobs = await app.inject({ method: 'GET', url: '/api/webhooks/n8n/scheduled-jobs' });
    expect(jobs.statusCode).toBe(401);
  });

  it('2 社の登録 → 分離 → 容量上限 → 竹の契約 → AI 上限 → トライアル切れで閲覧のみ', async () => {
    const prisma = db!.prisma;
    const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
    const orgRow = (id: string) => prisma.organization.findUniqueOrThrow({ where: { id } });

    // ── A 社・B 社が自分で登録する。どちらも自分の組織と 30 日のトライアル ──
    const a = await registerCompany(app, 'Owner@A.example.jp', 'A 工務店');
    const b = await registerCompany(app, 'owner@b.example.jp', 'B 建設');
    expect(a.orgId).not.toBe(b.orgId);
    const aOrg = await orgRow(a.orgId);
    expect(aOrg).toMatchObject({ plan: 'STARTER', subscriptionStatus: null, createdBy: a.userId });
    const trialDays = (aOrg.trialEndsAt!.getTime() - aOrg.createdAt.getTime()) / 86_400_000;
    expect(Math.round(trialDays)).toBe(30);
    expect(await prisma.membership.count({ where: { orgId: a.orgId, userId: a.userId, role: 'OWNER', status: 'ACTIVE' } })).toBe(1);
    // メールは小文字で保存される
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).email).toBe('owner@a.example.jp');

    // ── 分離: A のトークンで B のファイルを引いても 404。一覧にも混ざらない ──
    const bFile = await upload(app, b, 'b-secret.txt', Buffer.from('B 社の見積'));
    expect(bFile.statusCode).toBe(201);
    const bFileId = bFile.json().data.id as string;
    const peek = await app.inject({ method: 'GET', url: `/api/files/${bFileId}`, headers: a.headers });
    expect(peek.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/files/${bFileId}`, headers: a.headers });
    expect(del.statusCode).toBe(404);
    expect(await prisma.uploadedFile.count({ where: { id: bFileId } })).toBe(1);
    const aList = await app.inject({ method: 'GET', url: '/api/files', headers: a.headers });
    expect(aList.statusCode).toBe(200);
    expect(aList.json().data).toEqual([]);
    const own = await app.inject({ method: 'GET', url: `/api/files/${bFileId}`, headers: b.headers });
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe('B 社の見積');

    // ── A の容量: 1 件目で使用量が実バイト数だけ増える（行の作成と同じトランザクション）──
    const first = await upload(app, a, 'a-1.txt', Buffer.alloc(2 * MB, 'a'));
    expect(first.statusCode).toBe(201);
    expect(Number((await orgRow(a.orgId)).storageUsedBytes)).toBe(2 * MB);

    // 上限ちょうどまで埋める（1GB を実際に送る代わりに、カウンタを上限の 1MB 手前まで進める）
    const starterQuota = storageQuotaBytes('STARTER', 0);
    expect(starterQuota).toBe(PLAN_LIMITS.STARTER.storageBytes);
    await prisma.organization.update({ where: { id: a.orgId }, data: { storageUsedBytes: BigInt(starterQuota - MB) } });
    const big = Buffer.alloc(2 * MB, 'b');
    const rejected = await upload(app, a, 'a-2.txt', big);
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toMatchObject({ success: false, error: { code: 'QUOTA_EXCEEDED' } });
    expect(Number((await orgRow(a.orgId)).storageUsedBytes)).toBe(starterQuota - MB);
    expect(await prisma.uploadedFile.count({ where: { orgId: a.orgId } })).toBe(1);
    // B は A の上限に巻き込まれない
    expect((await upload(app, b, 'b-2.txt', big)).statusCode).toBe(201);

    // ── A が竹を契約（Checkout → 偽 webhook）──
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: a.headers,
      payload: { plan: 'PRO', interval: 'month' },
    });
    expect(checkout.statusCode).toBe(200);
    const session = stripe.lastSession();
    expect(session.form.get('client_reference_id')).toBe(a.orgId);
    const hook = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      ...signedWebhook(stripe.completeCheckout(session.id), WEBHOOK_SECRET),
    });
    expect(hook.statusCode).toBe(200);
    expect(await orgRow(a.orgId)).toMatchObject({ plan: 'PRO', subscriptionStatus: 'trialing' });
    expect(await prisma.billingEvent.count()).toBe(1);
    // B の契約状態は変わらない
    expect(await orgRow(b.orgId)).toMatchObject({ plan: 'STARTER', subscriptionStatus: null, stripeCustomerId: null });

    // ── 竹の容量で、さっき拒否されたファイルが入る ──
    const accepted = await upload(app, a, 'a-2.txt', big);
    expect(accepted.statusCode).toBe(201);
    expect(Number((await orgRow(a.orgId)).storageUsedBytes)).toBe(starterQuota + MB);
    let usage = (await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: a.headers })).json().data;
    expect(usage).toMatchObject({ planLimit: PLAN_LIMITS.PRO.aiCallsPerMonth, state: 'ok', aiCallsThisMonth: 0 });
    expect(usage.storageQuotaBytes).toBe(storageQuotaBytes('PRO', 0));

    // ── A の AILog を竹の上限まで積むと over。B の AILog は A に数えない ──
    const limit = PLAN_LIMITS.PRO.aiCallsPerMonth;
    const logRow = (orgId: string) => ({ orgId, department: 'GENERAL', provider: 'anthropic', model: 'test', inputText: '[masked]' });
    await prisma.aILog.createMany({ data: Array.from({ length: limit - 1 }, () => logRow(a.orgId)) });
    await prisma.aILog.createMany({ data: Array.from({ length: 50 }, () => logRow(b.orgId)) });
    // 先月分は今月の回数に入らない
    await prisma.aILog.create({ data: { ...logRow(a.orgId), createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    usage = (await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: a.headers })).json().data;
    expect(usage).toMatchObject({ aiCallsThisMonth: limit - 1, state: 'warn' });
    await prisma.aILog.create({ data: logRow(a.orgId) });
    usage = (await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: a.headers })).json().data;
    expect(usage).toMatchObject({ aiCallsThisMonth: limit, planLimit: limit, state: 'over' });
    const bUsage = (await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: b.headers })).json().data;
    expect(bUsage).toMatchObject({ aiCallsThisMonth: 50, state: 'ok' });

    // ── A を未契約に戻し、登録時トライアルを過去にすると書き込みは 402 ──
    await prisma.organization.update({
      where: { id: a.orgId },
      data: { subscriptionStatus: null, plan: 'STARTER', trialEndsAt: new Date(Date.now() - 60_000) },
    });
    clearMembershipCache(); // 所属キャッシュ（30 秒）に載った契約状態を捨てる。本番では webhook がこれをする
    const blocked = await app.inject({ method: 'PATCH', url: '/api/organizations/me', headers: a.headers, payload: { name: 'A 改' } });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED' } });
    const blockedUpload = await upload(app, a, 'a-3.txt', Buffer.from('x'));
    expect(blockedUpload.statusCode).toBe(402);
    expect((await orgRow(a.orgId)).name).toBe('A 工務店');
    // 閲覧・書き出し・決済の経路は通る（再開できるように）
    expect((await app.inject({ method: 'GET', url: '/api/files', headers: a.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/billing', headers: a.headers })).statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: a.headers,
      payload: { plan: 'PRO', interval: 'month' },
    });
    expect(again.statusCode).toBe(200);
    // B は止まらない
    const bWrite = await app.inject({ method: 'PATCH', url: '/api/organizations/me', headers: b.headers, payload: { name: 'B 改' } });
    expect(bWrite.statusCode).toBe(200);
    expect((await orgRow(b.orgId)).name).toBe('B 改');
  });
});
