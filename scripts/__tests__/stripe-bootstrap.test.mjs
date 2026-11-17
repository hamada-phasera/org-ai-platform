// scripts/stripe-bootstrap.mjs の検査（node --test）。本物の Stripe には接続しない（fetch は偽物）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BootstrapError,
  CATALOG,
  WEBHOOK_EVENTS,
  assertTestKey,
  bootstrap,
  formatEnv,
  parseArgs,
} from '../stripe-bootstrap.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'stripe-bootstrap.mjs');
// ⚠️ 秘密情報らしい文字列をソースに置かない（push 保護に引っかかる）。実行時に組み立てる
const TEST_KEY = ['sk', 'test', 'bootstrapunit'].join('_');
const LIVE_KEY = ['sk', 'live', 'bootstrapunit'].join('_');

/** 呼ばれた API を記録するだけの偽 fetch。state を返す */
function fakeStripe(state = {}) {
  const s = { prices: [], products: [], taxRates: [], portal: [], hooks: [], calls: [], seq: 0, ...state };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname.replace(/^\/v1/, '');
    const form = new URLSearchParams(method === 'GET' ? u.search : init.body);
    s.calls.push({ method, path, form, auth: init.headers?.Authorization });
    const id = (p) => `${p}_${++s.seq}`;
    if (method === 'GET') {
      if (path === '/prices') {
        const keys = [...form.entries()].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v);
        return reply({ data: s.prices.filter((p) => keys.includes(p.lookup_key)) });
      }
      if (path === '/products') return reply({ data: s.products });
      if (path === '/tax_rates') return reply({ data: s.taxRates });
      if (path === '/billing_portal/configurations') return reply({ data: s.portal });
      if (path === '/webhook_endpoints') return reply({ data: s.hooks });
    }
    if (method === 'POST') {
      if (path === '/products') {
        const p = { id: id('prod'), metadata: { flow_product: form.get('metadata[flow_product]') } };
        s.products.push(p);
        return reply(p);
      }
      if (path === '/prices') {
        const p = {
          id: id('price'), lookup_key: form.get('lookup_key'), currency: form.get('currency'),
          unit_amount: Number(form.get('unit_amount')), recurring: { interval: form.get('recurring[interval]') },
          tax_behavior: form.get('tax_behavior'), product: form.get('product'),
        };
        s.prices.push(p);
        return reply(p);
      }
      if (path === '/tax_rates') {
        const r = { id: id('txr'), percentage: Number(form.get('percentage')), inclusive: form.get('inclusive') === 'true', metadata: { flow_tax: form.get('metadata[flow_tax]') } };
        s.taxRates.push(r);
        return reply(r);
      }
      if (path === '/billing_portal/configurations') {
        const c = { id: id('bpc'), features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } };
        s.portal.push(c);
        return reply(c);
      }
      if (path === '/webhook_endpoints') {
        const h = { id: id('we'), url: form.get('url'), enabled_events: [...form.entries()].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v), secret: ['whsec', 'created'].join('_') };
        s.hooks.push({ ...h, secret: undefined });
        return reply(h);
      }
    }
    return reply({ error: { code: 'unexpected' } }, 400);
  };
  return s;
}

const posts = (s) => s.calls.filter((c) => c.method === 'POST');

test('本番キー（sk_live_）は Stripe を 1 回も呼ばずに拒否する', async () => {
  const s = fakeStripe();
  await assert.rejects(
    bootstrap({ key: LIVE_KEY, apply: true, returnUrl: 'https://app.example.com/settings', fetchImpl: s.fetch }),
    (e) => e instanceof BootstrapError && /本番/.test(e.message),
  );
  assert.equal(s.calls.length, 0);
  assert.throws(() => assertTestKey(['rk', 'live', 'x'].join('_')), BootstrapError);
});

test('本番キーをコマンドで渡しても何も作らずに終了コード 1（fetch に届く前に止まる）', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, '--apply'], {
      env: { PATH: process.env.PATH, STRIPE_SECRET_KEY: LIVE_KEY },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
    stderr = String(e.stderr);
  }
  assert.equal(status, 1);
  assert.match(stderr, /本番のキー/);
  assert.doesNotMatch(stderr, new RegExp(LIVE_KEY)); // キーそのものは出さない
});

test('キーが無い・形式が違うものは拒否', () => {
  assert.throws(() => assertTestKey(undefined), BootstrapError);
  assert.throws(() => assertTestKey('  '), BootstrapError);
  assert.throws(() => assertTestKey('pk_test_abc'), BootstrapError);
  assert.equal(assertTestKey(` ${TEST_KEY} `), TEST_KEY);
});

test('引数: 既定は確認のみ。知らない引数・https でない URL・宛先違いの webhook は止める', () => {
  assert.deepEqual(parseArgs([]), { apply: false, webhookUrl: null, returnUrl: null, help: false });
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--aply']), BootstrapError);
  assert.throws(() => parseArgs(['--webhook-url=http://gw.example.com/api/webhooks/stripe']), BootstrapError);
  assert.throws(() => parseArgs(['--webhook-url=https://gw.example.com/api/other']), BootstrapError);
  assert.throws(() => parseArgs(['--return-url=not a url']), BootstrapError);
  assert.equal(parseArgs(['--webhook-url=https://gw.example.com/api/webhooks/stripe']).webhookUrl, 'https://gw.example.com/api/webhooks/stripe');
});

test('確認のみ（--apply なし）は GET しか呼ばない', async () => {
  const s = fakeStripe();
  const r = await bootstrap({ key: TEST_KEY, apply: false, webhookUrl: 'https://gw.example.com/api/webhooks/stripe', returnUrl: 'https://app.example.com/settings', fetchImpl: s.fetch });
  assert.equal(posts(s).length, 0);
  assert.ok(r.actions.length >= 7 + 4 + 1 + 1); // 価格 7・商品 4・税率・ポータル（+ webhook）
  assert.deepEqual(r.env, {});
});

test('--apply で 7 本の価格・税率・ポータル・webhook を作り、貼り付け用の値を返す（キーは出さない）', async () => {
  const s = fakeStripe();
  const r = await bootstrap({ key: TEST_KEY, apply: true, webhookUrl: 'https://gw.example.com/api/webhooks/stripe', returnUrl: 'https://app.example.com/settings?tab=billing', fetchImpl: s.fetch });

  assert.equal(s.prices.length, 7);
  assert.equal(s.products.length, 4);
  for (const p of s.prices) {
    assert.equal(p.currency, 'jpy');
    assert.equal(p.tax_behavior, 'exclusive');
  }
  const pro = s.prices.find((p) => p.lookup_key === 'flow_pro_yearly');
  assert.equal(pro.unit_amount, 190080);
  assert.equal(pro.recurring.interval, 'year');
  assert.equal(s.taxRates[0].percentage, 10);
  assert.equal(s.taxRates[0].inclusive, false);

  const portal = posts(s).find((c) => c.path === '/billing_portal/configurations');
  assert.equal(portal.form.get('features[subscription_update][enabled]'), 'false');
  assert.equal(portal.form.get('features[subscription_cancel][mode]'), 'at_period_end');

  const hook = posts(s).find((c) => c.path === '/webhook_endpoints');
  const events = [...hook.form.entries()].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v);
  assert.deepEqual(events, WEBHOOK_EVENTS);

  const out = formatEnv(r.env);
  for (const item of CATALOG.flatMap((p) => p.prices)) assert.match(out, new RegExp(`^${item.env}=price_`, 'm'));
  assert.match(out, /^STRIPE_TAX_RATE_ID=txr_/m);
  assert.match(out, /^STRIPE_WEBHOOK_SECRET=whsec_created$/m);
  assert.doesNotMatch(out, /STRIPE_SECRET_KEY|sk_test_/);
  // どの呼び出しもテストキーで認証している（別のキーを混ぜない）
  for (const c of s.calls) assert.equal(c.auth, `Bearer ${TEST_KEY}`);
});

test('2 回目は何も作らない（lookup_key と metadata で既存を見つける）', async () => {
  const s = fakeStripe();
  const args = { key: TEST_KEY, apply: true, webhookUrl: 'https://gw.example.com/api/webhooks/stripe', returnUrl: 'https://app.example.com/settings', fetchImpl: s.fetch };
  const first = await bootstrap(args);
  const created = posts(s).length;
  const second = await bootstrap(args);
  assert.equal(posts(s).length, created);
  assert.deepEqual(second.actions, []);
  // 2 回目も価格と税率の ID は出る（webhook の署名鍵は Stripe が二度と返さないので出ない）
  const { STRIPE_WEBHOOK_SECRET: _omit, ...rest } = first.env;
  assert.deepEqual(second.env, rest);
});

test('既存の価格の金額が表と違えば作り直さず警告だけ', async () => {
  const s = fakeStripe();
  await bootstrap({ key: TEST_KEY, apply: true, returnUrl: 'https://app.example.com/settings', fetchImpl: s.fetch });
  s.prices.find((p) => p.lookup_key === 'flow_starter_monthly').unit_amount = 9000;
  const before = posts(s).length;
  const r = await bootstrap({ key: TEST_KEY, apply: true, returnUrl: 'https://app.example.com/settings', fetchImpl: s.fetch });
  assert.equal(posts(s).length, before);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /flow_starter_monthly/);
});
