import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { MessageSquare, Zap, Clock, AlertTriangle, ClipboardList, ArrowRight } from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import SetupChecklistBanner from '../components/SetupChecklistBanner';
import {
  GlassCard,
  GlassBadge,
  PageHeader,
  SkeletonCard,
  ErrorState,
  EmptyState,
} from '../components/ui';
import { DEPT_LABEL } from '../constants/departments';

interface Stats {
  totalRequests: number;
  totalTokens: number;
  riskEvents: Record<string, number>;
  topDepartments: { department: string; count: number }[];
  avgLatencyMs: number;
}

const DEPARTMENTS = [
  { key: 'SALES', label: '営業部', desc: '提案書・メール・見積もり作成', icon: '🤝' },
  { key: 'MARKETING', label: 'マーケ部', desc: 'SNS投稿・広告・コピーライティング', icon: '📣' },
  { key: 'ACCOUNTING', label: '経理部', desc: '請求書・経費・予算・税務', icon: '📊' },
  { key: 'GENERAL', label: '総合AI', desc: '何でも聞ける汎用アシスタント', icon: '✨' },
] as const;

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { setPendingDepartment } = useChatStore();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['governance-stats'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: Stats }>('/governance/stats');
      return res.data.data;
    },
    enabled: user?.role === 'OWNER',
  });

  const totalRisks = data ? Object.values(data.riskEvents).reduce((a, b) => a + b, 0) : 0;

  const handleDeptClick = async (deptKey: string) => {
    setPendingDepartment(deptKey);
    try {
      const res = await api.post<{ success: boolean; data: { id: string } }>('/chat/sessions', {});
      navigate(`/chat/${res.data.data.id}`);
    } catch {
      navigate('/chat');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        eyebrow={`Welcome back${user?.name ? ', ' + user.name : ''}`}
        title="ダッシュボード"
        description="部署を選んで AI チャットを開始、または現在の稼働状況を確認します。"
      />

      <SetupChecklistBanner />

      <motion.section
        className="mb-8"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <h3 className="text-[10px] font-semibold text-muted mb-3 uppercase tracking-[0.2em]">
          部署を選んでチャットを開始
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {DEPARTMENTS.map((dept, i) => (
            <motion.button
              key={dept.key}
              onClick={() => handleDeptClick(dept.key)}
              className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-2xl"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.15 + i * 0.05 }}
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.98 }}
            >
              <GlassCard
                variant="regular"
                padding="md"
                radius="2xl"
                tone={dept.key}
                reflectionTop
                className="h-full group"
              >
                <div className="text-2xl mb-3">{dept.icon}</div>
                <GlassBadge tone={dept.key} variant="soft" size="sm" className="mb-2">
                  {dept.label}
                </GlassBadge>
                <p className="text-xs text-muted leading-relaxed">{dept.desc}</p>
                <div className="flex items-center gap-1 mt-3 text-xs text-muted group-hover:text-accent transition-colors">
                  チャット開始 <ArrowRight size={11} />
                </div>
              </GlassCard>
            </motion.button>
          ))}
        </div>
      </motion.section>

      <motion.section
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
      >
        {[
          { label: 'AIチャット', desc: 'チャット履歴・新規会話', icon: MessageSquare, path: '/chat' },
          { label: 'タスク管理', desc: 'AIエージェントが自動実行', icon: ClipboardList, path: '/tasks' },
        ].map(({ label, desc, icon: Icon, path }) => (
          <motion.button
            key={path}
            onClick={() => navigate(path)}
            className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-2xl"
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
          >
            <GlassCard variant="thin" padding="md" radius="2xl" className="flex items-center gap-3 group">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0 bg-accent/15 text-accent">
                <Icon size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-primary">{label}</p>
                <p className="text-xs text-muted truncate">{desc}</p>
              </div>
              <ArrowRight
                size={14}
                className="text-muted group-hover:text-accent transition-colors flex-shrink-0"
              />
            </GlassCard>
          </motion.button>
        ))}
      </motion.section>

      {user?.role === 'OWNER' && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          {isLoading && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonCard key={i} className="h-28" />
              ))}
            </div>
          )}

          {isError && <ErrorState onRetry={() => refetch()} />}

          {data && !isLoading && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                {[
                  { label: 'AIリクエスト', value: data.totalRequests.toLocaleString(), icon: MessageSquare },
                  { label: 'トークン消費', value: data.totalTokens.toLocaleString(), icon: Zap },
                  { label: '平均応答', value: `${data.avgLatencyMs}ms`, icon: Clock },
                  { label: 'リスクイベント', value: totalRisks, icon: AlertTriangle },
                ].map(({ label, value, icon: Icon }) => (
                  <GlassCard key={label} variant="thin" padding="md" radius="2xl">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3 bg-accent/15 text-accent">
                      <Icon size={16} />
                    </div>
                    <p className="text-2xl font-bold text-primary">{value}</p>
                    <p className="text-xs text-muted mt-0.5">{label}</p>
                  </GlassCard>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {data.topDepartments.length > 0 ? (
                  <GlassCard variant="thin" padding="lg" radius="2xl" className="lg:col-span-2">
                    <h3 className="text-sm font-bold text-primary mb-4">部署別AIリクエスト数</h3>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart
                        data={data.topDepartments.map((d) => ({
                          ...d,
                          name: DEPT_LABEL[d.department] ?? d.department,
                        }))}
                      >
                        <XAxis
                          dataKey="name"
                          tick={{ fill: 'rgb(138,138,138)', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: 'rgb(138,138,138)', fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'rgba(255,255,255,0.85)',
                            backdropFilter: 'blur(16px)',
                            border: '1px solid rgba(255,255,255,0.6)',
                            borderRadius: 16,
                            fontSize: 12,
                            color: 'rgb(45,45,45)',
                          }}
                          cursor={{ fill: 'rgba(143,216,255,0.15)' }}
                        />
                        <Bar dataKey="count" fill="#8b85ff" radius={[8, 8, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </GlassCard>
                ) : (
                  <GlassCard variant="thin" padding="lg" radius="2xl" className="lg:col-span-2">
                    <EmptyState
                      icon={<BarChart2Icon />}
                      title="まだリクエストがありません"
                      description="部署を選択して最初のチャットを始めましょう。"
                    />
                  </GlassCard>
                )}
                <GlassCard variant="thin" padding="lg" radius="2xl">
                  <h3 className="text-sm font-bold text-primary mb-4">部署一覧</h3>
                  <div className="space-y-3">
                    {data.topDepartments.length > 0 ? (
                      data.topDepartments.map((d) => (
                        <div key={d.department} className="flex items-center justify-between">
                          <GlassBadge tone={d.department} variant="soft" size="sm">
                            {DEPT_LABEL[d.department] ?? d.department}
                          </GlassBadge>
                          <span className="text-sm font-bold text-primary">{d.count}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted">データがありません</p>
                    )}
                  </div>
                </GlassCard>
              </div>
            </>
          )}
        </motion.section>
      )}
    </div>
  );
}

function BarChart2Icon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" x2="18" y1="20" y2="10" />
      <line x1="12" x2="12" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </svg>
  );
}
