// 契約が切れた組織の扱い。
//
// ⚠️ データは消さないし、読めなくもしない。止めるのは「新しく作る・実行する」だけ。
//    建設業は帳簿を残す意識が強く、台帳が見えなくなることへの抵抗が大きい。
//    閲覧と書き出しの原価はほぼゼロなので、止める理由もない。
//
// ■ 判定（docs/plan/saas-readiness-plan.md D1・D2・D4）
//   * trialing / active / past_due … 通す（trialEndsAt に関係なく）
//   * それ以外の Stripe の状態（解約・未払い等） … 閲覧のみ
//   * subscriptionStatus が null（まだ決済を繋いでいない）
//       - 決済が未設定の環境 … 通す（契約で再開する手段が無いので、誰も止めない）
//       - trialEndsAt が null … 通す（登録時トライアルより前に作られた既存の組織。Stripe を設定した瞬間に
//         既存の利用者が全員止まる事故を避ける）
//       - trialEndsAt が過ぎた … 閲覧のみ（登録時トライアルの期限切れ）
//       - trialEndsAt が先 … 通す（登録時トライアル中。上限は梅）
//
// ⚠️ 時刻は要求ごとに渡す（キャッシュした時刻で判定しない）。

import { ENTITLED_STATUSES } from '@org-ai/shared-types';

export type Entitlement = 'full' | 'read_only';

/** 閲覧のみになった理由。文言を分けるためだけに使う（402 のコードはどちらも SUBSCRIPTION_REQUIRED）。 */
export type ReadOnlyReason = 'subscription_ended' | 'trial_expired';

export interface EntitlementInput {
  /** Organization.subscriptionStatus（Stripe の写し）。null は一度も決済を繋いでいない */
  status: string | null | undefined;
  /** Organization.trialEndsAt。登録時トライアルの終わり（Stripe のトライアル中はその終わり） */
  trialEndsAt: Date | string | null | undefined;
  /** 決済が設定済みか（config.billingConfigured: STRIPE_SECRET_KEY と梅の月額 price の両方） */
  billingConfigured: boolean;
  now: Date | number;
}

export type EntitlementDecision =
  | { access: 'full' }
  | { access: 'read_only'; reason: ReadOnlyReason };

const toMs = (v: Date | string | number): number =>
  typeof v === 'number' ? v : v instanceof Date ? v.getTime() : new Date(v).getTime();

/** 判定と理由。純粋関数（DB も環境変数も読まない）。 */
export function entitlementDecision(input: EntitlementInput): EntitlementDecision {
  const { status, trialEndsAt, billingConfigured, now } = input;
  if (status) {
    return (ENTITLED_STATUSES as readonly string[]).includes(status)
      ? { access: 'full' }
      : { access: 'read_only', reason: 'subscription_ended' };
  }
  if (!billingConfigured || !trialEndsAt) return { access: 'full' };
  const end = toMs(trialEndsAt);
  // 壊れた日付で止めない（fail-open。止める側に倒すと業務が止まる）
  if (!Number.isFinite(end)) return { access: 'full' };
  return end > toMs(now) ? { access: 'full' } : { access: 'read_only', reason: 'trial_expired' };
}

export function entitlementOf(input: EntitlementInput): Entitlement {
  return entitlementDecision(input).access;
}

export const READ_ONLY_MESSAGE =
  'ご契約が終了しているため、新しい実行と保存はできません。台帳・ファイル・過去のやり取りの閲覧と書き出しはそのままご利用いただけます。設定 > プラン から再開できます。';

export const TRIAL_EXPIRED_MESSAGE =
  '無料期間が終了したため、新しい実行と保存はできません。台帳・ファイル・過去のやり取りの閲覧と書き出しはそのままご利用いただけます。設定 > プラン からご契約いただくと再開できます。';

export function readOnlyMessageOf(reason: ReadOnlyReason): string {
  return reason === 'trial_expired' ? TRIAL_EXPIRED_MESSAGE : READ_ONLY_MESSAGE;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 登録時トライアルの終わり（作成時刻 + 日数）。 */
export function appTrialEndFrom(createdAt: Date, trialDays: number): Date {
  return new Date(createdAt.getTime() + trialDays * DAY_MS);
}

export interface AppTrial {
  /** 登録時トライアル中（未契約で、期限がまだ先） */
  active: boolean;
  endsAt: string | null;
  /** 残り日数（切り上げ）。期限切れ・対象外は 0 */
  daysLeft: number;
}

/**
 * 登録時トライアル（カード不要・アプリ側の期限）の状態。
 * Stripe のトライアル（subscriptionStatus = trialing）はここでは扱わない。
 */
export function appTrialOf(input: {
  status: string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
  now: Date | number;
}): AppTrial {
  if (input.status || !input.trialEndsAt) return { active: false, endsAt: null, daysLeft: 0 };
  const end = toMs(input.trialEndsAt);
  if (!Number.isFinite(end)) return { active: false, endsAt: null, daysLeft: 0 };
  const left = end - toMs(input.now);
  return {
    active: left > 0,
    endsAt: new Date(end).toISOString(),
    daysLeft: left > 0 ? Math.ceil(left / DAY_MS) : 0,
  };
}

/** 契約が切れていても通す経路。請求の手続きと認証を止めると、再開する手段が無くなる。 */
export const ALWAYS_ALLOWED_PREFIXES = ['/api/billing', '/api/auth', '/api/webhooks'];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** この要求で契約を確認する必要があるか（読み取りでは DB を引かない）。 */
export function needsEntitlementCheck(method: string | undefined, url: string | undefined): boolean {
  // Fastify は必ず両方を持つ。欠けるのはテストの作り物なので、確認せず通す
  if (!method || !url) return false;
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  const path = url.split('?')[0];
  return !ALWAYS_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}
