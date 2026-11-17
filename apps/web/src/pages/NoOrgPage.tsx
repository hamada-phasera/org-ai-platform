import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import type { MembershipSummary } from '@org-ai/shared-types';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { switchOrg } from '../services/session';
import { sessionDeps } from '../services/sessionDeps';
import { Button, Card } from '../components/ui';
import { CreateOrgDialog } from '../components/org/CreateOrgDialog';

/**
 * 所属している組織が無いとき（docs/design/multi-tenancy.md UC7）。
 * 唯一の組織から外された人・組織を作る前の人がここに来る。招待を受けるか、新しい組織を作る。
 */
export default function NoOrgPage() {
  const [creating, setCreating] = useState(false);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // 別の組織に招待されて戻ってきた場合など、所属があればそこに入れる
  const { data: memberships } = useQuery<MembershipSummary[]>({
    queryKey: ['memberships'],
    queryFn: async () => (await api.get<{ data: MembershipSummary[] }>('/auth/memberships')).data.data,
  });

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card variant="regular" padding="lg" radius="2xl" className="w-full max-w-md space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft">
          <Building2 size={20} className="text-accent" aria-hidden="true" />
        </div>
        <h1 className="text-body font-semibold text-primary">所属している組織がありません</h1>
        <p className="text-sm leading-relaxed text-muted">
          招待リンクを受け取っている場合は、そのリンクを開いて参加してください。新しく始める場合は組織を作成します。
        </p>
        {memberships && memberships.length > 0 && (
          <div className="space-y-2 text-left">
            {memberships.map((m) => (
              <Button key={m.orgId} variant="secondary" fullWidth onClick={() => void switchOrg(sessionDeps, m.orgId)}>
                {m.orgName} に入る
              </Button>
            ))}
          </div>
        )}
        <Button fullWidth onClick={() => setCreating(true)}>
          新しい組織を作成
        </Button>
        <Button
          variant="secondary"
          fullWidth
          onClick={() => {
            logout();
            navigate('/login', { replace: true });
          }}
        >
          ログアウト
        </Button>
      </Card>
      {creating && <CreateOrgDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
