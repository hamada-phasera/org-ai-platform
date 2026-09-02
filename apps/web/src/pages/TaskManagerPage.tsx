import { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader, Plus, ClipboardList, CheckCircle2, Clock, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useStore } from '../taskmanager/store/index';
import { executeTask, refineResult } from '../taskmanager/ai/executor';
import ExecutiveDashboard from '../taskmanager/components/ExecutiveDashboard';
import TaskInput from '../taskmanager/components/TaskInput';
import AIStatusDisplay from '../taskmanager/components/AIStatusDisplay';
import EmailPanel from '../taskmanager/components/panels/EmailPanel';
import ResearchPanel from '../taskmanager/components/panels/ResearchPanel';
import CodingPanel from '../taskmanager/components/panels/CodingPanel';
import DocumentPanel from '../taskmanager/components/panels/DocumentPanel';
import SchedulePanel from '../taskmanager/components/panels/SchedulePanel';
import { AnalyticsPanel } from '../taskmanager/components/panels/AnalyticsPanel';
import { SNSPanel } from '../taskmanager/components/panels/SNSPanel';
import ProjectResultsPanel from '../taskmanager/components/panels/ProjectResultsPanel';
import TaskDashboardStats from '../components/TaskManager/TaskDashboardStats';
import PastDeliverablesSection, { DeliverablePreview } from '../components/TaskManager/PastDeliverablesSection';
import { Button } from '../components/ui/Button';
import { LiquidTabs } from '../components/motion/LiquidTabs';
import { api } from '../services/api';
import { humanizeTaskManagerError } from '../utils/humanizeLlmError';
import { parseOutputJson } from '../utils/parseTaskOutput';
import type { Task } from '../taskmanager/types/index';

async function queueTaskOnBackend(task: Task): Promise<string | null> {
  const deptMap: Record<string, string> = {
    SALES: 'SALES', MARKETING: 'MARKETING', ACCOUNTING: 'ACCOUNTING', GENERAL: 'GENERAL',
  };
  try {
    const list = await api.get<{ success: boolean; data: { id: string; title: string; status: string }[] }>('/tasks');
    const existing = list.data.data.find((t) => t.title === task.title);
    if (existing) {
      await api.patch(`/tasks/${existing.id}`, { status: 'QUEUED' });
      return existing.id;
    }
    const created = await api.post<{ success: boolean; data: { id: string } }>('/tasks', {
      title: task.title,
      department: deptMap[task.projectId ?? ''] ?? 'GENERAL',
      input: task.rawInput ?? task.title,
      status: 'QUEUED',
    });
    return created.data.data.id;
  } catch {
    return null;
  }
}

interface BackendTask {
  id: string;
  title: string;
  status: string;
  department: string;
  taskType: string | null;
  output: string | null;
  createdAt: string;
  logs: { id: string; message: string; level: string; createdAt: string }[];
}

export default function TaskManagerPage() {
  const {
    tasks, projects, executionState, executionQueue, showTaskInput,
    loadAll, addTask, updateTask, deleteTask,
    startExecution, setStep, setResult, setExecutionError,
    clearExecution, advanceQueue, clearQueue, setShowTaskInput,
  } = useStore();

  // バックエンドタスク一覧（LLMから自動生成されたもの）
  const [backendTasks, setBackendTasks] = useState<BackendTask[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<'ALL' | 'QUEUED' | 'DONE' | 'FAILED'>('ALL');

  const fetchBackendTasks = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: BackendTask[] }>('/tasks');
      if (res.data.success) setBackendTasks(res.data.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchBackendTasks();
    const interval = setInterval(fetchBackendTasks, 10000);
    return () => clearInterval(interval);
  }, [fetchBackendTasks]);

  const filteredBackendTasks = backendTasks.filter(
    (t) => taskFilter === 'ALL' || t.status === taskFilter,
  );

  useEffect(() => { loadAll(); }, []);

  const handleExecute = async (task: Task) => {
    startExecution(task.id);
    await updateTask(task.id, { status: 'in_progress' });
    const memory = projects.find((p) => p.projectId === task.projectId);
    try {
      const result = await executeTask(task, memory, (role, status) => setStep(role, status));
      setResult(result);
      await updateTask(task.id, { executionResult: result });
    } catch (e) {
      setExecutionError(humanizeTaskManagerError(e));
    }
  };

  const handleApprove = async () => {
    if (!executionState.activeTaskId) return;
    await updateTask(executionState.activeTaskId, { status: 'done' });
    clearExecution();
  };

  const handleRefinement = async (request: string) => {
    if (!executionState.result || !executionState.activeTaskId) return;
    startExecution(executionState.activeTaskId);
    try {
      const task = tasks.find((t) => t.id === executionState.activeTaskId);
      if (!task) return;
      setStep('executor', 'running');
      const refined = await refineResult(task, executionState.result, request);
      setStep('executor', 'done');
      setResult(refined);
      await updateTask(executionState.activeTaskId, { executionResult: refined });
    } catch (e) {
      setExecutionError(humanizeTaskManagerError(e));
    }
  };

  const autoExecutingRef = useRef(false);

  const handleAutoExecute = async (task: Task) => {
    startExecution(task.id);
    await updateTask(task.id, { status: 'in_progress' });
    const memory = projects.find((p) => p.projectId === task.projectId);
    try {
      const result = await executeTask(task, memory, (role, status) => setStep(role, status));
      setResult(result);
      await updateTask(task.id, { executionResult: result, status: 'done' });
      advanceQueue();
      clearExecution();
    } catch (e) {
      setExecutionError(humanizeTaskManagerError(e));
      clearQueue();
    } finally {
      autoExecutingRef.current = false;
    }
  };

  useEffect(() => {
    if (!executionQueue?.isRunning) return;
    if (executionState.activeTaskId !== null) return;
    if (autoExecutingRef.current) return;
    const { taskIds, currentIndex } = executionQueue;
    if (currentIndex >= taskIds.length) return;
    const nextTask = tasks.find((t) => t.id === taskIds[currentIndex]);
    if (!nextTask) return;
    autoExecutingRef.current = true;
    handleAutoExecute(nextTask);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionQueue, executionState.activeTaskId, tasks]);

  const [viewingTask, setViewingTask] = useState<Task | null>(null);

  const [n8nLogs, setN8nLogs] = useState<{ id: string; message: string; level: string; createdAt: string }[]>([]);
  const [n8nBackendId, setN8nBackendId] = useState<string | null>(null);
  const [n8nDone, setN8nDone] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const startLogStream = (backendId: string) => {
    if (wsRef.current) wsRef.current.close();
    const wsBase = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const wsUrl = `${wsBase}/api/tasks/${backendId}/stream`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string; log?: { id: string; message: string; level: string; createdAt: string }; status?: string };
        if (msg.type === 'log' && msg.log) {
          setN8nLogs((prev) => [...prev, msg.log!]);
        } else if (msg.type === 'status' && (msg.status === 'DONE' || msg.status === 'FAILED')) {
          setN8nDone(true);
          ws.close();
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => ws.close();
  };

  const handleApproveTask = async (task: Task) => {
    await updateTask(task.id, { status: 'ready' });
    setN8nLogs([]);
    setN8nDone(false);
    const backendId = await queueTaskOnBackend(task);
    if (backendId) {
      setN8nBackendId(backendId);
      startLogStream(backendId);
    } else {
      const readyTask = { ...task, status: 'ready' as const };
      handleExecute(readyTask);
    }
  };

  const handleRejectTask = async (task: Task) => {
    await deleteTask(task.id);
  };

  const handleEditTask = async (task: Task, newTitle: string) => {
    await updateTask(task.id, { title: newTitle });
  };

  const isExecuting = executionState.activeTaskId !== null;
  const hasResult = executionState.result !== null;
  const showAIPanel = isExecuting && !hasResult;
  const activeTask = executionState.activeTaskId ? tasks.find((t) => t.id === executionState.activeTaskId) : null;
  const isQueueMode = executionQueue?.isRunning === true;
  const queueCompleted = executionQueue !== null && !executionQueue.isRunning && executionQueue.taskIds.length > 0;
  const showN8nPanel = n8nBackendId !== null;
  const showRightPanel = showAIPanel || hasResult || isQueueMode || queueCompleted || showN8nPanel || (viewingTask !== null && viewingTask.executionResult !== null);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-elevated border-b border-border px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent-soft rounded-md flex items-center justify-center">
            <ClipboardList size={18} className="text-accent" />
          </div>
          <div>
            <h2 className="text-h3 font-bold text-primary">タスク管理</h2>
            <p className="text-xs text-muted">
              チャットは相談、ここではメール・資料など<span className="text-primary font-medium">成果物パイプライン</span>を実行します
            </p>
          </div>
        </div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setShowTaskInput(true)}>
          新しいタスク
        </Button>
      </div>

      {/* Dashboard Stats */}
      <TaskDashboardStats tasks={backendTasks} />

      {/* Past Deliverables */}
      <PastDeliverablesSection tasks={backendTasks.filter((t) => t.status === 'DONE')} />

      {/* Backend Tasks from LLM */}
      {backendTasks.length > 0 && (
        <div className="px-6 py-3 border-b border-border bg-canvas">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-primary">AI実行タスク ({backendTasks.length})</h3>
            <LiquidTabs
              id="taskmanager-status-filter"
              label="AI実行タスクを状態で絞り込み"
              size="sm"
              items={[
                { value: 'ALL', label: '全て' },
                { value: 'QUEUED', label: '実行中' },
                { value: 'DONE', label: '完了' },
                { value: 'FAILED', label: '失敗' },
              ]}
              value={taskFilter}
              onChange={setTaskFilter}
            />
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {filteredBackendTasks.map((bt) => (
              <motion.div
                key={bt.id}
                className="bg-elevated rounded-lg p-3 shadow-elev-1 border border-border cursor-pointer"
                whileHover={{ scale: 1.005 }}
                onClick={() => setExpandedTaskId(expandedTaskId === bt.id ? null : bt.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {bt.status === 'DONE' && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
                    {bt.status === 'QUEUED' && <Clock size={14} className="text-info flex-shrink-0" />}
                    {bt.status === 'FAILED' && <XCircle size={14} className="text-danger flex-shrink-0" />}
                    {bt.status === 'PENDING' && <Clock size={14} className="text-muted flex-shrink-0" />}
                    <span className="text-xs font-medium text-primary truncate">{bt.title}</span>
                    <span className="text-micro px-1.5 py-0.5 rounded-full bg-sunken text-muted flex-shrink-0">{bt.department}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-micro text-muted tabular">{new Date(bt.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                    {expandedTaskId === bt.id ? <ChevronUp size={12} className="text-ink-decorative" /> : <ChevronDown size={12} className="text-ink-decorative" />}
                  </div>
                </div>
                <AnimatePresence>
                  {expandedTaskId === bt.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      {bt.output && (() => {
                        const parsed = parseOutputJson(bt.output);
                        if (parsed && (parsed.taskType || bt.taskType)) {
                          const data = parsed.taskType ? parsed : { ...parsed, taskType: bt.taskType };
                          return (
                            <div className="mt-2 p-2 bg-sunken rounded-md">
                              <DeliverablePreview data={data} />
                            </div>
                          );
                        }
                        return (
                          <div className="mt-2 p-2 bg-sunken rounded-md text-xs text-primary whitespace-pre-wrap max-h-40 overflow-y-auto">
                            {bt.output.slice(0, 500)}{bt.output.length > 500 ? '...' : ''}
                          </div>
                        );
                      })()}
                      {bt.logs.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {bt.logs.slice(-5).map((log) => (
                            <div key={log.id} className="text-micro text-muted flex items-center gap-1">
                              <span className={log.level === 'ERROR' ? 'text-danger' : 'text-ink-decorative'}>●</span>
                              {log.message}
                            </div>
                          ))}
                        </div>
                      )}
                      {!bt.output && bt.logs.length === 0 && (
                        <div className="mt-2 text-micro text-muted">実行結果なし</div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto px-6 py-5 flex gap-5">
          {/* Dashboard */}
          <div className="flex-1 min-w-0">
            <ExecutiveDashboard
              tasks={tasks}
              onExecute={handleExecute}
              executingTaskId={executionState.activeTaskId}
              onViewResult={(task) => {
                clearExecution();
                clearQueue();
                setViewingTask(task);
              }}
              onApprove={handleApproveTask}
              onReject={handleRejectTask}
              onEdit={handleEditTask}
            />
          </div>

          {/* Right Panel */}
          <AnimatePresence>
            {showRightPanel && (
              <motion.div
                className="w-96 flex-shrink-0 space-y-4"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.3 }}
              >
                {isQueueMode && executionQueue && (
                  <div className="bg-elevated border border-accent-soft-border rounded-xl p-5 space-y-3 shadow-elev-1">
                    <div className="flex items-center gap-2" aria-live="polite">
                      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                        <Loader size={14} className="text-accent" />
                      </motion.div>
                      <span className="text-sm font-bold text-accent tabular">
                        自動実行中 ({Math.min(executionQueue.currentIndex + 1, executionQueue.taskIds.length)}/{executionQueue.taskIds.length})
                      </span>
                    </div>
                    <div className="w-full bg-sunken rounded-full h-2">
                      <motion.div
                        className="bg-accent h-2 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${(executionQueue.currentIndex / executionQueue.taskIds.length) * 100}%` }}
                        transition={{ duration: 0.4 }}
                      />
                    </div>
                  </div>
                )}

                {/* n8n background execution log panel */}
                {showN8nPanel && (
                  <div className="bg-elevated border border-border rounded-xl p-5 space-y-3 shadow-elev-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2" aria-live="polite">
                        {n8nDone ? (
                          <span className="text-xs font-bold text-success">✅ n8n 実行完了</span>
                        ) : (
                          <>
                            <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                              <Loader size={13} className="text-accent" />
                            </motion.div>
                            <span className="text-xs font-bold text-accent">n8n バックグラウンド実行中...</span>
                          </>
                        )}
                      </div>
                      <button
                        className="text-xs text-muted hover:text-secondary font-medium transition-colors"
                        onClick={() => { wsRef.current?.close(); setN8nBackendId(null); setN8nLogs([]); setN8nDone(false); }}
                      >
                        閉じる
                      </button>
                    </div>
                    <div className="space-y-1.5 max-h-64 overflow-y-auto font-mono scrollbar-hide">
                      {n8nLogs.length === 0 ? (
                        <p className="text-xs text-muted">n8n からのログを待機中...</p>
                      ) : (
                        n8nLogs.map((log) => (
                          <div
                            key={log.id}
                            className={`text-xs px-3 py-1.5 rounded-md ${log.level === 'ERROR' ? 'text-danger' : log.level === 'WARN' ? 'text-warning' : 'bg-sunken text-muted'}`}
                            style={
                              log.level === 'ERROR'
                                ? { backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)' }
                                : log.level === 'WARN'
                                  ? { backgroundColor: 'color-mix(in srgb, var(--warning) 12%, transparent)' }
                                  : undefined
                            }
                          >
                            <span className="text-muted mr-1">[{new Date(log.createdAt).toLocaleTimeString()}]</span>
                            {log.message}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {activeTask && (
                  <div className="text-sm font-bold text-primary px-1">{activeTask.title}</div>
                )}

                {(showAIPanel || hasResult) && (
                  <AIStatusDisplay
                    steps={executionState.steps}
                    error={executionState.error}
                    onRetry={
                      executionState.error && activeTask
                        ? () => {
                            void handleExecute(activeTask);
                          }
                        : undefined
                    }
                  />
                )}

                {hasResult && executionState.result && !isQueueMode && !queueCompleted && (
                  <>
                    {executionState.result.type === 'email' && executionState.result.email && (
                      <EmailPanel email={executionState.result.email} onRefinement={handleRefinement} onApprove={handleApprove} isRefining={isExecuting && !hasResult} />
                    )}
                    {executionState.result.type === 'coding' && executionState.result.coding && (
                      <CodingPanel coding={executionState.result.coding} onApprove={handleApprove} />
                    )}
                    {executionState.result.type === 'research' && executionState.result.research && (
                      <ResearchPanel research={executionState.result.research} onApprove={handleApprove} />
                    )}
                    {executionState.result.type === 'document' && executionState.result.document && (
                      <DocumentPanel document={executionState.result.document} onRefinement={handleRefinement} onApprove={handleApprove} isRefining={isExecuting && !hasResult} />
                    )}
                    {executionState.result.type === 'schedule' && executionState.result.schedule && (
                      <SchedulePanel schedule={executionState.result.schedule} onApprove={handleApprove} />
                    )}
                    {executionState.result.type === 'analytics' && executionState.result.analytics && (
                      <div className="bg-elevated border border-border rounded-xl p-5 shadow-elev-1">
                        <AnalyticsPanel result={executionState.result.analytics} />
                        <Button variant="primary" size="sm" fullWidth className="mt-3" onClick={handleApprove}>承認</Button>
                      </div>
                    )}
                    {executionState.result.type === 'sns' && executionState.result.sns && (
                      <div className="bg-elevated border border-border rounded-xl p-5 shadow-elev-1">
                        <SNSPanel result={executionState.result.sns} />
                        <Button variant="primary" size="sm" fullWidth className="mt-3" onClick={handleApprove}>承認</Button>
                      </div>
                    )}
                    <button className="text-xs text-muted hover:text-secondary font-medium w-full text-center py-1 transition-colors" onClick={clearExecution}>閉じる</button>
                  </>
                )}

                {queueCompleted && !isQueueMode && executionQueue && (
                  <ProjectResultsPanel
                    tasks={tasks.filter((t) => executionQueue.taskIds.includes(t.id))}
                    projectName={tasks.find((t) => executionQueue.taskIds.includes(t.id))?.projectId ?? ''}
                    onClose={() => { clearQueue(); clearExecution(); }}
                  />
                )}

                {viewingTask?.executionResult && !isQueueMode && !queueCompleted && !hasResult && (
                  <>
                    <div className="text-sm font-bold text-primary px-1">{viewingTask.title}</div>
                    {viewingTask.executionResult.type === 'email' && viewingTask.executionResult.email && (
                      <EmailPanel email={viewingTask.executionResult.email} onRefinement={() => {}} onApprove={() => setViewingTask(null)} isRefining={false} />
                    )}
                    {viewingTask.executionResult.type === 'coding' && viewingTask.executionResult.coding && (
                      <CodingPanel coding={viewingTask.executionResult.coding} onApprove={() => setViewingTask(null)} />
                    )}
                    {viewingTask.executionResult.type === 'research' && viewingTask.executionResult.research && (
                      <ResearchPanel research={viewingTask.executionResult.research} onApprove={() => setViewingTask(null)} />
                    )}
                    {viewingTask.executionResult.type === 'document' && viewingTask.executionResult.document && (
                      <DocumentPanel document={viewingTask.executionResult.document} onRefinement={() => {}} onApprove={() => setViewingTask(null)} isRefining={false} />
                    )}
                    {viewingTask.executionResult.type === 'schedule' && viewingTask.executionResult.schedule && (
                      <SchedulePanel schedule={viewingTask.executionResult.schedule} onApprove={() => setViewingTask(null)} />
                    )}
                    {viewingTask.executionResult.type === 'analytics' && viewingTask.executionResult.analytics && (
                      <div className="bg-elevated border border-border rounded-xl p-5 shadow-elev-1">
                        <AnalyticsPanel result={viewingTask.executionResult.analytics} />
                      </div>
                    )}
                    {viewingTask.executionResult.type === 'sns' && viewingTask.executionResult.sns && (
                      <div className="bg-elevated border border-border rounded-xl p-5 shadow-elev-1">
                        <SNSPanel result={viewingTask.executionResult.sns} />
                      </div>
                    )}
                    <button className="text-xs text-muted hover:text-secondary font-medium w-full text-center py-1 transition-colors" onClick={() => setViewingTask(null)}>閉じる</button>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Task input modal */}
      <AnimatePresence>
        {showTaskInput && (
          <TaskInput onAdd={addTask} onClose={() => setShowTaskInput(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
