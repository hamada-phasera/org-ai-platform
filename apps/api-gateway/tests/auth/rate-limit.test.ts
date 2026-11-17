import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { createHmac } from 'node:crypto';

// チャンク 7: レート制限（middleware/rate-limit.ts）。index.ts と同じ順（制限 → ルート）で組み立てる。

const prismaMock = {
  user: { findUnique: vi.fn(async () => null) },
  invitation: { findUnique: vi.fn(async () => null) },
  billingEvent: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
const handleStripeEvent = vi.fn(async () => 'org-1');
vi.mock('../../src/services/billing/webhook-handler', () => ({
  handleStripeEvent: (...a: unknown[]) => handleStripeEvent(...(a as [])),
}));

const { registerRateLimit, isRateLimitExempt, AUTH_RATE_LIMIT, INVITE_RATE_LIMIT, GLOBAL_RATE_LIMIT } = await import(
  '../../src/middleware/rate-limit'
);
const { authRoutes } = await import('../../src/routes/auth');
const { memberRoutes } = await import('../../src/routes/members');
const { stripeWebhookRoutes } = await import('../../src/routes/billing-webhook');
const { healthRoutes } = await import('../../src/routes/health');

const WEBHOOK_SECRET = ['whsec', 'rate-limit-test'].join('_');

async function build(trustProxy: number | boolean = 1): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy });
  await app.register(jwt, { secret: 'x'.repeat(32) });
  await registerRateLimit(app);
  await app.register(healthRoutes, { pingDb: async () => 1 });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(memberRoutes, { prefix: '/api/members' });
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks/stripe' });
  app.get('/api/other', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const login = (app: FastifyInstance, ip = '203.0.113.1') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { email: 'a@example.com', password: 'wrong-password' },
  });

function signedStripe() {
  const body = JSON.stringify({ id: `evt_${Math.random()}`, type: 'customer.subscription.updated', data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return { payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}`, 'x-forwarded-for': '203.0.113.9' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'unit'].join('_');
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('上限の値（計画書チャンク 7）', () => {
  it('ログイン・登録 10 / 招待 20 / 全体 300（いずれも 1 分）', () => {
    expect(AUTH_RATE_LIMIT).toEqual({ max: 10, timeWindow: 60_000 });
    expect(INVITE_RATE_LIMIT).toEqual({ max: 20, timeWindow: 60_000 });
    expect(GLOBAL_RATE_LIMIT).toEqual({ max: 300, timeWindow: 60_000 });
  });
});

describe('ログイン', () => {
  it('同一 IP から 11 回続けると 11 回目が 429 RATE_LIMITED（統一フォーマット）', async () => {
    const app = await build();
    for (let i = 0; i < 10; i++) expect((await login(app)).statusCode).toBe(401);
    const res = await login(app);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(typeof res.json().error.message).toBe('string');
    expect(res.headers['retry-after']).toBeDefined();
    // 制限中は資格情報の照合まで進まない
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(10);
    await app.close();
  });

  it('IP は転送ヘッダから取る（別の利用者は止まらない）', async () => {
    const app = await build();
    for (let i = 0; i < 11; i++) await login(app, '203.0.113.1');
    expect((await login(app, '203.0.113.1')).statusCode).toBe(429);
    expect((await login(app, '198.51.100.7')).statusCode).toBe(401);
    await app.close();
  });

  it('⚠️ 利用者が X-Forwarded-For の先頭を書き換えても、プロキシが付けた IP で数える（trustProxy=1）', async () => {
    const app = await build(1);
    for (let i = 0; i < 10; i++) await login(app, `10.0.0.${i}, 203.0.113.1`);
    expect((await login(app, '10.9.9.9, 203.0.113.1')).statusCode).toBe(429);
    await app.close();
  });

  it('登録も 10 回 / 分', async () => {
    const app = await build();
    const reg = () =>
      app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-forwarded-for': '203.0.113.5' }, payload: {} });
    for (let i = 0; i < 10; i++) expect((await reg()).statusCode).toBe(400);
    expect((await reg()).statusCode).toBe(429);
    await app.close();
  });
});

describe('招待', () => {
  it('プレビューは 20 回 / 分（21 回目が 429）', async () => {
    const app = await build();
    const preview = () =>
      app.inject({ method: 'GET', url: '/api/members/invitations/preview/abcdefghijklmnopqrstuvwxyz', headers: { 'x-forwarded-for': '203.0.113.2' } });
    for (let i = 0; i < 20; i++) expect((await preview()).statusCode).toBe(404);
    expect((await preview()).statusCode).toBe(429);
    await app.close();
  });
});

describe('除外', () => {
  it('Stripe webhook は制限されない（署名で守られている）', async () => {
    const app = await build();
    for (let i = 0; i < 320; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signedStripe() });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('/health は制限されない。その他は全体の 300 回 / 分で止まる', async () => {
    const app = await build();
    for (let i = 0; i < 305; i++) {
      expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '203.0.113.3' } })).statusCode).toBe(200);
    }
    for (let i = 0; i < 300; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/other', headers: { 'x-forwarded-for': '203.0.113.3' } })).statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'GET', url: '/api/other', headers: { 'x-forwarded-for': '203.0.113.3' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    await app.close();
  });

  it.each([
    ['/api/webhooks/stripe', true],
    ['/api/webhooks/stripe?x=1', true],
    ['/api/webhooks/line', true],
    ['/api/webhooks/line/', true],
    ['/health', true],
    ['/health/x', false],
    ['/api/webhooks/stripe-fake', false],
    ['/api/webhooks/n8n/task-complete', false],
    ['/ready', false],
  ])('isRateLimitExempt(%s) → %s', (url, expected) => {
    expect(isRateLimitExempt(url)).toBe(expected);
  });
});
