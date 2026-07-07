import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';

/** usage-metrics-svc GET /metrics/departments の1行（README/A-3 契約）。 */
export interface DepartmentMetricsRow {
  department: string;
  calls: number;
  tokens: number;
  costUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

interface DepartmentsReport {
  tenantId: string;
  from: string;
  to: string;
  departments: DepartmentMetricsRow[];
  unknownModels?: string[];
}

/**
 * dev 用の直叩き先。本番はゲートウェイ経由（/api/analytics/departments, B 配線後）
 * のみとし、未配線・未設定なら静かに無効化する（コスト等は「接続予定」表示のまま）。
 */
const DIRECT_METRICS_URL: string | undefined =
  (import.meta.env.VITE_METRICS_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:8080' : undefined);

/**
 * 部署別 LLM 使用メトリクス（calls/tokens/cost/latency）を取得する。
 * 1) ゲートウェイ /api/analytics/departments（JWT・本番経路。B 配線後に有効）
 * 2) 失敗時: VITE_METRICS_URL 直叩き（dev のみ既定 localhost:8080）
 * 両方失敗なら null — 呼び出し側はコスト等を「接続予定」のまま表示する。
 */
async function fetchDepartmentMetrics(orgId: string | null | undefined): Promise<DepartmentsReport | null> {
  try {
    const res = await api.get<{ data: DepartmentsReport }>('/analytics/departments');
    return res.data.data;
  } catch {
    // 未配線 (404) やゲートウェイ停止時は dev フォールバックへ
  }
  if (DIRECT_METRICS_URL && orgId) {
    try {
      const res = await axios.get<{ data: DepartmentsReport }>(
        `${DIRECT_METRICS_URL.replace(/\/+$/, '')}/metrics/departments`,
        { params: { tenant_id: orgId }, timeout: 5_000 },
      );
      return res.data.data;
    } catch {
      // svc も停止 → 未接続として扱う
    }
  }
  return null;
}

/** 部署別メトリクスフック。metrics=null は「未接続」（エラーではなく劣化運転）。 */
export function useDepartmentMetrics() {
  const orgId = useAuthStore((s) => s.user?.orgId);

  const query = useQuery({
    queryKey: ['analytics', 'department-metrics', orgId],
    queryFn: () => fetchDepartmentMetrics(orgId),
    refetchInterval: 60_000,
    retry: false, // フォールバック込みで1往復。未接続は正常系として扱う
  });

  return {
    metrics: query.data ?? null,
    isLoading: query.isLoading,
  };
}
