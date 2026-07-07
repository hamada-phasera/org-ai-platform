// A-4: KPI イベント発火テスト（A-1 スキーマ準拠・integration-requests #1 のローカルモック検証）
// 対象: apps/api-gateway/src/routes/analytics/kpi-events.ts（shared-types 昇格後も挙動仕様として有効）
import { describe, it, expect } from 'vitest';
import {
  normalizeDepartment,
  deriveCostUsd,
  kpiEventFromAILog,
  kpiEventFromTask,
  kpiEventFromExecutionLog,
  kpiEventFromRiskEvent,
  rollupDepartmentKpis,
  type KpiEvent,
} from '../../src/routes/analytics/kpi-events';

const T0 = '2026-07-07T09:00:00.000Z';
const T1 = '2026-07-07T09:00:30.000Z'; // T0 + 30s

describe('normalizeDepartment（正本5値への正規化）', () => {
  it('正常系: 正本コードはそのまま通す', () => {
    expect(normalizeDepartment('SALES')).toBe('SALES');
    expect(normalizeDepartment('MARKETING')).toBe('MARKETING');
    expect(normalizeDepartment('ANALYTICS')).toBe('ANALYTICS');
  });

  it('エッジ: レガシー日本語名をコードへ正規化（seed/実データ互換）', () => {
    expect(normalizeDepartment('営業部')).toBe('SALES');
    expect(normalizeDepartment('SNSマーケ部')).toBe('MARKETING');
    expect(normalizeDepartment('経理部')).toBe('ACCOUNTING');
  });

  it("エッジ: 'SNS' は正本に存在しない → GENERAL（analytics#2 の値域決定に整合）", () => {
    expect(normalizeDepartment('SNS')).toBe('GENERAL');
  });

  it('エッジ: null / 空 / 未知値 / 前後空白', () => {
    expect(normalizeDepartment(null)).toBe('GENERAL');
    expect(normalizeDepartment('')).toBe('GENERAL');
    expect(normalizeDepartment('unknown-dept')).toBe('GENERAL');
    expect(normalizeDepartment(' SALES ')).toBe('SALES');
  });
});

describe('deriveCostUsd（コスト導出 — usage-metrics-svc DefaultPricing と同値）', () => {
  it('正常系: family 別ブレンド単価 (USD/MTok)', () => {
    expect(deriveCostUsd('claude-haiku-4-5', 1_000_000)).toBeCloseTo(3.0);
    expect(deriveCostUsd('claude-sonnet-4-6', 1_000_000)).toBeCloseTo(9.0);
    expect(deriveCostUsd('claude-opus-4-8', 1_000_000)).toBeCloseTo(15.0);
    expect(deriveCostUsd('claude-fable-5', 1_000_000)).toBeCloseTo(30.0);
  });

  it('エッジ: tokens null → null（0 と区別・捏造しない）、0 → 0、未知モデル → fallback', () => {
    expect(deriveCostUsd('claude-haiku-4-5', null)).toBeNull();
    expect(deriveCostUsd('claude-haiku-4-5', 0)).toBe(0);
    expect(deriveCostUsd('gpt-x', 1_000_000)).toBeCloseTo(9.0); // fallback = sonnet 級
  });
});

describe('kpiEventFromAILog（llm.call 発火）', () => {
  const base = {
    id: 'log-1',
    orgId: 'org-1',
    department: '営業部',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    tokens: 2_000_000,
    latencyMs: 840,
    riskScore: 0.1,
    createdAt: T0,
  };

  it('正常系: kind/department 正規化/コスト導出/ISO occurredAt', () => {
    const e = kpiEventFromAILog(base);
    expect(e.kind).toBe('llm.call');
    expect(e.department).toBe('SALES');
    expect(e.costUsd).toBeCloseTo(6.0);
    expect(e.occurredAt).toBe(T0);
    expect(e.tokens).toBe(2_000_000);
    expect(e.latencyMs).toBe(840);
  });

  it('エッジ: tokens null → costUsd null（tokens は入出力合算・NULL 可の既知制約）', () => {
    const e = kpiEventFromAILog({ ...base, tokens: null });
    expect(e.tokens).toBeNull();
    expect(e.costUsd).toBeNull();
  });
});

describe('kpiEventFromTask（task.completed / task.failed 発火）', () => {
  const base = {
    id: 'task-1',
    orgId: 'org-1',
    department: 'MARKETING',
    status: 'DONE',
    taskType: 'sns_draft',
    agentId: 'agent-1',
    lastError: null,
    createdAt: T0,
    executedAt: T1,
    updatedAt: T1,
  };

  it('正常系: DONE → task.completed、latency = executedAt − createdAt', () => {
    const e = kpiEventFromTask(base);
    expect(e).not.toBeNull();
    expect(e!.kind).toBe('task.completed');
    if (e!.kind === 'task.completed') {
      expect(e!.latencyMs).toBe(30_000);
      expect(e!.occurredAt).toBe(T1);
    }
  });

  it('正常系: FAILED → task.failed、lastError を保持', () => {
    const e = kpiEventFromTask({ ...base, status: 'FAILED', lastError: 'n8n timeout', executedAt: null });
    expect(e!.kind).toBe('task.failed');
    if (e!.kind === 'task.failed') {
      expect(e!.lastError).toBe('n8n timeout');
    }
  });

  it('エッジ: 進行中 (PENDING/RUNNING) は発火しない', () => {
    expect(kpiEventFromTask({ ...base, status: 'PENDING' })).toBeNull();
    expect(kpiEventFromTask({ ...base, status: 'RUNNING' })).toBeNull();
  });

  it('エッジ: executedAt null → latency null（occurredAt は updatedAt へフォールバック）', () => {
    const e = kpiEventFromTask({ ...base, executedAt: null });
    if (e!.kind === 'task.completed') {
      expect(e!.latencyMs).toBeNull();
      expect(e!.occurredAt).toBe(T1);
    }
  });

  it('エッジ: executedAt < createdAt（時計ずれ）は latency null（負値を出さない）', () => {
    const e = kpiEventFromTask({ ...base, createdAt: T1, executedAt: T0 });
    if (e!.kind === 'task.completed') {
      expect(e!.latencyMs).toBeNull();
    }
  });
});

describe('kpiEventFromExecutionLog / kpiEventFromRiskEvent', () => {
  it('capability.executed: department 列が無い → GENERAL（#1 既知制約）', () => {
    const e = kpiEventFromExecutionLog({
      id: 'exec-1',
      orgId: 'org-1',
      capabilityId: 'cap-1',
      status: 'failure',
      errorType: 'TIMEOUT',
      createdAt: T0,
    });
    expect(e.kind).toBe('capability.executed');
    expect(e.department).toBe('GENERAL');
    expect(e.errorType).toBe('TIMEOUT');
  });

  it('risk.flagged: AILog 側で解決した department を正規化して採用', () => {
    const e = kpiEventFromRiskEvent(
      { id: 'risk-1', orgId: 'org-1', aiLogId: 'log-1', type: 'PII_DETECTED', severity: 'HIGH', createdAt: T0 },
      '経理部',
    );
    expect(e.kind).toBe('risk.flagged');
    expect(e.department).toBe('ACCOUNTING');
    expect(e.severity).toBe('HIGH');
  });
});

describe('rollupDepartmentKpis（部署別ロールアップ — A-1 DepartmentKpi 準拠）', () => {
  function ev(partial: Partial<KpiEvent> & Pick<KpiEvent, 'kind' | 'department'>): KpiEvent {
    return {
      id: 'e',
      orgId: 'org-1',
      occurredAt: T0,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokens: null,
      latencyMs: null,
      riskScore: null,
      costUsd: null,
      taskId: 't',
      agentId: null,
      taskType: null,
      lastError: null,
      capabilityId: null,
      status: 'success',
      errorType: null,
      riskType: 'ANOMALY',
      severity: 'LOW',
      aiLogId: null,
      ...partial,
    } as KpiEvent;
  }

  it('正常系: 成功率・コスト合計・平均レイテンシ・リスク件数を部署別に集計', () => {
    const events: KpiEvent[] = [
      ev({ kind: 'task.completed', department: 'SALES', latencyMs: 10_000 }),
      ev({ kind: 'task.completed', department: 'SALES', latencyMs: 20_000 }),
      ev({ kind: 'task.failed', department: 'SALES' }),
      ev({ kind: 'llm.call', department: 'SALES', costUsd: 1.5, latencyMs: 600 }),
      ev({ kind: 'risk.flagged', department: 'SALES' }),
      ev({ kind: 'task.completed', department: 'MARKETING' }),
    ];
    const rows = rollupDepartmentKpis(events);

    expect(rows[0].department).toBe('SALES'); // executions desc
    expect(rows[0].executions).toBe(3);
    expect(rows[0].succeeded).toBe(2);
    expect(rows[0].failed).toBe(1);
    expect(rows[0].successRate).toBeCloseTo(2 / 3);
    expect(rows[0].costUsd).toBeCloseTo(1.5);
    expect(rows[0].avgLatencyMs).toBe(Math.round((10_000 + 20_000 + 600) / 3));
    expect(rows[0].riskEvents).toBe(1);

    expect(rows[1].department).toBe('MARKETING');
    expect(rows[1].successRate).toBe(1);
  });

  it('エッジ: タスク実行が無い部署の successRate は null（0% と区別）', () => {
    const rows = rollupDepartmentKpis([ev({ kind: 'llm.call', department: 'ANALYTICS', costUsd: 0.2 })]);
    expect(rows[0].executions).toBe(0);
    expect(rows[0].successRate).toBeNull();
    expect(rows[0].costUsd).toBeCloseTo(0.2);
  });

  it('エッジ: コスト情報が1件も無い部署の costUsd は null（0 と区別）', () => {
    const rows = rollupDepartmentKpis([ev({ kind: 'task.completed', department: 'SALES' })]);
    expect(rows[0].costUsd).toBeNull();
    expect(rows[0].avgLatencyMs).toBeNull();
  });

  it('エッジ: 空入力は空配列', () => {
    expect(rollupDepartmentKpis([])).toEqual([]);
  });

  it('エッジ: 同数 executions は department 名 asc で安定ソート', () => {
    const rows = rollupDepartmentKpis([
      ev({ kind: 'task.completed', department: 'SALES' }),
      ev({ kind: 'task.completed', department: 'MARKETING' }),
    ]);
    expect(rows.map((r) => r.department)).toEqual(['MARKETING', 'SALES']);
  });
});
