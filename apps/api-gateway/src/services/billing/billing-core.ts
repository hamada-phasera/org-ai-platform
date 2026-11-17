// 決済（Stripe）の純粋ロジック。HTTP も DB も触らない。
//
// ■ 方針
//   * 金額はコードに持たない。Stripe の price ID を環境変数で指す（値上げでデプロイが要らない）
//   * プランの真実の源は Organization.plan。Stripe の状態は webhook のたびに
//     サブスクリプションを**取り直して**写す（イベントは順不同で届くので、本文をそのまま書かない）
//   * SDK は入れない（LINE・Supabase と同じ方針）。使う API は数本だけ

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ENTITLED_STATUSES, type BillingInterval, type Plan } from '@org-ai/shared-types';
import { ENV_DEFAULTS, readEnv, type Env } from '../../config/env';

export const PLANS: readonly Plan[] = ['STARTER', 'PRO', 'MAX'];
export const INTERVALS: readonly BillingInterval[] = ['month', 'year'];

export interface BillingConfig {
  secretKey: string;
  /** 未設定なら webhook を受け付けない（署名を検証できないものは信じない） */
  webhookSecret: string | null;
  /** プラン × 支払い間隔 → price ID */
  prices: Record<Plan, Record<BillingInterval, string | null>>;
  /** 追加ストレージ 1口（10GB）あたりの月額 price（数量で課金） */
  storageAddonPrice: string | null;
  /** 消費税（外税 10%）の tax rate ID。価格は税抜で作るので、本番では必ず設定する */
  taxRateId: string | null;
  trialDays: number;
  /** Checkout とポータルから戻ってくる先。利用者の入力からは作らない（オープンリダイレクト対策） */
  appBaseUrl: string;
}

/**
 * 決済の設定。読み口は config/env.ts の readEnv()（CLAUDE.md「環境変数の読み口は1か所」）。
 * 引数はテスト用（envSchema の形の値を直接渡せる）。
 */
export function billingConfigFromEnv(env: Env = readEnv()): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const pick = (k: keyof Env): string | null => env[k]?.trim() || null;
  const prices = {} as BillingConfig['prices'];
  for (const plan of PLANS) {
    prices[plan] = { month: pick(`STRIPE_PRICE_${plan}_MONTHLY`), year: pick(`STRIPE_PRICE_${plan}_YEARLY`) };
  }
  const trial = Number(env.BILLING_TRIAL_DAYS ?? ENV_DEFAULTS.BILLING_TRIAL_DAYS);
  return {
    secretKey,
    webhookSecret: pick('STRIPE_WEBHOOK_SECRET'),
    prices,
    storageAddonPrice: pick('STRIPE_PRICE_STORAGE_ADDON'),
    taxRateId: pick('STRIPE_TAX_RATE_ID'),
    trialDays: Number.isFinite(trial) && trial >= 0 ? Math.floor(trial) : ENV_DEFAULTS.BILLING_TRIAL_DAYS,
    appBaseUrl: (env.APP_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
  };
}

/** テストと設定確認のための内部ヘルパ。 */
export const INTERNALS_FOR_TEST = {
  /** 設定されているべき price ID を全部（未設定は null のまま返す）。 */
  allPriceIds(config: BillingConfig): Array<string | null> {
    return PLANS.flatMap((plan) => INTERVALS.map((interval) => config.prices[plan][interval]));
  },
};

export function planFromPriceId(
  config: BillingConfig,
  priceId: string | null | undefined,
): { plan: Plan; interval: BillingInterval } | null {
  if (!priceId) return null;
  for (const plan of PLANS) {
    for (const interval of INTERVALS) {
      if (config.prices[plan][interval] === priceId) return { plan, interval };
    }
  }
  return null;
}

export function isEntitled(status: string | null | undefined): boolean {
  return !!status && (ENTITLED_STATUSES as readonly string[]).includes(status);
}

// ── Stripe のオブジェクト（使う項目だけ） ─────────────────────────────

export interface StripePrice {
  id: string;
  unit_amount?: number | null;
  currency?: string;
  recurring?: { interval?: string } | null;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number;
  /** API 版 2025-03-31 以降はここに載る */
  current_period_end?: number | null;
  price: StripePrice;
}

export interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  /** 従来の請求モードの「期間の終わりで解約」 */
  cancel_at_period_end?: boolean;
  /** 柔軟な請求モードでは解約予約がこちらに入る（cancel_at_period_end は使われない） */
  cancel_at?: number | null;
  /** API 版 2025-03-31 より前はここに載る */
  current_period_end?: number | null;
  trial_end?: number | null;
  metadata?: Record<string, string> | null;
  items: { data: StripeSubscriptionItem[] };
}

export interface SubscriptionSnapshot {
  subscriptionId: string;
  customerId: string;
  status: string;
  entitled: boolean;
  /** 写すプラン。null は「変えない」（設定に無い price が付いていたとき） */
  plan: Plan | null;
  interval: BillingInterval | null;
  addonUnits: number;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** 設定に無い price（ダッシュボードで手作りした等）。プランは変えずに警告だけ出す */
  unknownPrice: boolean;
}

const toDate = (sec: number | null | undefined): Date | null =>
  typeof sec === 'number' && sec > 0 ? new Date(sec * 1000) : null;

export const customerIdOf = (sub: StripeSubscription): string =>
  typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

/** 基本プランの明細（梅・竹・松のどれかの price が付いたもの）。追加ストレージの明細は含まない。 */
export function findBaseItem(config: BillingConfig, sub: StripeSubscription): StripeSubscriptionItem | null {
  return (sub.items?.data ?? []).find((i) => planFromPriceId(config, i.price?.id)) ?? null;
}

/** サブスクリプションを、組織に写す値に直す。 */
export function subscriptionSnapshot(sub: StripeSubscription, config: BillingConfig): SubscriptionSnapshot {
  const items = sub.items?.data ?? [];
  const base = findBaseItem(config, sub);
  const matched = base ? planFromPriceId(config, base.price.id) : null;
  const entitled = isEntitled(sub.status);

  // 権利が無くなったら追加容量も 0 に戻す（請求が止まった容量を使わせ続けない）
  const addonUnits =
    entitled && config.storageAddonPrice
      ? items
          .filter((i) => i.price?.id === config.storageAddonPrice)
          .reduce((n, i) => n + Math.max(0, i.quantity ?? 0), 0)
      : 0;

  // ⚠️ API 版 2025-03-31 以降は期間の終わりが明細側に移った。どちらの版の webhook でも読めるように両方を見る
  const itemEnds = items.map((i) => i.current_period_end).filter((v): v is number => typeof v === 'number');
  const periodEnd = sub.current_period_end ?? (itemEnds.length > 0 ? Math.min(...itemEnds) : null);

  return {
    subscriptionId: sub.id,
    customerId: customerIdOf(sub),
    status: sub.status,
    entitled,
    // 権利が無くなったら既定（梅）の上限に戻す。データは消さない
    plan: entitled ? (matched?.plan ?? null) : 'STARTER',
    interval: matched?.interval ?? null,
    addonUnits,
    currentPeriodEnd: toDate(periodEnd),
    trialEndsAt: toDate(sub.trial_end),
    // ⚠️ 請求モードで解約予約の載り方が違う。片方だけ見ると、柔軟モードの解約予約を見落とす
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || (typeof sub.cancel_at === 'number' && sub.cancel_at > 0),
    unknownPrice: entitled && !matched,
  };
}

// ── リクエストの組み立て ───────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
/**
 * Checkout の subscription_data.trial_end は「48 時間以上先」でないと Stripe が拒否する
 * （API リファレンス Create a Checkout Session、2026-11 確認）。
 * セッション作成までの時差と時計のずれに 1 時間の余裕を見て、49 時間未満なら付けない（＝その日から課金）。
 */
export const MIN_CHECKOUT_TRIAL_LEAD_MS = 49 * HOUR_MS;

/**
 * 登録時トライアルの残りを Checkout に引き継ぐときの trial_end（Unix 秒）。付けないなら null（D3）。
 * 早く契約した人が損をしないための引き継ぎで、無料期間を延ばすものではない（終わりの日は変わらない）。
 * ⚠️ 一度でも契約した組織（subscriptionStatus が入っている）には付けない。解約 → 再契約で
 *    同じ無料期間をもう一度使わせないため（登録時トライアルは「まだ契約していない」間だけのもの）。
 */
export function checkoutTrialEnd(input: {
  status: string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
  now: Date | number;
}): number | null {
  const { status, trialEndsAt, now } = input;
  if (status || !trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  const at = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(end) || end - at < MIN_CHECKOUT_TRIAL_LEAD_MS) return null;
  return Math.floor(end / 1000);
}

/** Checkout（新規契約）のパラメータ。 */
export function buildCheckoutParams(input: {
  config: BillingConfig;
  orgId: string;
  customerId: string;
  priceId: string;
  /** Stripe のトライアル（trial_period_days）を付ける。作成者ごとに 1 回 */
  withTrial: boolean;
  /** 登録時トライアルの残りを引き継ぐ終わり（checkoutTrialEnd の値）。withTrial が優先 */
  trialEnd?: number | null;
}): Record<string, unknown> {
  const { config, orgId, customerId, priceId, withTrial } = input;
  const trialDays = withTrial && config.trialDays > 0 ? config.trialDays : undefined;
  return {
    mode: 'subscription',
    customer: customerId,
    // webhook で組織を引く目印。3か所に入れておき、どのイベントからでも辿れるようにする
    client_reference_id: orgId,
    metadata: { orgId },
    line_items: [{ price: priceId, quantity: 1, tax_rates: config.taxRateId ? [config.taxRateId] : undefined }],
    subscription_data: {
      metadata: { orgId },
      // ⚠️ trial_period_days と trial_end は同時に送らない（どちらか一方）
      trial_period_days: trialDays,
      trial_end: trialDays === undefined ? (input.trialEnd ?? undefined) : undefined,
    },
    success_url: `${config.appBaseUrl}/settings?tab=billing&checkout=success`,
    cancel_url: `${config.appBaseUrl}/settings?tab=billing&checkout=cancel`,
    locale: 'ja',
    allow_promotion_codes: true,
  };
}

/**
 * 追加容量を units 口にするための items パラメータ。変更が無ければ null。
 * 重複して付いた明細（連打など）があれば1本に畳む。
 */
export function buildAddonItems(
  config: BillingConfig,
  sub: StripeSubscription,
  units: number,
): Array<Record<string, unknown>> | null {
  const price = config.storageAddonPrice;
  if (!price) return null;
  const existing = (sub.items?.data ?? []).filter((i) => i.price?.id === price);
  const [first, ...extra] = existing;
  const items: Array<Record<string, unknown>> = [];

  if (units <= 0) {
    for (const i of existing) items.push({ id: i.id, deleted: true });
  } else if (first) {
    if ((first.quantity ?? 0) !== units) items.push({ id: first.id, quantity: units });
    for (const i of extra) items.push({ id: i.id, deleted: true });
  } else {
    items.push({ price, quantity: units, tax_rates: config.taxRateId ? [config.taxRateId] : undefined });
  }
  return items.length > 0 ? items : null;
}

/** Stripe の form 形式（a[b][0][c]=v）に直す。undefined と null は送らない。 */
export function encodeStripeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, v);
      return;
    }
    // 角括弧は読みやすさのためにエンコードしない（Stripe はどちらも受け付ける）
    const key = encodeURIComponent(prefix).replace(/%5B/g, '[').replace(/%5D/g, ']');
    out.push(`${key}=${encodeURIComponent(String(value))}`);
  };
  walk('', params);
  return out.join('&');
}

/**
 * Stripe-Signature ヘッダの検証。
 * ⚠️ 受け取ったバイト列そのものに対して計算する（JSON を読み直すと空白が変わって一致しない）。
 * ⚠️ 時刻の許容幅で、盗んだ正しい署名の使い回し（リプレイ）を防ぐ。
 * v1 が複数あるのは署名鍵のローテーション中。どれか1つ一致すればよい。
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
