import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown } from 'lucide-react';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { LiquidOrbToggle } from '../theme-toggle/LiquidOrbToggle';
import { ADMIN_NAV, MAIN_NAV, WORK_PAGES } from './navConfig';
import type { NavEntry } from './navConfig';

interface OrgMe {
  id: string;
  name: string;
  plan: string;
}

interface OrgUsage {
  aiCallsThisMonth: number;
  planLimit: number;
  resetAt: string;
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex w-full items-center gap-2.5 h-8 px-2.5 rounded-sm text-sm font-semibold',
    'transition-colors duration-fast ease-standard',
    isActive
      ? 'bg-action text-inverse'
      : 'text-secondary hover:bg-sunken hover:text-primary',
  ].join(' ');

function NavItem({ entry }: { entry: NavEntry }) {
  const Icon = entry.icon;
  return (
    <NavLink to={entry.to} end={entry.end} className={linkClass}>
      {({ isActive }) => (
        <>
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
          <span className="flex-1 truncate">{entry.label}</span>
          {isActive && <span className="sr-only">（現在のページ）</span>}
        </>
      )}
    </NavLink>
  );
}

/**
 * 左サイドバー。デスクトップ主のシェルの背骨。
 *
 * v1 は全画面幅でアイコンのみの浮遊ボトムナビ1本しかなく、ラベルも aria-current も
 * 無かった。ここではラベルを出し、NavLink の active 判定を使う。
 */
export function Sidebar() {
  const user = useAuthStore((s) => s.user);

  const { data: org } = useQuery<OrgMe | null>({
    queryKey: ['org-me'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: OrgMe }>('/organizations/me');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  const { data: usage } = useQuery<OrgUsage | null>({
    queryKey: ['org-usage'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: OrgUsage }>('/organizations/me/usage');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  const used = usage?.aiCallsThisMonth ?? 0;
  const limit = usage?.planLimit ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const resetLabel = usage?.resetAt
    ? new Date(usage.resetAt).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })
    : null;

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-border bg-elevated px-3 pb-3 pt-3.5">
      <div className="flex items-center gap-2.5 px-2 pb-3.5">
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-sm bg-action" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-inverse)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h11M4 18h7" />
          </svg>
        </span>
        <span className="font-display text-[15px] font-extrabold">FLOW</span>
      </div>

      <button
        type="button"
        aria-label={`組織を切り替え — ${org?.name ?? '読み込み中'}、${org?.plan ?? ''} プラン`}
        className="flex w-full items-center gap-2.5 rounded-sm border border-border bg-canvas px-2.5 py-2 text-left transition-colors duration-fast hover:bg-sunken"
      >
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-action text-[10px] font-extrabold text-inverse">
          {org?.name?.slice(0, 1) ?? '—'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold text-primary">{org?.name ?? '—'}</span>
          <span className="block text-micro font-semibold text-text-muted">
            {org?.plan ?? '—'} プラン
          </span>
        </span>
        <ChevronsUpDown size={12} strokeWidth={2.4} className="text-text-muted" aria-hidden="true" />
      </button>

      <nav className="mt-3.5 flex flex-col gap-0.5" aria-label="メインナビゲーション">
        {MAIN_NAV.map((entry) => (
          <NavItem key={entry.to} entry={entry} />
        ))}

        <p className="mt-4 mb-1.5 px-2.5 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
          業務ページ
        </p>
        {WORK_PAGES.map((page) => (
          <NavLink key={page.to} to={page.to} className={linkClass}>
            <span
              className="ml-1 mr-1 h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: page.colorVar }}
              aria-hidden="true"
            />
            <span className="flex-1 truncate">{page.label}</span>
          </NavLink>
        ))}

        <p className="mt-4 mb-1.5 px-2.5 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
          管理
        </p>
        {ADMIN_NAV.map((entry) => (
          <NavItem key={entry.to} entry={entry} />
        ))}
      </nav>

      <div className="mt-auto">
        <div className="mb-2 flex justify-center">
          <LiquidOrbToggle />
        </div>

        {usage && (
          <div className="rounded-md border border-border bg-canvas px-2.5 py-2.5">
            <div className="flex items-center justify-between text-xs font-bold text-secondary">
              <span>今月の AI 呼び出し</span>
              <span className="font-mono text-primary">
                {used} / {limit}
              </span>
            </div>
            <div
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-label="今月の AI 呼び出し数"
            >
              <div className="h-full rounded-full bg-action" style={{ width: `${pct}%` }} />
            </div>
            {resetLabel && (
              <p className="mt-1.5 text-micro text-text-muted">{resetLabel}にリセット</p>
            )}
          </div>
        )}

        <NavLink
          to="/settings"
          className="mt-2.5 flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-fast hover:bg-sunken"
          aria-label={`アカウント — ${user?.name ?? ''}、${user?.role ?? ''}`}
        >
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-border bg-sunken text-xs font-extrabold text-secondary">
            {user?.name?.slice(0, 1) ?? '—'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-bold text-primary">{user?.name ?? '—'}</span>
            <span className="block text-micro text-text-muted">{user?.role ?? ''}</span>
          </span>
        </NavLink>
      </div>
    </aside>
  );
}

export default Sidebar;
