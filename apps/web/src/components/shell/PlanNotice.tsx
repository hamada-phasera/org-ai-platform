import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingOverview, OrganizationUsage } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { useNow } from '../../hooks/useNow';
import { useAuthStore } from '../../store/authStore';
import { usePlanNoticeStore } from '../../store/planNoticeStore';
import { BILLING_PATH, isReadOnly, planNoticeOf, planNoticeText } from '../../utils/planNotice';
import type { NoticeTone } from '../../utils/planNotice';

const TONE_TEXT: Record<NoticeTone, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-secondary',
};

/**
 * 本文の上の 1 行の帯（契約状態・上限）。PC とスマホの両方に出す。
 * 白地・下罫線・文言 1 文・リンク 1 つ。判定は utils/planNotice.ts の planNoticeOf だけ。
 */
export function PlanNotice() {
  const qc = useQueryClient();
  const orgId = useAuthStore((s) => s.user?.orgId ?? null);
  const readOnlyOrgId = usePlanNoticeStore((s) => s.readOnlyOrgId);
  const markedAt = usePlanNoticeStore((s) => s.markedAt);
  const now = useNow();

  const { data: billing, dataUpdatedAt } = useQuery({
    queryKey: ['billing'],
    queryFn: async () => (await api.get<{ success: boolean; data: BillingOverview }>('/billing')).data.data,
    staleTime: 5 * 60_000,
  });
  const { data: usage } = useQuery({
    queryKey: ['organization-usage'],
    queryFn: async () =>
      (await api.get<{ success: boolean; data: OrganizationUsage }>('/organizations/me/usage')).data.data,
    staleTime: 5 * 60_000,
  });

  // 402 を受けたら契約状態を取り直す（取り直した結果が正。別タブで契約した直後など）
  const flagged = !!orgId && readOnlyOrgId === orgId;
  useEffect(() => {
    if (flagged) void qc.invalidateQueries({ queryKey: ['billing'] });
  }, [flagged, markedAt, qc]);

  const fresherBilling = !!billing && dataUpdatedAt > markedAt;
  const readOnly = flagged && !(fresherBilling && !isReadOnly(billing, now));
  const notice = planNoticeOf(billing, usage, now, { readOnly });
  if (notice.kind === 'none') return null;

  const { text, tone } = planNoticeText(notice);
  return (
    <div
      role="status"
      data-notice={notice.kind}
      className="flex shrink-0 items-center gap-3 border-b border-border bg-elevated px-4 py-2 text-xs lg:px-6"
    >
      <p className={`min-w-0 flex-1 ${TONE_TEXT[tone]}`}>{text}</p>
      <Link to={BILLING_PATH} className="shrink-0 font-semibold text-accent hover:underline">
        プラン
      </Link>
    </div>
  );
}
