import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, Clock, AlertTriangle, BarChart3 } from 'lucide-react';
import { DEPT_ACCENT, DEPT_LABEL } from '../../constants/departments';

interface BackendTask {
  id: string;
  title: string;
  status: string;
  department: string;
  output: string | null;
  createdAt: string;
}

interface TaskDashboardStatsProps {
  tasks: BackendTask[];
}

const statCardClass = 'bg-elevated border border-border rounded-xl p-4 shadow-elev-1';

export default function TaskDashboardStats({ tasks }: TaskDashboardStatsProps) {
  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === 'DONE').length;
    const executing = tasks.filter((t) => ['QUEUED', 'IN_PROGRESS', 'RUNNING'].includes(t.status)).length;
    const failed = tasks.filter((t) => t.status === 'FAILED').length;
    const donePercent = total > 0 ? Math.round((done / total) * 100) : 0;

    const byDept: Record<string, number> = {};
    for (const t of tasks) {
      byDept[t.department] = (byDept[t.department] ?? 0) + 1;
    }
    const maxDeptCount = Math.max(...Object.values(byDept), 1);

    return { total, done, executing, failed, donePercent, byDept, maxDeptCount };
  }, [tasks]);

  if (tasks.length === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-6 py-4 border-b border-border bg-canvas">
      {/* Total */}
      <div className={statCardClass}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-accent-soft rounded-md flex items-center justify-center">
            <BarChart3 size={14} className="text-accent" />
          </div>
          <span className="text-micro text-muted font-medium">総タスク</span>
        </div>
        <motion.p
          className="text-h2 font-bold text-primary tabular"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {stats.total}
        </motion.p>
      </div>

      {/* Completed */}
      <div className={statCardClass}>
        <div className="flex items-center gap-2 mb-2">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center"
            style={{ backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
          >
            <CheckCircle2 size={14} className="text-success" />
          </div>
          <span className="text-micro text-muted font-medium">完了</span>
        </div>
        <div className="flex items-baseline gap-2">
          <motion.p
            className="text-h2 font-bold text-primary tabular"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.05 }}
          >
            {stats.done}
          </motion.p>
          <span className="text-xs text-success font-semibold tabular">{stats.donePercent}%</span>
        </div>
      </div>

      {/* Executing */}
      <div className={statCardClass}>
        <div className="flex items-center gap-2 mb-2">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center"
            style={{ backgroundColor: 'color-mix(in srgb, var(--info) 12%, transparent)' }}
          >
            <Clock size={14} className="text-info" />
          </div>
          <span className="text-micro text-muted font-medium">実行中</span>
        </div>
        <motion.p
          className="text-h2 font-bold text-primary tabular"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          {stats.executing}
        </motion.p>
      </div>

      {/* Department breakdown */}
      <div className={statCardClass}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-micro text-muted font-medium">部署別</span>
          {stats.failed > 0 && (
            <span className="flex items-center gap-0.5 text-micro text-danger font-medium tabular">
              <AlertTriangle size={10} /> {stats.failed}失敗
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          {Object.entries(stats.byDept)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([dept, count]) => (
              <div key={dept} className="flex items-center gap-2">
                <span className="text-micro text-muted w-12 truncate">
                  {DEPT_LABEL[dept] ?? dept}
                </span>
                <div className="flex-1 h-2 bg-sunken rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: DEPT_ACCENT[dept] ?? DEPT_ACCENT.GENERAL }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(count / stats.maxDeptCount) * 100}%` }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                  />
                </div>
                <span className="text-micro font-semibold text-primary w-5 text-right tabular">{count}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
