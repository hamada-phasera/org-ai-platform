import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, ShieldCheck, UserPlus, Users, X } from 'lucide-react';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';

/**
 * メンバーと招待。
 *
 * ⚠️ このプロダクトはメールを1通も送れないので、招待は**リンクを手渡す**方式。
 *    発行時に1回だけ表示される URL を、管理者が本人へ渡す（口頭・Slack・LINE など）。
 *    サーバはトークンのハッシュしか保存していないので、閉じたら二度と表示できない。
 */

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'オーナー',
  ADMIN: '管理者',
  MEMBER: 'メンバー',
};

const ROLE_HELP: Record<Role, string> = {
  OWNER: '人の出し入れと、組織・請求先の変更ができます',
  ADMIN: '連携の接続・外部API・エージェントの設定・監査の閲覧ができます',
  MEMBER: 'チャット・エージェントの実行・成果物の閲覧ができます',
};

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
}

interface InvitationRow {
  id: string;
  email: string | null;
  role: string;
  expiresAt: string;
  createdAt: string;
}

function InviteResult({ token, onClose }: { token: string; onClose: () => void }) {
  const url = `${window.location.origin}/invite/${token}`;
  const [copied, setCopied] = useState(false);

  return (
    <Card variant="regular" padding="md" radius="2xl" className="space-y-2.5">
      <div className="flex items-start gap-2">
        <Link2 size={15} className="mt-0.5 flex-shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-primary">招待リンクを発行しました</p>
          <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
            このリンクを本人にお渡しください。
            <b className="text-secondary">閉じると二度と表示できません</b>
            （サーバには保存していません）。
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted hover:text-primary">
          <X size={13} />
        </button>
      </div>

      <p className="break-all rounded-md bg-sunken px-3 py-2 font-mono text-micro text-secondary">{url}</p>

      <Button
        size="sm"
        icon={<Copy size={12} />}
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? 'コピーしました' : 'リンクをコピー'}
      </Button>
    </Card>
  );
}

export function MembersSection() {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const isOwner = me?.role === 'OWNER';

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const membersQ = useQuery({
    queryKey: ['members'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: MemberRow[] }>('/members');
      return res.data.data;
    },
  });

  const invitesQ = useQuery({
    queryKey: ['member-invitations'],
    enabled: isOwner,
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: InvitationRow[] }>('/members/invitations');
      return res.data.data;
    },
  });

  function describeError(err: unknown, fallback: string): string {
    const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
    return data?.error?.message ?? fallback;
  }

  const inviteMut = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; data: { token: string } }>('/members/invitations', {
        email: inviteEmail.trim() || undefined,
        role: inviteRole,
      }),
    onSuccess: (res) => {
      setIssuedToken(res.data.data.token);
      setInviteEmail('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['member-invitations'] });
    },
    onError: (err) => setError(describeError(err, '招待を発行できませんでした')),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/members/invitations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['member-invitations'] }),
    onError: (err) => setError(describeError(err, '取り消せませんでした')),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'ADMIN' | 'MEMBER' }) =>
      api.patch(`/members/${id}/role`, { role }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => setError(describeError(err, '役割を変更できませんでした')),
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'DISABLED' }) =>
      api.patch(`/members/${id}/status`, { status }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => setError(describeError(err, '状態を変更できませんでした')),
  });

  const members = membersQ.data ?? [];
  const invitations = invitesQ.data ?? [];

  return (
    <div className="space-y-5">
      {/* ── 招待 ── */}
      {isOwner && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-primary">メンバーを招待する</h2>
          </div>

          <Card variant="regular" padding="md" radius="2xl" className="space-y-3">
            <div className="grid gap-2.5 sm:grid-cols-3">
              <Input
                size="sm"
                type="email"
                placeholder="招待する人のメールアドレス"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="sm:col-span-2"
              />
              <select
                className="rounded-sm border border-border bg-elevated px-3 py-2 text-xs text-primary"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'ADMIN' | 'MEMBER')}
                aria-label="役割"
              >
                <option value="MEMBER">メンバー</option>
                <option value="ADMIN">管理者</option>
              </select>
            </div>
            <p className="text-micro leading-relaxed text-text-muted">
              {ROLE_HELP[inviteRole]}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                loading={inviteMut.isPending}
                disabled={!inviteEmail.trim()}
                onClick={() => {
                  setError(null);
                  inviteMut.mutate();
                }}
              >
                招待リンクを発行
              </Button>
              <p className="text-micro text-text-muted">
                メールは送りません。発行したリンクをご本人にお渡しください。
              </p>
            </div>
          </Card>

          {issuedToken && <InviteResult token={issuedToken} onClose={() => setIssuedToken(null)} />}

          {invitations.length > 0 && (
            <Card variant="thin" padding="md" radius="2xl">
              <p className="mb-2 text-micro font-semibold uppercase tracking-[0.15em] text-muted">
                保留中の招待
              </p>
              <ul className="divide-y divide-hairline">
                {invitations.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-primary">
                      {inv.email ?? '（メール未設定）'}
                    </span>
                    <span className="text-micro text-text-muted">
                      {ROLE_LABEL[inv.role as Role] ?? inv.role}
                    </span>
                    <span className="tabular text-micro text-text-muted">
                      {new Date(inv.expiresAt).toLocaleDateString('ja-JP')}まで
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={revokeMut.isPending && revokeMut.variables === inv.id}
                      onClick={() => revokeMut.mutate(inv.id)}
                    >
                      取り消す
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      {/* ── メンバー一覧 ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-primary">メンバー</h2>
          <span className="tabular text-[11px] text-muted">{members.length} 人</span>
        </div>

        {membersQ.isLoading ? (
          <SkeletonList count={2} />
        ) : members.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="メンバーがいません" />
        ) : (
          <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
            <ul className="divide-y divide-hairline">
              {members.map((m) => {
                const role = m.role as Role;
                const disabled = m.status === 'DISABLED';
                const isSelf = m.id === me?.id;
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-primary">
                        {m.name}
                        {isSelf && <span className="ml-1.5 text-micro text-text-muted">（自分）</span>}
                      </p>
                      <p className="truncate text-micro text-text-muted">{m.email}</p>
                    </div>

                    {role === 'OWNER' ? (
                      <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-micro font-bold text-accent">
                        <ShieldCheck size={10} aria-hidden="true" />
                        {ROLE_LABEL.OWNER}
                      </span>
                    ) : isOwner && !isSelf ? (
                      <select
                        className="rounded-sm border border-border bg-elevated px-2 py-1 text-micro text-primary"
                        value={role}
                        onChange={(e) =>
                          roleMut.mutate({ id: m.id, role: e.target.value as 'ADMIN' | 'MEMBER' })
                        }
                        aria-label={`${m.name} の役割`}
                      >
                        <option value="MEMBER">メンバー</option>
                        <option value="ADMIN">管理者</option>
                      </select>
                    ) : (
                      <span className="text-micro text-secondary">{ROLE_LABEL[role] ?? m.role}</span>
                    )}

                    <span
                      className={`rounded-full px-2 py-0.5 text-micro font-bold ${
                        disabled ? 'bg-sunken text-ink-decorative' : 'bg-success/10 text-success'
                      }`}
                    >
                      {disabled ? '無効' : '有効'}
                    </span>

                    {isOwner && !isSelf && role !== 'OWNER' && (
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={statusMut.isPending && statusMut.variables?.id === m.id}
                        onClick={() =>
                          statusMut.mutate({ id: m.id, status: disabled ? 'ACTIVE' : 'DISABLED' })
                        }
                      >
                        {disabled ? '復帰させる' : '無効にする'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <p className="text-micro leading-relaxed text-text-muted">
          無効にした人はログインできなくなりますが、記録（誰が作ったか）は残ります。
          そのため削除ではなく無効化にしています。
        </p>
      </section>
    </div>
  );
}

export default MembersSection;
