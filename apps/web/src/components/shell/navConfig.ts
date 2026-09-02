import {
  Bot,
  BarChart3,
  FileText,
  Home,
  ListChecks,
  MessageCircle,
  Settings,
  Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** end=true のときだけ完全一致で active 判定する（"/" が全ルートに一致するのを防ぐ） */
  end?: boolean;
}

/** 主ナビ。TOP から降りていく先。 */
export const MAIN_NAV: NavEntry[] = [
  { to: '/', label: 'ホーム', icon: Home, end: true },
  { to: '/dashboard', label: 'ダッシュボード', icon: BarChart3 },
  { to: '/chat', label: 'チャット', icon: MessageCircle },
  { to: '/agents', label: 'エージェント', icon: Bot },
  { to: '/deliverables', label: '成果物', icon: FileText },
  { to: '/tasks', label: 'タスク', icon: ListChecks },
];

export interface WorkPage {
  to: string;
  label: string;
  /** 部署カラー。CSS 変数で持ち、ダークでも自動的に切り替わるようにする。 */
  colorVar: string;
}

/**
 * 業務ページ。v1 ではルートは存在するのにナビから到達できない孤児だった。
 * 「部署」ではなく「業務ページ」と呼ぶ — 経理と総合がここに無いのは
 * 部署が無いからではなく、専用ページがまだ無いだけなので。
 */
export const WORK_PAGES: WorkPage[] = [
  { to: '/sales', label: '営業パイプライン', colorVar: 'var(--dept-sales)' },
  { to: '/analytics', label: 'データ分析', colorVar: 'var(--dept-analytics)' },
  { to: '/sns', label: 'SNS投稿', colorVar: 'var(--dept-marketing)' },
];

export const ADMIN_NAV: NavEntry[] = [
  { to: '/governance', label: 'ガバナンス', icon: Shield },
  { to: '/settings', label: '設定', icon: Settings },
];

/**
 * スマホで使えるルート。
 *
 * 閲覧・承認・チャットはスマホ、エージェント設定と監査ログはパソコン、という分担。
 * 表が横に長い画面をスマホに載せても正確に扱えないので、隠さず誘導する。
 */
export const MOBILE_ROUTES = ['/', '/chat', '/deliverables'] as const;

export function isMobileRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return MOBILE_ROUTES.some((route) => route !== '/' && pathname.startsWith(route));
}
