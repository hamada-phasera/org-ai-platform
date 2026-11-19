import { useQuery } from '@tanstack/react-query';
import type { OrganizationUsage, UsageState } from '@org-ai/shared-types';
import { api } from '../../services/api';

/**
 * 業務フローの利用状況（docs/design/canvas-home.md §7.6）。設定 > プラン の「ご契約」の下に 3 行。
 * フロー数（作れる数）・今月の実行・今月の部品の呼び出し。8 割で注意、上限で赤（新しい実行だけ止まる）。
 * 古い API（項目が無い）では何も出さない。
 */
export function FlowUsageRows() {
  const { data: usage } = useQuery({
    queryKey: ['organization-usage'],
    queryFn: async () =>
      (await api.get<{ success: boolean; data: OrganizationUsage }>('/organizations/me/usage')).data.data,
    staleTime: 30_000,
  });
  if (!usage?.flows || !usage.flowRuns || !usage.partCalls) return null;
  const flowsState: UsageState = usage.flows.count >= usage.flows.limit ? 'over' : 'ok';
  const rows: { label: string; used: number; limit: number; state: UsageState }[] = [
    { label: 'フロー', used: usage.flows.count, limit: usage.flows.limit, state: flowsState },
    { label: '実行', used: usage.flowRuns.used, limit: usage.flowRuns.limit, state: usage.flowRuns.state },
    { label: '部品', used: usage.partCalls.used, limit: usage.partCalls.limit, state: usage.partCalls.state },
  ];
  return (
    <dl className="mt-5 divide-y divide-border border-t border-border" aria-label="業務フローの利用状況">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between py-2.5">
          <dt className="text-sm text-secondary">{r.label}</dt>
          <dd
            className={`tabular font-mono text-sm ${r.state === 'over' ? 'text-danger' : r.state === 'warn' ? 'text-warning' : 'text-primary'}`}
          >
            {r.used.toLocaleString('ja-JP')} / {r.limit.toLocaleString('ja-JP')}
          </dd>
        </div>
      ))}
    </dl>
  );
}
