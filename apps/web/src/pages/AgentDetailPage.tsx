import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Bot,
  MessageCircle,
  Play,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ScheduledTask } from '@org-ai/shared-types';
import { api } from '../services/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Spinner,
} from '../components/ui';
import { LiquidTabs } from '../components/motion/LiquidTabs';
import { WorkflowCanvas } from '../components/workflow/WorkflowCanvas';
import type { CapabilityMeta } from '../components/workflow/stepsToFlow';
import { useAgentRun } from '../hooks/useAgentRun';
import { DEPT_LABEL } from '../constants/departments';
import { AGENT_N8N_STATUS_LABEL, type SavedAgent } from '../types/agent';
import { describeSchedule, formatNextRun, nextRunAt } from '../utils/schedule';
import { useChatStore } from '../store/chatStore';

/**
 * エージェント詳細。
 *
 * ワークフローの可視化は**読み取り専用**で、手順の追加・削除・並べ替えはすべてチャットで行う
 * （キャンバスを編集画面にするとチャットと役割がぶつかるため）。ここでは
 * 「何が起きるか」「いま何が動いているか」を見せることに徹する。
 */

type View = 'workflow' | 'history' | 'settings';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  agentId: string | null;
  output: string | null;
  lastError: string | null;
  createdAt: string;
}

interface CapabilityRow {
  name: string;
  displayName: string;
  description?: string;
  kind?: string | null;
  /** カスタム HTTP ノードの送信方式。GET かどうかで承認要否のバッジが変わる */
  httpMethod?: string | null;
}

const TASK_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  QUEUED: { label: '待機', className: 'bg-sunken text-text-muted' },
  RUNNING: { label: '実行中', className: 'bg-accent-soft text-accent' },
  DONE: { label: '完了', className: 'bg-success/10 text-success' },
  FAILED: { label: '失敗', className: 'bg-danger/10 text-danger' },
  PENDING_APPROVAL: { label: '承認待ち', className: 'bg-warning/10 text-warning' },
  REJECTED: { label: '却下', className: 'bg-sunken text-ink-decorative' },
};

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setEditingAgent = useChatStore((s) => s.setEditingAgent);
  const setAutoCreateSession = useChatStore((s) => s.setAutoCreateSession);

  /**
   * チャットを編集モードで開く。
   *
   * ⚠️ 編集対象を location.state で渡してはいけない。/chat でセッションが作られると
   *    /chat/:id へ遷移し、その時点で state が落ちて編集コンテキストが消える。
   *    ストアに積んでおけば遷移を跨いで生き残る。
   *    あわせてセッションの自動作成を頼み、「開いたのに何も打てない」状態を作らない。
   */
  const startEditingInChat = (id: string, name: string) => {
    setEditingAgent({ id, name });
    setAutoCreateSession(true);
    navigate('/chat');
  };
  const qc = useQueryClient();
  const [view, setView] = useState<View>('workflow');
  const [input, setInput] = useState('');

  const agentQ = useQuery({
    queryKey: ['agent', id],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: SavedAgent }>(`/agents/${id}`);
      return res.data.data;
    },
    enabled: !!id,
  });

  /* ノードの表示名は capability レジストリから引く。設定>連携 と同じキャッシュを共有する */
  const capsQ = useQuery({
    queryKey: ['capabilities'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: CapabilityRow[] }>('/capabilities');
      return res.data.data;
    },
  });

  const tasksQ = useQuery({
    queryKey: ['tasks', 'agent'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: TaskRow[] }>('/tasks?taskType=agent');
      return res.data.data;
    },
  });

  const schedulesQ = useQuery({
    queryKey: ['scheduled-tasks'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ScheduledTask[] }>('/scheduled-tasks');
      return res.data.data;
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saved-agents'] });
      qc.invalidateQueries({ queryKey: ['scheduled-tasks'] });
      navigate('/agents');
    },
  });

  const { status, busy, logs, output, error, runState, run } = useAgentRun(id);

  const agent = agentQ.data;
  const capabilities: CapabilityMeta[] = useMemo(
    () =>
      (capsQ.data ?? []).map((c) => ({
        name: c.name,
        displayName: c.displayName,
        kind: c.kind,
        // ⚠️ これを落とすと GET 専用のカスタムノードにも「送信前に承認」が出る
        //    （実際には承認ゲートは走らないので、画面だけが嘘をつく）
        httpMethod: c.httpMethod ?? null,
      })),
    [capsQ.data],
  );
  const history = useMemo(
    () => (tasksQ.data ?? []).filter((t) => t.agentId === id),
    [tasksQ.data, id],
  );
  const schedule = useMemo(
    () => (schedulesQ.data ?? []).find((s) => s.agentId === id),
    [schedulesQ.data, id],
  );

  if (agentQ.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  if (agentQ.isError || !agent) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <ErrorState
          title="エージェントを読み込めませんでした"
          description="削除されたか、権限が無い可能性があります。"
          onRetry={() => agentQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-28 sm:px-6">
      <Link
        to="/agents"
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-secondary hover:text-primary"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        エージェント一覧
      </Link>

      <PageHeader
        eyebrow="AGENT"
        title={`${agent.icon ?? '🤖'} ${agent.name}`}
        description={agent.description || agent.instructions}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageCircle size={13} />}
              onClick={() =>
                startEditingInChat(agent.id, agent.name)
              }
            >
              チャットで修正
            </Button>
            <Button
              size="sm"
              icon={<Play size={13} />}
              loading={busy}
              disabled={!agent.enabled || busy}
              onClick={() => void run(input)}
            >
              実行する
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge>{DEPT_LABEL[agent.department] ?? agent.department}</Badge>
        <Badge>{AGENT_N8N_STATUS_LABEL[agent.n8nStatus]}</Badge>
        {agent.trigger === 'SCHEDULED' &&
          (schedule ? (
            <span className="tabular text-micro text-text-muted">
              {describeSchedule(schedule)}
              {schedule.enabled && nextRunAt(schedule)
                ? ` · 次回 ${formatNextRun(nextRunAt(schedule)!)}`
                : ' （停止中）'}
            </span>
          ) : (
            <span className="text-micro text-warning">定期実行が未設定です</span>
          ))}
        {!agent.enabled && <Badge tone="danger">無効</Badge>}
      </div>

      <div className="mb-5">
        <LiquidTabs<View>
          id="agent-detail"
          size="sm"
          label="エージェント詳細の表示切り替え"
          items={[
            { value: 'workflow', label: 'ワークフロー' },
            { value: 'history', label: '実行履歴' },
            { value: 'settings', label: '設定' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      <AnimatePresence mode="wait">
        {view === 'workflow' && (
          <motion.div
            key="workflow"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="agent-run-input" className="mb-1 block text-xs text-secondary">
                  実行時の入力（任意。空なら指示文をそのまま使います）
                </label>
                <Input
                  id="agent-run-input"
                  size="sm"
                  placeholder="例: 今日の分でお願い"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>

            <WorkflowCanvas steps={agent.steps} capabilities={capabilities} runState={runState} />

            {status === 'awaiting_approval' && (
              <Card variant="regular" padding="md" radius="2xl" className="mt-3">
                <p className="flex items-center gap-1.5 text-sm font-bold text-warning">
                  <ShieldCheck size={14} aria-hidden="true" />
                  送信前の承認待ちです
                </p>
                <p className="mt-1 text-xs text-secondary">
                  外部に送信する手順の手前で止まっています。内容を確認して承認すると続きが実行されます。
                </p>
                <Link
                  to="/inbox"
                  className="mt-2 inline-block text-xs font-bold text-action hover:underline"
                >
                  受信ページで承認する →
                </Link>
              </Card>
            )}

            {error && (
              <p className="mt-3 text-xs text-danger" aria-live="polite">
                {error}
              </p>
            )}

            {output && (
              <Card variant="regular" padding="md" radius="2xl" className="mt-3">
                <p className="mb-1.5 text-micro font-bold uppercase tracking-[0.07em] text-text-muted">
                  実行結果
                </p>
                <p className="whitespace-pre-wrap text-sm text-secondary">{output}</p>
              </Card>
            )}

            {logs.length > 0 && (
              <Card variant="regular" padding="md" radius="2xl" className="mt-3">
                <p className="mb-1.5 text-micro font-bold uppercase tracking-[0.07em] text-text-muted">
                  実行ログ
                </p>
                <ul className="space-y-1">
                  {logs.map((l, i) => (
                    <li key={i} className="tabular text-micro text-secondary">
                      {new Date(l.createdAt).toLocaleTimeString('ja-JP')} · {l.message}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </motion.div>
        )}

        {view === 'history' && (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {tasksQ.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : history.length === 0 ? (
              <EmptyState
                icon={<Bot size={22} />}
                title="まだ実行されていません"
                description="「実行する」を押すか、定期実行を設定すると、ここに履歴が並びます。"
              />
            ) : (
              <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-sunken">
                      <tr>
                        <th className="px-5 py-3.5 text-left text-micro font-semibold uppercase tracking-[0.15em] text-muted">
                          実行日時
                        </th>
                        <th className="px-5 py-3.5 text-left text-micro font-semibold uppercase tracking-[0.15em] text-muted">
                          状態
                        </th>
                        <th className="px-5 py-3.5 text-left text-micro font-semibold uppercase tracking-[0.15em] text-muted">
                          結果
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {history.map((t) => {
                        const s = TASK_STATUS_LABEL[t.status] ?? {
                          label: t.status,
                          className: 'bg-sunken text-text-muted',
                        };
                        return (
                          <tr key={t.id} className="transition-colors hover:bg-sunken">
                            <td className="tabular px-5 py-3.5 text-xs text-secondary">
                              {new Date(t.createdAt).toLocaleString('ja-JP')}
                            </td>
                            <td className="px-5 py-3.5">
                              <span
                                className={`rounded-full px-2.5 py-1 text-micro font-bold ${s.className}`}
                              >
                                {s.label}
                              </span>
                            </td>
                            <td className="max-w-md truncate px-5 py-3.5 text-xs text-secondary">
                              {t.lastError || t.output || '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </motion.div>
        )}

        {view === 'settings' && (
          <motion.div
            key="settings"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            <Card variant="regular" padding="lg" radius="2xl">
              <h2 className="mb-2 text-body font-semibold text-primary">指示（システムプロンプト）</h2>
              <p className="whitespace-pre-wrap text-sm text-secondary">{agent.instructions}</p>
              <p className="mt-3 text-micro text-text-muted">
                内容の変更は「チャットで修正」から行えます。
              </p>
            </Card>

            <Card variant="regular" padding="lg" radius="2xl">
              <h2 className="mb-2 text-body font-semibold text-primary">このエージェントを削除</h2>
              <p className="mb-3 text-sm text-secondary">
                実行履歴は残ります。定期実行の設定は一緒に削除されます。
              </p>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={12} />}
                loading={deleteMut.isPending}
                onClick={() => {
                  if (confirm(`「${agent.name}」を削除しますか？`)) deleteMut.mutate();
                }}
              >
                削除する
              </Button>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
