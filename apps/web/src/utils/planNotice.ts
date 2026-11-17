import type { BillingOverview, OrganizationUsage } from '@org-ai/shared-types';
import {
  ENTITLED_STATUSES,
  STORAGE_WARN_RATIO,
  effectiveSubscriptionStatus,
  hasRoleAtLeast,
  readOnlyReasonOf,
  usageState,
} from '@org-ai/shared-types';

/**
 * 画面上部の 1 行の帯（契約状態・上限）の判定。純粋関数（DOM も時計も読まない）。
 *
 * 優先順（docs/plan/saas-readiness-plan.md §7）:
 *   expired > trial > storage-over > ai-over > storage-warn > ai-warn > none
 *   止まっているもの → 止まりそうなもの → 品質が落ちているもの → 近づいているもの の順。
 *
 * ⚠️ expired の条件は gateway の entitlementDecision（services/entitlement.ts）と同じにする。
 *    画面だけ違う判定をすると「帯は出ていないのに保存できない」になる。
 */

export type PlanNoticeKind =
  | 'expired'
  | 'trial'
  | 'storage-over'
  | 'ai-over'
  | 'storage-warn'
  | 'ai-warn'
  | 'none';

export interface PlanNotice {
  kind: PlanNoticeKind;
  /** trial のときだけ意味を持つ（切り上げ。1 以上） */
  daysLeft: number;
}

/** 帯を出す残り日数（これ以下で出す） */
export const TRIAL_NOTICE_DAYS = 7;

/** 契約画面。設定ページは ?tab=billing で「プラン」タブを開く */
export const BILLING_PATH = '/settings?tab=billing';

const DAY_MS = 24 * 60 * 60 * 1000;

type BillingLike = Pick<BillingOverview, 'configured' | 'subscriptionStatus' | 'trialEndsAt'>;
type UsageLike = Pick<OrganizationUsage, 'aiCallsThisMonth' | 'planLimit'> &
  Partial<Pick<OrganizationUsage, 'storageUsedBytes' | 'storageQuotaBytes'>>;

const toMs = (v: Date | number): number => (typeof v === 'number' ? v : v.getTime());

/** 書き込みが 402 になる状態か（gateway と同じ shared-types の readOnlyReasonOf）。 */
export function isReadOnly(billing: BillingLike, now: Date | number): boolean {
  return (
    readOnlyReasonOf({
      status: billing.subscriptionStatus,
      trialEndsAt: billing.trialEndsAt,
      billingConfigured: billing.configured,
      now,
    }) !== null
  );
}

/**
 * 登録時トライアルの残り日数（切り上げ）。対象外・期限切れは 0。
 * 契約中は対象外。incomplete は未契約と同じ、解約後も残りがあれば数える（gateway の appTrialOf と同じ）。
 */
export function appTrialDaysLeft(billing: BillingLike, now: Date | number): number {
  const status = effectiveSubscriptionStatus(billing.subscriptionStatus);
  if (status && (ENTITLED_STATUSES as readonly string[]).includes(status)) return 0;
  if (!billing.configured || !billing.trialEndsAt) return 0;
  const left = new Date(billing.trialEndsAt).getTime() - toMs(now);
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / DAY_MS);
}

export function planNoticeOf(
  billing: BillingLike | null | undefined,
  usage: UsageLike | null | undefined,
  now: Date | number,
  opts: { readOnly?: boolean } = {},
): PlanNotice {
  const none: PlanNotice = { kind: 'none', daysLeft: 0 };
  // 402 を受けた（サーバが閲覧のみと判定した）ら、overview の取得前でも expired
  if (opts.readOnly || (billing && isReadOnly(billing, now))) return { ...none, kind: 'expired' };

  const daysLeft = billing ? appTrialDaysLeft(billing, now) : 0;
  if (daysLeft > 0 && daysLeft <= TRIAL_NOTICE_DAYS) return { kind: 'trial', daysLeft };

  if (!usage) return none;
  const quota = usage.storageQuotaBytes ?? 0;
  const storageRatio = quota > 0 ? (usage.storageUsedBytes ?? 0) / quota : 0;
  const ai = usageState(usage.aiCallsThisMonth, usage.planLimit);

  if (quota > 0 && storageRatio >= 1) return { ...none, kind: 'storage-over' };
  if (ai === 'over') return { ...none, kind: 'ai-over' };
  if (quota > 0 && storageRatio >= STORAGE_WARN_RATIO) return { ...none, kind: 'storage-warn' };
  if (ai === 'warn') return { ...none, kind: 'ai-warn' };
  return none;
}

export type NoticeTone = 'danger' | 'warning' | 'muted';

/**
 * 契約の画面（設定 > プラン）へのリンクを出す役割か。契約の操作はオーナー（gateway の requireOwner）で、
 * 管理者は契約状態を見られる。メンバーには押しても何もできないリンクを出さない（saas-review #14）。
 */
export function canOpenBilling(role: unknown): boolean {
  return hasRoleAtLeast(role, 'ADMIN');
}

/** メンバー向けの文言（リンクの代わりに「オーナーにご連絡ください」。1 文のまま） */
function memberText(notice: PlanNotice): string {
  switch (notice.kind) {
    case 'expired':
      return '閲覧のみです（再開はオーナーにご連絡ください）。';
    case 'trial':
      return `無料期間は残り${notice.daysLeft}日です（ご契約はオーナーにご連絡ください）。`;
    case 'storage-over':
      return '保存容量が上限に達しました（オーナーにご連絡ください）。';
    case 'ai-over':
      return '今月の AI 上限を超えたため、軽いモデルで応答しています（オーナーにご連絡ください）。';
    case 'storage-warn':
      return '保存容量が残りわずかです（オーナーにご連絡ください）。';
    case 'ai-warn':
      return '今月の AI 利用が上限の8割を超えました（オーナーにご連絡ください）。';
    default:
      return '';
  }
}

/** 帯の文言（1 文）と色。none は呼ばない。forMember はリンクを出さない役割向けの文言。 */
export function planNoticeText(notice: PlanNotice, opts: { forMember?: boolean } = {}): { text: string; tone: NoticeTone } {
  if (opts.forMember) return { text: memberText(notice), tone: planNoticeText(notice).tone };
  switch (notice.kind) {
    case 'expired':
      return { text: '閲覧のみです（ご契約で保存と実行を再開できます）。', tone: 'danger' };
    case 'trial':
      return { text: `無料期間は残り${notice.daysLeft}日です。`, tone: 'warning' };
    case 'storage-over':
      return { text: '保存容量が上限に達しました。', tone: 'danger' };
    case 'ai-over':
      return { text: '今月の AI 上限を超えたため、軽いモデルで応答しています。', tone: 'warning' };
    case 'storage-warn':
      return { text: '保存容量が残りわずかです。', tone: 'muted' };
    case 'ai-warn':
      return { text: '今月の AI 利用が上限の8割を超えました。', tone: 'muted' };
    default:
      return { text: '', tone: 'muted' };
  }
}

/** このエラーコードのとき、エラー表示に契約画面へのリンクを付ける */
const PLAN_LINK_CODES = new Set(['QUOTA_EXCEEDED', 'FILE_TOO_LARGE', 'SUBSCRIPTION_REQUIRED']);

export function needsPlanLink(code: string | null | undefined): boolean {
  return !!code && PLAN_LINK_CODES.has(code);
}
