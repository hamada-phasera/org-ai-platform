/**
 * KPI イベントスキーマ v1 — 正本は `@org-ai/shared-types`（昇格済み）。
 *
 * このファイルは型を re-export し、フロント固有のコスト導出ヘルパーだけを保持する。
 * 設計は DB 実態（AILog / Task / ExecutionLog / RiskEvent）から**導出可能な範囲のみ**。
 */
import type {
  KpiEvent,
  KpiEventBase,
  LlmCallEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  CapabilityExecutedEvent,
  RiskFlaggedEvent,
  DepartmentKpi,
} from '@org-ai/shared-types';

export type {
  KpiEvent,
  KpiEventBase,
  LlmCallEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  CapabilityExecutedEvent,
  RiskFlaggedEvent,
  DepartmentKpi,
};

export type KpiEventKind = KpiEvent['kind'];

/**
 * モデル別の暫定コストレート（USD / 1K tokens・入出力ブレンド概算）。
 * ⚠️ placeholder。正式なレート表は人間確認のうえ確定する。
 * AILog.tokens は入出力合算のため、本来の入力/出力別課金は近似になる点に注意。
 */
export const PLACEHOLDER_MODEL_RATE_USD_PER_1K: Record<
  'haiku' | 'sonnet' | 'opus' | 'fable' | 'gemini' | 'default',
  number
> = {
  // usage-metrics-svc DefaultPricing（ブレンド USD/MTok: haiku 3 / sonnet 9 /
  // opus 15 / fable 30, gemini 0(無料枠), fallback 9）を 1K あたりに換算した同一値。
  // サービス側を単一の真実とする。
  haiku: 0.003,
  sonnet: 0.009,
  opus: 0.015,
  fable: 0.03,
  gemini: 0, // 梅/竹 = Gemini 無料枠（松竹梅ルーティング）
  default: 0.009,
};

/**
 * トークン数からコスト(USD)を導出する。
 * tokens が null の場合は null を返す（不明を数値で埋めない）。
 * family 部分一致は高額優先（usage-metrics-svc と同じ決定規則）。
 */
export function deriveCostUsd(model: string, tokens: number | null): number | null {
  if (tokens == null) return null;
  const m = model.toLowerCase();
  const rate = m.includes('fable')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.fable
    : m.includes('opus')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.opus
    : m.includes('sonnet')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.sonnet
    : m.includes('haiku')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.haiku
    : m.includes('gemini')
    ? PLACEHOLDER_MODEL_RATE_USD_PER_1K.gemini
    : PLACEHOLDER_MODEL_RATE_USD_PER_1K.default;
  return (tokens / 1000) * rate;
}
