// Stripe のサブスクリプションを組織へ写す。webhook と、API で更新した直後の両方がここを通る。

import { prisma } from '../../utils/prisma';
import { customerIdOf, subscriptionSnapshot, type BillingConfig, type StripeSubscription } from './billing-core';

export type ApplyOutcome = 'applied' | 'org_not_found' | 'customer_mismatch' | 'stale_subscription';

export async function applySubscription(
  orgId: string,
  sub: StripeSubscription,
  config: BillingConfig,
): Promise<ApplyOutcome> {
  const snap = subscriptionSnapshot(sub, config);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true, trialEndsAt: true },
  });
  if (!org) return 'org_not_found';

  // ⚠️ 別の顧客のサブスクリプションを写さない（metadata の取り違えに対する防御）
  if (org.stripeCustomerId && org.stripeCustomerId !== snap.customerId) {
    console.error('[billing] 組織の顧客IDと一致しないサブスクリプションを無視しました:', snap.subscriptionId);
    return 'customer_mismatch';
  }
  // ⚠️ 契約し直した組織に、古いサブスクリプションの「解約済み」が遅れて届くことがある。それで現行の契約を落とさない
  if (org.stripeSubscriptionId && org.stripeSubscriptionId !== snap.subscriptionId && !snap.entitled) {
    return 'stale_subscription';
  }

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      stripeCustomerId: snap.customerId,
      stripeSubscriptionId: snap.subscriptionId,
      subscriptionStatus: snap.status,
      billingInterval: snap.interval,
      currentPeriodEnd: snap.currentPeriodEnd,
      // 一度入ったトライアル日は消さない（消すと2回目の無料期間が出せてしまう）
      trialEndsAt: snap.trialEndsAt ?? org.trialEndsAt,
      cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
      storageAddonUnits: snap.addonUnits,
      ...(snap.plan ? { plan: snap.plan } : {}),
    },
  });
  if (snap.unknownPrice) {
    console.warn('[billing] 設定に無い price のサブスクリプションです。プランは変更していません:', snap.subscriptionId);
  }
  return 'applied';
}

/** webhook のサブスクリプションから組織を引く。metadata.orgId → 顧客ID の順。 */
export async function resolveOrgIdForSubscription(sub: StripeSubscription): Promise<string | null> {
  const metaOrg = sub.metadata?.orgId;
  if (metaOrg) {
    const org = await prisma.organization.findUnique({ where: { id: metaOrg }, select: { id: true } });
    if (org) return org.id;
  }
  const byCustomer = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerIdOf(sub) },
    select: { id: true },
  });
  return byCustomer?.id ?? null;
}
