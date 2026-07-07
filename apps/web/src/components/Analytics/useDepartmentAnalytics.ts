import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { DEPARTMENTS, DEPT_LABEL, DEPT_ACCENT } from '../../constants/departments';
import type { EfficiencyResponse, DepartmentRow } from './types';

const FALLBACK_ACCENT = '#475569';

export interface DepartmentAnalytics {
  rows: DepartmentRow[];
  totals: {
    executions: number;
    minutesSaved: number;
    hoursSaved: number;
    activeDepartments: number;
  };
}

/**
 * /dashboard/efficiency の byDepartment を、正本の5部署（＋APIに現れた未知/legacy部署）に
 * 揃えて行に変換する。実行数0の部署も0で表示する（欠落させない）。
 */
export function toDepartmentAnalytics(eff: EfficiencyResponse): DepartmentAnalytics {
  const byDept = new Map<string, { minutesSaved: number; tasks: number }>();
  for (const d of eff.byDepartment ?? []) {
    const key = d.department || 'GENERAL';
    const prev = byDept.get(key) ?? { minutesSaved: 0, tasks: 0 };
    byDept.set(key, { minutesSaved: prev.minutesSaved + d.minutesSaved, tasks: prev.tasks + d.tasks });
  }

  const canonical = DEPARTMENTS.map((d) => d.key);
  const extras = [...byDept.keys()].filter((k) => !canonical.includes(k));
  const order = [...canonical, ...extras];

  const totalExec = order.reduce((sum, k) => sum + (byDept.get(k)?.tasks ?? 0), 0);

  const rows: DepartmentRow[] = order.map((key) => {
    const agg = byDept.get(key) ?? { minutesSaved: 0, tasks: 0 };
    return {
      department: key,
      label: DEPT_LABEL[key] ?? key,
      accent: DEPT_ACCENT[key] ?? FALLBACK_ACCENT,
      executions: agg.tasks,
      minutesSaved: agg.minutesSaved,
      share: totalExec > 0 ? agg.tasks / totalExec : 0,
      costUsd: null, // A-3 で接続
      successRate: null, // A-3 で接続
    };
  });

  return {
    rows,
    totals: {
      executions: totalExec,
      minutesSaved: rows.reduce((sum, r) => sum + r.minutesSaved, 0),
      hoursSaved: eff.allTime?.hoursSaved ?? 0,
      activeDepartments: rows.filter((r) => r.executions > 0).length,
    },
  };
}

/** 部署別分析データを read-only で取得するフック（既存 dashboard API を流用）。 */
export function useDepartmentAnalytics() {
  const query = useQuery({
    queryKey: ['analytics', 'department-efficiency'],
    queryFn: async () =>
      (await api.get<{ data: EfficiencyResponse }>('/dashboard/efficiency')).data.data,
    refetchInterval: 60_000,
  });

  return {
    analytics: query.data ? toDepartmentAnalytics(query.data) : null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
