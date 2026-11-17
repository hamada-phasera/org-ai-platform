#!/usr/bin/env node
// Stripe（テストモード）の初期用意を 1 コマンドで行う。依存ゼロ（Node 18+ の fetch だけ）。
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs            # 確認のみ（既定・何も作らない）
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs --apply    # 足りないものを作る
//   ... --apply --webhook-url=https://<gateway>/api/webhooks/stripe              # webhook の宛先も作る
//   ... --return-url=https://<web>/settings?tab=billing                          # ポータルの戻り先（既定は APP_BASE_URL から）
//
//   npm run stripe:bootstrap -- --apply
//
// 作るもの（docs/billing.md「Stripe ダッシュボードで用意するもの」と同じ）:
//   1. 商品と価格 7 本（JPY・税抜・継続課金）。lookup_key で既存を探すので、何度流しても増えない
//   2. 税率（消費税 10%・外税）。metadata.flow_tax で既存を探す
//   3. カスタマーポータルの既定設定（プラン変更は無効・期間の終わりに解約・支払い方法と請求書は有効）
//   4. webhook エンドポイント（--webhook-url を渡したときだけ）
// 最後に貼り付け用の環境変数を出す。
//
// ⚠️ 本番のキー（sk_live_ / rk_live_）は受け付けない。何も呼ばずに終了する。
// ⚠️ シークレットキーは画面に出さない。webhook の署名鍵は「今回作ったとき」だけ一度出す（Stripe が二度と返さないため）。
// ⚠️ 価格は作り直さない（Stripe の価格は金額を変えられない）。金額が表と違えば警告だけ出す。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.stripe.com/v1';

/** docs/billing.md の表。金額は税抜の円。年額は月額 × 12 × 0.8 */
export const CATALOG = [
  { product: 'STARTER', name: 'FLOW 梅', prices: [
    { env: 'STRIPE_PRICE_STARTER_MONTHLY', lookupKey: 'flow_starter_monthly', amount: 9800, interval: 'month' },
    { env: 'STRIPE_PRICE_STARTER_YEARLY', lookupKey: 'flow_starter_yearly', amount: 94080, interval: 'year' },
  ] },
  { product: 'PRO', name: 'FLOW 竹', prices: [
    { env: 'STRIPE_PRICE_PRO_MONTHLY', lookupKey: 'flow_pro_monthly', amount: 19800, interval: 'month' },
    { env: 'STRIPE_PRICE_PRO_YEARLY', lookupKey: 'flow_pro_yearly', amount: 190080, interval: 'year' },
  ] },
  { product: 'MAX', name: 'FLOW 松', prices: [
    { env: 'STRIPE_PRICE_MAX_MONTHLY', lookupKey: 'flow_max_monthly', amount: 34800, interval: 'month' },
    { env: 'STRIPE_PRICE_MAX_YEARLY', lookupKey: 'flow_max_yearly', amount: 334080, interval: 'year' },
  ] },
  { product: 'STORAGE_ADDON', name: 'FLOW 追加ストレージ 10GB', prices: [
    { env: 'STRIPE_PRICE_STORAGE_ADDON', lookupKey: 'flow_storage_addon_10gb', amount: 1000, interval: 'month' },
  ] },
];

/** gateway が処理するイベント（services/billing/webhook-handler.ts と同じ） */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
];

const TAX_MARK = 'jp_consumption_10_exclusive';

export class BootstrapError extends Error {}

/** 引数の解釈。知らない引数は打ち間違いとみなして止める（--aply で本番に…を防ぐ） */
export function parseArgs(argv) {
  const out = { apply: false, webhookUrl: null, returnUrl: null, help: false };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--webhook-url=')) out.webhookUrl = arg.slice('--webhook-url='.length);
    else if (arg.startsWith('--return-url=')) out.returnUrl = arg.slice('--return-url='.length);
    else throw new BootstrapError(`知らない引数です: ${arg}`);
  }
  for (const [name, value] of [['--webhook-url', out.webhookUrl], ['--return-url', out.returnUrl]]) {
    if (value === null) continue;
    let u;
    try {
      u = new URL(value);
    } catch {
      throw new BootstrapError(`${name} が URL ではありません`);
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) {
      throw new BootstrapError(`${name} は https の URL にしてください`);
    }
  }
  if (out.webhookUrl && !new URL(out.webhookUrl).pathname.endsWith('/api/webhooks/stripe')) {
    throw new BootstrapError('--webhook-url は https://<api-gateway>/api/webhooks/stripe にしてください');
  }
  return out;
}

/**
 * キーの検査。テストモードのキーだけを通す。
 * ⚠️ 本番のキーは、Stripe を 1 回も呼ばずにここで止める。
 */
export function assertTestKey(key) {
  const k = (key ?? '').trim();
  if (!k) throw new BootstrapError('STRIPE_SECRET_KEY が未設定です（テストモードのシークレットキー sk_test_... を入れてください）');
  if (/_live_/.test(k)) {
    throw new BootstrapError('本番のキー（*_live_*）は受け付けません。テストモードのキー（sk_test_...）で流してください。何も作っていません。');
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(k)) {
    throw new BootstrapError('STRIPE_SECRET_KEY の形式が違います（sk_test_ で始まるキー）。何も作っていません。');
  }
  return k;
}

/** Stripe の form 形式（a[b][0]=v）。gateway の encodeStripeForm と同じ規則 */
export function encodeForm(params) {
  const out = [];
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) return value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
      return;
    }
    out.push(`${encodeURIComponent(prefix).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(String(value))}`);
  };
  walk('', params);
  return out.join('&');
}

function client(key, fetchImpl) {
  return async function call(method, path, params, idempotencyKey) {
    const form = params ? encodeForm(params) : '';
    const url = method === 'GET' && form ? `${API}${path}?${form}` : `${API}${path}`;
    const headers = { Authorization: `Bearer ${key}` };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetchImpl(url, { method, headers, body: method === 'POST' ? form : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // ⚠️ キーを含めない。Stripe のメッセージは運用者向けなので出してよい（利用者には見せない画面）
      throw new BootstrapError(`Stripe API ${method} ${path} が失敗 (HTTP ${res.status}${json?.error?.code ? `, ${json.error.code}` : ''}): ${json?.error?.message ?? ''}`);
    }
    return json;
  };
}

/**
 * 本体。確認のみ（apply=false）なら GET しか呼ばない。
 * 戻り値: { env: { NAME: value }, actions: string[], warnings: string[] }
 */
export async function bootstrap({ key, apply, webhookUrl = null, returnUrl, fetchImpl = fetch, log = () => {} }) {
  const call = client(assertTestKey(key), fetchImpl);
  const env = {};
  const actions = [];
  const warnings = [];
  const plan = (msg) => {
    actions.push(msg);
    log(`  ${apply ? '＋' : '…'} ${msg}${apply ? '' : '（--apply で作成）'}`);
  };

  // ── 1. 商品と価格 ──
  const lookupKeys = CATALOG.flatMap((p) => p.prices.map((x) => x.lookupKey));
  const found = await call('GET', '/prices', { active: 'true', limit: 100, lookup_keys: lookupKeys });
  const byLookup = new Map((found.data ?? []).map((p) => [p.lookup_key, p]));
  const products = await call('GET', '/products', { active: 'true', limit: 100 });
  const productByMark = new Map(
    (products.data ?? []).filter((p) => p.metadata?.flow_product).map((p) => [p.metadata.flow_product, p]),
  );

  for (const item of CATALOG) {
    let productId = productByMark.get(item.product)?.id ?? null;
    for (const price of item.prices) {
      const existing = byLookup.get(price.lookupKey);
      if (existing) {
        env[price.env] = existing.id;
        const ok = existing.currency === 'jpy' && existing.unit_amount === price.amount
          && existing.recurring?.interval === price.interval && existing.tax_behavior === 'exclusive';
        if (!ok) {
          const w = `${price.lookupKey} の内容が表と違います（${existing.currency} ${existing.unit_amount} / ${existing.recurring?.interval} / ${existing.tax_behavior}）。価格は変更できないので、ダッシュボードで確かめてください`;
          warnings.push(w);
          log(`  ⚠ ${w}`);
        } else {
          log(`  ✔ ${price.lookupKey} = ${existing.id}`);
        }
        continue;
      }
      if (!productId) {
        plan(`商品「${item.name}」`);
        if (apply) {
          const created = await call('POST', '/products', { name: item.name, metadata: { flow_product: item.product } }, `flow-bootstrap:product:${item.product}`);
          productId = created.id;
        }
      }
      plan(`価格 ${price.lookupKey}（${price.amount.toLocaleString('ja-JP')}円 / ${price.interval === 'month' ? '月' : '年'}・税抜）`);
      if (apply) {
        const created = await call('POST', '/prices', {
          product: productId,
          currency: 'jpy',
          unit_amount: price.amount,
          recurring: { interval: price.interval },
          tax_behavior: 'exclusive',
          lookup_key: price.lookupKey,
          nickname: price.lookupKey,
          metadata: { flow_price: price.lookupKey },
        }, `flow-bootstrap:price:${price.lookupKey}`);
        env[price.env] = created.id;
      }
    }
  }

  // ── 2. 税率（外税 10%） ──
  const rates = await call('GET', '/tax_rates', { active: 'true', limit: 100 });
  const rate = (rates.data ?? []).find((r) => r.metadata?.flow_tax === TAX_MARK);
  if (rate) {
    env.STRIPE_TAX_RATE_ID = rate.id;
    log(`  ✔ 税率 = ${rate.id}`);
  } else {
    plan('税率（消費税 10%・外税）');
    if (apply) {
      const created = await call('POST', '/tax_rates', {
        display_name: '消費税',
        description: '消費税 10%（外税）',
        percentage: 10,
        inclusive: 'false',
        country: 'JP',
        tax_type: 'jct',
        metadata: { flow_tax: TAX_MARK },
      }, `flow-bootstrap:tax:${TAX_MARK}`);
      env.STRIPE_TAX_RATE_ID = created.id;
    }
  }

  // ── 3. カスタマーポータル（既定の設定） ──
  const portalFeatures = {
    // ⚠️ プラン変更はアプリ内で行う（追加容量の明細があるとポータルでは変えられない・容量の確認ができない）
    subscription_update: { enabled: 'false' },
    subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
    payment_method_update: { enabled: 'true' },
    invoice_history: { enabled: 'true' },
    customer_update: { enabled: 'true', allowed_updates: ['email', 'name', 'address'] },
  };
  const configs = await call('GET', '/billing_portal/configurations', { is_default: 'true', limit: 1 });
  const current = (configs.data ?? [])[0];
  const portalOk = current
    && current.features?.subscription_update?.enabled === false
    && current.features?.subscription_cancel?.enabled === true
    && current.features?.subscription_cancel?.mode === 'at_period_end';
  if (portalOk) {
    log(`  ✔ ポータル設定 = ${current.id}`);
  } else if (current) {
    plan('ポータルの既定設定を更新（プラン変更を無効・期間の終わりに解約）');
    if (apply) {
      await call('POST', `/billing_portal/configurations/${encodeURIComponent(current.id)}`, {
        features: portalFeatures,
        default_return_url: returnUrl,
      });
    }
  } else {
    plan('ポータルの設定を作成');
    if (apply) {
      await call('POST', '/billing_portal/configurations', {
        features: portalFeatures,
        default_return_url: returnUrl,
        metadata: { flow_portal: 'default' },
      }, 'flow-bootstrap:portal');
      const w = 'ダッシュボードの「カスタマーポータル」を一度開き、作成した設定が既定になっているか確かめてください';
      warnings.push(w);
      log(`  ⚠ ${w}`);
    }
  }

  // ── 4. webhook（URL を渡したときだけ） ──
  if (webhookUrl) {
    const hooks = await call('GET', '/webhook_endpoints', { limit: 100 });
    const hook = (hooks.data ?? []).find((h) => h.url === webhookUrl);
    const missing = hook ? WEBHOOK_EVENTS.filter((e) => !(hook.enabled_events ?? []).includes(e) && !(hook.enabled_events ?? []).includes('*')) : [];
    if (hook && missing.length === 0) {
      log(`  ✔ webhook = ${hook.id}（署名鍵はダッシュボードで確認。既に設定済みならそのまま）`);
    } else if (hook) {
      plan(`webhook にイベントを追加（${missing.join(', ')}）`);
      if (apply) {
        await call('POST', `/webhook_endpoints/${encodeURIComponent(hook.id)}`, {
          enabled_events: [...new Set([...(hook.enabled_events ?? []), ...WEBHOOK_EVENTS])],
        });
      }
    } else {
      plan(`webhook ${webhookUrl}`);
      if (apply) {
        const created = await call('POST', '/webhook_endpoints', {
          url: webhookUrl,
          enabled_events: WEBHOOK_EVENTS,
          description: 'FLOW api-gateway',
          metadata: { flow_webhook: 'gateway' },
        }, `flow-bootstrap:webhook:${webhookUrl}`);
        // 署名鍵は作成時にしか返らない。貼り付け用に一度だけ出す
        if (created.secret) env.STRIPE_WEBHOOK_SECRET = created.secret;
      }
    }
  }

  return { env, actions, warnings };
}

/** 貼り付け用の行。STRIPE_SECRET_KEY は出さない */
export function formatEnv(env) {
  const order = [...CATALOG.flatMap((p) => p.prices.map((x) => x.env)), 'STRIPE_TAX_RATE_ID', 'STRIPE_WEBHOOK_SECRET'];
  return order.filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join('\n');
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const USAGE = `使い方: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-bootstrap.mjs [--apply] [--webhook-url=URL] [--return-url=URL]
  既定は確認のみ（何も作らない）。--apply で足りないものを作る。本番キー（sk_live_）は拒否する。`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✖ ${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'));
  const appBase = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const returnUrl = args.returnUrl ?? `${appBase}/settings?tab=billing`;

  console.log(`Stripe（テストモード）の用意 — ${args.apply ? '作成する' : '確認のみ'}`);
  try {
    const result = await bootstrap({
      key: process.env.STRIPE_SECRET_KEY,
      apply: args.apply,
      webhookUrl: args.webhookUrl,
      returnUrl,
      log: (m) => console.log(m),
    });
    if (!args.apply && result.actions.length > 0) {
      console.log(`\n足りないものが ${result.actions.length} 件あります。--apply を付けて流すと作ります。`);
    }
    if (!args.webhookUrl) console.log('\n（webhook は --webhook-url=https://<api-gateway>/api/webhooks/stripe を付けたときだけ用意します）');
    const lines = formatEnv(result.env);
    if (lines) {
      console.log('\n── 貼り付け用（api-gateway の環境変数）──');
      console.log(lines);
      console.log('STRIPE_SECRET_KEY は別途、手で入れてください（ここには出しません）。');
      if (result.env.STRIPE_WEBHOOK_SECRET) console.log('⚠️ STRIPE_WEBHOOK_SECRET はこの一度しか表示されません。');
    }
  } catch (e) {
    console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
