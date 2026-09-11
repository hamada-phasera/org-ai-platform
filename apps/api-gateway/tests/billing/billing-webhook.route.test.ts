import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';

const prismaMock = { billingEvent: { findUnique: vi.fn(), create: vi.fn() } };
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

const handleStripeEvent = vi.fn();
vi.mock('../../src/services/billing/webhook-handler', () => ({
  handleStripeEvent: (...a: unknown[]) => handleStripeEvent(...a),
}));

const { stripeWebhookRoutes } = await import('../../src/routes/billing-webhook');

const WEBHOOK_SECRET = ['whsec', 'unit-test-only'].join('_');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks/stripe' });
  await app.ready();
  return app;
}

function signed(payload: object, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } };
}

const EVENT = { id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'unit'].join('_');
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  prismaMock.billingEvent.findUnique.mockResolvedValue(null);
  prismaMock.billingEvent.create.mockResolvedValue({});
  handleStripeEvent.mockResolvedValue('org-1');
});

describe('POST /api/webhooks/stripe', () => {
  it('署名が正しければ処理し、成功してから処理済みの印を書く', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT) });
    expect(res.statusCode).toBe(200);
    expect(handleStripeEvent).toHaveBeenCalledTimes(1);
    expect(prismaMock.billingEvent.create).toHaveBeenCalledWith({ data: { id: 'evt_1', type: 'customer.subscription.updated', orgId: 'org-1' } });
    await app.close();
  });

  it('署名が違えば 400。処理もしない', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT, 'wrong-secret') });
    expect(res.statusCode).toBe(400);
    expect(handleStripeEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('署名ヘッダが無ければ 400', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/webhooks/stripe', payload: JSON.stringify(EVENT), headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('処理済みのイベントの再送は、処理せずに 200', async () => {
    prismaMock.billingEvent.findUnique.mockResolvedValue({ id: 'evt_1' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT) });
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
    expect(handleStripeEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('処理に失敗したら 500 を返し、印を書かない（Stripe の再送で直る）', async () => {
    handleStripeEvent.mockRejectedValue(new Error('stripe down'));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT) });
    expect(res.statusCode).toBe(500);
    expect(prismaMock.billingEvent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('同時に届いた同じイベントで印が一意制約に当たっても 200', async () => {
    prismaMock.billingEvent.create.mockRejectedValue({ code: 'P2002' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT) });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('署名鍵が未設定なら受け付けない（検証できないものは信じない）', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', ...signed(EVENT) });
    expect(res.statusCode).toBe(503);
    expect(handleStripeEvent).not.toHaveBeenCalled();
    await app.close();
  });
});
