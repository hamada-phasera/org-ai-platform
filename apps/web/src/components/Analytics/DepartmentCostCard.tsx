import { GlassCard, GlassBadge } from '../ui';
import { DEPT_LABEL, DEPT_ACCENT } from '../../constants/departments';
import type { DepartmentMetricsRow } from './useDepartmentMetrics';

const FALLBACK_ACCENT = '#475569';

function fmtUsd(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

/**
 * 部署別 LLM 推定コスト（usage-metrics-svc /metrics/departments 接続時のみ表示）。
 * コストは AILog.tokens × モデル別ブレンドレートの導出値（integration-requests #1）。
 */
export function DepartmentCostCard({ rows }: { rows: DepartmentMetricsRow[] }) {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd);
  const maxCost = Math.max(1e-9, ...sorted.map((r) => r.costUsd));
  const totalCost = sorted.reduce((sum, r) => sum + r.costUsd, 0);

  return (
    <GlassCard variant="regular" padding="none" className="p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-semibold text-primary">部署別 推定コスト（直近30日）</span>
        <GlassBadge>合計 {fmtUsd(totalCost)}</GlassBadge>
      </div>

      <div className="space-y-3">
        {sorted.map((r) => (
          <div key={r.department} className="flex items-center gap-3">
            <span className="w-24 flex items-center gap-1.5 text-xs text-secondary flex-shrink-0">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: DEPT_ACCENT[r.department] ?? FALLBACK_ACCENT }}
              />
              <span className="truncate">{DEPT_LABEL[r.department] ?? r.department}</span>
            </span>
            <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(r.costUsd / maxCost) * 100}%`,
                  background: DEPT_ACCENT[r.department] ?? FALLBACK_ACCENT,
                }}
              />
            </div>
            <span className="w-16 text-right text-xs text-primary font-semibold flex-shrink-0 tabular-nums">
              {fmtUsd(r.costUsd)}
            </span>
            <span className="w-14 text-right text-[11px] text-text-muted flex-shrink-0 tabular-nums">
              {r.calls}回
            </span>
            <span className="w-16 text-right text-[11px] text-text-muted flex-shrink-0 tabular-nums">
              {r.avgLatencyMs > 0 ? `${r.avgLatencyMs}ms` : '—'}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-text-muted mt-4 leading-relaxed">
        コスト＝AILog のトークン数 × モデル別ブレンド単価の<span className="font-medium">概算</span>
        （トークンは入出力合算のため近似。単価表の正式確定は統合フェーズ・integration-requests #1）。
        回数＝LLM呼び出し数、右端＝平均レイテンシ。
      </p>
    </GlassCard>
  );
}
