import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Sparkles, ArrowRight, AlertCircle } from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '@org-ai/shared-types';
import { AmbientBackground, Card, Input, Button } from '../components/ui';

const FIELDS = [
  { key: 'name', label: 'お名前', type: 'text', placeholder: '山田 太郎', autoComplete: 'name' },
  { key: 'email', label: 'メールアドレス', type: 'email', placeholder: 'you@example.com', autoComplete: 'email' },
  { key: 'password', label: 'パスワード (8文字以上)', type: 'password', placeholder: '••••••••', autoComplete: 'new-password' },
  { key: 'orgName', label: '組織名', type: 'text', placeholder: '株式会社サンプル', autoComplete: 'organization' },
] as const;

export default function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.post<{ success: boolean; data: { token: string; user: User } }>(
        '/auth/register',
        form,
      );
      login(res.data.data.token, res.data.data.user);
      navigate('/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg ?? '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
      <AmbientBackground />
      <motion.div
        className="w-full max-w-sm relative z-10"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex flex-col items-center mb-8">
          <motion.div
            className="w-14 h-14 bg-accent rounded-2xl flex items-center justify-center shadow-glow-primary mb-4"
            whileHover={{ rotate: 12, scale: 1.05 }}
          >
            <Sparkles size={24} className="text-white" />
          </motion.div>
          <h1 className="text-2xl font-bold text-primary tracking-tight">FLOW</h1>
          <p className="text-sm text-muted mt-1">みんなのAIオフィス</p>
        </div>

        <Card variant="regular" padding="lg" radius="2xl">
          <h2 className="text-body font-bold text-primary mb-1">新規登録</h2>
          <p className="text-sm text-muted mb-6">組織アカウントを作成する</p>

          <div aria-live="polite">
            {error && (
              <motion.div
                className="flex items-start gap-2 text-sm text-danger mb-5 p-3 rounded-xl bg-danger/10 border border-danger/20"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
              >
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </motion.div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {FIELDS.map(({ key, label, type, placeholder, autoComplete }) => (
              <div key={key}>
                <label
                  htmlFor={key}
                  className="block text-micro font-semibold text-muted mb-2 uppercase tracking-wider"
                >
                  {label}
                </label>
                <Input
                  id={key}
                  type={type}
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  autoComplete={autoComplete}
                  required
                />
              </div>
            ))}
            <Button
              type="submit"
              variant="primary"
              size="md"
              fullWidth
              loading={loading}
              trailingIcon={!loading ? <ArrowRight size={16} /> : undefined}
              className="mt-2"
            >
              {loading ? '登録中...' : 'アカウントを作成'}
            </Button>
          </form>

          <div className="mt-6 pt-5 border-t border-border text-center">
            <p className="text-xs text-muted">
              既にアカウントをお持ちの方は{' '}
              <Link to="/login" className="text-accent font-semibold hover:underline">
                ログイン
              </Link>
            </p>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
