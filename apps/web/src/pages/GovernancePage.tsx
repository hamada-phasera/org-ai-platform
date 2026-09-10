import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Shield, Activity, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../services/api';
import type { AILog, RiskEvent } from '@org-ai/shared-types';
import {
  Card,
  Badge,
  Button,
  PageHeader,
  EmptyState,
  ErrorState,
  SkeletonList,
} from '../components/ui';
import { LiquidTabs } from '../components/motion/LiquidTabs';
import { ExternalApiSection } from '../components/Governance/ExternalApiSection';

/* 深刻度＝意味の色。success / warning / danger のトークンで塗る（hex 直書き禁止）。
 * CRITICAL だけ塗りつぶしで一段強く。 */
const SEVERITY_CLASS: Record<string, string> = {
  LOW: 'bg-success/10 text-success',
  MEDIUM: 'bg-warning/10 text-warning',
  HIGH: 'bg-danger/10 text-danger',
  CRITICAL: 'bg-danger text-white',
};

const DEPARTMENTS = ['ALL', 'SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL'] as const;
type DeptFilter = typeof DEPARTMENTS[number];

interface LogsPayload {
  success: boolean;
  data: AILog[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export default function GovernancePage() {
  const [tab, setTab] = useState<'logs' | 'risks' | 'connections'>('logs');
  const [deptFilter, setDeptFilter] = useState<DeptFilter>('ALL');
  const [page, setPage] = useState(1);
  const [riskFilter, setRiskFilter] = useState<'all' | 'unresolved' | 'resolved'>('all');
  const LIMIT = 20;
  const qc = useQueryClient();

  const {
    data: logsData,
    isLoading: logsLoading,
    isError: logsError,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: ['ai-logs', page, deptFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (deptFilter !== 'ALL') params.set('department', deptFilter);
      const res = await api.get<LogsPayload>(`/governance/logs?${params.toString()}`);
      return res.data;
    },
    enabled: tab === 'logs',
  });
  const logs = logsData?.data;
  const pagination = logsData?.pagination;

  const {
    data: risks,
    isLoading: risksLoading,
    isError: risksError,
    refetch: refetchRisks,
  } = useQuery({
    queryKey: ['risks', riskFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (riskFilter === 'unresolved') params.set('resolved', 'false');
      if (riskFilter === 'resolved') params.set('resolved', 'true');
      const qs = params.toString();
      const res = await api.get<{ success: boolean; data: RiskEvent[] }>(
        `/governance/risks${qs ? `?${qs}` : ''}`,
      );
      return res.data.data;
    },
    enabled: tab === 'risks',
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/governance/risks/${id}/resolve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['risks'] }),
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        eyebrow="Governance"
        title="AIガバナンス"
        description="AI の使用状況・個人情報マスキング・リスクイベントを監視します。"
        actions={
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-accent-soft text-accent">
            <Shield size={18} />
          </div>
        }
      />

      <Card variant="thin" padding="md" radius="2xl" className="mb-5 text-sm text-secondary leading-relaxed">
        <p className="font-medium text-primary mb-1">この画面について</p>
        <p>
          「いつ・どの部署の AI が・どれくらいトークンを使ったか」と、個人情報がマスクされたかなどの記録を閲覧できます。監査や社内ルールの確認用で、日々のチャット内容そのものが一覧されるわけではありません（詳細は組織の設定によります）。
        </p>
      </Card>

      {/* Tabs */}
      <LiquidTabs
        id="governance-view"
        label="ガバナンスの表示切り替え"
        items={[
          { value: 'logs', label: 'AIログ' },
          { value: 'risks', label: 'リスクイベント' },
          { value: 'connections', label: '外部API接続' },
        ]}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setPage(1);
        }}
        className="mb-5"
      />

      {/* Filters */}
      {tab === 'logs' && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">部署:</span>
          {DEPARTMENTS.map((d) => (
            <button
              key={d}
              onClick={() => {
                setDeptFilter(d);
                setPage(1);
              }}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                deptFilter === d
                  ? 'bg-accent-soft border-accent-soft-border text-accent'
                  : 'bg-sunken border-border text-secondary hover:text-primary'
              }`}
            >
              {d === 'ALL' ? 'すべて' : d}
            </button>
          ))}
        </div>
      )}

      {tab === 'risks' && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">状態:</span>
          {([
            { key: 'all' as const, label: 'すべて' },
            { key: 'unresolved' as const, label: '未解決のみ' },
            { key: 'resolved' as const, label: '解決済みのみ' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRiskFilter(key)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                riskFilter === key
                  ? 'bg-accent-soft border-accent-soft-border text-accent'
                  : 'bg-sunken border-border text-secondary hover:text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {tab === 'logs' && (
          <motion.div
            key="logs"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {logsLoading ? (
              <SkeletonList count={5} />
            ) : logsError ? (
              <ErrorState onRetry={() => refetchLogs()} />
            ) : (logs ?? []).length === 0 ? (
              <EmptyState
                icon={<Activity size={22} />}
                title={deptFilter === 'ALL' ? 'ログがありません' : `${deptFilter} のログはありません`}
                description="AI へのリクエストが発生すると、ここに記録されます。"
              />
            ) : (
              <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-sunken">
                      <tr>
                        {['日時', '部署', 'モデル', 'トークン', 'レイテンシ', '入力プレビュー'].map((h) => (
                          <th
                            key={h}
                            className="text-left px-5 py-3.5 text-micro font-semibold text-muted uppercase tracking-[0.15em]"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {(logs ?? []).map((log) => (
                        <tr key={log.id} className="hover:bg-sunken transition-colors">
                          <td className="px-5 py-3.5 text-xs text-secondary tabular whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleString('ja-JP')}
                          </td>
                          <td className="px-5 py-3.5">
                            <Badge tone={log.department} variant="soft" size="sm">
                              {log.department}
                            </Badge>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-secondary font-mono">{log.model}</td>
                          <td className="px-5 py-3.5 text-xs text-primary font-semibold tabular">{log.tokens ?? '-'}</td>
                          <td className="px-5 py-3.5 text-xs text-primary tabular">{log.latencyMs ? `${log.latencyMs}ms` : '-'}</td>
                          <td className="px-5 py-3.5 text-xs text-secondary max-w-xs truncate">
                            {log.inputText.slice(0, 60)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pagination && pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-sunken">
                    <span className="text-xs text-secondary tabular">
                      {pagination.total} 件中 {(pagination.page - 1) * pagination.limit + 1} -{' '}
                      {Math.min(pagination.page * pagination.limit, pagination.total)} 件を表示
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1}
                        icon={<ChevronLeft size={12} />}
                      >
                        前へ
                      </Button>
                      <span className="text-xs text-primary font-semibold px-3 tabular">
                        {pagination.page} / {pagination.totalPages}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                        disabled={page >= pagination.totalPages}
                        trailingIcon={<ChevronRight size={12} />}
                      >
                        次へ
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )}
          </motion.div>
        )}

        {tab === 'risks' && (
          <motion.div
            key="risks"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {risksLoading ? (
              <SkeletonList count={4} />
            ) : risksError ? (
              <ErrorState onRetry={() => refetchRisks()} />
            ) : (risks ?? []).length === 0 ? (
              <EmptyState
                icon={<CheckCircle size={22} />}
                title="リスクイベントはありません"
                description="検知されたリスクはすべて解決済みか、まだ発生していません。"
              />
            ) : (
              <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-sunken">
                      <tr>
                        {['日時', 'タイプ', '深刻度', '説明', 'ステータス', '操作'].map((h) => (
                          <th
                            key={h}
                            className="text-left px-5 py-3.5 text-micro font-semibold text-muted uppercase tracking-[0.15em]"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {(risks ?? []).map((risk) => (
                        <tr key={risk.id} className="hover:bg-sunken transition-colors">
                          <td className="px-5 py-3.5 text-xs text-secondary tabular whitespace-nowrap">
                            {new Date(risk.createdAt).toLocaleString('ja-JP')}
                          </td>
                          <td className="px-5 py-3.5 text-xs font-mono text-primary">{risk.type}</td>
                          <td className="px-5 py-3.5">
                            <span
                              className={`inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full ${
                                SEVERITY_CLASS[risk.severity] ?? 'bg-sunken border border-border text-secondary'
                              }`}
                            >
                              {risk.severity}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-secondary max-w-xs truncate">{risk.description}</td>
                          <td className="px-5 py-3.5">
                            {risk.resolved ? (
                              <span className="flex items-center gap-1.5 text-xs text-success font-medium">
                                <CheckCircle size={13} /> 解決済み
                              </span>
                            ) : (
                              <span className="flex items-center gap-1.5 text-xs text-warning font-medium">
                                <AlertCircle size={13} /> 未解決
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3.5">
                            {!risk.resolved && (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => resolveMutation.mutate(risk.id)}
                                loading={resolveMutation.isPending}
                              >
                                解決済みにする
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </motion.div>
        )}

        {tab === 'connections' && (
          <motion.div
            key="connections"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <ExternalApiSection />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
