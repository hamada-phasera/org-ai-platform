import {
  Bot,
  BarChart3,
  FileText,
  Home,
  Inbox,
  ListChecks,
  MessageCircle,
  Settings,
  Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * スマホで開けるか。
 * - `exact`  … そのパスだけ（`/agents` は可、`/agents/:id` は不可）
 * - `prefix` … そのパスと配下（`/chat` と `/chat/:id`）
 * - `false`  … パソコン向け（スマホでは DesktopOnly に差し替える）
 */
export type MobileRule = 'exact' | 'prefix' | false;

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** end=true のときだけ完全一致で active 判定する（"/" が全ルートに一致するのを防ぐ） */
  end?: boolean;
  mobile: MobileRule;
  /** スマホの下部タブに出す（4 つ＋メニュー）。並びはこの表の順 */
  tab?: boolean;
}

/** 主ナビ。TOP から降りていく先。 */
export const MAIN_NAV: NavEntry[] = [
  { to: '/', label: 'ホーム', icon: Home, end: true, mobile: 'exact', tab: true },
  { to: '/dashboard', label: 'ダッシュボード', icon: BarChart3, mobile: false },
  { to: '/chat', label: 'チャット', icon: MessageCircle, mobile: 'prefix', tab: true },
  { to: '/inbox', label: '受信', icon: Inbox, mobile: 'prefix', tab: true },
  { to: '/agents', label: 'エージェント', icon: Bot, mobile: 'exact' },
  { to: '/deliverables', label: '成果物', icon: FileText, mobile: 'prefix', tab: true },
  { to: '/tasks', label: 'タスク', icon: ListChecks, mobile: false },
];

export interface WorkPage {
  to: string;
  label: string;
  /** 部署カラー。CSS 変数で持ち、ダークでも自動的に切り替わるようにする。 */
  colorVar: string;
  mobile: MobileRule;
}

/**
 * 業務ページ。v1 ではルートは存在するのにナビから到達できない孤児だった。
 * 「部署」ではなく「業務ページ」と呼ぶ — 経理と総合がここに無いのは
 * 部署が無いからではなく、専用ページがまだ無いだけなので。
 */
export const WORK_PAGES: WorkPage[] = [
  { to: '/sales', label: '営業パイプライン', colorVar: 'var(--dept-sales)', mobile: false },
  { to: '/analytics', label: 'データ分析', colorVar: 'var(--dept-analytics)', mobile: false },
  { to: '/sns', label: 'SNS投稿', colorVar: 'var(--dept-marketing)', mobile: false },
  { to: '/accounting', label: '工事別 原価管理', colorVar: 'var(--dept-accounting)', mobile: 'exact' },
];

export const ADMIN_NAV: NavEntry[] = [
  { to: '/governance', label: 'ガバナンス', icon: Shield, mobile: false },
  { to: '/settings', label: '設定', icon: Settings, mobile: 'exact' },
];

/**
 * スマホで使えるかの正本。サイドバー・下部タブ・メニュー・AppShell の判定はすべてこの表から出す
 * （以前は MobileNav に TABS / MOBILE_OK の別定義があり、片方だけ直す事故が起きた）。
 *
 * 分担: 閲覧・承認・チャット・契約・経理の確認はスマホ、エージェントの手順編集と監査はパソコン。
 * 表が横に長い画面をスマホに載せても正確に扱えないので、隠さず誘導する。
 */
export type NavItem = NavEntry | WorkPage;

export const NAV_ROUTES: readonly NavItem[] = [...MAIN_NAV, ...WORK_PAGES, ...ADMIN_NAV];

/** スマホの下部タブ（メニューを除く 4 つ） */
export const MOBILE_TABS: readonly NavEntry[] = MAIN_NAV.filter((e) => e.tab);

/** メニューの「スマホで使える」 */
export const MOBILE_MENU: readonly NavItem[] = NAV_ROUTES.filter((e) => e.mobile !== false);

/** メニューの「パソコン向け」 */
export const DESKTOP_MENU: readonly NavItem[] = NAV_ROUTES.filter((e) => e.mobile === false);

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

export function isMobileRoute(pathname: string): boolean {
  const path = normalize(pathname);
  return NAV_ROUTES.some((e) => {
    if (e.mobile === 'exact') return path === e.to;
    if (e.mobile === 'prefix') return path === e.to || path.startsWith(`${e.to}/`);
    return false;
  });
}
