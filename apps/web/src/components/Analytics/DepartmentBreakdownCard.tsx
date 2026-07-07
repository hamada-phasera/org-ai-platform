import { GlassCard, GlassBadge } from '../ui';
import type { DepartmentRow } from './types';

function fmtMin(min: number): string {
  if (min <= 0) return '0分';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m > 0 ? `${m}分` : ''}` : `${m}分`;
}

/** 部署別の実行数（＋シェア・削減時間）を横棒で表示。cost/成功率は含めない（A-3 で接続）。 */
export function DepartmentBreakdownCard({ rows }: { rows: DepartmentRow[] }) {
  const sorted = [...rows].sort((a, b) => b.executions - a.executions);
  const maxExec = Math.max(1, ...sorted.map((r) => r.executions));

  return (
    <GlassCard variant="regular" padding="none" className="p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-semibold text-primary">部署別 実行数</span>
        <GlassBadge>完了(DONE)タスク基準</GlassBadge>
      </div>

      <div className="space-y-3">
        {sorted.map((r) => (
          <div key={r.department} className="flex items-center gap-3">
            <span className="w-24 flex items-center gap-1.5 text-xs text-secondary flex-shrink-0">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.accent }} />
              <span className="truncate">{r.label}</span>
            </span>
            <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${(r.executions / maxExec) * 100}%`, background: r.accent }}
              />
            </div>
            <span className="w-12 text-right text-xs text-primary font-semibold flex-shrink-0 tabular-nums">
              {r.executions}件
            </span>
            <span className="w-10 text-right text-[11px] text-text-muted flex-shrink-0 tabular-nums">
              {Math.round(r.share * 100)}%
            </span>
            <span className="w-20 text-right text-[11px] text-text-muted flex-shrink-0 tabular-nums">
              {fmtMin(r.minutesSaved)}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-text-muted mt-4 leading-relaxed">
        実行数＝完了(DONE)タスク数、時間＝各タスクの推定削減時間の合計（/dashboard/efficiency 由来）。
        LLM 呼び出し数・コストは下の「部署別 推定コスト」カード（usage-metrics-svc 由来）を参照。
      </p>
    </GlassCard>
  );
}
