// KPI イベント発火モジュール (A-4) — A-1 スキーマ準拠のローカルモック実装。
//
// ⚠️ 型の正本は integration-requests #1 の提案（統合フェーズ B で
// packages/shared-types へ昇格予定）。昇格後はこのローカル型を import に差し替える。
// フロント側ミラー: apps/web/src/components/Analytics/kpiEvents.ts
//
// 「発火」= 既存レコード（AILog / Task / ExecutionLog / RiskEvent）から
// KPI イベントを構築する純関数群。DB への書き込みは行わない（read-only 設計）。
// コスト単価は usage-metrics-svc の DefaultPricing と同一値
// （ブレンド USD/MTok: haiku 3.0 / sonnet 9.0 / opus 15.0 / fable 30.0, fallback 9.0）。

// ---- 部署語彙（shared-types AgentDepartment のローカルミラー） ----

export type AgentDepartment = 'SALES' | 'MARKETING' | 'ACCOUNTING' | 'ANALYTICS' | 'GENERAL';

export const AGENT_DEPARTMENTS: AgentDepartment[] = [
  'SALES',
  'MARKETING',
  'ACCOUNTING',
  'ANALYTICS',
  'GENERAL',
];

/** レガシー日本語部署名 → 正本コードの正規化表（DB の department は自由文字列のため）。 */
const LEGACY_DEPARTMENT_ALIASES: Record<string, AgentDepartment> = {
  営業部: 'SALES',
  マーケ部: 'MARKETING',
  SNSマーケ部: 'MARKETING',
  経理部: 'ACCOUNTING',
  データ分析: 'ANALYTICS',
  総合: 'GENERAL',
  総合AI: 'GENERAL',
};

/**
 * 自由文字列の department を正本5値に正規化する。
 * 未知の値は GENERAL に落とす（集計から欠落させない・新値を勝手に増やさない）。
 */
export function normalizeDepartment(raw: string | null | undefined): AgentDepartment {
  if (!raw) return 'GENERAL';
  const trimmed = raw.trim();
  if ((AGENT_DEPARTMENTS as string[]).includes(trimmed)) return trimmed as AgentDepartment;
  return LEGACY_DEPARTMENT_ALIASES[trimmed] ?? 'GENERAL';
}

// ---- KPI イベント型（A-1 提案の discriminated union・ローカルモック） ----

export interface KpiEventBase {
  id: string;
  orgId: string;
  department: AgentDepartment;
  occurredAt: string; // ISO 8601
}

export interface LlmCallEvent extends KpiEventBase {
  kind: 'llm.call';
  provider: string;
  model: string;
  tokens: number | null;
  latencyMs: number | null;
  riskScore: number | null;
  costUsd: number | null; // 導出値（DB にコスト列は無い）
}

export interface TaskCompletedEvent extends KpiEventBase {
  kind: 'task.completed';
  taskId: string;
  agentId: string | null;
  taskType: string | null;
  latencyMs: number | null; // executedAt − createdAt の導出
}

export interface TaskFailedEvent extends KpiEventBase {
  kind: 'task.failed';
  taskId: string;
  agentId: string | null;
  taskType: string | null;
  lastError: string | null;
}

export interface CapabilityExecutedEvent extends KpiEventBase {
  kind: 'capability.executed';
  capabilityId: string | null;
  status: string;
  errorType: string | null;
}

export interface RiskFlaggedEvent extends KpiEventBase {
  kind: 'risk.flagged';
  riskType: string;
  severity: string;
  aiLogId: string | null;
}

export type KpiEvent =
  | LlmCallEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | CapabilityExecutedEvent
  | RiskFlaggedEvent;

/** 部署別ロールアップ（A-1 提案の DepartmentKpi）。母数0の率・データ無しの値は null。 */
export interface DepartmentKpi {
  department: AgentDepartment;
  executions: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  costUsd: number | null;
  avgLatencyMs: number | null;
  riskEvents: number;
}

// ---- コスト導出（usage-metrics-svc DefaultPricing と同一値） ----

/** ブレンド単価 USD / 1M tokens。正式単価表は統合フェーズで確定（#1）。 */
export const BLENDED_RATE_USD_PER_MTOK: Record<'haiku' | 'sonnet' | 'opus' | 'fable' | 'fallback', number> = {
  fable: 30.0,
  opus: 15.0,
  sonnet: 9.0,
  haiku: 3.0,
  fallback: 9.0,
};

/** モデル名（family 部分一致・高額優先）からコスト USD を導出。tokens null → null。 */
export function deriveCostUsd(model: string, tokens: number | null): number | null {
  if (tokens == null) return null;
  if (tokens <= 0) return 0;
  const m = model.toLowerCase();
  const rate = m.includes('fable')
    ? BLENDED_RATE_USD_PER_MTOK.fable
    : m.includes('opus')
    ? BLENDED_RATE_USD_PER_MTOK.opus
    : m.includes('sonnet')
    ? BLENDED_RATE_USD_PER_MTOK.sonnet
    : m.includes('haiku')
    ? BLENDED_RATE_USD_PER_MTOK.haiku
    : BLENDED_RATE_USD_PER_MTOK.fallback;
  return (tokens / 1_000_000) * rate;
}

// ---- 発火（構築）関数 ----

function toIso(d: Date | string): string {
  return typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
}

/** AILog レコード（Prisma AILog の必要列のみの構造型）。 */
export interface AILogRecord {
  id: string;
  orgId: string;
  department: string;
  provider: string;
  model: string;
  tokens: number | null;
  latencyMs: number | null;
  riskScore: number | null;
  createdAt: Date | string;
}

export function kpiEventFromAILog(log: AILogRecord): LlmCallEvent {
  return {
    kind: 'llm.call',
    id: log.id,
    orgId: log.orgId,
    department: normalizeDepartment(log.department),
    occurredAt: toIso(log.createdAt),
    provider: log.provider,
    model: log.model,
    tokens: log.tokens,
    latencyMs: log.latencyMs,
    riskScore: log.riskScore,
    costUsd: deriveCostUsd(log.model, log.tokens),
  };
}

/** Task レコード（必要列のみ）。 */
export interface TaskRecord {
  id: string;
  orgId: string;
  department: string;
  status: string; // PENDING | RUNNING | DONE | FAILED（自由文字列）
  taskType: string | null;
  agentId: string | null;
  lastError: string | null;
  createdAt: Date | string;
  executedAt: Date | string | null;
  updatedAt: Date | string;
}

/**
 * Task から KPI イベントを発火する。終端状態（DONE/FAILED）のみ発火し、
 * 進行中（PENDING/RUNNING 等）は null（イベント無し）。
 */
export function kpiEventFromTask(task: TaskRecord): TaskCompletedEvent | TaskFailedEvent | null {
  const department = normalizeDepartment(task.department);
  if (task.status === 'DONE') {
    let latencyMs: number | null = null;
    if (task.executedAt != null) {
      const started = new Date(task.createdAt).getTime();
      const executed = new Date(task.executedAt).getTime();
      if (Number.isFinite(started) && Number.isFinite(executed) && executed >= started) {
        latencyMs = executed - started;
      }
    }
    return {
      kind: 'task.completed',
      id: task.id,
      orgId: task.orgId,
      department,
      occurredAt: toIso(task.executedAt ?? task.updatedAt),
      taskId: task.id,
      agentId: task.agentId,
      taskType: task.taskType,
      latencyMs,
    };
  }
  if (task.status === 'FAILED') {
    return {
      kind: 'task.failed',
      id: task.id,
      orgId: task.orgId,
      department,
      occurredAt: toIso(task.updatedAt),
      taskId: task.id,
      agentId: task.agentId,
      taskType: task.taskType,
      lastError: task.lastError,
    };
  }
  return null;
}

/** ExecutionLog レコード（必要列のみ）。department 列が無いため常に GENERAL。 */
export interface ExecutionLogRecord {
  id: string;
  orgId: string;
  capabilityId: string | null;
  status: string;
  errorType: string | null;
  createdAt: Date | string;
}

export function kpiEventFromExecutionLog(exec: ExecutionLogRecord): CapabilityExecutedEvent {
  return {
    kind: 'capability.executed',
    id: exec.id,
    orgId: exec.orgId,
    department: 'GENERAL', // ExecutionLog に department 列が無い（#1 の既知制約）
    occurredAt: toIso(exec.createdAt),
    capabilityId: exec.capabilityId,
    status: exec.status,
    errorType: exec.errorType,
  };
}

/** RiskEvent レコード（必要列のみ）。department は AILog 側から解決して渡す。 */
export interface RiskEventRecord {
  id: string;
  orgId: string;
  aiLogId: string | null;
  type: string;
  severity: string;
  createdAt: Date | string;
}

export function kpiEventFromRiskEvent(
  risk: RiskEventRecord,
  department: string | null | undefined,
): RiskFlaggedEvent {
  return {
    kind: 'risk.flagged',
    id: risk.id,
    orgId: risk.orgId,
    department: normalizeDepartment(department),
    occurredAt: toIso(risk.createdAt),
    riskType: risk.type,
    severity: risk.severity,
    aiLogId: risk.aiLogId,
  };
}

// ---- 部署別ロールアップ ----

/**
 * KPI イベント列を部署別 KPI に畳み込む。
 * - executions = task.completed + task.failed の件数
 * - successRate = succeeded / (succeeded + failed)。母数0なら null（0% と区別）
 * - costUsd = llm.call の costUsd 合計。コスト情報が1件も無ければ null
 * - avgLatencyMs = llm.call / task.completed の非 null latency の平均。無ければ null
 * - riskEvents = risk.flagged の件数
 * 出力は executions desc → department asc で安定ソート。
 */
export function rollupDepartmentKpis(events: KpiEvent[]): DepartmentKpi[] {
  interface Acc {
    succeeded: number;
    failed: number;
    costUsd: number;
    hasCost: boolean;
    latSum: number;
    latCount: number;
    riskEvents: number;
  }
  const acc = new Map<AgentDepartment, Acc>();
  const get = (d: AgentDepartment): Acc => {
    let a = acc.get(d);
    if (!a) {
      a = { succeeded: 0, failed: 0, costUsd: 0, hasCost: false, latSum: 0, latCount: 0, riskEvents: 0 };
      acc.set(d, a);
    }
    return a;
  };

  for (const e of events) {
    const a = get(e.department);
    switch (e.kind) {
      case 'llm.call':
        if (e.costUsd != null) {
          a.costUsd += e.costUsd;
          a.hasCost = true;
        }
        if (e.latencyMs != null) {
          a.latSum += e.latencyMs;
          a.latCount += 1;
        }
        break;
      case 'task.completed':
        a.succeeded += 1;
        if (e.latencyMs != null) {
          a.latSum += e.latencyMs;
          a.latCount += 1;
        }
        break;
      case 'task.failed':
        a.failed += 1;
        break;
      case 'capability.executed':
      case 'risk.flagged':
        if (e.kind === 'risk.flagged') a.riskEvents += 1;
        break;
    }
  }

  const rows: DepartmentKpi[] = [...acc.entries()].map(([department, a]) => {
    const denominator = a.succeeded + a.failed;
    return {
      department,
      executions: denominator,
      succeeded: a.succeeded,
      failed: a.failed,
      successRate: denominator > 0 ? a.succeeded / denominator : null,
      costUsd: a.hasCost ? a.costUsd : null,
      avgLatencyMs: a.latCount > 0 ? Math.round(a.latSum / a.latCount) : null,
      riskEvents: a.riskEvents,
    };
  });

  rows.sort((x, y) => {
    if (x.executions !== y.executions) return y.executions - x.executions;
    return x.department < y.department ? -1 : x.department > y.department ? 1 : 0;
  });
  return rows;
}
