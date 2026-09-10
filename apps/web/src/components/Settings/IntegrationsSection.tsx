import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Copy, ExternalLink, MessageSquare, Plug, Trash2, FileText, Hash } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';

/**
 * 設定 > 連携。
 *
 * 「連携は裏で足すのではなく、ユーザーが自分で選んで接続する」ための画面。
 * - LINE: ChannelConnection（webhook はチャネル種類ごとに1本の共通URL）
 * - Slack / Google: ProviderConnection。トークンは暗号化して自社DBに保存し、
 *   capability 実行は gateway が直接 API を叩く（n8n の credential には依存しない）
 * - その他（Gmail / X / 既存シート読取）は引き続き n8n 側で資格情報を管理
 */

interface ChannelConnectionView {
  id: string;
  provider: string;
  channelId: string;
  displayName: string | null;
  status: string;
  monthlyPushCount: number;
  quotaUsage: number | null;
  lastEventAt: string | null;
  webhookUrl: string;
}

interface ProviderConnectionView {
  id: string;
  provider: 'slack' | 'google';
  scopes: string | null;
  externalAccountId: string | null;
  displayName: string | null;
  status: 'CONNECTED' | 'NEEDS_RECONNECT' | 'DISABLED';
  lastCheckedAt: string | null;
}

interface CapabilityView {
  id: string;
  name: string;
  displayName: string;
  status: string;
  requiredCreds: Array<{
    id: string;
    provider: string;
    status: string;
    lastCheckedAt: string | null;
  }>;
}

/* Slack / Google に移行済みの provider。n8n 管理カードからは除外する */
const NATIVE_CRED_PROVIDERS = new Set(['slack', 'googledocs', 'googlesheets', 'googleslides']);

const statusChip = (connected: boolean, labelOn = '接続済み', labelOff = '未接続') =>
  connected ? (
    <span className="rounded-full bg-success/10 px-2.5 py-1 text-micro font-bold text-success">{labelOn}</span>
  ) : (
    <span className="rounded-full bg-warning/10 px-2.5 py-1 text-micro font-bold text-warning">{labelOff}</span>
  );

export function IntegrationsSection() {
  const qc = useQueryClient();
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [slackToken, setSlackToken] = useState('');
  const [slackError, setSlackError] = useState<string | null>(null);
  const [slackWarning, setSlackWarning] = useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  /* OAuth から戻ってきたときの処理。
     callback はトークンをどの org にも紐づけずに返してくるので、ここで confirm を叩いて
     「いまログインしているこの組織」に保存する（アカウント連結 CSRF を構造的に防ぐ設計）。 */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkId = params.get('googleLink');
    const error = params.get('error');
    if (!linkId && !error) return;

    // 読み終えたクエリは消す（再読み込みで二重に走らせない）
    params.delete('googleLink');
    params.delete('connected');
    params.delete('error');
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);

    if (error) {
      const text =
        error === 'google_denied'
          ? 'Google の接続がキャンセルされました。'
          : error === 'google_state'
            ? '接続リンクの有効期限が切れました。もう一度お試しください。'
            : 'Google の接続に失敗しました。時間をおいて再度お試しください。';
      setOauthMessage({ kind: 'error', text });
      return;
    }

    void (async () => {
      try {
        await api.post('/oauth/google/confirm', { linkId });
        setOauthMessage({ kind: 'ok', text: 'Google を接続しました。' });
        void qc.invalidateQueries({ queryKey: ['provider-connections'] });
        void qc.invalidateQueries({ queryKey: ['capabilities'] });
      } catch (err) {
        const message =
          err instanceof AxiosError
            ? (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message
            : undefined;
        setOauthMessage({
          kind: 'error',
          text: message ?? 'Google の接続を完了できませんでした。もう一度お試しください。',
        });
      }
    })();
  }, [qc]);

  const connectionsQ = useQuery({
    queryKey: ['channel-connections'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ChannelConnectionView[] }>(
        '/inbox/connections',
      );
      return res.data.data;
    },
    retry: (count, err) =>
      // OWNER以外は403で確定なのでリトライしない
      !(err instanceof AxiosError && err.response?.status === 403) && count < 2,
  });

  const providersQ = useQuery({
    queryKey: ['provider-connections'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ProviderConnectionView[] }>('/integrations');
      return res.data.data;
    },
    retry: (count, err) =>
      !(err instanceof AxiosError && err.response?.status === 403) && count < 2,
  });

  const capabilitiesQ = useQuery({
    queryKey: ['capabilities'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: CapabilityView[] }>('/capabilities');
      return res.data.data;
    },
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/inbox/connections', { channelSecret: secret.trim(), accessToken: token.trim() }),
    onSuccess: () => {
      setSecret('');
      setToken('');
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['channel-connections'] });
    },
    onError: (err) => {
      const res = err instanceof AxiosError ? err.response : null;
      if (res?.status === 400) setFormError('資格情報が正しくありません。Channel Secret と長期アクセストークンを確認してください。');
      else if (res?.status === 409) setFormError('この LINE 公式アカウントは既に別の組織に接続されています。');
      else setFormError('接続に失敗しました。時間をおいて再度お試しください。');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/inbox/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-connections'] }),
  });

  const slackMut = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ success: boolean; data: { warning: string | null } }>(
        '/integrations/slack',
        { botToken: slackToken.trim() },
      );
      return res.data.data;
    },
    onSuccess: (data) => {
      setSlackToken('');
      setSlackError(null);
      setSlackWarning(data?.warning ?? null);
      qc.invalidateQueries({ queryKey: ['provider-connections'] });
      qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
    onError: (err) => {
      const message =
        err instanceof AxiosError
          ? (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message
          : undefined;
      setSlackError(message ?? '接続に失敗しました。時間をおいて再度お試しください。');
    },
  });

  const googleStartMut = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ success: boolean; data: { authUrl: string } }>(
        '/oauth/google/start',
      );
      return res.data.data.authUrl;
    },
    onSuccess: (authUrl) => {
      // OAuth 同意画面へ遷移（ヘッダ認証が乗らないので XHR ではなく画面遷移）
      window.location.href = authUrl;
    },
    onError: (err) => {
      const message =
        err instanceof AxiosError
          ? (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message
          : undefined;
      setOauthMessage({ kind: 'error', text: message ?? 'Google 連携を開始できませんでした。' });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: (provider: string) => api.delete(`/integrations/${provider}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-connections'] });
      qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });

  const notOwner =
    (connectionsQ.error instanceof AxiosError && connectionsQ.error.response?.status === 403) ||
    (providersQ.error instanceof AxiosError && providersQ.error.response?.status === 403);
  const connections = connectionsQ.data ?? [];
  const webhookUrl = connections[0]?.webhookUrl;
  const providers = providersQ.data ?? [];
  const slack = providers.find((p) => p.provider === 'slack');
  const google = providers.find((p) => p.provider === 'google');

  /* n8n 側で管理する残りの provider（Gmail / X / 既存シート読取）を集約 */
  const providerStatus = new Map<string, { connected: boolean; lastCheckedAt: string | null }>();
  for (const cap of capabilitiesQ.data ?? []) {
    for (const cred of cap.requiredCreds) {
      if (NATIVE_CRED_PROVIDERS.has(cred.provider)) continue;
      const prev = providerStatus.get(cred.provider);
      const connected = cred.status === 'CONNECTED';
      if (!prev || connected) {
        providerStatus.set(cred.provider, { connected, lastCheckedAt: cred.lastCheckedAt });
      }
    }
  }

  if (notOwner) {
    return (
      <Card variant="regular" padding="lg" radius="2xl">
        <p className="text-sm text-secondary">
          連携の管理は OWNER のみ行えます。管理者に依頼してください。
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {oauthMessage && (
        <div
          aria-live="polite"
          className={`rounded-md px-4 py-3 text-sm ${
            oauthMessage.kind === 'ok'
              ? 'bg-success/10 text-success'
              : 'bg-danger/10 text-danger'
          }`}
        >
          {oauthMessage.text}
        </div>
      )}

      {/* ── LINE ── */}
      <Card variant="regular" padding="lg" radius="2xl">
        <div className="mb-4 flex items-center gap-2">
          <MessageSquare size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-body font-semibold text-primary">LINE 公式アカウント</h2>
        </div>

        {connectionsQ.isLoading ? (
          <SkeletonList count={1} />
        ) : (
          <>
            {connections.length === 0 ? (
              <EmptyState
                icon={<Plug size={22} />}
                title="まだ接続されていません"
                description="LINE Developers で Messaging API チャネルを作成し、Channel Secret と長期チャネルアクセストークンを貼り付けてください。"
                className="py-4"
              />
            ) : (
              <ul className="mb-5 space-y-2.5">
                {connections.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 rounded-md border border-border px-3.5 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-primary">
                        {c.displayName ?? c.channelId}
                      </p>
                      <p className="tabular text-micro text-text-muted">
                        今月の送信 {c.quotaUsage ?? c.monthlyPushCount} 通
                        {c.lastEventAt &&
                          ` · 最終受信 ${new Date(c.lastEventAt).toLocaleString('ja-JP')}`}
                      </p>
                    </div>
                    {statusChip(c.status === 'ACTIVE')}
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<Trash2 size={11} />}
                      loading={deleteMut.isPending && deleteMut.variables === c.id}
                      onClick={() => deleteMut.mutate(c.id)}
                      aria-label={`${c.displayName ?? c.channelId} の接続を解除`}
                    >
                      解除
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="line-secret" className="mb-1 block text-xs font-semibold text-secondary">
                  Channel Secret
                </label>
                <Input
                  id="line-secret"
                  size="sm"
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="line-token" className="mb-1 block text-xs font-semibold text-secondary">
                  チャネルアクセストークン（長期）
                </label>
                <Input
                  id="line-token"
                  size="sm"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
            </div>
            {formError && (
              <p className="mt-2 text-xs text-danger" aria-live="polite">
                {formError}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Button
                size="sm"
                disabled={!secret.trim() || !token.trim()}
                loading={createMut.isPending}
                onClick={() => createMut.mutate()}
              >
                接続する
              </Button>
              <p className="text-micro text-text-muted">
                トークンは暗号化して保存されます。画面に再表示されることはありません。
              </p>
            </div>

            {webhookUrl && (
              <div className="mt-5 rounded-md bg-sunken p-3.5">
                <p className="mb-1.5 text-micro font-bold uppercase tracking-[0.07em] text-text-muted">
                  Webhook URL（LINE Developers に設定）
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">
                    {webhookUrl}
                  </code>
                  <Button
                    size="xs"
                    variant="glass"
                    icon={<Copy size={11} />}
                    onClick={() => {
                      void navigator.clipboard.writeText(webhookUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? 'コピー済' : 'コピー'}
                  </Button>
                </div>
                <ul className="mt-2.5 space-y-1 text-micro text-secondary">
                  <li>・LINE console の <b>「応答メッセージ（自動応答）」を必ずOFF</b> にしてください（ONだと定型文が勝手に返信されます）</li>
                  <li>・「グループトーク・複数人トークへの参加を許可する」をONにして、bot をグループに招待してください</li>
                  <li>・返信の無料枠は月200通で、<b>グループへの1返信はグループ人数分</b>カウントされます</li>
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Slack（Bot トークン貼付） ── */}
      <Card variant="regular" padding="lg" radius="2xl">
        <div className="mb-4 flex items-center gap-2">
          <Hash size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-body font-semibold text-primary">Slack</h2>
          {slack && (
            <span className="ml-auto">
              {slack.status === 'CONNECTED'
                ? statusChip(true)
                : statusChip(false, '', '再接続が必要')}
            </span>
          )}
        </div>

        {providersQ.isLoading ? (
          <SkeletonList count={1} />
        ) : (
          <>
            {slack && slack.status === 'CONNECTED' ? (
              <div className="flex items-center gap-3 rounded-md border border-border px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-primary">{slack.displayName ?? 'Slack ワークスペース'}</p>
                  <p className="tabular text-micro text-text-muted">
                    {slack.scopes ?? ''}
                    {slack.lastCheckedAt &&
                      ` · 確認 ${new Date(slack.lastCheckedAt).toLocaleDateString('ja-JP')}`}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 size={11} />}
                  loading={disconnectMut.isPending && disconnectMut.variables === 'slack'}
                  onClick={() => disconnectMut.mutate('slack')}
                  aria-label="Slack の接続を解除"
                >
                  解除
                </Button>
              </div>
            ) : (
              <>
                {slack?.status === 'NEEDS_RECONNECT' && (
                  <p className="mb-3 text-xs text-warning">
                    トークンが無効になりました。新しい Bot User OAuth Token を貼り直してください。
                  </p>
                )}
                <div>
                  <label htmlFor="slack-token" className="mb-1 block text-xs font-semibold text-secondary">
                    Bot User OAuth Token（xoxb- で始まる）
                  </label>
                  <Input
                    id="slack-token"
                    size="sm"
                    type="password"
                    autoComplete="off"
                    placeholder="xoxb-..."
                    value={slackToken}
                    onChange={(e) => setSlackToken(e.target.value)}
                  />
                </div>
                {slackError && (
                  <p className="mt-2 text-xs text-danger" aria-live="polite">
                    {slackError}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    size="sm"
                    disabled={!slackToken.trim()}
                    loading={slackMut.isPending}
                    onClick={() => slackMut.mutate()}
                  >
                    接続する
                  </Button>
                  <p className="text-micro text-text-muted">
                    api.slack.com でアプリを作り、Bot Token Scopes に <b>chat:write</b> と{' '}
                    <b>chat:write.public</b> を付けてインストールしてください。
                  </p>
                </div>
              </>
            )}
            {slackWarning && (
              <p className="mt-2 text-xs text-warning" aria-live="polite">
                {slackWarning}
              </p>
            )}
          </>
        )}
      </Card>

      {/* ── Google（OAuth） ── */}
      <Card variant="regular" padding="lg" radius="2xl">
        <div className="mb-4 flex items-center gap-2">
          <FileText size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-body font-semibold text-primary">Google（ドキュメント / スプレッドシート / スライド）</h2>
          {google && (
            <span className="ml-auto">
              {google.status === 'CONNECTED'
                ? statusChip(true)
                : statusChip(false, '', '再接続が必要')}
            </span>
          )}
        </div>

        {providersQ.isLoading ? (
          <SkeletonList count={1} />
        ) : google && google.status === 'CONNECTED' ? (
          <div className="flex items-center gap-3 rounded-md border border-border px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-primary">{google.displayName ?? 'Google アカウント'}</p>
              <p className="tabular text-micro text-text-muted">
                このアプリが作成したファイルのみにアクセスします
                {google.lastCheckedAt &&
                  ` · 確認 ${new Date(google.lastCheckedAt).toLocaleDateString('ja-JP')}`}
              </p>
            </div>
            <Button
              size="xs"
              variant="ghost"
              icon={<Trash2 size={11} />}
              loading={disconnectMut.isPending && disconnectMut.variables === 'google'}
              onClick={() => disconnectMut.mutate('google')}
              aria-label="Google の接続を解除"
            >
              解除
            </Button>
          </div>
        ) : (
          <>
            {google?.status === 'NEEDS_RECONNECT' && (
              <p className="mb-3 text-xs text-warning">
                Google の許可が切れました。もう一度接続してください。
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button size="sm" loading={googleStartMut.isPending} onClick={() => googleStartMut.mutate()}>
                {google?.status === 'NEEDS_RECONNECT' ? 'Google に再接続' : 'Google で接続'}
              </Button>
              <p className="text-micro text-text-muted">
                このアプリが作成したファイルだけにアクセスします（既存のドライブは読みません）。
              </p>
            </div>
          </>
        )}
      </Card>

      {/* ── その他（n8n 側 OAuth） ── */}
      {providerStatus.size > 0 && (
        <Card variant="regular" padding="lg" radius="2xl">
          <div className="mb-4 flex items-center gap-2">
            <Plug size={16} className="text-accent" aria-hidden="true" />
            <h2 className="text-body font-semibold text-primary">その他の外部サービス</h2>
          </div>
          <ul className="space-y-2.5">
            {[...providerStatus.entries()].map(([provider, st]) => (
              <li
                key={provider}
                className="flex items-center gap-3 rounded-md border border-border px-3.5 py-2.5"
              >
                <span className="flex-1 text-sm font-bold capitalize text-primary">{provider}</span>
                {st.lastCheckedAt && (
                  <span className="tabular text-micro text-text-muted">
                    確認 {new Date(st.lastCheckedAt).toLocaleDateString('ja-JP')}
                  </span>
                )}
                {statusChip(st.connected)}
              </li>
            ))}
          </ul>
          <p className="mt-3.5 flex items-center gap-1.5 text-micro text-text-muted">
            <ExternalLink size={11} aria-hidden="true" />
            これらの資格情報は n8n 側で管理します。接続手順は docs/oauth-setup.md（管理者向け）。
          </p>
        </Card>
      )}
    </div>
  );
}

export default IntegrationsSection;
