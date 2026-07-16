import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Share2, Check, X, Sparkles, Clock, CalendarDays, List } from 'lucide-react';
import { api } from '../services/api';
import { GlassCard } from '../components/ui/GlassCard';
import { GlassButton } from '../components/ui/GlassButton';
import { GlassBadge } from '../components/ui/GlassBadge';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/LoadingSkeleton';
import { SnsCalendar } from '../components/Sns/SnsCalendar';

const SNS_TASK_TYPE = 'sns';
type Platform = 'twitter' | 'instagram' | 'linkedin';
const PLATFORM_LABEL: Record<Platform, string> = {
  twitter: 'X (Twitter)',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
};

interface SnsTask {
  id: string;
  title: string;
  status: string;
  department: string;
  taskType: string | null;
  output: string | null;
  createdAt: string;
}

interface SnsDraft {
  platform: Platform;
  content: string;
  hashtags: string[];
}

const STATUS_BADGE: Record<string, string> = {
  QUEUED: '⏳ 生成中',
  RUNNING: '⏳ 生成中',
  PENDING_APPROVAL: '🟡 承認待ち',
  APPROVED: '🟢 承認済み',
  REJECTED: '⛔ 却下',
  DONE: '✅ 完了',
  FAILED: '🔴 失敗',
};

const GENERATING_STATUSES = new Set(['QUEUED', 'RUNNING']);

function parseDraft(output: string | null): SnsDraft | null {
  if (!output) return null;
  try {
    const j = JSON.parse(output) as Partial<SnsDraft>;
    if (typeof j.content === 'string') {
      return {
        platform: (j.platform as Platform) ?? 'twitter',
        content: j.content,
        hashtags: Array.isArray(j.hashtags) ? j.hashtags : [],
      };
    }
  } catch {
    /* 非JSON output は無視 */
  }
  return null;
}

async function fetchSnsTasks(): Promise<SnsTask[]> {
  const res = await api.get<{ success: boolean; data: SnsTask[] }>('/tasks');
  return res.data.data.filter((t) => t.taskType === SNS_TASK_TYPE);
}

function DraftCard({ task, children }: { task: SnsTask; children?: React.ReactNode }) {
  const draft = parseDraft(task.output);
  return (
    <GlassCard variant="regular" className="p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Share2 size={14} className="flex-shrink-0 text-muted" />
          <h3 className="text-sm font-semibold text-primary truncate">
            {draft ? PLATFORM_LABEL[draft.platform] : task.title}
          </h3>
        </div>
        <GlassBadge>{STATUS_BADGE[task.status] ?? task.status}</GlassBadge>
      </div>
      {draft ? (
        <>
          <p className="text-xs text-secondary whitespace-pre-wrap line-clamp-4 mb-2">{draft.content}</p>
          {draft.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {draft.hashtags.map((t) => (
                <span key={t} className="text-[10px] text-accent">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-muted mb-2">{task.title}</p>
      )}
      {children}
    </GlassCard>
  );
}

/**
 * SNS投稿部署ページ（R1・N-1/N-2）。
 * 下書き生成 → 承認待ちキュー（承認/却下）→ 履歴。
 * ※ SNSへの実投稿は行わない。承認は状態遷移のみ（投稿ボタンは存在しない）。
 * ルーティング登録は統合フェーズ(B)。
 */
export default function SnsPage() {
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<Platform>('twitter');
  const [topic, setTopic] = useState('');
  const [view, setView] = useState<'list' | 'calendar'>('list');

  // 生成は非同期 Task（202 → QUEUED → PENDING_APPROVAL）のため、生成中はポーリングで追う。
  const tasksQ = useQuery({
    queryKey: ['sns-tasks'],
    queryFn: fetchSnsTasks,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((t) => GENERATING_STATUSES.has(t.status)) ? 3000 : false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['sns-tasks'] });

  const genMut = useMutation({
    mutationFn: () => api.post('/sns/posts', { platform, topic }),
    onSuccess: () => {
      setTopic('');
      invalidate();
    },
  });
  const approveMut = useMutation({
    mutationFn: (id: string) => api.post(`/sns/posts/${id}/approve`),
    onSuccess: invalidate,
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.post(`/sns/posts/${id}/reject`, {}),
    onSuccess: invalidate,
  });

  const all = tasksQ.data ?? [];
  const generating = all.filter((t) => GENERATING_STATUSES.has(t.status));
  const pending = all.filter((t) => t.status === 'PENDING_APPROVAL');
  const history = all.filter((t) => t.status !== 'PENDING_APPROVAL' && !GENERATING_STATUSES.has(t.status));

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-28">
      <PageHeader
        eyebrow="SNS"
        title="SNS投稿"
        description="投稿の下書きを生成し、承認フローを通します（自動投稿はしません）。"
        actions={
          <div className="flex gap-1">
            <GlassButton
              variant={view === 'list' ? 'primary' : 'ghost'}
              size="sm"
              icon={<List size={14} />}
              onClick={() => setView('list')}
            >
              リスト
            </GlassButton>
            <GlassButton
              variant={view === 'calendar' ? 'primary' : 'ghost'}
              size="sm"
              icon={<CalendarDays size={14} />}
              onClick={() => setView('calendar')}
            >
              カレンダー
            </GlassButton>
          </div>
        }
      />

      {/* ── 下書き生成 ─────────────────────────────── */}
      <GlassCard variant="regular" className="p-4 mb-8">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Platform)}
            className="glass-regular rounded-lg px-3 py-2 text-sm text-primary bg-transparent"
            aria-label="プラットフォーム"
          >
            {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="投稿テーマ（例: 新サービスの告知）"
            className="flex-1 glass-regular rounded-lg px-3 py-2 text-sm text-primary bg-transparent"
          />
          <GlassButton
            variant="primary"
            icon={<Sparkles size={14} />}
            onClick={() => genMut.mutate()}
            loading={genMut.isPending}
            disabled={!topic.trim()}
          >
            下書きを生成
          </GlassButton>
        </div>
        {genMut.isError && (
          <p className="text-xs text-danger mt-2">生成に失敗しました。時間をおいて再度お試しください。</p>
        )}
      </GlassCard>

      {view === 'calendar' ? (
        <SnsCalendar tasks={all} />
      ) : (
      <>
      {/* ── 承認待ちキュー ─────────────────────────── */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={16} className="text-muted" />
          <h2 className="text-sm font-semibold text-primary">承認待ちキュー</h2>
          <span className="text-[11px] text-muted">{pending.length}件</span>
        </div>

        {generating.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
            {generating.map((task) => (
              <DraftCard key={task.id} task={task} />
            ))}
          </div>
        )}

        {tasksQ.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : tasksQ.isError ? (
          <EmptyState icon={<Share2 size={28} />} title="読み込みに失敗しました" />
        ) : pending.length === 0 && generating.length > 0 ? null : pending.length === 0 ? (
          <EmptyState
            icon={<Share2 size={28} />}
            title="承認待ちの下書きはありません"
            description="上の「下書きを生成」から投稿案を作成すると、ここに承認待ちで並びます。"
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {pending.map((task) => (
              <motion.div key={task.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <DraftCard task={task}>
                  <div className="flex gap-2 mt-1">
                    <GlassButton
                      variant="primary"
                      size="sm"
                      icon={<Check size={12} />}
                      onClick={() => approveMut.mutate(task.id)}
                      loading={approveMut.isPending && approveMut.variables === task.id}
                    >
                      承認
                    </GlassButton>
                    <GlassButton
                      variant="ghost"
                      size="sm"
                      icon={<X size={12} />}
                      onClick={() => rejectMut.mutate(task.id)}
                      loading={rejectMut.isPending && rejectMut.variables === task.id}
                    >
                      却下
                    </GlassButton>
                  </div>
                </DraftCard>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* ── 履歴（承認済み/却下） ───────────────────── */}
      {history.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Share2 size={16} className="text-muted" />
            <h2 className="text-sm font-semibold text-primary">下書き履歴</h2>
            <span className="text-[11px] text-muted">{history.length}件</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {history.map((task) => (
              <DraftCard key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}
      </>
      )}
    </div>
  );
}
