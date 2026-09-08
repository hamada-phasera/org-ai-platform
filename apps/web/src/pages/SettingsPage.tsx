import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LogOut,
  Settings as SettingsIcon,
  User as UserIcon,
  Building2,
  FileText,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User, UploadedFile, Plan, OrganizationUsage, PlanTier } from '@org-ai/shared-types';
import { PLAN_LIMITS } from '@org-ai/shared-types';
import {
  Card,
  Surface,
  Button,
  PageHeader,
  EmptyState,
  SkeletonList,
} from '../components/ui';
import UsageCard from '../components/Settings/UsageCard';
import IntegrationsSection from '../components/Settings/IntegrationsSection';
import { LiquidTabs } from '../components/motion/LiquidTabs';

interface OrganizationView {
  id: string;
  name: string;
  plan: PlanTier;
  billingEmail: string | null;
  createdAt: string;
  memberCount: number;
}

/* プランのピル。意味色トークンで塗る（hex 直書き禁止） */
const PLAN_BADGE: Record<Plan, { label: string; className: string }> = {
  STARTER: { label: 'Starter', className: 'bg-sunken border border-border text-secondary' },
  PRO: { label: 'Pro', className: 'bg-accent-soft border border-accent-soft-border text-accent' },
  MAX: { label: 'Max', className: 'bg-warning/10 border border-warning/30 text-warning' },
};

export default function SettingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const storedUser = useAuthStore((s) => s.user);
  const [view, setView] = useState<'general' | 'integrations'>('general');
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<{ fileName: string; content: string } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: User }>('/auth/me');
      return res.data.data;
    },
  });

  const { data: organization } = useQuery({
    queryKey: ['organization-me'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: OrganizationView }>('/organizations/me');
      return res.data.data;
    },
  });

  const { data: usage } = useQuery({
    queryKey: ['organization-usage'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: OrganizationUsage }>('/organizations/me/usage');
      return res.data.data;
    },
    enabled: !!organization,
  });

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['uploaded-files'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: UploadedFile[] }>('/files');
      return res.data.data;
    },
  });

  const handleLogout = () => {
    logout();
    qc.clear();
    navigate('/login', { replace: true });
  };

  const handleAnalyze = async (file: UploadedFile) => {
    setAnalyzingId(file.id);
    setAnalysisError(null);
    setAnalysisResult(null);
    try {
      const res = await api.post<{
        success: boolean;
        data?: { analysis: { content: string } };
        error?: { message: string };
      }>(`/files/${file.id}/analyze`, {
        question: 'このファイルの内容を300字程度で要約してください。',
      });
      if (res.data.success && res.data.data) {
        setAnalysisResult({ fileName: file.originalName, content: res.data.data.analysis.content });
      } else {
        setAnalysisError(res.data.error?.message ?? '分析に失敗しました');
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: { message?: string } } } };
      setAnalysisError(err.response?.data?.error?.message ?? '分析に失敗しました');
    } finally {
      setAnalyzingId(null);
    }
  };

  const user = me ?? storedUser;
  const planKey: Plan = organization?.plan ?? 'STARTER';
  const plan = PLAN_BADGE[planKey];
  const modelLabel = PLAN_LIMITS[planKey].modelLabel;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        eyebrow="Settings"
        title="設定"
        description="プロフィール・組織情報・ファイル管理をここで確認します。"
        actions={
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-accent-soft text-accent">
            <SettingsIcon size={18} />
          </div>
        }
      />

      <div className="mb-5">
        <LiquidTabs<'general' | 'integrations'>
          id="settings-tab"
          size="sm"
          label="設定の切り替え"
          items={[
            { value: 'general', label: '基本' },
            { value: 'integrations', label: '連携' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      {view === 'integrations' ? (
        <IntegrationsSection />
      ) : (
        <>

      <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
        <div className="flex items-center gap-2 mb-4">
          <UserIcon size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-primary">プロフィール</h3>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <Field label="名前" value={user?.name ?? '—'} />
          <Field label="メールアドレス" value={user?.email ?? '—'} />
          <Field label="ロール" value={user?.role ?? '—'} />
          <Field label="ユーザーID" value={user?.id ?? '—'} mono />
        </dl>
      </Card>

      <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-primary">組織</h3>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <Field label="組織名" value={organization?.name ?? '—'} />
          <Field label="組織ID" value={organization?.id ?? user?.orgId ?? '—'} mono />
          <Field label="メンバー数" value={organization?.memberCount?.toString() ?? '—'} />
          <Field label="請求先メール" value={organization?.billingEmail ?? '—'} />
          <div>
            <dt className="text-xs text-muted mb-1">プラン</dt>
            <dd className="flex items-center gap-2">
              <span className={`inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full ${plan.className}`}>
                {plan.label}
              </span>
              <span className="text-xs text-muted">{modelLabel}</span>
            </dd>
          </div>
        </dl>
      </Card>

      {usage && <UsageCard usage={usage} modelLabel={modelLabel} />}

      <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
        <div className="flex items-center gap-2 mb-4">
          <FileText size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-primary">アップロード済みファイル</h3>
          <span className="ml-auto text-xs text-muted tabular">{files?.length ?? 0} 件</span>
        </div>

        {filesLoading ? (
          <SkeletonList count={3} />
        ) : (files ?? []).length === 0 ? (
          <EmptyState
            icon={<FileText size={22} />}
            title="ファイルはまだありません"
            description="チャット内からファイルをアップロードすると、ここに表示されます。"
            action={{ label: 'チャットへ', onClick: () => navigate('/chat') }}
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {(files ?? []).map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary truncate">{f.originalName}</p>
                  <p className="text-xs text-muted tabular">
                    {f.mimeType} · {(f.sizeBytes / 1024).toFixed(1)} KB ·{' '}
                    {new Date(f.createdAt).toLocaleDateString('ja-JP')}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => handleAnalyze(f)}
                  disabled={analyzingId === f.id}
                  loading={analyzingId === f.id}
                  icon={<Sparkles size={12} />}
                >
                  {analyzingId === f.id ? '分析中...' : 'AIで分析'}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {analysisError && (
          <div className="mt-4 p-3 rounded-2xl bg-danger/10 border border-danger/20 text-xs text-danger flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{analysisError}</span>
          </div>
        )}
        {analysisResult && (
          <Surface variant="thin" padding="md" radius="xl" className="mt-4">
            <p className="text-xs font-semibold text-primary mb-2">{analysisResult.fileName} の要約</p>
            <p className="text-xs text-secondary whitespace-pre-wrap leading-relaxed">{analysisResult.content}</p>
          </Surface>
        )}
      </Card>

      <Card variant="regular" padding="lg" radius="2xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-primary">ログアウト</h3>
            <p className="text-xs text-muted">このブラウザからサインアウトします</p>
          </div>
          <Button size="sm" variant="danger" onClick={handleLogout} icon={<LogOut size={13} />}>
            ログアウト
          </Button>
        </div>
      </Card>
        </>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted mb-1">{label}</dt>
      <dd className={`text-sm text-primary ${mono ? 'font-mono text-xs' : ''} break-all`}>{value}</dd>
    </div>
  );
}
