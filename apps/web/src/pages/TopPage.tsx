import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, BarChart3, CheckCircle2, FileText, Send } from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { ExpandableCard } from '../components/motion/ExpandableCard';
import { DEPT_LABEL } from '../constants/departments';

type PanelKey = 'metrics' | 'approvals' | 'agents' | null;

interface Efficiency {
  today: { minutesSaved: number; taskCount: number };
  week: { minutesSaved: number; taskCount: number };
  total: { hoursSaved: number; taskCount: number };
  targetMinutesPerDay: number;
  byDepartment?: { department: string; minutesSaved: number }[];
}

interface BackendTask {
  id: string;
  title: string;
  status: string;
  department?: string | null;
  taskType?: string | null;
  createdAt: string;
}

interface SavedAgent {
  id: string;
  name: string;
  department: string;
  enabled: boolean;
  description?: string | null;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'お疲れさまです';
}

function fmtMin(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/**
 * TOP — 最初に見える画面。
 *
 * ここに数字（KPI）は出さない。初見の人が「何からやればいいか」で止まるのを避けるため、
 * 置くのは「一行の指示入力」と「大きな入口4つ」だけにしている。
 * 唯一の例外が承認待ちの件数で、これは放置されると困るもの。
 *
 * 詳細は押した位置から展開する（ページ遷移しない）。データはその時に初めて取りに行く。
 */
export default function TopPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState<PanelKey>(null);
  const [draft, setDraft] = useState('');

  // 展開されたときだけ取得する。TOP を開いただけで 3 本走らせない。
  const metrics = useQuery<Efficiency>({
    queryKey: ['efficiency'],
    queryFn: async () => (await api.get('/dashboard/efficiency')).data.data,
    enabled: open === 'metrics',
    staleTime: 60_000,
  });

  const tasks = useQuery<BackendTask[]>({
    queryKey: ['top-approvals'],
    queryFn: async () => (await api.get('/tasks')).data.data ?? [],
    enabled: open === 'approvals',
    staleTime: 30_000,
  });

  const agents = useQuery<SavedAgent[]>({
    queryKey: ['saved-agents'],
    queryFn: async () => (await api.get('/agents')).data.data ?? [],
    staleTime: 60_000,
  });

  // 承認待ちの件数だけは常時出す。件数はエージェント一覧と違って「放置されると困る」もの。
  const pending = useQuery<number>({
    queryKey: ['pending-approval-count'],
    queryFn: async () => {
      const list: BackendTask[] = (await api.get('/tasks')).data.data ?? [];
      return list.filter((t) => t.status === 'PENDING_APPROVAL').length;
    },
    staleTime: 60_000,
  });

  const submit = () => {
    const text = draft.trim();
    navigate('/chat', text ? { state: { draft: text } } : undefined);
  };

  const pendingCount = pending.data ?? 0;
  const approvals = (tasks.data ?? []).filter((t) => t.status === 'PENDING_APPROVAL');

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="relative mx-auto w-full max-w-[760px] px-5 pb-16 pt-10 lg:pt-14">
        <div className="text-center">
          <div className="brand-strip mb-6 w-16" aria-hidden="true" />
          <h1 className="font-display text-[26px] font-extrabold leading-snug lg:text-[34px]">
            {greeting()}、{user?.name ?? 'ようこそ'}さん。
          </h1>
          <p className="mt-2.5 text-body text-secondary">
            今日やることを一行で伝えてください。担当の部署AIに振り分けます。
          </p>
        </div>

        <form
          className="mt-7 flex items-center gap-3 rounded-xl border border-border bg-elevated px-4 py-2 shadow-elev-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="top-instruction" className="sr-only">
            今日は何をしますか？
          </label>
          <input
            id="top-instruction"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="今日は何をしますか？"
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-text-muted"
          />
          <button
            type="submit"
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-action px-5 text-sm font-bold text-white shadow-[0_1px_2px_rgba(10,37,64,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors duration-fast hover:bg-action-hover"
          >
            <Send size={14} strokeWidth={2.2} aria-hidden="true" />
            送信
          </button>
        </form>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {/* 提案書 — ここだけは展開ではなくチャットへ渡す */}
          <button
            type="button"
            onClick={() => navigate('/chat', { state: { department: 'SALES' } })}
            className="flex min-h-[150px] flex-col rounded-xl border border-border bg-elevated p-5 text-left shadow-elev-2 transition-shadow duration-base hover:shadow-elev-3"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-dept-sales/10">
                <FileText size={19} strokeWidth={2} className="text-dept-sales" aria-hidden="true" />
              </span>
              <span className="text-h3 font-extrabold">提案書をつくる</span>
            </span>
            <span className="mt-3 block text-sm leading-relaxed text-secondary">
              商談の履歴と手元の資料から、{DEPT_LABEL.SALES}AIが下書きを起こします。
            </span>
          </button>

          <ExpandableCard
            id="metrics"
            open={open === 'metrics'}
            onOpenChange={(v) => setOpen(v ? 'metrics' : null)}
            label="数字を見る"
            className="sm:col-span-2"
            collapsedClassName="min-h-[150px] p-5 sm:col-span-1"
            collapsed={
              <span className="flex h-full flex-col">
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-dept-analytics/10">
                    <BarChart3 size={19} strokeWidth={2} className="text-dept-analytics" aria-hidden="true" />
                  </span>
                  <span className="text-h3 font-extrabold">数字を見る</span>
                </span>
                <span className="mt-3 block text-sm leading-relaxed text-secondary">
                  削減できた時間と、部署ごとの内訳。押すとこの場で開きます。
                </span>
              </span>
            }
          >
            <MetricsPanel
              data={metrics.data}
              loading={metrics.isLoading}
              onClose={() => setOpen(null)}
              onSeeAll={() => navigate('/dashboard')}
            />
          </ExpandableCard>

          <ExpandableCard
            id="approvals"
            open={open === 'approvals'}
            onOpenChange={(v) => setOpen(v ? 'approvals' : null)}
            label="承認する"
            className="sm:col-span-2"
            collapsedClassName="min-h-[150px] p-5 sm:col-span-1"
            collapsed={
              <span className="flex h-full flex-col">
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-warning/10">
                    <CheckCircle2 size={19} strokeWidth={2} className="text-warning" aria-hidden="true" />
                  </span>
                  <span className="text-h3 font-extrabold">承認する</span>
                  {pendingCount > 0 && (
                    <span className="ml-auto rounded-sm border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-extrabold text-warning">
                      {pendingCount}件
                    </span>
                  )}
                </span>
                <span className="mt-3 block text-sm leading-relaxed text-secondary">
                  あなたの確認を待っているもの。承認するまで外部には出ません。
                </span>
              </span>
            }
          >
            <ListPanel
              title="承認する"
              empty="いま確認を待っているものはありません。"
              loading={tasks.isLoading}
              onClose={() => setOpen(null)}
              onSeeAll={() => navigate('/tasks')}
              seeAllLabel="タスク一覧へ →"
              items={approvals.map((t) => ({
                id: t.id,
                primary: t.title,
                secondary: t.department ? DEPT_LABEL[t.department] ?? t.department : '—',
              }))}
            />
          </ExpandableCard>

          <ExpandableCard
            id="agents"
            open={open === 'agents'}
            onOpenChange={(v) => setOpen(v ? 'agents' : null)}
            label="エージェントを動かす"
            className="sm:col-span-2"
            collapsedClassName="min-h-[150px] p-5 sm:col-span-1"
            collapsed={
              <span className="flex h-full flex-col">
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <Bot size={19} strokeWidth={2} className="text-primary" aria-hidden="true" />
                  </span>
                  <span className="text-h3 font-extrabold">エージェントを動かす</span>
                </span>
                <span className="mt-3 block text-sm leading-relaxed text-secondary">
                  保存済みの手順を、ひと押しで実行します。
                </span>
              </span>
            }
          >
            <ListPanel
              title="エージェントを動かす"
              empty="保存済みのエージェントはまだありません。"
              loading={agents.isLoading}
              onClose={() => setOpen(null)}
              onSeeAll={() => navigate('/agents')}
              seeAllLabel="エージェント管理へ →"
              items={(agents.data ?? []).map((a) => ({
                id: a.id,
                primary: a.name,
                secondary: DEPT_LABEL[a.department] ?? a.department,
              }))}
            />
          </ExpandableCard>
        </div>

        <p className="mt-7 text-center text-xs leading-relaxed text-text-muted">
          もっと細かく見るときは、左のメニューから。ここには「いま決めること」だけを置いています。
        </p>
      </div>
    </div>
  );

  function MetricsPanel({
    data,
    loading,
    onClose,
    onSeeAll,
  }: {
    data?: Efficiency;
    loading: boolean;
    onClose: () => void;
    onSeeAll: () => void;
  }) {
    return (
      <div className="p-5">
        <PanelHeader
          icon={<BarChart3 size={18} strokeWidth={2} className="text-dept-analytics" aria-hidden="true" />}
          title="数字を見る"
          onClose={onClose}
          onSeeAll={onSeeAll}
          seeAllLabel="すべての指標を見る →"
        />
        {loading || !data ? (
          <p className="mt-4 text-sm text-secondary" aria-live="polite">
            集計を読み込んでいます…
          </p>
        ) : (
          <dl className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="今日" value={fmtMin(data.today.minutesSaved)} note={`${data.today.taskCount}件を自動化`} />
            <Stat label="今週" value={fmtMin(data.week.minutesSaved)} note={`${data.week.taskCount}件`} />
            <Stat label="累計" value={`${data.total.hoursSaved}時間`} note={`通算 ${data.total.taskCount}件`} />
            <Stat
              label="1日の目標"
              value={`${Math.min(100, Math.round((data.today.minutesSaved / Math.max(1, data.targetMinutesPerDay)) * 100))}%`}
              note={`${data.today.minutesSaved} / ${data.targetMinutesPerDay}分`}
            />
          </dl>
        )}
      </div>
    );
  }
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-text-muted">{label}</dt>
      <dd className="mt-1.5 font-mono text-h2 font-semibold tracking-tight">{value}</dd>
      <p className="mt-1 text-xs font-semibold text-text-muted">{note}</p>
    </div>
  );
}

function PanelHeader({
  icon,
  title,
  onClose,
  onSeeAll,
  seeAllLabel,
}: {
  icon: React.ReactNode;
  title: string;
  onClose: () => void;
  onSeeAll: () => void;
  seeAllLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sunken">{icon}</span>
      <h2 className="flex-1 text-h3 font-extrabold">{title}</h2>
      <button type="button" onClick={onSeeAll} className="text-xs font-bold text-accent hover:text-accent-hover">
        {seeAllLabel}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="閉じる"
        className="flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-elevated text-secondary"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function ListPanel({
  title,
  items,
  empty,
  loading,
  onClose,
  onSeeAll,
  seeAllLabel,
}: {
  title: string;
  items: { id: string; primary: string; secondary: string }[];
  empty: string;
  loading: boolean;
  onClose: () => void;
  onSeeAll: () => void;
  seeAllLabel: string;
}) {
  return (
    <div className="p-5">
      <PanelHeader
        icon={<Bot size={18} strokeWidth={2} className="text-secondary" aria-hidden="true" />}
        title={title}
        onClose={onClose}
        onSeeAll={onSeeAll}
        seeAllLabel={seeAllLabel}
      />
      {loading ? (
        <p className="mt-4 text-sm text-secondary" aria-live="polite">
          読み込んでいます…
        </p>
      ) : items.length === 0 ? (
        <p className="mt-4 text-sm text-secondary">{empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline">
          {items.slice(0, 5).map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.primary}</span>
              <span className="shrink-0 text-xs font-bold text-text-muted">{item.secondary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
