import { ChevronRight } from 'lucide-react';
import { Button, SkeletonList } from '../ui';
import { StepDot } from './FlowBits';
import { formatDuration, labelOfRunStatus } from './flowModel';
import type { FlowRunSummary } from './flowApi';

/**
 * 実行の履歴（§3.4「区切り線の行: 日時・誰が・状態・所要時間。押すとその回のステップ結果を重ねる」）。PC・スマホ共用。
 * ⚠️ zod の値も `@xyflow/react` も import しない。
 */
export function whoOf(run: Pick<FlowRunSummary, 'trigger' | 'actorName' | 'actorId'>): string {
  if (run.trigger === 'schedule') return '定期';
  if (run.trigger === 'page') return run.actorName ?? 'ページ';
  return run.actorName ?? (run.actorId ? 'メンバー' : '—');
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RunHistory({
  runs,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  runs: FlowRunSummary[] | undefined;
  loading: boolean;
  error: boolean;
  selectedId: string | null;
  onSelect: (runId: string) => void;
  onRetry: () => void;
}) {
  if (loading) return <SkeletonList count={3} />;
  if (error) {
    return (
      <p className="flex items-center gap-3 border-y border-border px-2 py-3 text-sm text-secondary">
        読み込めませんでした
        <Button size="sm" variant="ghost" onClick={onRetry}>
          再読込
        </Button>
      </p>
    );
  }
  if (!runs || runs.length === 0) return <p className="border-y border-border px-2 py-4 text-sm text-text-muted">まだありません</p>;
  return (
    <ul className="divide-y divide-hairline border-y border-border" aria-label="履歴">
      {runs.map((r) => {
        const selected = r.id === selectedId;
        return (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              aria-pressed={selected}
              className={`flex min-h-14 w-full items-center gap-3 px-2 py-2.5 text-left transition-colors duration-fast hover:bg-sunken lg:min-h-11 ${
                selected ? 'bg-accent-soft' : ''
              }`}
            >
              <StepDot status={r.status} />
              <span className="w-24 shrink-0 font-mono text-sm text-secondary tabular">{when(r.createdAt)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-primary">{whoOf(r)}</span>
              <span className="shrink-0 text-xs font-bold text-secondary">{labelOfRunStatus(r.status)}</span>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-text-muted tabular">{formatDuration(r.durationMs)}</span>
              <ChevronRight size={14} className="shrink-0 text-text-muted lg:hidden" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
