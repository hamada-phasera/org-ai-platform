import { describe, it, expect, beforeEach, vi } from 'vitest';

const prismaMock = {
  organization: { findUnique: vi.fn(), update: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

const { handleStripeEvent } = await import('../../src/services/billing/webhook-handler');
const { StripeError } = await import('../../src/services/billing/stripe-client');
import type { BillingConfig, StripeSubscription } from '../../src/services/billing/billing-core';

const config: BillingConfig = {
  secretKey: ['sk', 'test', 'unit'].join('_'),
  webhookSecret: ['whsec', 'unit-test-only'].join('_'),
  prices: {
    STARTER: { month: 'price_s_m', year: null },
    PRO: { month: 'price_p_m', year: null },
    MAX: { month: 'price_x_m', year: null },
  },
  storageAddonPrice: 'price_addon',
  taxRateId: null,
  trialDays: 30,
  appBaseUrl: 'https://app.example.com',
};

const subscription = (o: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  metadata: { orgId: 'org-1' },
  trial_end: null,
  items: { data: [{ id: 'si', quantity: 1, current_period_end: 1_790_000_000, price: { id: 'price_p_m' } }] },
  ...o,
});

const stripe = { retrieveSubscription: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockImplementation(async ({ where, select }: { where: Record<string, string>; select: Record<string, boolean> }) => {
    if (select.stripeSubscriptionId) return { stripeCustomerId: null, stripeSubscriptionId: null, trialEndsAt: null };
    return where.id === 'org-1' || where.stripeCustomerId === 'cus_1' ? { id: 'org-1' } : null;
  });
});

const event = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, data: { object } });

describe('checkout.session.completed', () => {
  it('サブスクリプションを取り直して、組織にプランと顧客を写す', async () => {
    stripe.retrieveSubscription.mockResolvedValue(subscription());
    const orgId = await handleStripeEvent(
      event('checkout.session.completed', { mode: 'subscription', client_reference_id: 'org-1', subscription: 'sub_1' }),
      config,
      stripe,
    );
    expect(orgId).toBe('org-1');
    expect(stripe.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: expect.objectContaining({ plan: 'PRO', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active' }),
    });
  });

  it('サブスクリプション以外の Checkout は無視する', async () => {
    const orgId = await handleStripeEvent(event('checkout.session.completed', { mode: 'payment' }), config, stripe);
    expect(orgId).toBeNull();
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.*', () => {
  it('イベント本文ではなく、取り直した最新の状態を写す（順不同対策）', async () => {
    // 本文は古い「契約中」、実際はもう解約済み
    stripe.retrieveSubscription.mockResolvedValue(subscription({ status: 'canceled' }));
    await handleStripeEvent(event('customer.subscription.updated', subscription({ status: 'active' }) as never), config, stripe);
    expect(prismaMock.organization.update.mock.calls[0][0].data).toMatchObject({ subscriptionStatus: 'canceled', plan: 'STARTER', storageAddonUnits: 0 });
  });

  it('契約し直した組織に、古いサブスクリプションの解約が遅れて届いても現行を落とさない', async () => {
    prismaMock.organization.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.stripeSubscriptionId ? { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_new', trialEndsAt: null } : { id: 'org-1' },
    );
    stripe.retrieveSubscription.mockResolvedValue(subscription({ id: 'sub_old', status: 'canceled' }));
    await handleStripeEvent(event('customer.subscription.deleted', subscription({ id: 'sub_old' }) as never), config, stripe);
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('組織の顧客IDと違うサブスクリプションは写さない', async () => {
    prismaMock.organization.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.stripeSubscriptionId ? { stripeCustomerId: 'cus_other', stripeSubscriptionId: null, trialEndsAt: null } : { id: 'org-1' },
    );
    stripe.retrieveSubscription.mockResolvedValue(subscription());
    await handleStripeEvent(event('customer.subscription.updated', subscription() as never), config, stripe);
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('一度入ったトライアル終了日は消さない（2回目の無料期間を出さない）', async () => {
    const trialEnd = new Date('2026-08-01T00:00:00Z');
    prismaMock.organization.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.stripeSubscriptionId ? { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', trialEndsAt: trialEnd } : { id: 'org-1' },
    );
    stripe.retrieveSubscription.mockResolvedValue(subscription({ trial_end: null }));
    await handleStripeEvent(event('customer.subscription.updated', subscription() as never), config, stripe);
    expect(prismaMock.organization.update.mock.calls[0][0].data.trialEndsAt).toEqual(trialEnd);
  });

  it('metadata が無くても顧客IDから組織を引ける', async () => {
    stripe.retrieveSubscription.mockResolvedValue(subscription({ metadata: null }));
    const orgId = await handleStripeEvent(event('customer.subscription.updated', subscription({ metadata: null }) as never), config, stripe);
    expect(orgId).toBe('org-1');
  });

  it('削除済みで取り直せない（404）ときだけ本文を使う', async () => {
    stripe.retrieveSubscription.mockRejectedValue(new StripeError('gone', 404));
    await handleStripeEvent(event('customer.subscription.deleted', subscription({ status: 'canceled' }) as never), config, stripe);
    expect(prismaMock.organization.update.mock.calls[0][0].data.subscriptionStatus).toBe('canceled');
  });

  it('Stripe が落ちていたら投げる（500 を返して再送させる）', async () => {
    stripe.retrieveSubscription.mockRejectedValue(new StripeError('down', 500));
    await expect(
      handleStripeEvent(event('customer.subscription.updated', subscription() as never), config, stripe),
    ).rejects.toThrow();
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('関係の無いイベントは何もしない', async () => {
    expect(await handleStripeEvent(event('invoice.paid', {}), config, stripe)).toBeNull();
  });
});
