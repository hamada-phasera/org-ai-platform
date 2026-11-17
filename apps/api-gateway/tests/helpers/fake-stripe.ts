// メモリ内の偽 Stripe（課金の通しテスト用）。本物の Stripe には一切つながない。
//
// StripeClient は呼ぶ時点のグローバル fetch を使うので、vi.stubGlobal('fetch', stripe.fetch) で差し替える。
// 実装しているのは StripeClient が叩く API だけ:
//   POST /v1/customers, POST /v1/checkout/sessions, POST /v1/billing_portal/sessions,
//   GET/POST /v1/subscriptions/:id, GET /v1/prices/:id
// Checkout の画面で人がカードを入れる部分は completeCheckout() が代わりに行い、
// Stripe が送ってくる webhook のイベント（署名済み）を返す。

import { createHmac } from 'node:crypto';
import type { StripeSubscription } from '../../src/services/billing/billing-core';

export interface FakeStripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

interface Session {
  id: string;
  url: string;
  customer: string;
  form: URLSearchParams;
  completed: boolean;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeStripe {
  readonly customers = new Map<string, { id: string; email: string | null; metadata: Record<string, string> }>();
  readonly sessions = new Map<string, Session>();
  readonly subscriptions = new Map<string, StripeSubscription>();
  /** 叩かれた API（検証用）。Authorization は記録しない */
  readonly calls: Array<{ method: string; path: string; form: URLSearchParams }> = [];
  private seq = 0;

  constructor(private readonly prices: Record<string, { unit_amount: number; currency: string }> = {}) {}

  private nextId(prefix: string): string {
    return `${prefix}_fake${++this.seq}`;
  }

  /** グローバル fetch の代わり。Stripe 以外の宛先は 503（外に出さない） */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.stripe.com') return json(503, { error: 'offline in tests' });
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/v1/, '');
    const form = new URLSearchParams(method === 'GET' ? url.search : String(init?.body ?? ''));
    this.calls.push({ method, path, form });

    if (method === 'POST' && path === '/customers') {
      const id = this.nextId('cus');
      this.customers.set(id, { id, email: form.get('email'), metadata: { orgId: form.get('metadata[orgId]') ?? '' } });
      return json(200, { id });
    }
    if (method === 'POST' && path === '/checkout/sessions') {
      const id = this.nextId('cs');
      const customer = form.get('customer') ?? '';
      if (!this.customers.has(customer)) return json(400, { error: { code: 'resource_missing' } });
      // 本物と同じく trial_period_days と trial_end の同時指定は拒否する
      if (form.has('subscription_data[trial_end]') && form.has('subscription_data[trial_period_days]')) {
        return json(400, { error: { code: 'parameter_invalid' } });
      }
      const session: Session = { id, url: `https://checkout.stripe.test/c/${id}`, customer, form, completed: false };
      this.sessions.set(id, session);
      return json(200, { id, url: session.url });
    }
    if (method === 'POST' && path === '/billing_portal/sessions') {
      return json(200, { url: `https://billing.stripe.test/p/${form.get('customer')}` });
    }
    const subMatch = path.match(/^\/subscriptions\/([^/]+)$/);
    if (subMatch) {
      const sub = this.subscriptions.get(decodeURIComponent(subMatch[1]));
      if (!sub) return json(404, { error: { code: 'resource_missing' } });
      if (method === 'GET') return json(200, sub);
      // 基本プランの差し替え（items[0][id] / items[0][price]）だけを扱う
      const itemId = form.get('items[0][id]');
      const price = form.get('items[0][price]');
      const item = sub.items.data.find((i) => i.id === itemId);
      if (item && price) item.price = { id: price };
      return json(200, sub);
    }
    const priceMatch = path.match(/^\/prices\/([^/]+)$/);
    if (priceMatch) {
      const id = decodeURIComponent(priceMatch[1]);
      const p = this.prices[id];
      return p ? json(200, { id, ...p, recurring: { interval: 'month' } }) : json(404, { error: { code: 'resource_missing' } });
    }
    return json(404, { error: { code: 'unknown_endpoint' } });
  };

  /** 最後に作られた Checkout セッション */
  lastSession(): Session {
    const list = [...this.sessions.values()];
    if (list.length === 0) throw new Error('Checkout セッションがありません');
    return list[list.length - 1];
  }

  /**
   * 利用者が Checkout で支払いを終えた状態にする。サブスクリプションを作り、
   * Stripe が送る checkout.session.completed を返す（無料期間があれば trialing）。
   */
  completeCheckout(sessionId: string, nowSec = Math.floor(Date.now() / 1000)): FakeStripeEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`セッションがありません: ${sessionId}`);
    if (s.completed) throw new Error('完了済みのセッションです');
    s.completed = true;

    const trialEnd = Number(s.form.get('subscription_data[trial_end]')) || null;
    const trialDays = Number(s.form.get('subscription_data[trial_period_days]')) || null;
    const end = trialEnd ?? (trialDays ? nowSec + trialDays * 86_400 : null);
    const subId = this.nextId('sub');
    const sub: StripeSubscription = {
      id: subId,
      customer: s.customer,
      status: end ? 'trialing' : 'active',
      cancel_at_period_end: false,
      trial_end: end,
      metadata: { orgId: s.form.get('subscription_data[metadata][orgId]') ?? '' },
      items: {
        data: [
          {
            id: this.nextId('si'),
            quantity: Number(s.form.get('line_items[0][quantity]') ?? 1),
            current_period_end: (end ?? nowSec) + 30 * 86_400,
            price: { id: s.form.get('line_items[0][price]') ?? '' },
          },
        ],
      },
    };
    this.subscriptions.set(subId, sub);
    return this.event('checkout.session.completed', {
      id: s.id,
      object: 'checkout.session',
      mode: 'subscription',
      customer: s.customer,
      client_reference_id: s.form.get('client_reference_id'),
      metadata: { orgId: s.form.get('metadata[orgId]') },
      subscription: subId,
    });
  }

  /** サブスクリプションの状態を変え、customer.subscription.updated を返す（past_due など） */
  setStatus(subId: string, status: string): FakeStripeEvent {
    const sub = this.mustSub(subId);
    sub.status = status;
    return this.event('customer.subscription.updated', { ...sub });
  }

  /** 解約が確定した（期間の終わり・即時解約）。customer.subscription.deleted を返す */
  cancel(subId: string): FakeStripeEvent {
    const sub = this.mustSub(subId);
    sub.status = 'canceled';
    return this.event('customer.subscription.deleted', { ...sub });
  }

  private mustSub(id: string): StripeSubscription {
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`サブスクリプションがありません: ${id}`);
    return sub;
  }

  private event(type: string, object: Record<string, unknown>): FakeStripeEvent {
    return { id: this.nextId('evt'), type, data: { object } };
  }
}

/** Stripe と同じ形の署名ヘッダを付けた webhook の本文（app.inject にそのまま渡せる） */
export function signedWebhook(
  event: FakeStripeEvent,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): { payload: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex');
  return { payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${nowSec},v1=${sig}` } };
}
