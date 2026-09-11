// Stripe API の薄いクライアント。SDK は入れず REST を直接叩く。
//
// ⚠️ シークレットキーはログにも例外のメッセージにも出さない。
// ⚠️ Stripe のエラーメッセージを利用者へそのまま返さない（決済の文脈が混じる）。code だけ残す。

import { encodeStripeForm, type StripePrice, type StripeSubscription } from './billing-core';

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 20_000;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST';

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    // テストで差し替えられるよう、呼ぶ時点の fetch を使う
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: Method, path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const form = params ? encodeStripeForm(params) : '';
    const url = method === 'GET' && form ? `${API}${path}?${form}` : `${API}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    // 同じ操作の再送（連打・タイムアウト後の再試行）で二重に作らない
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: method === 'POST' ? form : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    if (!res.ok) {
      const code = json.error?.code;
      throw new StripeError(`Stripe API エラー (HTTP ${res.status}${code ? `, ${code}` : ''})`, res.status, code);
    }
    return json as T;
  }

  createCustomer(input: { name: string; email: string | null; orgId: string }): Promise<{ id: string }> {
    return this.call(
      'POST',
      '/customers',
      { name: input.name, email: input.email ?? undefined, metadata: { orgId: input.orgId } },
      `customer:${input.orgId}`,
    );
  }

  createCheckoutSession(params: Record<string, unknown>): Promise<{ id: string; url: string | null }> {
    return this.call('POST', '/checkout/sessions', params);
  }

  createPortalSession(customer: string, returnUrl: string): Promise<{ url: string }> {
    return this.call('POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
  }

  retrieveSubscription(id: string): Promise<StripeSubscription> {
    return this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
  }

  updateSubscription(id: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<StripeSubscription> {
    return this.call('POST', `/subscriptions/${encodeURIComponent(id)}`, params, idempotencyKey);
  }

  retrievePrice(id: string): Promise<StripePrice> {
    return this.call('GET', `/prices/${encodeURIComponent(id)}`);
  }
}
