import { prisma } from '../utils/prisma';

/**
 * 分析 KPI アラート（n8n 統合設計 A-6 / 監視系）。
 *
 * cron（n8n schedule WF `apps/n8n-workflows/analytics-alert.json` 等）から
 * POST /api/webhooks/n8n/kpi-alert-check で起動され、直近 24h の部署別 KPI を
 * 閾値判定して超過を RiskEvent として記録する（ガバナンス画面に表示される）。
 *
 * - コスト / p95 レイテンシ: usage-metrics-svc GET /metrics/departments から取得
 *   （svc 不達時はこの2軸をスキップし、失敗率のみ判定 = 読み取り専用の優雅な縮退）。
 * - 失敗率: Task の DONE/FAILED を DB から直接集計（メトリクス svc に依存しない）。
 * - Task の発火・LLM 呼び出しは一切しない（読み取り + RiskEvent 記録のみ）。
 */

export interface KpiAlertThresholds {
  /** 部署別 24h コスト上限 (USD)。 */
  maxCostUsd: number;
  /** 失敗率上限 (0-1)。母数 minExecutions 以上のときのみ判定。 */
  maxFailureRate: number;
  /** 失敗率・レイテンシ判定に必要な最小実行数（ノイズ防止）。 */
  minExecutions: number;
  /** p95 レイテンシ上限 (ms)。 */
  maxP95LatencyMs: number;
}

export function thresholdsFromEnv(): KpiAlertThresholds {
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxCostUsd: num(process.env.KPI_ALERT_MAX_COST_USD, 5),
    maxFailureRate: num(process.env.KPI_ALERT_MAX_FAILURE_RATE, 0.3),
    minExecutions: num(process.env.KPI_ALERT_MIN_EXECUTIONS, 5),
    maxP95LatencyMs: num(process.env.KPI_ALERT_MAX_P95_LATENCY_MS, 20_000),
  };
}

/** usage-metrics-svc /metrics/departments の1行（必要フィールドのみ）。 */
export interface MetricsDepartmentRow {
  department: string;
  calls: number;
  costUsd: number;
  p95LatencyMs: number;
}

/** Task 集計による部署別 成功/失敗数。 */
export interface DepartmentTaskStats {
  department: string;
  succeeded: number;
  failed: number;
}

export interface KpiAlert {
  department: string;
  kind: 'COST_SPIKE' | 'FAILURE_RATE' | 'LATENCY_P95';
  severity: 'MEDIUM' | 'HIGH';
  value: number;
  threshold: number;
  description: string;
}

/**
 * 部署別 KPI を閾値判定する純関数（テスト対象）。
 * metricsRows が null のとき（svc 不達）はコスト/レイテンシ判定をスキップする。
 */
export function evaluateDepartmentAlerts(
  metricsRows: MetricsDepartmentRow[] | null,
  taskStats: DepartmentTaskStats[],
  t: KpiAlertThresholds,
): KpiAlert[] {
  const alerts: KpiAlert[] = [];

  for (const row of metricsRows ?? []) {
    if (row.costUsd > t.maxCostUsd) {
      alerts.push({
        department: row.department,
        kind: 'COST_SPIKE',
        severity: row.costUsd > t.maxCostUsd * 2 ? 'HIGH' : 'MEDIUM',
        value: row.costUsd,
        threshold: t.maxCostUsd,
        description: `[KPIアラート] ${row.department}: 24hコスト $${row.costUsd.toFixed(2)} が閾値 $${t.maxCostUsd.toFixed(2)} を超過`,
      });
    }
    if (row.calls >= t.minExecutions && row.p95LatencyMs > t.maxP95LatencyMs) {
      alerts.push({
        department: row.department,
        kind: 'LATENCY_P95',
        severity: 'MEDIUM',
        value: row.p95LatencyMs,
        threshold: t.maxP95LatencyMs,
        description: `[KPIアラート] ${row.department}: p95レイテンシ ${row.p95LatencyMs}ms が閾値 ${t.maxP95LatencyMs}ms を超過`,
      });
    }
  }

  for (const s of taskStats) {
    const total = s.succeeded + s.failed;
    if (total < t.minExecutions) continue;
    const rate = s.failed / total;
    if (rate > t.maxFailureRate) {
      alerts.push({
        department: s.department,
        kind: 'FAILURE_RATE',
        severity: rate > 0.5 ? 'HIGH' : 'MEDIUM',
        value: rate,
        threshold: t.maxFailureRate,
        description: `[KPIアラート] ${s.department}: タスク失敗率 ${(rate * 100).toFixed(0)}% (${s.failed}/${total}) が閾値 ${(t.maxFailureRate * 100).toFixed(0)}% を超過`,
      });
    }
  }

  return alerts;
}

function metricsBaseUrl(): string {
  return (process.env.METRICS_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

/** usage-metrics-svc から部署別 KPI を取得。不達なら null（呼び出し側で縮退）。 */
async function fetchDepartmentMetrics(orgId: string, from: Date, to: Date): Promise<MetricsDepartmentRow[] | null> {
  const params = new URLSearchParams({
    tenant_id: orgId,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  try {
    const res = await fetch(`${metricsBaseUrl()}/metrics/departments?${params.toString()}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: { departments?: MetricsDepartmentRow[] } };
    if (!body.success || !body.data?.departments) return null;
    return body.data.departments;
  } catch {
    return null;
  }
}

/** Task の DONE/FAILED を部署別に集計（ウィンドウは updatedAt 基準）。 */
async function fetchTaskStats(orgId: string, from: Date): Promise<DepartmentTaskStats[]> {
  const grouped = await prisma.task.groupBy({
    by: ['department', 'status'],
    where: { orgId, status: { in: ['DONE', 'FAILED'] }, updatedAt: { gte: from } },
    _count: { _all: true },
  });
  const byDept = new Map<string, DepartmentTaskStats>();
  for (const g of grouped) {
    let s = byDept.get(g.department);
    if (!s) {
      s = { department: g.department, succeeded: 0, failed: 0 };
      byDept.set(g.department, s);
    }
    if (g.status === 'DONE') s.succeeded += g._count._all;
    else s.failed += g._count._all;
  }
  return [...byDept.values()];
}

export interface KpiAlertCheckResult {
  orgsChecked: number;
  alerts: (KpiAlert & { orgId: string })[];
  riskEventsCreated: number;
  /** metrics svc に到達できずコスト/レイテンシ判定をスキップした org。 */
  metricsUnavailableOrgs: string[];
}

/**
 * 全 org の KPI を閾値チェックし、超過を RiskEvent として記録する。
 * 同一 org × 種別 × 説明文の未解決 RiskEvent が窓内に既にあれば重複作成しない（cron 多重実行に冪等）。
 */
export async function runKpiAlertCheck(now: Date = new Date()): Promise<KpiAlertCheckResult> {
  const thresholds = thresholdsFromEnv();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const orgs = await prisma.organization.findMany({ select: { id: true } });

  const allAlerts: (KpiAlert & { orgId: string })[] = [];
  const metricsUnavailableOrgs: string[] = [];
  let riskEventsCreated = 0;

  for (const org of orgs) {
    const [metricsRows, taskStats] = await Promise.all([
      fetchDepartmentMetrics(org.id, from, now),
      fetchTaskStats(org.id, from),
    ]);
    if (metricsRows === null) metricsUnavailableOrgs.push(org.id);

    const alerts = evaluateDepartmentAlerts(metricsRows, taskStats, thresholds);
    for (const alert of alerts) {
      allAlerts.push({ ...alert, orgId: org.id });
      const type = alert.kind === 'COST_SPIKE' ? 'COST_ANOMALY' : 'ANOMALY';
      const existing = await prisma.riskEvent.findFirst({
        where: {
          orgId: org.id,
          type,
          description: alert.description,
          resolved: false,
          createdAt: { gte: from },
        },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.riskEvent.create({
        data: {
          orgId: org.id,
          type,
          description: alert.description,
          severity: alert.severity,
        },
      });
      riskEventsCreated += 1;
    }
  }

  return { orgsChecked: orgs.length, alerts: allAlerts, riskEventsCreated, metricsUnavailableOrgs };
}
