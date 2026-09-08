import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Copy, ExternalLink, MessageSquare, Plug, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';

/**
 * 設定 > 連携。
 *
 * 「連携は裏で足すのではなく、ユーザーが自分で選んで接続する」ための画面。
 * - LINE: ChannelConnection をここで登録（webhook はチャネル種類ごとに1本の共通URL。
 *   顧客追加=DB行追加でコード変更なし、という設計の入口）
 * - Google / Slack: 資格情報は n8n 側が保持。ここでは接続状態の表示と手順への誘導のみ
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

  const notOwner =
    connectionsQ.error instanceof AxiosError && connectionsQ.error.response?.status === 403;
  const connections = connectionsQ.data ?? [];
  const webhookUrl = connections[0]?.webhookUrl;

  /* n8n 側で管理する OAuth（Google/Slack）を provider ごとに集約 */
  const providerStatus = new Map<string, { connected: boolean; lastCheckedAt: string | null }>();
  for (const cap of capabilitiesQ.data ?? []) {
    for (const cred of cap.requiredCreds) {
      const prev = providerStatus.get(cred.provider);
      const connected = cred.status === 'CONNECTED';
      if (!prev || connected) {
        providerStatus.set(cred.provider, { connected, lastCheckedAt: cred.lastCheckedAt });
      }
    }
  }

  return (
    <div className="space-y-5">
      {/* ── LINE ── */}
      <Card variant="regular" padding="lg" radius="2xl">
        <div className="mb-4 flex items-center gap-2">
          <MessageSquare size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-body font-semibold text-primary">LINE 公式アカウント</h2>
        </div>

        {notOwner ? (
          <p className="text-sm text-secondary">
            LINE 連携の管理は OWNER のみ行えます。管理者に依頼してください。
          </p>
        ) : connectionsQ.isLoading ? (
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

      {/* ── Google / Slack（n8n 側 OAuth） ── */}
      <Card variant="regular" padding="lg" radius="2xl">
        <div className="mb-4 flex items-center gap-2">
          <Plug size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-body font-semibold text-primary">外部サービス（Google / Slack）</h2>
        </div>
        {capabilitiesQ.isLoading ? (
          <SkeletonList count={1} />
        ) : providerStatus.size === 0 ? (
          <p className="text-sm text-secondary">利用可能な外部連携がまだありません。</p>
        ) : (
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
        )}
        <p className="mt-3.5 flex items-center gap-1.5 text-micro text-text-muted">
          <ExternalLink size={11} aria-hidden="true" />
          これらの資格情報は n8n 側で管理します。接続手順は docs/oauth-setup.md（管理者向け）。
        </p>
      </Card>
    </div>
  );
}

export default IntegrationsSection;
