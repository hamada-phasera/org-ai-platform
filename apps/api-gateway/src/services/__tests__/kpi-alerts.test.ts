import { describe, it, expect } from 'vitest';

// 純関数のみを対象にするため prisma 依存はモック（import 時の DATABASE_URL 要求を回避）。
import { vi } from 'vitest';
vi.mock('../../utils/prisma', () => ({ prisma: {} }));

const { evaluateDepartmentAlerts } = await import('../kpi-alerts');

const T = { maxCostUsd: 5, maxFailureRate: 0.3, minExecutions: 5, maxP95LatencyMs: 20_000 };

describe('evaluateDepartmentAlerts', () => {
  it('正常系: 閾値内なら空配列', () => {
    const alerts = evaluateDepartmentAlerts(
      [{ department: 'SALES', calls: 10, costUsd: 1.2, p95LatencyMs: 3000 }],
      [{ department: 'SALES', succeeded: 9, failed: 1 }],
      T,
    );
    expect(alerts).toEqual([]);
  });

  it('コスト超過: 閾値超で MEDIUM、2倍超で HIGH', () => {
    const med = evaluateDepartmentAlerts(
      [{ department: 'SALES', calls: 10, costUsd: 6, p95LatencyMs: 0 }],
      [],
      T,
    );
    expect(med).toHaveLength(1);
    expect(med[0]).toMatchObject({ kind: 'COST_SPIKE', severity: 'MEDIUM', department: 'SALES' });

    const high = evaluateDepartmentAlerts(
      [{ department: 'MARKETING', calls: 10, costUsd: 12, p95LatencyMs: 0 }],
      [],
      T,
    );
    expect(high[0]).toMatchObject({ kind: 'COST_SPIKE', severity: 'HIGH' });
    expect(high[0].description).toContain('MARKETING');
  });

  it('失敗率: 母数が minExecutions 未満なら判定しない・超過で FAILURE_RATE', () => {
    // 母数4 (< 5) → ノイズとして無視
    const few = evaluateDepartmentAlerts(null, [{ department: 'SALES', succeeded: 1, failed: 3 }], T);
    expect(few).toEqual([]);

    // 母数10・失敗率40% → MEDIUM
    const med = evaluateDepartmentAlerts(null, [{ department: 'SALES', succeeded: 6, failed: 4 }], T);
    expect(med[0]).toMatchObject({ kind: 'FAILURE_RATE', severity: 'MEDIUM' });

    // 失敗率60% → HIGH
    const high = evaluateDepartmentAlerts(null, [{ department: 'SALES', succeeded: 4, failed: 6 }], T);
    expect(high[0]).toMatchObject({ kind: 'FAILURE_RATE', severity: 'HIGH' });
  });

  it('p95 レイテンシ: calls が minExecutions 以上のときのみ判定', () => {
    const ignored = evaluateDepartmentAlerts(
      [{ department: 'ANALYTICS', calls: 2, costUsd: 0, p95LatencyMs: 60_000 }],
      [],
      T,
    );
    expect(ignored).toEqual([]);

    const hit = evaluateDepartmentAlerts(
      [{ department: 'ANALYTICS', calls: 8, costUsd: 0, p95LatencyMs: 60_000 }],
      [],
      T,
    );
    expect(hit[0]).toMatchObject({ kind: 'LATENCY_P95', severity: 'MEDIUM' });
  });

  it('metrics svc 不達 (null): コスト/レイテンシはスキップし失敗率のみ判定（優雅な縮退）', () => {
    const alerts = evaluateDepartmentAlerts(null, [{ department: 'GENERAL', succeeded: 0, failed: 10 }], T);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('FAILURE_RATE');
  });
});
