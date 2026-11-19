import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { hasRoleAtLeast } from '@org-ai/shared-types';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { Onboarding } from '../components/shell/Onboarding';
import { BusinessList } from '../components/canvas/BusinessList';
import { canvasToList } from '../components/canvas/canvasToList';
import { fallbackCanvas, useCanvas, useOpenCanvasNode } from '../components/canvas/canvasApi';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { BILLING_PATH, canOpenBilling } from '../utils/planNotice';

/* キャンバス（@xyflow/react ≒ 55KB gzip）は PC だけが遅延で読む。スマホは縦リストだけ（K20） */
const CanvasBoard = lazy(() => import('../components/canvas/CanvasBoard'));

interface BackendTask {
  id: string;
  status: string;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'お疲れさまです';
}

/**
 * ホーム `/`（docs/design/canvas-home.md §3.2・§4.2）。指示入力＋初回の案内＋業務のキャンバス。
 *
 * - PC: 業務のノードが線でつながるキャンバス（閲覧モードが既定。ADMIN 以上は配置を編集できる）。
 * - スマホ: 同じ内容の縦リスト（`canvasToList`）。`@xyflow/react` は読まない。
 * - 数字（KPI）は置かない。例外は承認待ちの件数だけ（承認のノードの印）。
 * - `Canvas` の行が無い組織は既定の配置（gateway が返す。読み込み前も同じものを描く）。
 */
export default function CanvasHomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const canManage = hasRoleAtLeast(role, 'ADMIN');
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const canvas = useCanvas();
  const data = canvas.data ?? fallbackCanvas();
  const rows = useMemo(() => canvasToList(data.layout, data.flows), [data]);
  const { open, pendingId, error } = useOpenCanvasNode();

  // 承認待ちの件数だけは常時出す（放置されると困るもの）。承認のノードの印になる
  const pending = useQuery<number>({
    queryKey: ['pending-approval-count'],
    queryFn: async () => {
      const list: BackendTask[] = (await api.get('/tasks')).data.data ?? [];
      return list.filter((t) => t.status === 'PENDING_APPROVAL').length;
    },
    staleTime: 60_000,
  });
  const approvalsCount = pending.data ?? 0;

  const submit = () => {
    const text = draft.trim();
    navigate('/chat', text ? { state: { draft: text } } : undefined);
  };

  const onOpen = (row: (typeof rows)[number]) => void open(row, canManage);

  const list = (
    <BusinessList rows={rows} approvalsCount={approvalsCount} canCreate={canManage} onOpen={onOpen} pendingId={pendingId} />
  );

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1120px] px-5 pb-16 pt-8 lg:px-8 lg:pt-10">
        <h1 className="font-display text-h2 font-extrabold leading-snug lg:text-[26px]">
          {greeting()}、{user?.name ?? 'ようこそ'}さん。
        </h1>

        <form
          className="mt-4 flex max-w-[760px] items-center gap-3 rounded-xl border border-border bg-elevated px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="top-instruction" className="sr-only">
            今日は何をしますか？
          </label>
          <input
            ref={inputRef}
            id="top-instruction"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="今日は何をしますか？"
            className="h-11 min-w-0 flex-1 bg-transparent text-body max-lg:text-base text-primary outline-none placeholder:text-text-muted"
          />
          <button
            type="submit"
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-action px-5 text-sm font-bold text-white transition-colors duration-fast hover:bg-action-hover"
          >
            <Send size={14} strokeWidth={2.2} aria-hidden="true" />
            送信
          </button>
        </form>
        <Onboarding onInstruct={() => inputRef.current?.focus()} />

        <section className="mt-8" aria-label="業務">
          {desktop ? (
            <Suspense
              fallback={
                <div aria-busy="true">
                  <h2 className="mb-2 flex min-h-9 items-center text-sm font-bold text-text-muted">業務</h2>
                  {list}
                </div>
              }
            >
              <CanvasBoard
                data={data}
                approvalsCount={approvalsCount}
                canEdit={canManage && !canvas.isError && !canvas.isLoading}
                canCreate={canManage}
                onOpen={onOpen}
                pendingId={pendingId}
              />
            </Suspense>
          ) : (
            <>
              <h2 className="mb-1 text-sm font-bold text-text-muted">業務</h2>
              {list}
            </>
          )}

          <div aria-live="polite" className="mt-2 min-h-5 text-sm">
            {error && (
              <p className="text-secondary">
                {error.message}
                {error.code === 'FLOW_LIMIT_REACHED' && canOpenBilling(role) && (
                  <Link to={BILLING_PATH} className="ml-2 font-bold text-accent hover:text-accent-hover">
                    プラン
                  </Link>
                )}
              </p>
            )}
            {canvas.isError && <p className="text-secondary">読み込めませんでした。既定の配置を表示しています。</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
