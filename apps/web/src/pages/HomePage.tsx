import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart, Bar, ResponsiveContainer, XAxis, Tooltip, Cell } from 'recharts';
import { Plus, Play, Clock, Target, TrendingUp, Bot, ArrowRight } from 'lucide-react';
import { api } from '../services/api';
import { GlassCard } from '../components/ui/GlassCard';
import { GlassButton } from '../components/ui/GlassButton';
import { GlassBadge } from '../components/ui/GlassBadge';
import { Spinner } from '../components/ui/LoadingSkeleton';
import { CreateAgentModal } from '../components/Agents/CreateAgentModal';
import { AgentRunModal } from '../components/Agents/AgentRunModal';
import { DEPT_LABEL, DEPT_ACCENT } from '../constants/departments';
import { useAuthStore } from '../store/authStore';
import type { SavedAgent } from '../types/agent';

interface Efficiency {
  target: { percent: number; workdayMinutes: number; minutesPerDay: number };
  today: { minutesSaved: number; tasksCompleted: number; percentOfWorkday: number; percentOfTarget: number; targetReached: boolean };
  week: { minutesSaved: number; tasksCompleted: number; percentOfTarget: number };
  allTime: { minutesSaved: number; tasksCompleted: number; hoursSaved: number };
  dailyTrend: { date: string; minutesSaved: number; tasks: number }[];
  byDepartment: { department: string; minutesSaved: number; tasks: number }[];
}

function fmtMin(min: number): string {
  if (min <= 0) return '0分';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m > 0 ? `${m}分` : ''}` : `${m}分`;
}

export default function HomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [runAgent, setRunAgent] = useState<SavedAgent | null>(null);

  const { data: eff, isLoading } = useQuery({
    queryKey: ['efficiency'],
    queryFn: async () => (await api.get<{ data: Efficiency }>('/dashboard/efficiency')).data.data,
    refetchInterval: 60_000,
  });
  const { data: agents } = useQuery({
    queryKey: ['saved-agents'],
    queryFn: async () => (await api.get<{ data: SavedAgent[] }>('/agents')).data.data,
  });

  const target = eff?.target.minutesPerDay ?? 120;
  const todayPct = Math.min(100, eff?.today.percentOfTarget ?? 0);
  const trend = eff?.dailyTrend ?? [];
  const maxDept = Math.max(1, ...(eff?.byDepartment ?? []).map((d) => d.minutesSaved));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-28">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <p className="text-xs font-medium tracking-wide text-text-muted uppercase mb-1">ダッシュボード</p>
            <h1 className="text-h1 font-bold text-primary tracking-tight">
              こんにちは{user?.name ? `、${user.name}さん` : ''}
            </h1>
            <p className="text-sm text-secondary mt-1">AIが肩代わりした業務量と、1日25%削減の達成度</p>
          </div>
          <GlassButton variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            エージェント作成
          </GlassButton>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <KpiCard
                icon={<Clock size={16} />}
                label="今日の削減時間"
                value={fmtMin(eff?.today.minutesSaved ?? 0)}
                sub={`${eff?.today.tasksCompleted ?? 0}件のタスクを自動化`}
              />
              <KpiCard
                icon={<TrendingUp size={16} />}
                label="今週の削減時間"
                value={fmtMin(eff?.week.minutesSaved ?? 0)}
                sub={`${eff?.week.tasksCompleted ?? 0}件 / 達成率 ${eff?.week.percentOfTarget ?? 0}%`}
              />
              <KpiCard
                icon={<Bot size={16} />}
                label="累計の削減"
                value={`${eff?.allTime.hoursSaved ?? 0}時間`}
                sub={`通算 ${eff?.allTime.tasksCompleted ?? 0}件`}
              />
            </div>

            {/* 25% goal + trend */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
              {/* Goal */}
              <GlassCard variant="regular" padding="none" className="p-5 lg:col-span-1">
                <div className="flex items-center gap-2 mb-4">
                  <Target size={16} className="text-accent" />
                  <span className="text-sm font-semibold text-primary">1日の目標: 業務の25%削減</span>
                </div>
                <div className="flex items-center justify-center py-2">
                  <Ring percent={todayPct} />
                </div>
                <p className="text-center text-sm text-secondary mt-3">
                  目標 <span className="text-primary font-medium">{fmtMin(target)}</span> / 日
                  （8時間労働の25%）
                </p>
                {eff?.today.targetReached && (
                  <p className="text-center text-xs text-success font-medium mt-1">🎉 本日の目標達成！</p>
                )}
              </GlassCard>

              {/* Trend */}
              <GlassCard variant="regular" padding="none" className="p-5 lg:col-span-2">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-primary">直近7日の削減時間（分）</span>
                  <GlassBadge>目標 {target}分/日</GlassBadge>
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trend} margin={{ top: 6, right: 0, left: -22, bottom: 0 }}>
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d: string) => d.slice(5).replace('-', '/')}
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--surface-2)' }}
                        contentStyle={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          fontSize: 12,
                          color: 'var(--text-primary)',
                        }}
                        formatter={(v: number) => [`${v}分`, '削減']}
                      />
                      <Bar dataKey="minutesSaved" radius={[5, 5, 0, 0]} maxBarSize={34}>
                        {trend.map((d, i) => (
                          <Cell key={i} fill={d.minutesSaved >= target ? '#16A34A' : 'var(--accent)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GlassCard>
            </div>

            {/* Department breakdown */}
            {(eff?.byDepartment.length ?? 0) > 0 && (
              <GlassCard variant="regular" padding="none" className="p-5 mb-3">
                <span className="text-sm font-semibold text-primary">部署別の貢献</span>
                <div className="mt-3 space-y-2.5">
                  {eff!.byDepartment.map((d) => (
                    <div key={d.department} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-secondary flex-shrink-0">
                        {DEPT_LABEL[d.department] ?? d.department}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(d.minutesSaved / maxDept) * 100}%`,
                            background: DEPT_ACCENT[d.department] ?? 'var(--accent)',
                          }}
                        />
                      </div>
                      <span className="w-24 text-right text-xs text-primary font-medium flex-shrink-0">
                        {fmtMin(d.minutesSaved)}
                      </span>
                    </div>
                  ))}
                </div>
              </GlassCard>
            )}

            {/* Agents */}
            <div className="flex items-center justify-between mb-2 mt-6">
              <h2 className="text-sm font-semibold text-primary">あなたのエージェント</h2>
              <button
                onClick={() => navigate('/agents')}
                className="text-xs text-accent hover:underline flex items-center gap-1"
              >
                すべて見る <ArrowRight size={12} />
              </button>
            </div>
            {(agents?.length ?? 0) === 0 ? (
              <GlassCard variant="regular" padding="none" className="p-6 text-center">
                <Bot size={26} className="mx-auto mb-2 text-text-muted" />
                <p className="text-sm text-secondary mb-3">
                  まだエージェントがありません。作成すると業務を自動化できます。
                </p>
                <GlassButton variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setShowCreate(true)}>
                  最初のエージェントを作成
                </GlassButton>
              </GlassCard>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {agents!.slice(0, 6).map((a) => (
                  <GlassCard key={a.id} variant="regular" padding="none" className="p-4 flex flex-col">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-lg">{a.icon ?? '🤖'}</span>
                      <span className="text-sm font-semibold text-primary truncate">{a.name}</span>
                    </div>
                    <p className="text-xs text-secondary line-clamp-2 flex-1 mb-3">
                      {a.description || a.instructions}
                    </p>
                    <div className="flex items-center justify-between">
                      <GlassBadge>{DEPT_LABEL[a.department] ?? a.department}</GlassBadge>
                      <GlassButton size="sm" icon={<Play size={12} />} onClick={() => setRunAgent(a)} disabled={!a.enabled}>
                        実行
                      </GlassButton>
                    </div>
                  </GlassCard>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <AnimatePresence>
        {showCreate && (
          <CreateAgentModal
            onClose={() => setShowCreate(false)}
            onCreated={() => qc.invalidateQueries({ queryKey: ['saved-agents'] })}
          />
        )}
        {runAgent && (
          <AgentRunModal
            agent={runAgent}
            onClose={() => {
              setRunAgent(null);
              qc.invalidateQueries({ queryKey: ['efficiency'] });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function KpiCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
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

function Ring({ percent }: { percent: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(100, percent) / 100) * c;
  const reached = percent >= 100;
  return (
    <div className="relative" style={{ width: 132, height: 132 }}>
      <svg width={132} height={132} className="-rotate-90">
        <circle cx={66} cy={66} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={10} />
        <circle
          cx={66}
          cy={66}
          r={r}
          fill="none"
          stroke={reached ? '#16A34A' : 'var(--accent)'}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-h2 font-bold text-primary">{Math.round(percent)}%</span>
        <span className="text-[10px] text-text-muted">達成</span>
      </div>
    </div>
  );
}
