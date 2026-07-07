import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Bot, ClipboardList } from 'lucide-react';
import { api } from '../services/api';
import { GlassCard } from '../components/ui/GlassCard';
import { GlassBadge } from '../components/ui/GlassBadge';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/LoadingSkeleton';
import { DEPT_LABEL, DEPT_ACCENT } from '../constants/departments';
import { AGENT_N8N_STATUS_LABEL, type SavedAgent } from '../types/agent';

const DEPT = 'SALES';

/** 営業部のタスク（バックエンド Task モデルに対応。共有型が未整備のためローカル定義）。 */
interface SalesTask {
  id: string;
  title: string;
  status: string;
  department: string;
  taskType: string | null;
  output: string | null;
  createdAt: string;
}

/** Task.status → 表示ラベル（TaskStatus: PENDING/RUNNING/DONE/FAILED）。 */
const TASK_STATUS_LABEL: Record<string, string> = {
  PENDING: '⚪ 待機',
  RUNNING: '🔵 実行中',
  DONE: '🟢 完了',
  FAILED: '🔴 失敗',
};

async function fetchSalesAgents(): Promise<SavedAgent[]> {
  const res = await api.get<{ success: boolean; data: SavedAgent[] }>('/agents');
  // サーバ側に department フィルタが無いためクライアントで絞り込む。
  return res.data.data.filter((a) => a.department === DEPT);
}

async function fetchSalesTasks(): Promise<SalesTask[]> {
  const res = await api.get<{ success: boolean; data: SalesTask[] }>('/tasks');
  return res.data.data.filter((t) => t.department === DEPT);
}

/**
 * 営業部ダッシュボード（R1・読み取り専用）。
 * 営業部（department="SALES"）に属するエージェントとタスクを一覧表示する。
 * ルーティングへの登録（App.tsx の <Route>）は統合フェーズ(B)で行う。
 */
export default function SalesPage() {
  const agentsQ = useQuery({ queryKey: ['sales-agents'], queryFn: fetchSalesAgents });
  const tasksQ = useQuery({ queryKey: ['sales-tasks'], queryFn: fetchSalesTasks });

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-28">
      <PageHeader
        eyebrow="SALES"
        title="営業部"
        description="営業部のAIエージェントとタスクの状況を確認できます。"
        actions={<GlassBadge>{DEPT_LABEL[DEPT]}</GlassBadge>}
      />

      {/* ── 営業エージェント ───────────────────────── */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Bot size={16} style={{ color: DEPT_ACCENT[DEPT] }} />
          <h2 className="text-sm font-semibold text-primary">営業エージェント</h2>
          {agentsQ.data && (
            <span className="text-[11px] text-muted">{agentsQ.data.length}件</span>
          )}
        </div>

        {agentsQ.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : agentsQ.isError ? (
          <EmptyState
            icon={<Bot size={28} />}
            title="読み込みに失敗しました"
            description="時間をおいて再度お試しください。"
          />
        ) : !agentsQ.data || agentsQ.data.length === 0 ? (
          <EmptyState
            icon={<Bot size={28} />}
            title="営業部のエージェントはまだありません"
            description="「業務効率化エージェント」から department を営業部にして作成すると、ここに表示されます。"
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agentsQ.data.map((agent) => (
              <motion.div key={agent.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <GlassCard variant="regular" className="p-4 h-full flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xl flex-shrink-0">{agent.icon ?? '🤝'}</span>
                      <h3 className="text-sm font-semibold text-primary truncate">{agent.name}</h3>
                    </div>
                    <GlassBadge>
                      {agent.n8nStatus === 'ACTIVE' ? '🟢' : '🟡'} {AGENT_N8N_STATUS_LABEL[agent.n8nStatus]}
                    </GlassBadge>
                  </div>
                  <p className="text-xs text-secondary line-clamp-2 mb-2 flex-1">
                    {agent.description || agent.instructions}
                  </p>
                  <div className="flex items-center gap-2 mt-auto">
                    <GlassBadge>{DEPT_LABEL[agent.department] ?? agent.department}</GlassBadge>
                    <span className="text-[10px] text-muted">
                      {agent.trigger === 'SCHEDULED' ? '定期実行' : '手動実行'}
                    </span>
                    <span className="text-[10px] text-muted ml-auto">
                      {agent.enabled ? '有効' : '停止中'}
                    </span>
                  </div>
                </GlassCard>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* ── 営業タスク ────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <ClipboardList size={16} style={{ color: DEPT_ACCENT[DEPT] }} />
          <h2 className="text-sm font-semibold text-primary">営業タスク</h2>
          {tasksQ.data && <span className="text-[11px] text-muted">{tasksQ.data.length}件</span>}
        </div>

        {tasksQ.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : tasksQ.isError ? (
          <EmptyState
            icon={<Briefcase size={28} />}
            title="読み込みに失敗しました"
            description="時間をおいて再度お試しください。"
          />
        ) : !tasksQ.data || tasksQ.data.length === 0 ? (
          <EmptyState
            icon={<Briefcase size={28} />}
            title="営業部のタスクはまだありません"
            description="営業エージェントを実行すると、ここにタスクの履歴が表示されます。"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {tasksQ.data.map((task) => (
              <motion.div key={task.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <GlassCard variant="regular" className="p-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-primary truncate">{task.title}</h3>
                    {task.output && (
                      <p className="text-xs text-secondary line-clamp-1">{task.output}</p>
                    )}
                  </div>
                  <GlassBadge>{TASK_STATUS_LABEL[task.status] ?? task.status}</GlassBadge>
                </GlassCard>
              </motion.div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
