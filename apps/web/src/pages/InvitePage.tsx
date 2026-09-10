import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Building2, ShieldCheck } from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { Button, Card, Input, Spinner } from '../components/ui';
import type { User } from '@org-ai/shared-types';

/**
 * 招待されたひとがアカウントを作る画面。**ログイン不要**。
 *
 * 招待リンクは管理者が手渡す（このプロダクトはメールを送れない）。
 * 組織と役割はサーバがトークンから決めるので、この画面からは選べない。
 */

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理者',
  MEMBER: 'メンバー',
};

export default function InvitePage() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const previewQ = useQuery({
    queryKey: ['invite-preview', token],
    retry: false,
    queryFn: async () => {
      const res = await api.get<{
        success: boolean;
        data: { organizationName: string; role: string; expiresAt: string };
      }>(`/members/invitations/preview/${token}`);
      return res.data.data;
    },
  });

  const acceptMut = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; data: { token: string; user: User } }>(
        '/members/invitations/accept',
        { token, name: name.trim(), password },
      ),
    onSuccess: (res) => {
      login(res.data.data.token, res.data.data.user);
      navigate('/', { replace: true });
    },
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      setError(data?.error?.message ?? 'アカウントを作成できませんでした');
    },
  });

  if (previewQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  /* 無効なリンク。理由は細かく出さない（トークンの当てずっぽうに情報を与えない） */
  if (previewQ.isError || !previewQ.data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card variant="regular" padding="lg" radius="2xl" className="w-full max-w-md text-center">
          <h1 className="text-body font-semibold text-primary">この招待リンクは使えません</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            期限が切れているか、既に使用されています。お手数ですが、招待した方に再発行を依頼してください。
          </p>
          <Button className="mt-4" variant="secondary" onClick={() => navigate('/login')}>
            ログイン画面へ
          </Button>
        </Card>
      </div>
    );
  }

  const invite = previewQ.data;
  const canSubmit = name.trim().length > 0 && password.length >= 8;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <motion.div
        className="w-full max-w-md"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Card variant="regular" padding="lg" radius="2xl" className="space-y-4">
          <div className="space-y-1.5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft">
              <Building2 size={20} className="text-accent" aria-hidden="true" />
            </div>
            <h1 className="text-body font-semibold text-primary">
              「{invite.organizationName}」に招待されています
            </h1>
            <p className="flex items-center justify-center gap-1 text-xs text-muted">
              <ShieldCheck size={12} aria-hidden="true" />
              {ROLE_LABEL[invite.role] ?? invite.role}として参加します
            </p>
          </div>

          <div className="space-y-2.5">
            <div>
              <label htmlFor="invite-name" className="mb-1 block text-xs font-bold text-primary">
                お名前
              </label>
              <Input
                id="invite-name"
                size="md"
                fullWidth
                placeholder="山田 太郎"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="invite-password" className="mb-1 block text-xs font-bold text-primary">
                パスワード
              </label>
              <Input
                id="invite-password"
                size="md"
                fullWidth
                type="password"
                autoComplete="new-password"
                placeholder="8文字以上"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="mt-1 text-micro text-text-muted">8文字以上にしてください。</p>
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <Button
            fullWidth
            loading={acceptMut.isPending}
            disabled={!canSubmit}
            onClick={() => {
              setError(null);
              acceptMut.mutate();
            }}
          >
            参加する
          </Button>

          <p className="text-center text-micro text-text-muted">
            メールアドレスは招待した方が設定済みです。参加後に変更できます。
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
