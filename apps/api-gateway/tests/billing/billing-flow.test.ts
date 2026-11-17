import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { PLAN_LIMITS } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { FakeStripe, signedWebhook, type FakeStripeEvent } from '../helpers/fake-stripe';

// 課金の通しテスト（計画書チャンク 3 の受け入れ条件 1〜3）。
//
// 本物の requireAuth / tenantDb / 登録 / Checkout / webhook / 利用量を通し、
// DB はメモリ内の偽 Prisma、Stripe はメモリ内の偽 Stripe（tests/helpers/fake-stripe.ts）に差し替える。
//   登録 → Checkout URL → checkout.session.completed → 竹 → 上限 8000 回 / 5GB
//   → past_due でも書ける → subscription.deleted で書き込み 402 → 再 Checkout → 復帰
// ⚠️ 本物の Stripe には接続しない（api.stripe.com 宛ても偽物が答える）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const stripe = new FakeStripe({
  price_s_m: { unit_amount: 9800, currency: 'jpy' },
  price_p_m: { unit_amount: 19800, currency: 'jpy' },
});
vi.stubGlobal('fetch', stripe.fetch);

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { authRoutes } = await import('../../src/routes/auth');
const { billingRoutes, resetBillingPriceCache } = await import('../../src/routes/billing');
const { stripeWebhookRoutes } = await import('../../src/routes/billing-webhook');
const { organizationRoutes } = await import('../../src/routes/organizations');

const JWT_SECRET = 'billing-flow-test-secret-32-chars-long!!';
// ⚠️ 秘密情報らしい文字列をソースに置かない（push 保護に引っかかる）。実行時に組み立てる
const WEBHOOK_SECRET = ['whsec', 'flow-test-only'].join('_');
const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: ['sk', 'test', 'flow'].join('_'),
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_STARTER_MONTHLY: 'price_s_m',
  STRIPE_PRICE_PRO_MONTHLY: 'price_p_m',
  STRIPE_TAX_RATE_ID: 'txr_jp10',
  APP_BASE_URL: 'https://app.example.com',
};
const GB = 1024 * 1024 * 1024;
const saved: Record<string, string | undefined> = {};

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: JWT_SECRET });
  registerTenantContext(app);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks/stripe' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.BILLING_TRIAL_DAYS = process.env.BILLING_TRIAL_DAYS;
  delete process.env.BILLING_TRIAL_DAYS;
  fake = new FakePrisma({});
  clearMembershipCache();
  resetBillingPriceCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  app = await build();
});

afterEach(async () => {
  await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

async function register(email = 'owner@example.com'): Promise<{ token: string; orgId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '山田', email, password: 'password123', orgName: '山田工務店' },
  });
  expect(res.statusCode).toBe(201);
  return { token: res.json().data.token, orgId: res.json().data.user.orgId };
}

const sendWebhook = (event: FakeStripeEvent, secret = WEBHOOK_SECRET) =>
  app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signedWebhook(event, secret) });

describe('課金の通し（偽 Stripe）', () => {
  it('登録 → 契約 → 上限拡大 → 未払いの猶予 → 解約で閲覧のみ → 再契約で復帰', async () => {
    const { token, orgId } = await register();
    const h = { authorization: `Bearer ${token}` };
    const write = (name: string) =>
      app.inject({ method: 'PATCH', url: '/api/organizations/me', headers: h, payload: { name } });
    const org = () => fake.rows('organization').find((o) => o.id === orgId)!;

    // ── 登録直後: 登録時トライアル中（梅）。契約すると残り期間が引き継がれる ──
    const trialEndsAt = org().trialEndsAt as Date;
    let overview = (await app.inject({ method: 'GET', url: '/api/billing', headers: h })).json().data;
    expect(overview).toMatchObject({ configured: true, plan: 'STARTER', subscriptionStatus: null, trialAvailable: false });
    expect(overview.appTrial).toMatchObject({ active: true, daysLeft: 30 });
    expect(overview.checkoutTrialEndsAt).toBe(new Date(Math.floor(trialEndsAt.getTime() / 1000) * 1000).toISOString());
    expect((await write('登録直後')).statusCode).toBe(200);

    // ── Checkout の URL を取る ──
    const checkout = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: h, payload: { plan: 'PRO', interval: 'month' } });
    expect(checkout.statusCode).toBe(200);
    const session = stripe.lastSession();
    expect(checkout.json().data.url).toBe(session.url);
    expect(session.form.get('client_reference_id')).toBe(orgId);
    expect(session.form.get('line_items[0][price]')).toBe('price_p_m');
    // D3: 登録時トライアルの残り（30 日）を trial_end で引き継ぐ。Stripe のトライアル日数は付けない
    expect(Number(session.form.get('subscription_data[trial_end]'))).toBe(Math.floor(trialEndsAt.getTime() / 1000));
    expect(session.form.has('subscription_data[trial_period_days]')).toBe(false);

    // ── 支払い完了 → webhook → 竹 ──
    const completed = stripe.completeCheckout(session.id);
    const hook = await sendWebhook(completed);
    expect(hook.statusCode).toBe(200);
    expect(hook.json()).toEqual({ received: true });
    expect(org()).toMatchObject({ plan: 'PRO', subscriptionStatus: 'trialing' });
    const subId = org().stripeSubscriptionId as string;
    // 引き継いだ無料期間の終わりは変わらない（延びない）
    expect((org().trialEndsAt as Date).getTime()).toBe(Math.floor(trialEndsAt.getTime() / 1000) * 1000);

    // ── 上限が竹になる ──
    const usage = (await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: h })).json().data;
    expect(usage.planLimit).toBe(8000);
    expect(usage.planLimit).toBe(PLAN_LIMITS.PRO.aiCallsPerMonth);
    expect(usage.storageQuotaBytes).toBe(5 * GB);

    // ── 未払い（past_due）は猶予期間なので書ける ──
    expect((await sendWebhook(stripe.setStatus(subId, 'past_due'))).statusCode).toBe(200);
    expect(org().subscriptionStatus).toBe('past_due');
    expect((await write('未払いの猶予中')).statusCode).toBe(200);

    // ── 解約が確定。上限は梅に戻る ──
    expect((await sendWebhook(stripe.cancel(subId))).statusCode).toBe(200);
    expect(org()).toMatchObject({ plan: 'STARTER', subscriptionStatus: 'canceled' });
    // 登録時トライアルの残りがある間は、解約しても閲覧のみにしない（saas-review #4: 試しに契約して即解約しても無料期間を失わない）
    expect((await write('解約直後・無料期間の残りあり')).statusCode).toBe(200);

    // ── 無料期間の終わりを過ぎる → 書き込みは 402、閲覧と決済の経路は通る ──
    org().trialEndsAt = new Date(Date.now() - 60_000);
    clearMembershipCache(); // 所属のキャッシュ（30 秒）に載った trialEndsAt の写しを捨てる
    const blocked = await write('解約後');
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    const afterCancel = await app.inject({ method: 'GET', url: '/api/organizations/me/usage', headers: h });
    expect(afterCancel.statusCode).toBe(200);
    expect(afterCancel.json().data.planLimit).toBe(PLAN_LIMITS.STARTER.aiCallsPerMonth);
    overview = (await app.inject({ method: 'GET', url: '/api/billing', headers: h })).json().data;
    expect(overview.subscriptionStatus).toBe('canceled');
    // 一度契約した組織には無料期間を引き継がない（解約 → 再契約で同じ期間を使い直させない）
    expect(overview.checkoutTrialEndsAt).toBeNull();

    // ── 再 Checkout → その日から課金（無料期間なし）→ 復帰 ──
    const again = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: h, payload: { plan: 'PRO', interval: 'month' } });
    expect(again.statusCode).toBe(200);
    const second = stripe.lastSession();
    expect(second.id).not.toBe(session.id);
    expect(second.form.has('subscription_data[trial_end]')).toBe(false);
    expect(second.form.has('subscription_data[trial_period_days]')).toBe(false);
    // 顧客は使い回す（2 人目の顧客を作らない）
    expect(stripe.customers.size).toBe(1);
    expect(second.customer).toBe(org().stripeCustomerId);

    expect((await sendWebhook(stripe.completeCheckout(second.id))).statusCode).toBe(200);
    expect(org()).toMatchObject({ plan: 'PRO', subscriptionStatus: 'active' });
    expect(org().stripeSubscriptionId).not.toBe(subId);
    expect((await write('再契約後')).statusCode).toBe(200);

    // 古いサブスクリプションの「解約済み」が遅れて届いても、現行の契約は落ちない
    expect((await sendWebhook(stripe.cancel(subId))).statusCode).toBe(200);
    expect(org().subscriptionStatus).toBe('active');
    expect((await write('遅れた解約イベントの後')).statusCode).toBe(200);
  });

  it('署名が違う webhook は 400 で、組織は変わらない', async () => {
    const { token, orgId } = await register();
    const h = { authorization: `Bearer ${token}` };
    await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: h, payload: { plan: 'PRO', interval: 'month' } });
    const event = stripe.completeCheckout(stripe.lastSession().id);

    const res = await sendWebhook(event, ['whsec', 'someone-else'].join('_'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
    expect(fake.rows('organization').find((o) => o.id === orgId)).toMatchObject({ plan: 'STARTER', subscriptionStatus: null });
    expect(fake.rows('billingEvent')).toHaveLength(0);
  });

  it('同じイベント ID の再送は duplicate で、二度は処理しない', async () => {
    const { token } = await register();
    const h = { authorization: `Bearer ${token}` };
    await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: h, payload: { plan: 'PRO', interval: 'month' } });
    const event = stripe.completeCheckout(stripe.lastSession().id);

    expect((await sendWebhook(event)).json()).toEqual({ received: true });
    const fetched = stripe.calls.filter((c) => c.path.startsWith('/subscriptions/')).length;
    const again = await sendWebhook(event);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true, duplicate: true });
    // 2 回目はサブスクリプションを取り直さない（処理していない）
    expect(stripe.calls.filter((c) => c.path.startsWith('/subscriptions/')).length).toBe(fetched);
    expect(fake.rows('billingEvent')).toHaveLength(1);
  });

  it('登録時トライアルの残りが 1 日なら、Checkout はその日から課金（trial_end を付けない）', async () => {
    const { token, orgId } = await register();
    const h = { authorization: `Bearer ${token}` };
    fake.rows('organization').find((o) => o.id === orgId)!.trialEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const overview = (await app.inject({ method: 'GET', url: '/api/billing', headers: h })).json().data;
    expect(overview.appTrial).toMatchObject({ active: true, daysLeft: 1 });
    expect(overview.checkoutTrialEndsAt).toBeNull();

    expect((await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: h, payload: { plan: 'PRO', interval: 'month' } })).statusCode).toBe(200);
    const s = stripe.lastSession();
    expect(s.form.has('subscription_data[trial_end]')).toBe(false);
    expect(s.form.has('subscription_data[trial_period_days]')).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signedWebhook(stripe.completeCheckout(s.id), WEBHOOK_SECRET) })).statusCode).toBe(200);
    expect(fake.rows('organization').find((o) => o.id === orgId)).toMatchObject({ plan: 'PRO', subscriptionStatus: 'active' });
  });
});
