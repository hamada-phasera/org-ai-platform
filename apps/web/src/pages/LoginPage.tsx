import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Sparkles, ArrowRight, AlertCircle } from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '@org-ai/shared-types';
import { AmbientBackground, Card, Input, Button } from '../components/ui';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
        '/auth/login',
        { email, password },
      );
      login(res.data.data.token, res.data.data.user);
      navigate('/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg ?? 'ログインに失敗しました');
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
          <h2 className="text-body font-bold text-primary mb-1">おかえりなさい</h2>
          <p className="text-sm text-muted mb-6">アカウントにサインインする</p>

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
            <div>
              <label htmlFor="email" className="block text-micro font-semibold text-muted mb-2 uppercase tracking-wider">
                メールアドレス
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-micro font-semibold text-muted mb-2 uppercase tracking-wider">
                パスワード
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              fullWidth
              loading={loading}
              trailingIcon={!loading ? <ArrowRight size={16} /> : undefined}
            >
              {loading ? 'ログイン中...' : 'ログイン'}
            </Button>
          </form>

          <div className="mt-6 pt-5 border-t border-border text-center">
            <p className="text-xs text-muted">
              アカウントをお持ちでない方は{' '}
              <Link to="/register" className="text-accent font-semibold hover:underline">
                新規登録
              </Link>
            </p>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
