import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PLAN_LIMITS, STORAGE_ADDON_UNIT_BYTES } from '@org-ai/shared-types';

const prismaMock = {
  organization: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

let currentUser: Record<string, unknown> = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = currentUser;
  },
  requireOwner: async (req: { user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    req.user = currentUser;
    if (currentUser.role !== 'OWNER') {
      reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'この操作はオーナーのみ行えます' } });
    }
  },
}));

const stripeMock = {
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  retrieveSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  retrievePrice: vi.fn(),
};
vi.mock('../../src/services/billing/stripe-client', () => ({
  StripeClient: class {
    constructor() {
      return stripeMock;
    }
  },
  StripeError: class extends Error {},
}));

const applySubscription = vi.fn();
vi.mock('../../src/services/billing/sync', () => ({ applySubscription: (...a: unknown[]) => applySubscription(...a) }));

const { billingRoutes, resetBillingPriceCache } = await import('../../src/routes/billing');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.ready();
  return app;
}

const ENV_KEYS = [
  'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_YEARLY',
  'STRIPE_PRICE_STORAGE_ADDON', 'STRIPE_TAX_RATE_ID', 'APP_BASE_URL', 'BILLING_TRIAL_DAYS',
];

function configure(): void {
  process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'unit'].join('_');
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_s_m';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_p_m';
  process.env.STRIPE_PRICE_PRO_YEARLY = 'price_p_y';
  process.env.STRIPE_PRICE_STORAGE_ADDON = 'price_addon';
  process.env.APP_BASE_URL = 'https://app.example.com';
}

function org(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1', name: '山田工務店', plan: 'STARTER', billingEmail: null,
    stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, billingInterval: null,
    currentPeriodEnd: null, trialEndsAt: null, cancelAtPeriodEnd: false,
    storageAddonUnits: 0, storageUsedBytes: BigInt(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  resetBillingPriceCache();
  currentUser = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
  prismaMock.organization.findUnique.mockResolvedValue(org());
  prismaMock.organization.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });
  stripeMock.retrievePrice.mockImplementation(async (id: string) => ({
    id, currency: 'jpy', unit_amount: { price_s_m: 9800, price_p_m: 19800, price_p_y: 190080, price_addon: 500 }[id] ?? null,
  }));
});

describe('GET /api/billing', () => {
  it('決済が未設定なら configured=false を返し、Stripe を呼ばない', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/billing' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ configured: false, plan: 'STARTER', prices: [], trialAvailable: true });
    expect(stripeMock.retrievePrice).not.toHaveBeenCalled();
    await app.close();
  });

  it('金額は Stripe の価格から出す（コードに金額を持たない）', async () => {
    configure();
    const app = await build();
    const data = (await app.inject({ method: 'GET', url: '/api/billing' })).json().data;
    expect(data.configured).toBe(true);
    expect(data.prices).toContainEqual({ plan: 'PRO', interval: 'year', amount: 190080 });
    // 設定の無い price は null（画面では「—」）
    expect(data.prices).toContainEqual({ plan: 'MAX', interval: 'month', amount: null });
    expect(data.storageAddon).toMatchObject({ available: true, purchasable: false, unitAmount: 500, unitBytes: STORAGE_ADDON_UNIT_BYTES });
    await app.close();
  });

  it('追加容量は課金中（active）だけ買える', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(org({ subscriptionStatus: 'trialing', stripeSubscriptionId: 'sub_1' }));
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/billing' })).json().data.storageAddon.purchasable).toBe(false);
    prismaMock.organization.findUnique.mockResolvedValue(org({ subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1' }));
    expect((await app.inject({ method: 'GET', url: '/api/billing' })).json().data.storageAddon.purchasable).toBe(true);
    await app.close();
  });
});

describe('POST /api/billing/checkout', () => {
  it('オーナー以外は申し込めない', async () => {
    configure();
    currentUser = { orgId: 'org-1', sub: 'admin-1', role: 'ADMIN' };
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(403);
    expect(stripeMock.createCheckoutSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('未設定なら 503', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('顧客を作り（まだ空のときだけ書く）、初回はトライアル付きの Checkout を返す', async () => {
    configure();
    stripeMock.createCustomer.mockResolvedValue({ id: 'cus_new' });
    stripeMock.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'year' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe('https://checkout.stripe.com/c/cs_1');
    expect(stripeMock.createCustomer).toHaveBeenCalledWith({ name: '山田工務店', email: 'owner@example.com', orgId: 'org-1' });
    expect(prismaMock.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1', stripeCustomerId: null },
      data: { stripeCustomerId: 'cus_new' },
    });
    const params = stripeMock.createCheckoutSession.mock.calls[0][0];
    expect(params).toMatchObject({ customer: 'cus_new', client_reference_id: 'org-1', line_items: [{ price: 'price_p_y' }] });
    expect(params.subscription_data.trial_period_days).toBe(30);
    await app.close();
  });

  it('同時に押されて顧客IDの書き込みに負けたら、先に書かれた方を使う', async () => {
    configure();
    stripeMock.createCustomer.mockResolvedValue({ id: 'cus_loser' });
    prismaMock.organization.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.organization.findUnique
      .mockResolvedValueOnce(org())
      .mockResolvedValueOnce({ stripeCustomerId: 'cus_winner' });
    stripeMock.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(stripeMock.createCheckoutSession.mock.calls[0][0].customer).toBe('cus_winner');
    await app.close();
  });

  it('トライアルを使った組織には無料期間を付けない', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(
      org({ stripeCustomerId: 'cus_1', subscriptionStatus: 'canceled', trialEndsAt: new Date('2026-08-01') }),
    );
    stripeMock.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(stripeMock.createCustomer).not.toHaveBeenCalled();
    expect(stripeMock.createCheckoutSession.mock.calls[0][0].subscription_data.trial_period_days).toBeUndefined();
    await app.close();
  });

  it('契約中なら 409（2本目を作らせない）', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(org({ stripeCustomerId: 'cus_1', subscriptionStatus: 'past_due' }));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_SUBSCRIBED');
    expect(stripeMock.createCheckoutSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('price が設定されていないプランは 400', async () => {
    configure();
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'MAX', interval: 'month' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_NOT_AVAILABLE');
    await app.close();
  });

  it('Stripe が落ちていたら 502。Stripe の文言は返さない', async () => {
    configure();
    stripeMock.createCustomer.mockRejectedValue(new Error('Stripe API エラー (HTTP 500, card_declined)'));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('card_declined');
    await app.close();
  });
});

describe('POST /api/billing/portal', () => {
  it('まだ顧客が無ければ 409', async () => {
    configure();
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/portal' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('戻り先は設定から作る（利用者の入力を使わない）', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    stripeMock.createPortalSession.mockResolvedValue({ url: 'https://billing.stripe.com/p/session' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/portal', payload: { returnUrl: 'https://evil.example' } });
    expect(res.json().data.url).toBe('https://billing.stripe.com/p/session');
    expect(stripeMock.createPortalSession).toHaveBeenCalledWith('cus_1', 'https://app.example.com/settings?tab=billing');
    await app.close();
  });
});

describe('POST /api/billing/storage-addon', () => {
  const activeOrg = (o: Record<string, unknown> = {}) =>
    org({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active', ...o });

  it('トライアル中は買えない（請求が立たないまま容量だけ渡すことになる）', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg({ subscriptionStatus: 'trialing' }));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/storage-addon', payload: { units: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BILLING_NOT_ACTIVE');
    expect(stripeMock.retrieveSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('使用量が収まらない減らし方は止める（ファイルを勝手に消さない）', async () => {
    configure();
    const used = PLAN_LIMITS.STARTER.storageBytes + STORAGE_ADDON_UNIT_BYTES + 1;
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg({ storageAddonUnits: 2, storageUsedBytes: BigInt(used) }));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/storage-addon', payload: { units: 1 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STORAGE_IN_USE');
    expect(stripeMock.updateSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('桁の打ち間違いを止める（上限 50 口）', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg());
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/storage-addon', payload: { units: 500 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('明細を足し、返ってきたサブスクリプションを先に組織へ写す', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg());
    const current = { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ id: 'si_base', quantity: 1, price: { id: 'price_s_m' } }] } };
    const updated = { ...current, items: { data: [...current.items.data, { id: 'si_addon', quantity: 2, price: { id: 'price_addon' } }] } };
    stripeMock.retrieveSubscription.mockResolvedValue(current);
    stripeMock.updateSubscription.mockResolvedValue(updated);

    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/storage-addon', payload: { units: 2 } });

    expect(res.statusCode).toBe(200);
    const [subId, params, idempotencyKey] = stripeMock.updateSubscription.mock.calls[0];
    expect(subId).toBe('sub_1');
    expect(params).toEqual({ items: [{ price: 'price_addon', quantity: 2, tax_rates: undefined }], proration_behavior: 'create_prorations' });
    expect(idempotencyKey).toContain('addon:sub_1:2:');
    expect(applySubscription).toHaveBeenCalledWith('org-1', updated, expect.objectContaining({ storageAddonPrice: 'price_addon' }));
    await app.close();
  });
});

describe('POST /api/billing/change-plan', () => {
  const activeOrg = (o: Record<string, unknown> = {}) =>
    org({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active', billingInterval: 'month', ...o });
  const subWith = (priceId: string, extra: unknown[] = []) => ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    items: { data: [{ id: 'si_base', quantity: 1, price: { id: priceId } }, ...extra] },
  });
  const addonItem = { id: 'si_addon', quantity: 2, price: { id: 'price_addon' } };

  it('契約が無ければ 409（先に申し込みへ）', async () => {
    configure();
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_SUBSCRIBED');
    await app.close();
  });

  it('オーナー以外は変更できない', async () => {
    configure();
    currentUser = { orgId: 'org-1', sub: 'member-1', role: 'MEMBER' };
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('基本プランの明細だけ price を差し替え、追加ストレージの明細には触らない', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg());
    stripeMock.retrieveSubscription.mockResolvedValue(subWith('price_s_m', [addonItem]));
    const updated = subWith('price_p_m', [addonItem]);
    stripeMock.updateSubscription.mockResolvedValue(updated);

    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'PRO', interval: 'month' } });

    expect(res.statusCode).toBe(200);
    expect(stripeMock.updateSubscription).toHaveBeenCalledWith(
      'sub_1',
      { items: [{ id: 'si_base', price: 'price_p_m' }], proration_behavior: 'create_prorations' },
      'plan:sub_1:si_base:price_s_m:price_p_m',
    );
    expect(applySubscription).toHaveBeenCalledWith('org-1', updated, expect.anything());
    await app.close();
  });

  it('同じ price なら Stripe を更新しない', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg({ plan: 'PRO' }));
    stripeMock.retrieveSubscription.mockResolvedValue(subWith('price_p_m'));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(200);
    expect(stripeMock.updateSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('下げた先の容量に今のファイルが収まらなければ 409（Stripe に触らない）', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(
      activeOrg({ plan: 'PRO', storageUsedBytes: BigInt(PLAN_LIMITS.STARTER.storageBytes + 1) }),
    );
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'STARTER', interval: 'month' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STORAGE_IN_USE');
    expect(stripeMock.retrieveSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('基本プランの明細が見つからない契約は 409', async () => {
    configure();
    prismaMock.organization.findUnique.mockResolvedValue(activeOrg());
    stripeMock.retrieveSubscription.mockResolvedValue(subWith('price_manual'));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/billing/change-plan', payload: { plan: 'PRO', interval: 'month' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNKNOWN_SUBSCRIPTION');
    await app.close();
  });
});
