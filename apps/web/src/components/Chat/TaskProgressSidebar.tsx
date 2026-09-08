import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { PanelRightClose, ExternalLink } from 'lucide-react';
import { api } from '../../services/api';
import { TaskProgressItem } from './TaskProgressItem';
import type { TaskProgressItemData } from './TaskProgressItem';

interface InlineTask {
  id: string;
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';
  afterMessageId: string;
  department: string;
  logs: Array<{ message: string; level: string; createdAt: string }>;
  output?: string;
}

interface BackendTask {
  id: string;
  title: string;
  status: string;
  department: string;
  output: string | null;
  createdAt: string;
  logs: { id: string; message: string; level: string; createdAt: string }[];
}

interface TaskProgressSidebarProps {
  open: boolean;
  onClose: () => void;
  inlineTasks: InlineTask[];
}

function mapBackendStatus(status: string): TaskProgressItemData['status'] {
  switch (status) {
    case 'DONE': return 'done';
    case 'FAILED': return 'failed';
    case 'QUEUED':
    case 'IN_PROGRESS':
    case 'RUNNING': return 'executing';
    case 'PENDING': return 'pending';
    default: return 'pending';
  }
}

export function TaskProgressSidebar({ open, onClose, inlineTasks }: TaskProgressSidebarProps) {
  const [tab, setTab] = useState<'session' | 'all'>('session');
  const [orgTasks, setOrgTasks] = useState<BackendTask[]>([]);

  const fetchOrgTasks = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: BackendTask[] }>('/tasks');
      if (res.data.success) setOrgTasks(res.data.data);
    } catch { /* ignore */ }
  }, []);

  // Fetch org tasks on mount and poll every 10s
  useEffect(() => {
    if (!open) return;
    fetchOrgTasks();
    const interval = setInterval(fetchOrgTasks, 10000);
    return () => clearInterval(interval);
  }, [open, fetchOrgTasks]);

  // Convert inline tasks to common format
  const sessionItems: TaskProgressItemData[] = useMemo(() =>
    inlineTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      department: t.department,
      logs: t.logs,
      output: t.output,
      createdAt: new Date().toISOString(),
    })),
  [inlineTasks]);

  // Convert org tasks to common format, excluding those already in session
  const orgItems: TaskProgressItemData[] = useMemo(() => {
    const sessionIds = new Set(inlineTasks.map((t) => t.id));
    return orgTasks
      .filter((t) => !sessionIds.has(t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: mapBackendStatus(t.status),
        department: t.department,
        logs: t.logs.map((l) => ({ message: l.message, level: l.level, createdAt: l.createdAt })),
        output: t.output ?? undefined,
        createdAt: t.createdAt,
      }));
  }, [orgTasks, inlineTasks]);

  const allItems = useMemo(() => [...sessionItems, ...orgItems], [sessionItems, orgItems]);
  const displayItems = tab === 'session' ? sessionItems : allItems;

  const executingCount = allItems.filter((t) => t.status === 'executing').length;

  return (
    <>
      {/* Overlay for mobile */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute inset-0 bg-black/20 z-20 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
        )}
      </AnimatePresence>

      {/* Sidebar panel */}
      <AnimatePresence>
        {open && (
          <motion.aside
            className="absolute lg:relative right-0 z-30 lg:z-0 w-80 h-full flex-shrink-0 flex flex-col border-l border-border bg-elevated"
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            {/* Header */}
            <div className="p-4 flex items-center gap-2 border-b border-border">
              <div className="flex-1 flex items-center gap-2">
                <span className="text-sm font-bold text-primary">タスク進捗</span>
                {executingCount > 0 && (
                  <span className="text-micro bg-accent text-white px-1.5 py-0.5 rounded-full font-bold min-w-[18px] text-center">
                    {executingCount}
                  </span>
                )}
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-xl bg-elevated/60 flex items-center justify-center text-text-muted hover:text-primary transition-colors"
              >
                <PanelRightClose size={15} />
              </button>
            </div>

            {/* Tab filter */}
            <div className="px-4 py-2.5">
              <div className="flex gap-1">
                <button
                  onClick={() => setTab('session')}
                  className={`text-micro px-3 py-1.5 rounded-full transition-all font-medium ${
                    tab === 'session'
                      ? 'bg-accent text-white'
                      : 'bg-elevated/60 text-text-muted hover:bg-elevated'
                  }`}
                >
                  セッション ({sessionItems.length})
                </button>
                <button
                  onClick={() => setTab('all')}
                  className={`text-micro px-3 py-1.5 rounded-full transition-all font-medium ${
                    tab === 'all'
                      ? 'bg-accent text-white'
                      : 'bg-elevated/60 text-text-muted hover:bg-elevated'
                  }`}
                >
                  全タスク ({allItems.length})
                </button>
              </div>
            </div>

            {/* Task list */}
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2 scrollbar-hide">
              {displayItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-xs text-text-muted">
                    {tab === 'session' ? 'このセッションにタスクはありません' : 'タスクはありません'}
                  </p>
                </div>
              ) : (
                displayItems.map((task) => (
                  <TaskProgressItem key={task.id} task={task} />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-border">
              <Link
                to="/tasks"
                className="flex items-center justify-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors font-medium py-2"
              >
                全タスク管理 <ExternalLink size={11} />
              </Link>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
