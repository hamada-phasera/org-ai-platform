import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle, X } from 'lucide-react';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { onboardingDismissKey, onboardingKeysFor, onboardingSteps } from '../../utils/onboarding';

/**
 * 初回の案内（TOP の入力欄の下の 3 行: 指示・連携・招待）。判定は utils/onboarding.ts。
 *
 * 見た目は区切り線の一覧だけ（カード・影・角丸・左アクセントバーを使わない。TOP はカードの上に置くので入れ子になる）。
 * 数字（KPI）は出さない（DESIGN.md §4・ホームの方針）。
 * 完了の判定に使う一覧は設定画面と同じキャッシュキー・同じ形で取るので、設定で接続・招待すると TOP に戻った時点で反映される。
 */

/** 設定 > 連携 と同じキャッシュを共有するので、形は IntegrationsSection の一覧と同じ（使うのは status だけ） */
type ProviderConnectionView = { status: string };

interface Props {
  /** 「指示」を押したとき（TOP の入力欄にフォーカスを移す） */
  onInstruct: () => void;
}

function readDismissed(orgId: string | null): boolean {
  if (!orgId) return true;
  try {
    return window.localStorage.getItem(onboardingDismissKey(orgId)) === '1';
  } catch {
    return false;
  }
}

export function Onboarding({ onInstruct }: Props) {
  const navigate = useNavigate();
  const orgId = useAuthStore((s) => s.user?.orgId ?? null);
  const role = useAuthStore((s) => s.memberships.find((m) => m.orgId === s.user?.orgId)?.role ?? null);
  // 組織を切り替えたら、その組織の記録を読み直す（描画中に導出。effect で setState しない）
  const [dismissedFor, setDismissedFor] = useState<Record<string, boolean>>({});
  const dismissed = orgId ? (dismissedFor[orgId] ?? readDismissed(orgId)) : true;

  const keys = onboardingKeysFor(role);
  const wants = (k: 'connect' | 'invite') => !dismissed && keys.includes(k);

  const chat = useQuery<unknown[]>({
    queryKey: ['chat-sessions'],
    queryFn: async () => (await api.get<{ data: unknown[] }>('/chat/sessions')).data.data ?? [],
    enabled: !dismissed,
    staleTime: 60_000,
  });
  const providers = useQuery<ProviderConnectionView[]>({
    queryKey: ['provider-connections'],
    queryFn: async () => (await api.get<{ data: ProviderConnectionView[] }>('/integrations')).data.data,
    enabled: wants('connect'),
    staleTime: 60_000,
    retry: false,
  });
  // LINE の接続一覧はオーナーだけが読める（ADMIN は 403）ので、招待と同じ条件で取る
  const channels = useQuery<unknown[]>({
    queryKey: ['channel-connections'],
    queryFn: async () => (await api.get<{ data: unknown[] }>('/inbox/connections')).data.data,
    enabled: wants('invite'),
    staleTime: 60_000,
    retry: false,
  });
  const members = useQuery<{ status: string }[]>({
    queryKey: ['members'],
    queryFn: async () => (await api.get<{ data: { status: string }[] }>('/members')).data.data,
    enabled: wants('invite'),
    staleTime: 60_000,
    retry: false,
  });
  const invitations = useQuery<unknown[]>({
    queryKey: ['member-invitations'],
    queryFn: async () => (await api.get<{ data: unknown[] }>('/members/invitations')).data.data,
    enabled: wants('invite'),
    staleTime: 60_000,
    retry: false,
  });

  const hasConnection =
    providers.data === undefined || (keys.includes('invite') && channels.data === undefined)
      ? undefined
      : providers.data.some((p) => p.status === 'CONNECTED') || (channels.data?.length ?? 0) > 0;

  const steps = onboardingSteps(
    {
      role,
      hasChat: chat.data === undefined ? undefined : chat.data.length > 0,
      hasConnection,
      memberCount: members.data?.filter((m) => m.status === 'ACTIVE').length,
      pendingInvites: invitations.data?.length,
    },
    dismissed,
  );
  if (steps.length === 0 || !orgId) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(onboardingDismissKey(orgId), '1');
    } catch {
      // 保存できない（プライベートモード等）ときは、この表示中だけ閉じる
    }
    setDismissedFor((m) => ({ ...m, [orgId]: true }));
  };

  return (
    <section aria-labelledby="onboarding-title" className="mt-6">
      <div className="flex items-center justify-between">
        <h2 id="onboarding-title" className="text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
          はじめに
        </h2>
        <button
          type="button"
          onClick={dismiss}
          aria-label="案内を閉じる"
          className="-mr-3 flex h-11 w-11 items-center justify-center text-text-muted hover:text-primary"
        >
          <X size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      <ul className="divide-y divide-hairline border-y border-border">
        {steps.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={s.done}
              onClick={() => (s.to ? navigate(s.to) : onInstruct())}
              className="flex min-h-11 w-full items-center gap-3 py-2.5 text-left disabled:cursor-default"
            >
              {s.done ? (
                <CheckCircle2 size={18} strokeWidth={2} className="shrink-0 text-success" aria-hidden="true" />
              ) : (
                <Circle size={18} strokeWidth={2} className="shrink-0 text-ink-decorative" aria-hidden="true" />
              )}
              <span className={`w-10 shrink-0 text-sm font-bold ${s.done ? 'text-text-muted' : 'text-primary'}`}>
                {s.label}
              </span>
              <span className={`min-w-0 flex-1 text-sm ${s.done ? 'text-text-muted' : 'text-secondary'}`}>
                {s.hint}
                {s.done && <span className="sr-only">（完了）</span>}
              </span>
              {!s.done && <ChevronRight size={16} strokeWidth={2} className="shrink-0 text-text-muted" aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
