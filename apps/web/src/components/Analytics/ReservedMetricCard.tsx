import type { ReactNode } from 'react';
import { GlassCard } from '../ui';

/**
 * まだデータ源が無い指標（コスト・成功率）の「接続予定」プレースホルダ。
 * 数値を捏造せず「—」を表示し、いつ接続されるかを明示する。R2 (A-3) で実データに差し替え。
 */
export function ReservedMetricCard({
  icon,
  label,
  note,
}: {
  icon: ReactNode;
  label: string;
  note: string;
}) {
  return (
    <GlassCard variant="thin" padding="none" className="p-4 border border-dashed border-white/40">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-text-muted">
          {icon}
          <span className="text-xs font-medium">{label}</span>
        </div>
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider bg-muted px-2 py-0.5 rounded-full">
          R2 予定
        </span>
      </div>
      <div className="text-h2 font-bold text-text-muted tracking-tight">—</div>
      <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{note}</div>
    </GlassCard>
  );
}
