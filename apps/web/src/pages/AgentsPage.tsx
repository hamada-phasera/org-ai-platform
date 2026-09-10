import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2, Bot } from 'lucide-react';
import { api } from '../services/api';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/LoadingSkeleton';
import { CreateAgentModal } from '../components/Agents/CreateAgentModal';
import { AgentRunModal } from '../components/Agents/AgentRunModal';
import { DEPT_LABEL } from '../constants/departments';
import { AGENT_N8N_STATUS_LABEL, type SavedAgent } from '../types/agent';
import type { ScheduledTask } from '@org-ai/shared-types';
import { describeSchedule, formatNextRun, nextRunAt } from '../utils/schedule';

async function fetchAgents(): Promise<SavedAgent[]> {
  const res = await api.get<{ success: boolean; data: SavedAgent[] }>('/agents');
  return res.data.data;
}

async function fetchScheduledTasks(): Promise<ScheduledTask[]> {
  const res = await api.get<{ success: boolean; data: ScheduledTask[] }>('/scheduled-tasks');
  return res.data.data;
}

/** 作成済みの業務効率化エージェントを一覧・選択し、再実行できるページ。 */
export default function AgentsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [runAgent, setRunAgent] = useState<SavedAgent | null>(null);

  const { data: agents, isLoading, isError } = useQuery({
    queryKey: ['saved-agents'],
    queryFn: fetchAgents,
  });

  /* 定期実行の設定はエージェントとは別テーブル。agentId で引き当てて次回実行を表示する */
  const { data: schedules } = useQuery({
    queryKey: ['scheduled-tasks'],
    queryFn: fetchScheduledTasks,
  });
  const scheduleByAgent = new Map<string, ScheduledTask>();
  for (const s of schedules ?? []) {
    if (s.agentId) scheduleByAgent.set(s.agentId, s);
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saved-agents'] });
      qc.invalidateQueries({ queryKey: ['scheduled-tasks'] });
    },
  });

  const handleCreated = () => {
    qc.invalidateQueries({ queryKey: ['saved-agents'] });
    qc.invalidateQueries({ queryKey: ['scheduled-tasks'] });
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-28">
      <PageHeader
        eyebrow="AGENTS"
        title="業務効率化エージェント"
        description="作成したエージェントを選んで、いつでも再実行できます。"
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            エージェントを作成
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : isError ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="読み込みに失敗しました"
          description="時間をおいて再度お試しください。"
        />
      ) : !agents || agents.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="まだエージェントがありません"
          description="「エージェントを作成」から、繰り返し使える業務効率化エージェントを作りましょう。"
          action={{
            label: '最初のエージェントを作成',
            onClick: () => setShowCreate(true),
            icon: <Plus size={14} />,
          }}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => (
            <motion.div key={agent.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <Card variant="regular" padding="none" className="p-4 h-full flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xl flex-shrink-0">{agent.icon ?? '🤖'}</span>
                    <h3 className="text-sm font-semibold text-primary truncate">{agent.name}</h3>
                  </div>
                  <Badge>{agent.n8nStatus === 'ACTIVE' ? '🟢' : '🟡'} {AGENT_N8N_STATUS_LABEL[agent.n8nStatus]}</Badge>
                </div>
                <p className="text-xs text-secondary line-clamp-2 mb-2 flex-1">
                  {agent.description || agent.instructions}
                </p>
                <div className="flex items-center gap-2 mb-3">
                  <Badge>{DEPT_LABEL[agent.department] ?? agent.department}</Badge>
                  <span className="text-[10px] text-muted">
                    {agent.trigger === 'SCHEDULED' ? '定期実行' : '手動実行'}
                  </span>
                </div>
                {agent.trigger === 'SCHEDULED' && (
                  <ScheduleLine schedule={scheduleByAgent.get(agent.id)} />
                )}
                <div className="flex gap-2 mt-auto">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Play size={12} />}
                    onClick={() => setRunAgent(agent)}
                    disabled={!agent.enabled}
                  >
                    実行
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    onClick={() => {
                      if (confirm(`「${agent.name}」を削除しますか？`)) deleteMutation.mutate(agent.id);
                    }}
                    loading={deleteMutation.isPending && deleteMutation.variables === agent.id}
                    aria-label="削除"
                  />
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {showCreate && (
          <CreateAgentModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />
        )}
        {runAgent && <AgentRunModal agent={runAgent} onClose={() => setRunAgent(null)} />}
      </AnimatePresence>
    </div>
  );
}

/** 定期実行エージェントの「いつ動くか」を 1 行で示す。未設定なら警告する。 */
function ScheduleLine({ schedule }: { schedule?: ScheduledTask }) {
  if (!schedule) {
    return (
      <p className="mb-3 text-[10px] text-warning">
        スケジュール未設定（このままでは自動実行されません）
      </p>
    );
  }
  if (!schedule.enabled) {
    return <p className="mb-3 text-[10px] text-muted">{describeSchedule(schedule)}（停止中）</p>;
  }
  const next = nextRunAt(schedule);
  return (
    <p className="mb-3 text-[10px] text-muted tabular">
      {describeSchedule(schedule)}
      {next && ` · 次回 ${formatNextRun(next)}`}
    </p>
  );
}
