import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

import { userWithMembership } from '../helpers/membership';

// 契約状態は、所属の確認（User ⨝ Membership ⨝ Organization の1回の読み取り）に載っている
const prismaMock = { user: { findUnique: vi.fn() } };
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

const { requireAuth } = await import('../../src/middleware/auth');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const withStatus = (subscriptionStatus: string | null, trialEndsAt: Date | null = null) =>
  prismaMock.user.findUnique.mockResolvedValue(userWithMembership({ subscriptionStatus, trialEndsAt }));
const { entitlementOf, entitlementDecision, readOnlyMessageOf, appTrialOf, appTrialEndFrom, needsEntitlementCheck } = await import(
  '../../src/services/entitlement'
);

const SECRET = 'test-secret-value-that-is-long-enough-32';

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: SECRET });
  const handler = async () => ({ success: true, data: { ran: true } });
  app.post('/api/tasks', { preHandler: requireAuth }, handler);
  app.get('/api/tasks', { preHandler: requireAuth }, handler);
  app.post('/api/billing/checkout', { preHandler: requireAuth }, handler);
  app.post('/api/auth/switch-org', { preHandler: requireAuth }, handler);
  await app.ready();
  return app;
}

const auth = (app: FastifyInstance) => ({
  authorization: `Bearer ${app.jwt.sign({ sub: 'user-1', orgId: 'org-1', role: 'OWNER' })}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearMembershipCache();
  withStatus(null);
});

const NOW = new Date('2026-11-17T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const decide = (status: string | null | undefined, trialEndsAt: Date | null, billingConfigured = true, now: Date = NOW) =>
  entitlementOf({ status, trialEndsAt, billingConfigured, now });

describe('entitlementOf', () => {
  it('まだ決済を繋いでいない既存組織（trialEndsAt なし）は止めない（課金開始前の利用者を落とさない）', () => {
    expect(decide(null, null)).toBe('full');
    expect(decide(undefined, null)).toBe('full');
  });

  it('契約中・トライアル中・支払い遅延は通す', () => {
    for (const s of ['trialing', 'active', 'past_due']) expect(decide(s, null)).toBe('full');
  });

  it('解約・未払い・一時停止は閲覧のみ', () => {
    for (const s of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(decide(s, null)).toBe('read_only');
    }
  });

  // チャンク 1 の受け入れ条件（docs/plan/saas-readiness-plan.md）
  it.each([
    // [説明, status, trialEndsAt, 決済設定, 期待]
    ['(1) 登録直後（残り 30 日）は書き込める', null, at(30), true, 'full'],
    ['(2) 31 日後（1 日前に期限切れ）は閲覧のみ', null, at(-1), true, 'read_only'],
    ['(2) 期限ちょうどは閲覧のみ', null, at(0), true, 'read_only'],
    ['(3) 決済未設定なら期限切れでも止めない', null, at(-1), false, 'full'],
    ['(4) trialEndsAt なし・未契約の既存組織は止めない', null, null, true, 'full'],
    ['(5) 2 つ目の組織（作成時刻 = 期限）は閲覧のみ', null, at(0), true, 'read_only'],
    ['(6) trialing は期限切れでも通す', 'trialing', at(-10), true, 'full'],
    ['(6) active は期限切れでも通す', 'active', at(-10), true, 'full'],
    ['(6) past_due は期限切れでも通す', 'past_due', at(-10), true, 'full'],
    ['解約済みは決済未設定でも閲覧のみ（従来どおり）', 'canceled', null, false, 'read_only'],
  ] as const)('%s', (_label, status, trialEndsAt, configured, expected) => {
    expect(decide(status, trialEndsAt, configured)).toBe(expected);
  });

  it('理由で文言を分ける（コードは同じ SUBSCRIPTION_REQUIRED）', () => {
    expect(entitlementDecision({ status: null, trialEndsAt: at(-1), billingConfigured: true, now: NOW })).toEqual({
      access: 'read_only',
      reason: 'trial_expired',
    });
    expect(entitlementDecision({ status: 'canceled', trialEndsAt: null, billingConfigured: true, now: NOW })).toEqual({
      access: 'read_only',
      reason: 'subscription_ended',
    });
    expect(readOnlyMessageOf('trial_expired')).toContain('無料期間');
    expect(readOnlyMessageOf('subscription_ended')).toContain('ご契約が終了');
  });

  it('壊れた日付では止めない', () => {
    expect(entitlementOf({ status: null, trialEndsAt: 'not-a-date', billingConfigured: true, now: NOW })).toBe('full');
  });
});

describe('appTrialOf', () => {
  it('未契約で期限が先なら残り日数を切り上げで返す', () => {
    expect(appTrialOf({ status: null, trialEndsAt: at(29.5), now: NOW })).toEqual({
      active: true,
      endsAt: at(29.5).toISOString(),
      daysLeft: 30,
    });
  });

  it('期限切れは active=false・残り 0', () => {
    expect(appTrialOf({ status: null, trialEndsAt: at(-1), now: NOW })).toMatchObject({ active: false, daysLeft: 0 });
  });

  it('契約している（Stripe の状態がある）・期限が無いなら対象外', () => {
    expect(appTrialOf({ status: 'trialing', trialEndsAt: at(5), now: NOW })).toEqual({ active: false, endsAt: null, daysLeft: 0 });
    expect(appTrialOf({ status: null, trialEndsAt: null, now: NOW })).toEqual({ active: false, endsAt: null, daysLeft: 0 });
  });

  it('トライアルの終わり = 作成時刻 + 日数', () => {
    expect(appTrialEndFrom(NOW, 30)).toEqual(at(30));
  });
});

describe('needsEntitlementCheck', () => {
  it('読み取りでは確認しない（全リクエストに1クエリ足さない）', () => {
    expect(needsEntitlementCheck('GET', '/api/tasks')).toBe(false);
    expect(needsEntitlementCheck('HEAD', '/api/tasks')).toBe(false);
  });

  it('書き込みでは確認する', () => {
    expect(needsEntitlementCheck('POST', '/api/chat/sessions')).toBe(true);
    expect(needsEntitlementCheck('DELETE', '/api/files/abc')).toBe(true);
    expect(needsEntitlementCheck('PATCH', '/api/accounting/costs/1')).toBe(true);
  });

  it('決済と認証の経路は止めない（止めると再開できなくなる）', () => {
    expect(needsEntitlementCheck('POST', '/api/billing/checkout')).toBe(false);
    expect(needsEntitlementCheck('POST', '/api/auth/login')).toBe(false);
    expect(needsEntitlementCheck('POST', '/api/webhooks/stripe')).toBe(false);
    expect(needsEntitlementCheck('POST', '/api/billing/portal?x=1')).toBe(false);
  });
});

describe('requireAuth の契約チェック', () => {
  it('解約済みの組織は書き込みを 402 で止める', async () => {
    withStatus('canceled');
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(app), payload: {} });

    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(res.json().error.message).toContain('閲覧');
    await app.close();
  });

  it('解約済みでも読み取りは通り、契約のために余分なクエリを足さない', async () => {
    // 所属の確認は毎リクエスト行う（設計書 Q1）。契約状態はその1回の読み取りに載っているので、
    // 読み取りのために別のクエリは増えない
    withStatus('canceled');
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(app) });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('解約済みでも決済の手続きは通す', async () => {
    withStatus('canceled');
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: auth(app), payload: {} });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('契約中と、まだ決済を繋いでいない組織は書き込める', async () => {
    const app = await build();
    for (const status of ['active', 'trialing', 'past_due', null]) {
      clearMembershipCache();
      withStatus(status);
      const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: auth(app), payload: {} });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('トークンが無ければ 401（契約を見る前に止める）', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('requireAuth の登録時トライアル', () => {
  const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
  const REGISTERED = new Date('2026-11-17T00:00:00Z');
  const TRIAL_END = new Date(REGISTERED.getTime() + 30 * DAY);
  const after = (days: number) => new Date(REGISTERED.getTime() + days * DAY);

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  });

  const call = async (app: FastifyInstance, method: 'GET' | 'POST', url: string) =>
    app.inject({ method, url, headers: auth(app), ...(method === 'POST' ? { payload: {} } : {}) });

  it('(1) 登録直後は書き込める', async () => {
    vi.setSystemTime(after(0));
    withStatus(null, TRIAL_END);
    const app = await build();
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(200);
    await app.close();
  });

  it('(2) 31 日後は POST が 402（トライアル切れの文言）、GET と決済・認証の経路は通る', async () => {
    vi.setSystemTime(after(31));
    withStatus(null, TRIAL_END);
    const app = await build();

    const post = await call(app, 'POST', '/api/tasks');
    expect(post.statusCode).toBe(402);
    expect(post.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(post.json().error.message).toContain('無料期間');

    expect((await call(app, 'GET', '/api/tasks')).statusCode).toBe(200);
    expect((await call(app, 'POST', '/api/billing/checkout')).statusCode).toBe(200);
    expect((await call(app, 'POST', '/api/auth/switch-org')).statusCode).toBe(200);
    await app.close();
  });

  it('判定は要求時刻で行う（キャッシュに載った写しでも期限が来たら止まる）', async () => {
    vi.setSystemTime(new Date(TRIAL_END.getTime() - 1000));
    withStatus(null, TRIAL_END);
    const app = await build();
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(200);
    vi.setSystemTime(new Date(TRIAL_END.getTime() + 1000)); // キャッシュの TTL（30 秒）の内側
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(402);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('(3) STRIPE_SECRET_KEY 未設定なら 31 日後も 402 にならない', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    vi.setSystemTime(after(31));
    withStatus(null, TRIAL_END);
    const app = await build();
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(200);
    await app.close();
  });

  it('(4) trialEndsAt = null かつ未契約の既存組織は従来どおり通る', async () => {
    vi.setSystemTime(after(400));
    withStatus(null, null);
    const app = await build();
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(200);
    await app.close();
  });

  it('(5) 作成時点で期限切れ（2 つ目の組織）は作成直後から書き込みが 402', async () => {
    vi.setSystemTime(after(0));
    withStatus(null, after(0));
    const app = await build();
    expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(402);
    await app.close();
  });

  it('(6) trialing / active / past_due は trialEndsAt に関係なく通る', async () => {
    vi.setSystemTime(after(31));
    const app = await build();
    for (const status of ['trialing', 'active', 'past_due']) {
      clearMembershipCache();
      withStatus(status, TRIAL_END);
      expect((await call(app, 'POST', '/api/tasks')).statusCode).toBe(200);
    }
    await app.close();
  });
});
