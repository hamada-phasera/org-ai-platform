import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  billingConfigFromEnv,
  buildAddonItems,
  buildCheckoutParams,
  checkoutTrialEnd,
  encodeStripeForm,
  MIN_CHECKOUT_TRIAL_LEAD_MS,
  findBaseItem,
  planFromPriceId,
  subscriptionSnapshot,
  verifyStripeSignature,
  type BillingConfig,
  type StripeSubscription,
} from '../../src/services/billing/billing-core';

// ⚠️ 秘密情報らしい文字列をソースに置かない（push 保護に引っかかる）。実行時に組み立てる
const SECRET_KEY = ['sk', 'test', 'unit'].join('_');
const WEBHOOK_SECRET = ['whsec', 'unit-test-only'].join('_');

const config: BillingConfig = {
  secretKey: SECRET_KEY,
  webhookSecret: WEBHOOK_SECRET,
  prices: {
    STARTER: { month: 'price_s_m', year: 'price_s_y' },
    PRO: { month: 'price_p_m', year: 'price_p_y' },
    MAX: { month: 'price_x_m', year: 'price_x_y' },
  },
  storageAddonPrice: 'price_addon',
  taxRateId: 'txr_jp10',
  trialDays: 30,
  appBaseUrl: 'https://app.example.com',
};

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    items: { data: [{ id: 'si_base', quantity: 1, current_period_end: 1_790_000_000, price: { id: 'price_p_m' } }] },
    ...overrides,
  };
}

describe('billingConfigFromEnv', () => {
  it('シークレットキーが無ければ null（決済は未設定として扱う）', () => {
    expect(billingConfigFromEnv({})).toBeNull();
  });

  it('price ID を読み、戻り先の末尾スラッシュを落とす', () => {
    const c = billingConfigFromEnv({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_PRICE_PRO_YEARLY: 'price_p_y',
      APP_BASE_URL: 'https://app.example.com/',
    });
    expect(c?.prices.PRO.year).toBe('price_p_y');
    expect(c?.prices.PRO.month).toBeNull();
    expect(c?.appBaseUrl).toBe('https://app.example.com');
    expect(c?.trialDays).toBe(30);
  });

  it('トライアル日数が壊れていたら既定の30日', () => {
    expect(billingConfigFromEnv({ STRIPE_SECRET_KEY: SECRET_KEY, BILLING_TRIAL_DAYS: 'abc' })?.trialDays).toBe(30);
    expect(billingConfigFromEnv({ STRIPE_SECRET_KEY: SECRET_KEY, BILLING_TRIAL_DAYS: '0' })?.trialDays).toBe(0);
  });
});

describe('planFromPriceId', () => {
  it('price からプランと支払い間隔を引く', () => {
    expect(planFromPriceId(config, 'price_x_y')).toEqual({ plan: 'MAX', interval: 'year' });
    expect(planFromPriceId(config, 'price_unknown')).toBeNull();
    expect(planFromPriceId(config, undefined)).toBeNull();
  });
});

describe('subscriptionSnapshot', () => {
  it('契約中: プラン・間隔・追加容量・更新日を写す（新しい API 版は期間が明細に載る）', () => {
    const s = subscriptionSnapshot(
      sub({
        items: {
          data: [
            { id: 'si_base', quantity: 1, current_period_end: 1_790_000_000, price: { id: 'price_p_m' } },
            { id: 'si_addon', quantity: 3, current_period_end: 1_790_000_000, price: { id: 'price_addon' } },
          ],
        },
      }),
      config,
    );
    expect(s).toMatchObject({ plan: 'PRO', interval: 'month', addonUnits: 3, entitled: true, unknownPrice: false });
    expect(s.currentPeriodEnd?.getTime()).toBe(1_790_000_000 * 1000);
  });

  it('古い API 版（期間がサブスクリプション直下）でも更新日を読める', () => {
    const s = subscriptionSnapshot(
      sub({ current_period_end: 1_780_000_000, items: { data: [{ id: 'si', quantity: 1, price: { id: 'price_s_y' } }] } }),
      config,
    );
    expect(s.currentPeriodEnd?.getTime()).toBe(1_780_000_000 * 1000);
    expect(s.plan).toBe('STARTER');
    expect(s.interval).toBe('year');
  });

  it('トライアル中は権利あり。トライアル終了日を持つ', () => {
    const s = subscriptionSnapshot(sub({ status: 'trialing', trial_end: 1_760_000_000 }), config);
    expect(s.entitled).toBe(true);
    expect(s.trialEndsAt?.getTime()).toBe(1_760_000_000 * 1000);
  });

  it('支払い遅延（past_due）は猶予期間なので、プランを下げない', () => {
    expect(subscriptionSnapshot(sub({ status: 'past_due' }), config).plan).toBe('PRO');
  });

  it('解約・未払いでは既定の上限に戻し、追加容量も 0 にする', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      const s = subscriptionSnapshot(
        sub({
          status,
          items: {
            data: [
              { id: 'si_base', quantity: 1, price: { id: 'price_x_m' } },
              { id: 'si_addon', quantity: 5, price: { id: 'price_addon' } },
            ],
          },
        }),
        config,
      );
      expect(s).toMatchObject({ entitled: false, plan: 'STARTER', addonUnits: 0 });
    }
  });

  it('設定に無い price なら、プランを変えずに知らせる', () => {
    const s = subscriptionSnapshot(sub({ items: { data: [{ id: 'si', quantity: 1, price: { id: 'price_manual' } }] } }), config);
    expect(s.plan).toBeNull();
    expect(s.unknownPrice).toBe(true);
  });

  it('解約予約は、従来モード（cancel_at_period_end）と柔軟モード（cancel_at）の両方を読む', () => {
    expect(subscriptionSnapshot(sub({ cancel_at_period_end: true }), config).cancelAtPeriodEnd).toBe(true);
    expect(subscriptionSnapshot(sub({ cancel_at_period_end: false, cancel_at: 1_790_000_000 }), config).cancelAtPeriodEnd).toBe(true);
    expect(subscriptionSnapshot(sub({ cancel_at_period_end: false, cancel_at: null }), config).cancelAtPeriodEnd).toBe(false);
  });

  it('顧客が展開済みオブジェクトで来ても ID を取れる', () => {
    expect(subscriptionSnapshot(sub({ customer: { id: 'cus_9' } }), config).customerId).toBe('cus_9');
  });
});

describe('buildCheckoutParams', () => {
  it('組織の目印を3か所に入れ、税率を付け、戻り先は設定から作る', () => {
    const p = buildCheckoutParams({ config, orgId: 'org-1', customerId: 'cus_1', priceId: 'price_p_y', withTrial: true });
    expect(p).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'org-1',
      metadata: { orgId: 'org-1' },
      line_items: [{ price: 'price_p_y', quantity: 1, tax_rates: ['txr_jp10'] }],
      subscription_data: { metadata: { orgId: 'org-1' }, trial_period_days: 30 },
      success_url: 'https://app.example.com/settings?tab=billing&checkout=success',
      locale: 'ja',
    });
  });

  it('トライアル使用済みなら無料期間を付けない', () => {
    const p = buildCheckoutParams({ config, orgId: 'org-1', customerId: 'cus_1', priceId: 'price_p_y', withTrial: false });
    expect((p.subscription_data as Record<string, unknown>).trial_period_days).toBeUndefined();
  });
});

describe('登録時トライアルの残りを Checkout に引き継ぐ（D3: trial_end）', () => {
  const NOW = new Date('2026-11-17T00:00:00Z').getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const params = (trialEndsAt: Date | null, withTrial = false) =>
    buildCheckoutParams({
      config, orgId: 'org-1', customerId: 'cus_1', priceId: 'price_p_m', withTrial,
      trialEnd: checkoutTrialEnd({ status: null, trialEndsAt, now: NOW }),
    }).subscription_data as Record<string, unknown>;

  it('残り 10 日なら trial_end にトライアルの終わり（秒）が入り、trial_period_days は付かない', () => {
    const end = new Date(NOW + 10 * DAY);
    const sd = params(end);
    expect(sd.trial_end).toBe(Math.floor(end.getTime() / 1000));
    expect(sd.trial_period_days).toBeUndefined();
    // form にしても 1 本だけ（Stripe は両方の同時指定を受け付けない）
    const form = encodeStripeForm({ subscription_data: sd });
    expect(form).toContain('subscription_data[trial_end]=');
    expect(form).not.toContain('trial_period_days');
  });

  it('残り 1 日なら付けない（Stripe は 48 時間以上先でないと拒否する）＝その日から課金', () => {
    const sd = params(new Date(NOW + 1 * DAY));
    expect(sd.trial_end).toBeUndefined();
    expect(sd.trial_period_days).toBeUndefined();
  });

  it('期限切れ・未設定・壊れた日付なら付けない。境界は 49 時間（1 時間の余裕）', () => {
    expect(checkoutTrialEnd({ status: null, trialEndsAt: new Date(NOW - DAY), now: NOW })).toBeNull();
    expect(checkoutTrialEnd({ status: null, trialEndsAt: null, now: NOW })).toBeNull();
    expect(checkoutTrialEnd({ status: null, trialEndsAt: 'not-a-date', now: NOW })).toBeNull();
    expect(checkoutTrialEnd({ status: null, trialEndsAt: new Date(NOW + 48 * 60 * 60 * 1000), now: NOW })).toBeNull();
    expect(checkoutTrialEnd({ status: null, trialEndsAt: new Date(NOW + MIN_CHECKOUT_TRIAL_LEAD_MS), now: NOW })).toBe(
      Math.floor((NOW + MIN_CHECKOUT_TRIAL_LEAD_MS) / 1000),
    );
  });

  it('一度でも契約した組織（解約後の再契約など）には付けない', () => {
    for (const status of ['canceled', 'incomplete_expired', 'unpaid']) {
      expect(checkoutTrialEnd({ status, trialEndsAt: new Date(NOW + 10 * DAY), now: NOW })).toBeNull();
    }
  });

  it('Stripe のトライアル（withTrial）があるときはそちらだけ', () => {
    const sd = params(new Date(NOW + 10 * DAY), true);
    expect(sd.trial_period_days).toBe(30);
    expect(sd.trial_end).toBeUndefined();
  });
});

describe('buildAddonItems', () => {
  it('追加容量が無ければ明細を足す', () => {
    expect(buildAddonItems(config, sub(), 2)).toEqual([{ price: 'price_addon', quantity: 2, tax_rates: ['txr_jp10'] }]);
  });

  it('既にあれば数量を変える。同じ数量なら何もしない', () => {
    const s = sub({ items: { data: [...sub().items.data, { id: 'si_addon', quantity: 2, price: { id: 'price_addon' } }] } });
    expect(buildAddonItems(config, s, 4)).toEqual([{ id: 'si_addon', quantity: 4 }]);
    expect(buildAddonItems(config, s, 2)).toBeNull();
  });

  it('0 口にしたら明細を消す', () => {
    const s = sub({ items: { data: [...sub().items.data, { id: 'si_addon', quantity: 2, price: { id: 'price_addon' } }] } });
    expect(buildAddonItems(config, s, 0)).toEqual([{ id: 'si_addon', deleted: true }]);
  });

  it('重複して付いた明細は1本に畳む', () => {
    const s = sub({
      items: {
        data: [
          ...sub().items.data,
          { id: 'si_a1', quantity: 1, price: { id: 'price_addon' } },
          { id: 'si_a2', quantity: 1, price: { id: 'price_addon' } },
        ],
      },
    });
    expect(buildAddonItems(config, s, 3)).toEqual([
      { id: 'si_a1', quantity: 3 },
      { id: 'si_a2', deleted: true },
    ]);
  });
});

describe('encodeStripeForm', () => {
  it('入れ子と配列を Stripe の形式にし、null と undefined は送らない', () => {
    const form = encodeStripeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1, tax_rates: ['txr_1'] }],
      metadata: { orgId: 'org 1' },
      skip: undefined,
      none: null,
    });
    expect(form.split('&')).toEqual([
      'mode=subscription',
      'line_items[0][price]=price_1',
      'line_items[0][quantity]=1',
      'line_items[0][tax_rates][0]=txr_1',
      'metadata[orgId]=org%201',
    ]);
  });
});

describe('verifyStripeSignature', () => {
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' }));
  const t = 1_760_000_000;
  const sign = (payload: Buffer, secret = WEBHOOK_SECRET, ts = t) =>
    createHmac('sha256', secret).update(`${ts}.`).update(payload).digest('hex');

  it('正しい署名を通す', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(body)}`, WEBHOOK_SECRET, t)).toBe(true);
  });

  it('本文が1バイトでも違えば拒否する', () => {
    const tampered = Buffer.from(body.toString().replace('updated', 'deleted'));
    expect(verifyStripeSignature(tampered, `t=${t},v1=${sign(body)}`, WEBHOOK_SECRET, t)).toBe(false);
  });

  it('別の鍵で作った署名を拒否する', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(body, 'other')}`, WEBHOOK_SECRET, t)).toBe(false);
  });

  it('5分より古い署名は拒否する（使い回し対策）', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(body)}`, WEBHOOK_SECRET, t + 301)).toBe(false);
  });

  it('鍵のローテーション中（v1 が複数）は、どれか1つ一致すれば通す', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${sign(body)}`, WEBHOOK_SECRET, t)).toBe(true);
  });

  it('ヘッダが無い・壊れている・v0 だけは拒否する', () => {
    expect(verifyStripeSignature(body, undefined, WEBHOOK_SECRET, t)).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', WEBHOOK_SECRET, t)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v0=${sign(body)}`, WEBHOOK_SECRET, t)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=zz`, WEBHOOK_SECRET, t)).toBe(false);
  });
});

describe('findBaseItem', () => {
  it('基本プランの明細を返し、追加ストレージの明細は選ばない', () => {
    const s = sub({
      items: {
        data: [
          { id: 'si_addon', quantity: 2, price: { id: 'price_addon' } },
          { id: 'si_base', quantity: 1, price: { id: 'price_x_y' } },
        ],
      },
    });
    expect(findBaseItem(config, s)?.id).toBe('si_base');
  });

  it('設定に無い price しか無ければ null', () => {
    expect(findBaseItem(config, sub({ items: { data: [{ id: 'si', price: { id: 'price_manual' } }] } }))).toBeNull();
  });
});
