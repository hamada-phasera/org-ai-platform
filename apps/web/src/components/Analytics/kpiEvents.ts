/**
 * KPI イベントスキーマ v1 — ローカルモック（提案中 / integration-requests #1）
 *
 * ⚠️ これは「正本」ではありません。統合フェーズ B で `@org-ai/shared-types` へ昇格される
 * までの暫定モックです。昇格後は import を差し替えてください（このファイルは削除）。
 *
 * 設計は DB 実態（AILog / Task / ExecutionLog / RiskEvent）から**導出可能な範囲のみ**。
 * 詳細な制約は docs/integration-requests.md #1 を参照。R1 では発火しません（提案のみ）。
 */
import type { AgentDepartment, RiskType, RiskSeverity } from '@org-ai/shared-types';

/** 全 KPI イベント共通のベース。occurredAt は ISO 文字列。 */
export interface KpiEventBase {
  id: string;
  orgId: string;
  department: AgentDepartment;
  occurredAt: string;
}

/** LLM 呼び出し（source: AILog）。costUsd は導出値（下記 deriveCostUsd）。 */
export interface LlmCallEvent extends KpiEventBase {
  kind: 'llm.call';
  provider: string;
  model: string;
  tokens: number | null; // AILog.tokens（入出力合算・NULL 可）
  latencyMs: number | null;
  riskScore: number | null;
  costUsd: number | null; // 導出値。コストカラムは DB に存在しない。
}

/** タスク完了（source: Task.status='DONE'）。latencyMs は executedAt-createdAt 導出。 */
export interface TaskCompletedEvent extends KpiEventBase {
  kind: 'task.completed';
  taskId: string;
  agentId: string | null;
  taskType: string | null;
  latencyMs: number | null;
}

/** タスク失敗（source: Task.status='FAILED'）。 */
export interface TaskFailedEvent extends KpiEventBase {
  kind: 'task.failed';
  taskId: string;
  agentId: string | null;
  taskType: string | null;
  lastError: string | null;
}

/**
 * 能力実行（source: ExecutionLog）。
 * 注: ExecutionLog に department が無いため、現状 department は GENERAL/不明になりうる。
 */
export interface CapabilityExecutedEvent extends KpiEventBase {
  kind: 'capability.executed';
  capabilityId: string | null;
  status: string; // success / failure など（ExecutionLog.status は自由文字列）
  errorType: string | null;
}

/** リスク検知（source: RiskEvent）。 */
export interface RiskFlaggedEvent extends KpiEventBase {
  kind: 'risk.flagged';
  riskType: RiskType;
  severity: RiskSeverity;
  aiLogId: string | null;
}

export type KpiEvent =
  | LlmCallEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | CapabilityExecutedEvent
  | RiskFlaggedEvent;

export type KpiEventKind = KpiEvent['kind'];

/**
 * 部署別 KPI ロールアップ形（A-2 の画面 / A-3 の集計 API が共通で返す想定）。
 * successRate / costUsd / avgLatencyMs はデータ不足時 null（数値を捏造しない）。
 */
export interface DepartmentKpi {
  department: AgentDepartment;
  executions: number;
  succeeded: number;
  failed: number;
  successRate: number | null; // succeeded / (succeeded + failed)、母数0なら null
  costUsd: number | null;
  avgLatencyMs: number | null;
  riskEvents: number;
}

/**
 * モデル別の暫定コストレート（USD / 1K tokens・入出力ブレンド概算）。
 * ⚠️ placeholder。正式なレート表は人間確認のうえ統合フェーズで確定する（#1 参照）。
 * AILog.tokens は入出力合算のため、本来の入力/出力別課金は近似になる点に注意。
 */
export const PLACEHOLDER_MODEL_RATE_USD_PER_1K: Record<'haiku' | 'sonnet' | 'opus' | 'default', number> = {
  haiku: 0.004,
  sonnet: 0.012,
  opus: 0.06,
  default: 0.012,
};

/**
 * トークン数からコスト(USD)を導出する（提案中の導出ロジック）。
 * tokens が null の場合は null を返す（不明を数値で埋めない）。
 */
export function deriveCostUsd(model: string, tokens: number | null): number | null {
  if (tokens == null) return null;
  const m = model.toLowerCase();
  const rate = m.includes('haiku')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.haiku
    : m.includes('sonnet')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.sonnet
    : m.includes('opus')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.opus
    : PLACEHOLDER_MODEL_RATE_USD_PER_1K.default;
  return (tokens / 1000) * rate;
}
