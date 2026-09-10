// Agent.steps を React Flow のノード/エッジへ写像する pure 関数群。
//
// キャンバスは読み取り専用。位置は永続化せず index から導出する
// （データは steps[] の順序だけ、という前提を崩さないため）。
// 実行エンジンが線形なので、描くのも必ず1本の縦チェーンにする。

import type { AgentRunState, AgentStepDef, StepStatus } from '@org-ai/shared-types';
import { APPROVAL_REQUIRED_CAPS, LLM_TRANSFORM_STEP } from '@org-ai/shared-types';

/** ノード1つの縦間隔（px）。ノードの高さ + 余白。 */
export const NODE_GAP = 132;
export const NODE_WIDTH = 300;

/** capability レジストリから引ける表示情報。無い capability も描けるようにする。 */
export interface CapabilityMeta {
  name: string;
  displayName: string;
  description?: string;
  /** 'n8n' | 'native' | 'http'。http かつ非 GET は承認必須になる（Phase 3） */
  kind?: string | null;
  /** カスタム HTTP ノードのメソッド。承認要否の判定に使う */
  httpMethod?: string | null;
}

export interface StepNodeData extends Record<string, unknown> {
  index: number;
  capabilityName: string;
  label: string;
  /** 引数の1行要約。空なら未設定 */
  argSummary: string;
  status: StepStatus;
  requiresApproval: boolean;
  /** 実行が失敗したときの理由 */
  error?: string;
  /** レジストリに存在しない capability（消された・未シード） */
  unknown: boolean;
}

export interface FlowNode {
  id: string;
  type: 'step';
  position: { x: number; y: number };
  data: StepNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  animated: boolean;
}

/**
 * 外部へ送信するステップか。gateway の requiresApproval と同じ規則を持つ
 * （表示のためだけの複製。実際のゲートは step-runner が持つ真実の源）。
 */
export function stepRequiresApproval(capabilityName: string, meta?: CapabilityMeta): boolean {
  if ((APPROVAL_REQUIRED_CAPS as readonly string[]).includes(capabilityName)) return true;
  if (meta?.kind === 'http') return (meta.httpMethod ?? '').toUpperCase() !== 'GET';
  return false;
}

/** 予約ステップ（capability レジストリを引かないもの）の表示名。 */
const RESERVED_LABELS: Record<string, string> = {
  [LLM_TRANSFORM_STEP]: 'AIで加工',
};

export function stepLabel(capabilityName: string, meta?: CapabilityMeta): string {
  return RESERVED_LABELS[capabilityName] ?? meta?.displayName ?? capabilityName;
}

/**
 * argTemplate を1行に畳む。
 * ⚠️ AI 推論で作られた steps は zod を通らずに保存されるため、値が string とは限らない
 *    （step-runner.ts の renderArgTemplate と同じ前提）。防御的に文字列化する。
 */
export function summarizeArgs(argTemplate: unknown, maxLength = 64): string {
  if (!argTemplate || typeof argTemplate !== 'object' || Array.isArray(argTemplate)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(argTemplate as Record<string, unknown>)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}: ${text ?? ''}`);
  }
  const joined = parts.join(' / ');
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}

/** Agent.steps は null を取りうる（types/agent.ts）。常に配列にして扱う。 */
export function normalizeSteps(steps: AgentStepDef[] | null | undefined): AgentStepDef[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter((s): s is AgentStepDef => !!s && typeof s.capabilityName === 'string');
}

/**
 * steps ＋ capability メタ ＋ 実行状態から、キャンバスに描くノードとエッジを作る。
 * runState が無ければ全ステップ PENDING（＝まだ走っていない）として描く。
 */
export function stepsToFlow(
  steps: AgentStepDef[] | null | undefined,
  capabilities: CapabilityMeta[] = [],
  runState?: AgentRunState | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const list = normalizeSteps(steps);
  const byName = new Map(capabilities.map((c) => [c.name, c]));

  const nodes: FlowNode[] = list.map((step, index) => {
    const meta = byName.get(step.capabilityName);
    const runStep = runState?.steps?.[index];
    const isReserved = step.capabilityName in RESERVED_LABELS;
    return {
      id: `step-${index}`,
      type: 'step' as const,
      position: { x: 0, y: index * NODE_GAP },
      data: {
        index,
        capabilityName: step.capabilityName,
        label: stepLabel(step.capabilityName, meta),
        argSummary: summarizeArgs(step.argTemplate),
        status: runStep?.status ?? 'PENDING',
        requiresApproval: stepRequiresApproval(step.capabilityName, meta),
        error: runStep?.error,
        unknown: !meta && !isReserved,
      },
    };
  });

  const edges: FlowEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    // 実行中の区間だけ線を流す。どこまで進んだかが一目で分かる
    const animated = nodes[i].data.status === 'RUNNING';
    edges.push({ id: `edge-${i - 1}-${i}`, source: `step-${i - 1}`, target: `step-${i}`, animated });
  }
  return { nodes, edges };
}
