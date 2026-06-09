import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2, Bot } from 'lucide-react';
import { api } from '../services/api';
import { GlassCard } from '../components/ui/GlassCard';
import { GlassButton } from '../components/ui/GlassButton';
import { GlassBadge } from '../components/ui/GlassBadge';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/LoadingSkeleton';
import { CreateAgentModal } from '../components/Agents/CreateAgentModal';
import { AgentRunModal } from '../components/Agents/AgentRunModal';
import { DEPT_LABEL } from '../constants/departments';
import { AGENT_N8N_STATUS_LABEL, type SavedAgent } from '../types/agent';

async function fetchAgents(): Promise<SavedAgent[]> {
  const res = await api.get<{ success: boolean; data: SavedAgent[] }>('/agents');
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

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-agents'] }),
  });

  const handleCreated = () => qc.invalidateQueries({ queryKey: ['saved-agents'] });

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-28">
      <PageHeader
        eyebrow="AGENTS"
        title="業務効率化エージェント"
        description="作成したエージェントを選んで、いつでも再実行できます。"
        actions={
          <GlassButton variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            エージェントを作成
          </GlassButton>
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
              <GlassCard variant="regular" className="p-4 h-full flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xl flex-shrink-0">{agent.icon ?? '🤖'}</span>
                    <h3 className="text-sm font-semibold text-primary truncate">{agent.name}</h3>
                  </div>
                  <GlassBadge>{agent.n8nStatus === 'ACTIVE' ? '🟢' : '🟡'} {AGENT_N8N_STATUS_LABEL[agent.n8nStatus]}</GlassBadge>
                </div>
                <p className="text-xs text-secondary line-clamp-2 mb-2 flex-1">
                  {agent.description || agent.instructions}
                </p>
                <div className="flex items-center gap-2 mb-3">
                  <GlassBadge>{DEPT_LABEL[agent.department] ?? agent.department}</GlassBadge>
                  <span className="text-[10px] text-muted">
                    {agent.trigger === 'SCHEDULED' ? '定期実行' : '手動実行'}
                  </span>
                </div>
                <div className="flex gap-2 mt-auto">
                  <GlassButton
                    variant="primary"
                    size="sm"
                    icon={<Play size={12} />}
                    onClick={() => setRunAgent(agent)}
                    disabled={!agent.enabled}
                  >
                    実行
                  </GlassButton>
                  <GlassButton
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
              </GlassCard>
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
