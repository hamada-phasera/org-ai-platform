// 決済（プラン・お支払い・追加容量）。prefix /api/billing
//
// ■ 役割分担
//   * 新規契約: Stripe Checkout（カードの入力は Stripe の画面。カード情報をこのサーバに通さない）
//   * プラン変更・支払い方法・請求書・解約: Stripe のカスタマーポータル（自前の画面を作らない）
//   * 追加容量: ここから数量を変える（課金が始まっている契約だけ）
// ■ 組織への写し込みは webhook（routes/billing-webhook.ts）が正本。ここでは更新の直後に同じ関数で先に写すだけ

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  STORAGE_ADDON_UNIT_BYTES,
  formatBytes,
  storageQuotaBytes,
  type BillingInterval,
  type BillingOverview,
  type Plan,
  type SubscriptionStatus,
} from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import {
  INTERVALS,
  PLANS,
  billingConfigFromEnv,
  buildAddonItems,
  buildCheckoutParams,
  findBaseItem,
  isEntitled,
} from '../services/billing/billing-core';
import { StripeClient } from '../services/billing/stripe-client';
import { applySubscription } from '../services/billing/sync';

/** 追加容量の上限（1口 = 1GB）。桁の打ち間違いで高額な請求を作らないための柵 */
const MAX_ADDON_UNITS = 50;
const PRICE_CACHE_MS = 10 * 60 * 1000;

const priceCache = new Map<string, { amount: number | null; at: number }>();

/** テスト用 */
export function resetBillingPriceCache(): void {
  priceCache.clear();
}

/** 表示する金額。Stripe を正本にして10分だけ覚える。取れなくても画面は出す */
async function priceAmount(stripe: StripeClient, priceId: string | null): Promise<number | null> {
  if (!priceId) return null;
  const hit = priceCache.get(priceId);
  if (hit && Date.now() - hit.at < PRICE_CACHE_MS) return hit.amount;
  try {
    const price = await stripe.retrievePrice(priceId);
    // 円は小数の無い通貨なので unit_amount がそのまま円。円以外は表示しない（桁を取り違えるため）
    const amount = price.currency === 'jpy' && typeof price.unit_amount === 'number' ? price.unit_amount : null;
    priceCache.set(priceId, { amount, at: Date.now() });
    return amount;
  } catch (e) {
    console.error('[billing] 価格の取得に失敗:', e instanceof Error ? e.message : e);
    return null;
  }
}

const ORG_SELECT = {
  id: true,
  name: true,
  plan: true,
  billingEmail: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  billingInterval: true,
  currentPeriodEnd: true,
  trialEndsAt: true,
  cancelAtPeriodEnd: true,
  storageAddonUnits: true,
  storageUsedBytes: true,
} as const;

const PLAN_NAME: Record<Plan, string> = { STARTER: '梅', PRO: '竹', MAX: '松' };

const asPlan = (v: string): Plan => ((PLANS as readonly string[]).includes(v) ? (v as Plan) : 'STARTER');

async function buildOverview(orgId: string): Promise<BillingOverview | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: ORG_SELECT });
  if (!org) return null;
  const config = billingConfigFromEnv();
  const stripe = config ? new StripeClient(config.secretKey) : null;

  const prices =
    config && stripe
      ? await Promise.all(
          PLANS.flatMap((plan) =>
            INTERVALS.map(async (interval) => ({
              plan,
              interval,
              amount: await priceAmount(stripe, config.prices[plan][interval]),
            })),
          ),
        )
      : [];

  return {
    configured: !!config,
    plan: asPlan(org.plan),
    subscriptionStatus: (org.subscriptionStatus as SubscriptionStatus | null) ?? null,
    billingInterval: (org.billingInterval as BillingInterval | null) ?? null,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    trialAvailable: !org.trialEndsAt && !org.stripeSubscriptionId,
    trialDays: config?.trialDays ?? 30,
    hasCustomer: !!org.stripeCustomerId,
    prices,
    storageAddon: {
      available: !!config?.storageAddonPrice,
      purchasable: !!config?.storageAddonPrice && org.subscriptionStatus === 'active',
      units: org.storageAddonUnits,
      unitBytes: STORAGE_ADDON_UNIT_BYTES,
      unitAmount: config && stripe ? await priceAmount(stripe, config.storageAddonPrice) : null,
    },
  };
}

const notConfigured = (reply: FastifyReply) =>
  reply.code(503).send({ success: false, error: { code: 'BILLING_NOT_CONFIGURED', message: '決済はまだ準備中です。' } });

/** ⚠️ Stripe のエラー文言は利用者へ返さない（決済の文脈が混じる）。ログにだけ残す */
const upstreamFailed = (reply: FastifyReply, e: unknown) => {
  console.error('[billing] Stripe の呼び出しに失敗:', e instanceof Error ? e.message : e);
  return reply.code(502).send({
    success: false,
    error: { code: 'BILLING_UPSTREAM_ERROR', message: '決済サービスに接続できませんでした。時間をおいて再度お試しください。' },
  });
};

const checkoutSchema = z.object({
  plan: z.enum(['STARTER', 'PRO', 'MAX']),
  interval: z.enum(['month', 'year']),
});

const addonSchema = z.object({ units: z.number().int().min(0).max(MAX_ADDON_UNITS) });

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // 現在の契約と価格。メンバーも見られる（操作はオーナーだけ）
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const data = await buildOverview(orgId);
    if (!data) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: '組織が見つかりません' } });
    }
    return reply.send({ success: true, data });
  });

  // 新規契約（Stripe Checkout の URL を返す）
  app.post('/checkout', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId, sub } = request.user as { orgId: string; sub: string };
    const config = billingConfigFromEnv();
    if (!config) return notConfigured(reply);

    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'プランと支払い間隔を指定してください' } });
    }
    const priceId = config.prices[parsed.data.plan][parsed.data.interval];
    if (!priceId) {
      return reply.code(400).send({ success: false, error: { code: 'PRICE_NOT_AVAILABLE', message: 'このプランはまだお申し込みいただけません。' } });
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: ORG_SELECT });
    if (!org) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: '組織が見つかりません' } });
    }
    // ⚠️ 契約中に2本目を作らせない（二重請求になる）。変更はポータルで行う
    if (isEntitled(org.subscriptionStatus)) {
      return reply.code(409).send({
        success: false,
        error: { code: 'ALREADY_SUBSCRIBED', message: 'すでにご契約中です。プランの変更は「お支払い・契約の管理」から行えます。' },
      });
    }

    const stripe = new StripeClient(config.secretKey);
    try {
      let customerId = org.stripeCustomerId;
      if (!customerId) {
        const owner = await prisma.user.findUnique({ where: { id: sub }, select: { email: true } });
        const customer = await stripe.createCustomer({ name: org.name, email: org.billingEmail ?? owner?.email ?? null, orgId: org.id });
        // 同時に2回押されても顧客IDを1つにする。まだ空のときだけ書き、負けたら勝った方を使う
        const claimed = await prisma.organization.updateMany({
          where: { id: org.id, stripeCustomerId: null },
          data: { stripeCustomerId: customer.id },
        });
        if (claimed.count === 1) {
          customerId = customer.id;
        } else {
          const again = await prisma.organization.findUnique({ where: { id: org.id }, select: { stripeCustomerId: true } });
          customerId = again?.stripeCustomerId ?? customer.id;
        }
      }

      const session = await stripe.createCheckoutSession(
        buildCheckoutParams({
          config,
          orgId: org.id,
          customerId,
          priceId,
          // トライアルは組織ごとに1回だけ
          withTrial: !org.trialEndsAt && !org.stripeSubscriptionId,
        }),
      );
      if (!session.url) return upstreamFailed(reply, new Error('Checkout の URL が返りませんでした'));
      return reply.send({ success: true, data: { url: session.url } });
    } catch (e) {
      return upstreamFailed(reply, e);
    }
  });

  // お支払い・契約の管理（Stripe のカスタマーポータル）
  app.post('/portal', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const config = billingConfigFromEnv();
    if (!config) return notConfigured(reply);

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripeCustomerId: true } });
    if (!org?.stripeCustomerId) {
      return reply.code(409).send({ success: false, error: { code: 'NO_CUSTOMER', message: 'まだご契約がありません。' } });
    }
    try {
      const session = await new StripeClient(config.secretKey).createPortalSession(
        org.stripeCustomerId,
        `${config.appBaseUrl}/settings?tab=billing`,
      );
      return reply.send({ success: true, data: { url: session.url } });
    } catch (e) {
      return upstreamFailed(reply, e);
    }
  });

  // プラン・支払い間隔の変更（契約中のみ）。
  // ⚠️ ポータルに任せない。追加ストレージを買った契約は明細が2本になり、ポータルのプラン変更が使えない。
  //    またポータルでは「下げた先の容量に今のファイルが収まるか」を確かめられない。
  app.post('/change-plan', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const config = billingConfigFromEnv();
    if (!config) return notConfigured(reply);

    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'プランと支払い間隔を指定してください' } });
    }
    const { plan, interval } = parsed.data;
    const priceId = config.prices[plan][interval];
    if (!priceId) {
      return reply.code(400).send({ success: false, error: { code: 'PRICE_NOT_AVAILABLE', message: 'このプランはまだお申し込みいただけません。' } });
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: ORG_SELECT });
    if (!org) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: '組織が見つかりません' } });
    }
    if (!isEntitled(org.subscriptionStatus) || !org.stripeSubscriptionId) {
      return reply.code(409).send({
        success: false,
        error: { code: 'NOT_SUBSCRIBED', message: 'ご契約がありません。先にプランをお申し込みください。' },
      });
    }

    // ⚠️ 下げた先の容量に今のファイルが収まらないなら止める（勝手に消さない・超過の状態を作らない）
    const used = Number(org.storageUsedBytes);
    const nextQuota = storageQuotaBytes(plan, org.storageAddonUnits);
    if (used > nextQuota) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'STORAGE_IN_USE',
          message: `${formatBytes(used)} を使用中のため、${PLAN_NAME[plan]}（${formatBytes(nextQuota)}）には変更できません。先に不要なファイルを削除してください。`,
        },
      });
    }

    const stripe = new StripeClient(config.secretKey);
    try {
      const current = await stripe.retrieveSubscription(org.stripeSubscriptionId);
      const base = findBaseItem(config, current);
      if (!base) {
        return reply.code(409).send({
          success: false,
          error: { code: 'UNKNOWN_SUBSCRIPTION', message: '契約の内容を確認できませんでした。お手数ですがお問い合わせください。' },
        });
      }
      if (base.price.id !== priceId) {
        // 基本プランの明細の price だけを差し替える。追加ストレージの明細には触らない
        const updated = await stripe.updateSubscription(
          current.id,
          { items: [{ id: base.id, price: priceId }], proration_behavior: 'create_prorations' },
          `plan:${current.id}:${base.id}:${base.price.id}:${priceId}`,
        );
        await applySubscription(org.id, updated, config);
      }
    } catch (e) {
      return upstreamFailed(reply, e);
    }
    return reply.send({ success: true, data: await buildOverview(org.id) });
  });

  // 追加容量の口数を変える（1口 = 1GB / 月額）
  app.post('/storage-addon', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const config = billingConfigFromEnv();
    if (!config?.storageAddonPrice) return notConfigured(reply);

    const parsed = addonSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `追加容量は 0〜${MAX_ADDON_UNITS} の整数で指定してください` },
      });
    }
    const units = parsed.data.units;

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: ORG_SELECT });
    if (!org) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: '組織が見つかりません' } });
    }
    // 課金が始まってから（トライアル中は請求が立たないので、容量だけ先に渡すことになる）
    if (org.subscriptionStatus !== 'active' || !org.stripeSubscriptionId) {
      return reply.code(409).send({
        success: false,
        error: { code: 'BILLING_NOT_ACTIVE', message: '追加容量は、課金が始まってから（無料トライアルの終了後に）ご利用いただけます。' },
      });
    }

    // ⚠️ 減らすときは、いまの使用量が収まることを確認する。ファイルを勝手に消さない
    const used = Number(org.storageUsedBytes);
    const nextQuota = storageQuotaBytes(asPlan(org.plan), units);
    if (units < org.storageAddonUnits && used > nextQuota) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'STORAGE_IN_USE',
          message: `${formatBytes(used)} を使用中のため、${formatBytes(nextQuota)} には減らせません。先に不要なファイルを削除してください。`,
        },
      });
    }

    const stripe = new StripeClient(config.secretKey);
    try {
      const current = await stripe.retrieveSubscription(org.stripeSubscriptionId);
      const items = buildAddonItems(config, current, units);
      const updated = items
        ? await stripe.updateSubscription(
            current.id,
            { items, proration_behavior: 'create_prorations' },
            // 連打やタイムアウト後の再送で明細を二重に足さない
            `addon:${current.id}:${units}:${current.items.data.map((i) => `${i.id}x${i.quantity ?? 0}`).join(',')}`,
          )
        : current;
      await applySubscription(org.id, updated, config);
    } catch (e) {
      return upstreamFailed(reply, e);
    }
    return reply.send({ success: true, data: await buildOverview(org.id) });
  });
}
