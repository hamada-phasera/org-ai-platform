import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, HelpCircle, ServerCog } from 'lucide-react';
import type { SetupHealth, SetupItem } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { Card, SkeletonList } from '../ui';

/**
 * 本番の設定が入っているかを、実際に確かめた結果で出す。
 *
 * ⚠️ オーナーにだけ見せる（サーバ側も requireOwner）。「トークン未設定」のような情報は
 *    攻撃側にとって有用なので、メンバーには出さない。
 * ⚠️ 秘密の値は一切返ってこない。状態と直し方だけ。
 */

const TONE: Record<SetupHealth, { text: string; icon: typeof CheckCircle2; label: string }> = {
  ok: { text: 'text-success', icon: CheckCircle2, label: '設定済み' },
  warn: { text: 'text-warning', icon: AlertCircle, label: '未設定' },
  error: { text: 'text-danger', icon: AlertCircle, label: '要対応' },
  unknown: { text: 'text-muted', icon: HelpCircle, label: '確認できず' },
};

const ORDER: Record<SetupHealth, number> = { error: 0, warn: 1, unknown: 2, ok: 3 };

export function SetupStatusCard() {
  const { data: items, isLoading } = useQuery({
    queryKey: ['setup-status'],
    queryFn: async () =>
      (await api.get<{ success: boolean; data: SetupItem[] }>('/organizations/me/setup')).data.data,
    // 設定の確認は保存先と AI エンジンに実際に触るので、開くたびには走らせない
    staleTime: 60 * 1000,
    retry: false,
  });

  if (isLoading) return <SkeletonList count={2} />;
  if (!items || items.length === 0) return null;

  const sorted = [...items].sort((a, b) => ORDER[a.health] - ORDER[b.health]);
  const needsWork = sorted.filter((i) => i.health !== 'ok').length;

  return (
    <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
      <div className="flex items-center gap-2 mb-4">
        <ServerCog size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-primary">セットアップ状況</h3>
        <span className="ml-auto text-xs text-muted">
          {needsWork === 0 ? 'すべて設定済み' : `${needsWork} 件が未対応`}
        </span>
      </div>

      <ul className="divide-y divide-hairline">
        {sorted.map((item) => {
          const tone = TONE[item.health];
          const Icon = tone.icon;
          return (
            <li key={item.key} className="flex items-start gap-3 py-3">
              <Icon size={15} className={`mt-0.5 flex-shrink-0 ${tone.text}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-primary">
                  {item.label}
                  <span className={`ml-2 text-xs ${tone.text}`}>{tone.label}</span>
                </p>
                {item.detail && <p className="mt-0.5 text-xs text-secondary leading-relaxed">{item.detail}</p>}
                {item.action && <p className="mt-1 text-xs text-muted leading-relaxed">→ {item.action}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-muted">オーナーにだけ表示されます。</p>
    </Card>
  );
}
