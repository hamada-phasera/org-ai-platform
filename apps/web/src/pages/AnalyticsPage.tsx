import { BarChart3, Activity, Building2, DollarSign, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassCard, PageHeader, EmptyState, ErrorState, SkeletonList } from '../components/ui';
import {
  useDepartmentAnalytics,
  DepartmentBreakdownCard,
  ReservedMetricCard,
} from '../components/Analytics';

function fmtHours(hours: number): string {
  return `${hours}時間`;
}

/**
 * 部署別分析画面（A-2）。既存 /api/dashboard/efficiency を read-only で流用し、
 * 部署ごとの実行数・シェア・削減時間を可視化する。コスト・成功率は R2 (A-3) で接続予定。
 * ※ ルーティング/ナビへの配線は統合フェーズ B が行う（本ファイルは App.tsx に登録しない）。
 */
export default function AnalyticsPage() {
  const { analytics, isLoading, isError, refetch } = useDepartmentAnalytics();

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        eyebrow="Analytics"
        title="部署別分析"
        description="部署ごとの AI 実行数・稼働状況を可視化します。コスト・成功率は順次接続予定です。"
        actions={
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-accent/15 text-accent">
            <BarChart3 size={18} />
          </div>
        }
      />

      {isLoading ? (
        <SkeletonList count={4} />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !analytics || analytics.totals.executions === 0 ? (
        <EmptyState
          icon={<Activity size={22} />}
          title="まだ分析できる実行がありません"
          description="AI エージェントがタスクを完了すると、部署別の実行数がここに集計されます。"
        />
      ) : (
        <div className="space-y-4">
          {/* 実データのサマリー */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SummaryTile
              icon={<Activity size={16} />}
              label="総実行数"
              value={`${analytics.totals.executions}件`}
              sub="完了(DONE)タスク"
            />
            <SummaryTile
              icon={<Building2 size={16} />}
              label="稼働部署"
              value={`${analytics.totals.activeDepartments}部署`}
              sub={`全 ${analytics.rows.length} 部署中`}
            />
            <SummaryTile
              icon={<BarChart3 size={16} />}
              label="累計削減時間"
              value={fmtHours(analytics.totals.hoursSaved)}
              sub="AI による自動化"
            />
          </div>

          <DepartmentBreakdownCard rows={analytics.rows} />

          {/* 接続予定（R2 / A-3: usage-metrics-svc 部署別集計） */}
          <div>
            <p className="text-xs font-medium tracking-wide text-text-muted uppercase mb-2">
              接続予定（R2 / A-3）
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ReservedMetricCard
                icon={<CheckCircle2 size={16} />}
                label="部署別 成功率"
                note="usage-metrics-svc の部署別集計 (A-3) 接続後に表示。現状の /efficiency は完了タスクのみ返すため成功率は算出不可。"
              />
              <ReservedMetricCard
                icon={<DollarSign size={16} />}
                label="部署別 推定コスト"
                note="AILog.tokens × モデル別レートで導出予定 (A-3)。DB にコスト列は無く、レート表は要確定（integration-requests #1）。"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <GlassCard variant="regular" padding="none" className="p-4">
      <div className="flex items-center gap-1.5 text-text-muted mb-2">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-h2 font-bold text-primary tracking-tight">{value}</div>
      <div className="text-xs text-secondary mt-1">{sub}</div>
    </GlassCard>
  );
}
