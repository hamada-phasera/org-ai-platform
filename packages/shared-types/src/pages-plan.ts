/**
 * 業務ページ（docs/design/custom-pages.md）のうち、zod に依存しない定数と判定。
 *
 * ⚠️ ここに zod を import しない。web のサイドバー（初回ロード）がアイコン名や上限を読むので、
 *    スキーマ（pages.ts）と分けておくと zod が `/p/*` の遅延チャンクにだけ載る（設計書 K20）。
 */
import type { Plan, UsageState, UserRole } from './index';
import { usageState } from './index';

/** ページのアイコン名の許可リスト。web は名前 → lucide コンポーネントの静的な表で引く（動的 import しない） */
export const PAGE_ICONS = [
  'file-text',
  'inbox',
  'users',
  'calendar',
  'truck',
  'hammer',
  'clipboard-list',
  'phone',
  'mail',
  'package',
  'wallet',
  'chart-bar',
  'building',
  'map-pin',
  'wrench',
  'shopping-cart',
  'star',
  'bell',
  'folder',
  'clock',
  'check-square',
  'message-circle',
  'briefcase',
  'receipt',
] as const;
export type PageIcon = (typeof PAGE_ICONS)[number];
export const DEFAULT_PAGE_ICON: PageIcon = 'file-text';

export function isPageIcon(value: unknown): value is PageIcon {
  return typeof value === 'string' && (PAGE_ICONS as readonly string[]).includes(value);
}

/** ページの状態・作成元・閲覧に要る役割（DB は String 列。値域はここで縛る。設計書 K17） */
export const PAGE_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];
export const PAGE_SOURCES = ['N8N', 'MANUAL', 'SEED'] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];
export const PAGE_MIN_ROLES: readonly UserRole[] = ['MEMBER', 'ADMIN', 'OWNER'];

/** ページの送信の記録（PageActionLog.status） */
export const PAGE_ACTION_LOG_STATUSES = ['PENDING', 'OK', 'FAILED', 'TIMEOUT', 'INVALID_RESPONSE'] as const;
export type PageActionLogStatus = (typeof PAGE_ACTION_LOG_STATUSES)[number];

/**
 * プランごとの業務ページの上限（設計書 §6）。金額は持たない。
 * - maxPages: 組織が持てるページ数。超えたら**新規作成だけ**断る（既存の更新・表示は通す。降格しても消さない）
 * - actionsPerMonth: 当月（UTC の暦月＝日本時間では毎月 1 日 9:00 から。K27）の送信（submit）の回数。超えたら**送信だけ**止める（表示は止めない）
 *
 * ⚠️ AI の月間上限と違い、超えたら止める。n8n の実行には原価があり「軽いモデルへ落とす」逃げ道が無い（設計書 K7）。
 * トライアル中は梅（STARTER）の値。
 */
export const PAGE_LIMITS: Record<Plan, { maxPages: number; actionsPerMonth: number }> = {
  STARTER: { maxPages: 1, actionsPerMonth: 300 },
  PRO: { maxPages: 5, actionsPerMonth: 3000 },
  MAX: { maxPages: 20, actionsPerMonth: 20000 },
};

/** 知らないプラン名（DB の値の揺れ）は梅の上限で数える＝安全側 */
function pageLimitsOf(plan: Plan | string): { maxPages: number; actionsPerMonth: number } {
  return PAGE_LIMITS[plan as Plan] ?? PAGE_LIMITS.STARTER;
}

/** もう 1 ページ作れるか。`currentCount` はその組織のいまのページ数（下書きも数える） */
export function canAddPage(plan: Plan | string, currentCount: number): boolean {
  return Math.max(0, currentCount) < pageLimitsOf(plan).maxPages;
}

export interface PageActionUsage {
  used: number;
  limit: number;
  /** 'ok' | 'warn'(8割) | 'over'(上限) — 表示の判定は AI の月間上限と同じ usageState */
  state: UsageState;
  /** true なら送信（submit）を 429 `PAGE_ACTION_LIMIT` で止める。表示（query）は止めない */
  blocked: boolean;
}

/** 当月の送信数から、送信できるかと表示の状態を出す（gateway の判定と web の表示で共有） */
export function pageActionState(plan: Plan | string, usedThisMonth: number): PageActionUsage {
  const limit = pageLimitsOf(plan).actionsPerMonth;
  const used = Math.max(0, usedThisMonth);
  return { used, limit, state: usageState(used, limit), blocked: used >= limit };
}

/**
 * ページの slug に使えない名前。`/api/pages/admin/list` `/api/pages/tokens` と衝突するため
 * （GET /api/pages/tokens がページではなくトークン一覧になる）。登録時に 400。
 */
export const PAGE_RESERVED_SLUGS = ['admin', 'tokens'] as const;

export function isReservedPageSlug(slug: string): boolean {
  return (PAGE_RESERVED_SLUGS as readonly string[]).includes(slug);
}
