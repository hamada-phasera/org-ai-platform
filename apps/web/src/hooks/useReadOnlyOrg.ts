import { useQuery } from '@tanstack/react-query';
import type { BillingOverview } from '@org-ai/shared-types';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { usePlanNoticeStore } from '../store/planNoticeStore';
import { isReadOnly } from '../utils/planNotice';
import { useNow } from './useNow';

/** 閲覧のみのときにボタンへ添える理由（title と 1 行で使う） */
export const READ_ONLY_REASON = '閲覧のみです';

/**
 * いまの組織が「閲覧のみ」（書き込みが 402）か。判定は帯（`PlanNotice`）と同じ:
 * 402 を受けた印（planNoticeStore）か、取得済みの `GET /api/billing` が閲覧のみを指すとき。
 * 印の後に取り直した billing が「書ける」と言えばそちらを正とする。
 *
 * billing は印が付いたときだけ取りに行く（帯と同じキーなので重複しない）。普段はキャッシュを読むだけ。
 */
export function useReadOnlyOrg(): boolean {
  const orgId = useAuthStore((s) => s.user?.orgId ?? null);
  const readOnlyOrgId = usePlanNoticeStore((s) => s.readOnlyOrgId);
  const markedAt = usePlanNoticeStore((s) => s.markedAt);
  const flagged = !!orgId && readOnlyOrgId === orgId;
  const now = useNow();
  const { data: billing, dataUpdatedAt } = useQuery({
    queryKey: ['billing'],
    queryFn: async () => (await api.get<{ success: boolean; data: BillingOverview }>('/billing')).data.data,
    staleTime: 5 * 60_000,
    enabled: flagged,
  });
  const billingSaysReadOnly = !!billing && isReadOnly(billing, now);
  if (flagged) {
    const fresher = !!billing && dataUpdatedAt > markedAt;
    return !(fresher && !billingSaysReadOnly);
  }
  return billingSaysReadOnly;
}
