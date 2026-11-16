import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import type { MembershipSummary } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { switchOrg } from '../../services/session';
import { sessionDeps } from '../../services/sessionDeps';
import { CreateOrgDialog } from './CreateOrgDialog';

const ROLE_LABEL: Record<string, string> = { OWNER: 'オーナー', ADMIN: '管理者', MEMBER: 'メンバー' };

/**
 * 組織スイッチャー（サイドバー上部）。docs/design/multi-tenancy.md §10.1
 * 所属組織の一覧（今の組織にチェック）と「新しい組織を作成」。所属が1つでも作成の入口として出す。
 */
export function OrgSwitcher({ org }: { org: { name: string; plan: string } | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeOrgId = useAuthStore((s) => s.user?.orgId ?? null);
  const setMemberships = useAuthStore((s) => s.setMemberships);
  const rootRef = useRef<HTMLDivElement>(null);

  // 組織をまたぐ一覧なので、これだけはユーザー単位のキー（切り替えで clear されても取り直すだけ）
  const { data: memberships } = useQuery<MembershipSummary[]>({
    queryKey: ['memberships'],
    enabled: open,
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: MembershipSummary[] }>('/auth/memberships');
      setMemberships(res.data.data);
      return res.data.data;
    },
  });
  const cached = useAuthStore((s) => s.memberships);
  const list = memberships ?? cached;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = async (orgId: string) => {
    if (orgId === activeOrgId) {
      setOpen(false);
      return;
    }
    setSwitching(orgId);
    setError(null);
    try {
      await switchOrg(sessionDeps, orgId);
    } catch {
      setError('切り替えられませんでした。この組織へのアクセス権がない可能性があります。');
      setSwitching(null);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label={`組織を切り替え — ${org?.name ?? '読み込み中'}、${org?.plan ?? ''} プラン`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-sm border border-border bg-canvas px-2.5 py-2 text-left transition-colors duration-fast hover:bg-sunken"
      >
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-action text-[10px] font-extrabold text-inverse">
          {org?.name?.slice(0, 1) ?? '—'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold text-primary">{org?.name ?? '—'}</span>
          <span className="block text-micro font-semibold text-text-muted">{org?.plan ?? '—'} プラン</span>
        </span>
        <ChevronsUpDown size={12} strokeWidth={2.4} className="text-text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="所属している組織"
          className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-border bg-elevated py-1 shadow-lg"
        >
          {list.map((m) => (
            <button
              key={m.orgId}
              type="button"
              role="menuitemradio"
              aria-checked={m.orgId === activeOrgId}
              disabled={switching !== null}
              onClick={() => void choose(m.orgId)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sunken disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-primary">{m.orgName}</span>
                <span className="block text-micro text-text-muted">
                  {m.plan} ・ {ROLE_LABEL[m.role] ?? m.role}
                  {switching === m.orgId ? ' ・ 切り替え中…' : ''}
                </span>
              </span>
              {m.orgId === activeOrgId && <Check size={13} className="text-accent" aria-hidden="true" />}
            </button>
          ))}
          {error && <p className="px-2.5 py-1 text-micro text-danger">{error}</p>}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-bold text-secondary hover:bg-sunken"
          >
            <Plus size={13} aria-hidden="true" />
            新しい組織を作成
          </button>
        </div>
      )}
      {creating && <CreateOrgDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
