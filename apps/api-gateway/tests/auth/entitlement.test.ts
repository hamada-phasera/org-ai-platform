import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

import { userWithMembership } from '../helpers/membership';

// 契約状態は、所属の確認（User ⨝ Membership ⨝ Organization の1回の読み取り）に載っている
const prismaMock = { user: { findUnique: vi.fn() } };
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

const { requireAuth } = await import('../../src/middleware/auth');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const withStatus = (subscriptionStatus: string | null) =>
  prismaMock.user.findUnique.mockResolvedValue(userWithMembership({ subscriptionStatus }));
const { entitlementOf, needsEntitlementCheck } = await import('../../src/services/entitlement');

const SECRET = 'test-secret-value-that-is-long-enough-32';

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: SECRET });
  const handler = async () => ({ success: true, data: { ran: true } });
  app.post('/api/tasks', { preHandler: requireAuth }, handler);
  app.get('/api/tasks', { preHandler: requireAuth }, handler);
  app.post('/api/billing/checkout', { preHandler: requireAuth }, handler);
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

describe('entitlementOf', () => {
  it('まだ決済を繋いでいない組織は止めない（課金開始前の利用者を落とさない）', () => {
    expect(entitlementOf(null)).toBe('full');
    expect(entitlementOf(undefined)).toBe('full');
  });

  it('契約中・トライアル中・支払い遅延は通す', () => {
    for (const s of ['trialing', 'active', 'past_due']) expect(entitlementOf(s)).toBe('full');
  });

  it('解約・未払い・一時停止は閲覧のみ', () => {
    for (const s of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(entitlementOf(s)).toBe('read_only');
    }
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
