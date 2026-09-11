// Stripe webhook のイベントを処理する。署名の検証と冪等性はルート側（routes/billing-webhook.ts）。
//
// ⚠️ イベント本文の状態を信じない。Stripe はイベントの順序を保証しないので、
//    「更新 → 作成」の順で届くと古い状態で上書きしてしまう。毎回サブスクリプションを取り直す。

import type { BillingConfig, StripeSubscription } from './billing-core';
import type { StripeClient } from './stripe-client';
import { StripeError } from './stripe-client';
import { applySubscription, resolveOrgIdForSubscription } from './sync';

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

/** 処理した組織の ID を返す。関係の無いイベントは null。 */
export async function handleStripeEvent(
  event: StripeEvent,
  config: BillingConfig,
  stripe: Pick<StripeClient, 'retrieveSubscription'>,
): Promise<string | null> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as {
      mode?: string;
      client_reference_id?: string | null;
      metadata?: { orgId?: string } | null;
      subscription?: string | { id: string } | null;
    };
    if (session.mode !== 'subscription' || !session.subscription) return null;
    const orgId = session.client_reference_id ?? session.metadata?.orgId ?? null;
    if (!orgId) return null;
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    await applySubscription(orgId, await stripe.retrieveSubscription(subId), config);
    return orgId;
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const fromEvent = event.data.object as unknown as StripeSubscription;
    const orgId = await resolveOrgIdForSubscription(fromEvent);
    if (!orgId) return null;
    let latest: StripeSubscription;
    try {
      latest = await stripe.retrieveSubscription(fromEvent.id);
    } catch (e) {
      // 削除済みで取れないときだけ本文を使う。それ以外は投げて Stripe に再送させる
      if (e instanceof StripeError && e.status === 404) latest = fromEvent;
      else throw e;
    }
    await applySubscription(orgId, latest, config);
    return orgId;
  }

  return null;
}
