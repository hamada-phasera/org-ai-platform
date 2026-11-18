/**
 * 業務フロー（docs/design/canvas-home.md）のうち、zod に依存しない定数・上限・プランの判定。
 *
 * ⚠️ ここに zod を import しない。web のホーム（初回ロード）とスマホの縦リストが読むので、
 *    スキーマ（flows.ts）と分けておくと zod がフロー画面の遅延チャンクにだけ載る（業務ページの K20 と同じ）。
 *    純粋関数（並び・参照・式の展開）は flows-core.ts。
 */
import type { Plan, UsageState, UserRole } from './index';
import { usageState } from './index';

export const FLOW_SCHEMA_VERSION = 1;

// ── 値域（DB は String 列。値域はここで縛る。設計書 §5） ───────────────────

/** ノード型の許可リスト（設計書 §6.2）。これ以外は無い */
export const FLOW_NODE_TYPES = ['trigger', 'ai', 'approval', 'data', 'part', 'branch', 'output'] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

/** 画面に出す一語 */
export const FLOW_NODE_TYPE_LABEL: Record<FlowNodeType, string> = {
  trigger: 'きっかけ',
  ai: 'AI',
  approval: '確認',
  data: 'データ',
  part: '部品',
  branch: '分岐',
  output: '出力',
};

export const FLOW_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

/** 終わった（もう進まない）状態 */
export const FLOW_RUN_FINAL_STATUSES: readonly FlowRunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'];

export const FLOW_RUN_TRIGGERS = ['manual', 'form', 'schedule', 'page'] as const;
export type FlowRunTrigger = (typeof FLOW_RUN_TRIGGERS)[number];

export const FLOW_STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'WAITING_APPROVAL'] as const;
export type FlowStepStatus = (typeof FLOW_STEP_STATUSES)[number];

export const FLOW_MIN_ROLES: readonly UserRole[] = ['MEMBER', 'ADMIN', 'OWNER'];

/** 部品の最低プラン（設計書 §5.7） */
export const PLAN_RANK: Record<Plan, number> = { STARTER: 1, PRO: 2, MAX: 3 };

// ── フロー定義の上限（設計書 §6.7） ───────────────────────────────

export const FLOW_DEFINITION_LIMITS = {
  /** 定義全体の JSON（UTF-8）のバイト数 */
  maxDefinitionBytes: 64 * 1024,
  minNodes: 2,
  maxNodes: 30,
  minEdges: 1,
  maxEdges: 60,
  maxAiNodes: 5,
  maxPartNodes: 8,
  maxBranchNodes: 5,
  /** 分岐以外のノードから出る線（並列は 3 つまで） */
  maxOutDegree: 3,
  maxPageOutputs: 1,
  /** ノードのラベルは一語（DESIGN.md） */
  labelMax: 8,
  nameMax: 24,
  formFieldsMax: 12,
  instructionMax: 2000,
  aiInputMax: 4000,
  extractFieldsMax: 12,
  classifyChoicesMin: 2,
  classifyChoicesMax: 8,
  choiceMax: 24,
  approvalMessageMax: 140,
  approvalPreviewMax: 2000,
  dataWhereMax: 3,
  dataValueMax: 2000,
  dataLimitMax: 50,
  partInputMax: 4000,
  branchRightMax: 200,
  pageValuesMax: 20,
  pageValueMax: 2000,
  documentTitleMax: 80,
  documentBodyMax: 20000,
  notifyToMax: 200,
  notifyBodyMax: 2000,
  /** 展開後の 1 項目（UTF-8 のバイト数） */
  renderedMaxBytes: 32 * 1024,
} as const;

/** 実行の上限（設計書 §6.7・§7.2）。ランナーが使う */
export const FLOW_RUN_LIMITS = {
  aiNodeTimeoutMs: 60_000,
  dataNodeTimeoutMs: 5_000,
  partTimeoutDefaultMs: 10_000,
  partTimeoutMaxMs: 30_000,
  /** 動いている時間の合計（承認待ちは含めない） */
  runActiveMaxMs: 5 * 60_000,
  approvalExpireMs: 7 * 24 * 60 * 60_000,
  /** メモリ上のノード出力 */
  nodeOutputMaxBytes: 256 * 1024,
  /** 保存するノード出力 */
  storedNodeOutputMaxBytes: 16 * 1024,
  storedStepsMaxBytes: 256 * 1024,
  storedOutputMaxBytes: 64 * 1024,
  inputMaxBytes: 16 * 1024,
  /** 1 回の実行が持つ値の合計 */
  runValuesMaxBytes: 1024 * 1024,
  /** HTTP で完了を待つ時間（K10） */
  syncWaitMs: 8_000,
  /** 組織ごとの QUEUED の上限。超えたら 429 FLOW_BUSY */
  maxQueuedPerOrg: 20,
  /** 版の履歴の保持数 */
  versionsKept: 20,
} as const;

// ── キャンバスの配置の上限（設計書 §6.6） ───────────────────────────

export const CANVAS_LAYOUT_LIMITS = {
  maxNodes: 40,
  maxEdges: 80,
  labelMax: 8,
  coordMin: -5000,
  coordMax: 5000,
  maxLayoutBytes: 32 * 1024,
} as const;

/** テンプレートのキー（設計書 §5.6。中身は flow-templates.ts） */
export const FLOW_TEMPLATE_KEYS = ['proposal', 'estimate', 'invoice', 'sns_post'] as const;
export type FlowTemplateKey = (typeof FLOW_TEMPLATE_KEYS)[number];

export function isFlowTemplateKey(value: unknown): value is FlowTemplateKey {
  return typeof value === 'string' && (FLOW_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/**
 * キャンバスの `link` が開ける内部パス（設計書 §6.6）。外部 URL・`//`・`javascript:` は書けない。
 * 固定のパスか、`/agents/:id` `/p/:slug` の形だけ。
 */
export const CANVAS_LINK_PATHS = [
  '/chat',
  '/inbox',
  '/inbox?tab=approvals',
  '/deliverables',
  '/dashboard',
  '/agents',
  '/sales',
  '/analytics',
  '/sns',
  '/accounting',
  '/settings',
] as const;

/** 業務ページの slug と同じ形（pages.ts は zod を読むのでここに写す） */
const PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

export function isCanvasLinkPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if ((CANVAS_LINK_PATHS as readonly string[]).includes(value)) return true;
  if (value.startsWith('/agents/')) return AGENT_ID_PATTERN.test(value.slice('/agents/'.length));
  if (value.startsWith('/p/')) return PAGE_SLUG_PATTERN.test(value.slice('/p/'.length));
  return false;
}

// ── プランの上限（設計書 §7.6。値は仮＝U-5。金額は持たない） ─────────────────

export interface FlowPlanLimits {
  /** 組織が持てるフロー数。超えたら**新規作成だけ**断る（既存の編集・実行は通す。降格しても消さない） */
  maxFlows: number;
  /** 当月（UTC の暦月）の実行数。超えたら**新しい実行だけ**止める */
  runsPerMonth: number;
  /** 当月の部品の呼び出し数（FlowRun.partCalls の合計）。超えたら部品を含むフローの新しい実行を止める */
  partCallsPerMonth: number;
  /** 組織ごとの同時実行数 */
  concurrency: number;
  /** 実行履歴の保持日数（当月の行は消さないので最短 60 日） */
  historyDays: number;
}

/**
 * プランごとの業務フローの上限。トライアル中は梅（STARTER）。
 * ⚠️ AI の呼び出しは別枠を作らない（既存の aiCallsPerMonth に数え、超えても止めずに軽いモデルへ落とす）。
 */
export const FLOW_LIMITS: Record<Plan, FlowPlanLimits> = {
  STARTER: { maxFlows: 3, runsPerMonth: 300, partCallsPerMonth: 100, concurrency: 2, historyDays: 60 },
  PRO: { maxFlows: 10, runsPerMonth: 3000, partCallsPerMonth: 1000, concurrency: 4, historyDays: 180 },
  MAX: { maxFlows: 30, runsPerMonth: 20000, partCallsPerMonth: 10000, concurrency: 8, historyDays: 365 },
};

/** 知らないプラン名（DB の値の揺れ）は梅の上限で数える＝安全側 */
export function flowLimitsOf(plan: Plan | string): FlowPlanLimits {
  return Object.prototype.hasOwnProperty.call(FLOW_LIMITS, plan) ? FLOW_LIMITS[plan as Plan] : FLOW_LIMITS.STARTER;
}

/** もう 1 つフローを作れるか。`currentCount` はその組織のいまのフロー数 */
export function canAddFlow(plan: Plan | string, currentCount: number): boolean {
  return Math.max(0, currentCount) < flowLimitsOf(plan).maxFlows;
}

export interface FlowUsage {
  used: number;
  limit: number;
  /** 'ok' | 'warn'(8割) | 'over'(上限) — 表示の判定は AI の月間上限と同じ usageState */
  state: UsageState;
  /** true なら新しい実行を止める（閲覧・編集・承認待ちの続きは止めない） */
  blocked: boolean;
}

function usageOf(used: number, limit: number): FlowUsage {
  const u = Number.isFinite(used) ? Math.max(0, used) : 0;
  return { used: u, limit, state: usageState(u, limit), blocked: u >= limit };
}

/** 当月の実行数から、新しい実行を受け付けられるかと表示の状態（gateway の判定と web の表示で共有） */
export function flowRunState(plan: Plan | string, usedThisMonth: number): FlowUsage {
  return usageOf(usedThisMonth, flowLimitsOf(plan).runsPerMonth);
}

/** 当月の部品の呼び出し数から、部品を含むフローを受け付けられるか */
export function flowPartCallState(plan: Plan | string, usedThisMonth: number): FlowUsage {
  return usageOf(usedThisMonth, flowLimitsOf(plan).partCallsPerMonth);
}

/** その部品を使えるプランか（部品の `minPlan` 以上）。知らない値はどちらも使えない側に倒す */
export function planAllowsPart(plan: Plan | string, minPlan: Plan | string): boolean {
  const have = Object.prototype.hasOwnProperty.call(PLAN_RANK, plan) ? PLAN_RANK[plan as Plan] : PLAN_RANK.STARTER;
  const need = Object.prototype.hasOwnProperty.call(PLAN_RANK, minPlan) ? PLAN_RANK[minPlan as Plan] : Infinity;
  return have >= need;
}

export type FlowRunRejection = 'FLOW_RUN_LIMIT' | 'FLOW_PART_LIMIT';

/**
 * 新しい実行を受け付けるかの判定（設計書 §7.6）。受け付けるなら null。
 * - 実行数が上限 → 429 `FLOW_RUN_LIMIT`
 * - 部品を含むフローで、部品の呼び出しが上限 → 429 `FLOW_PART_LIMIT`（部品の無いフローは動く）
 */
export function flowRunAdmission(
  plan: Plan | string,
  usage: { runsThisMonth: number; partCallsThisMonth: number },
  usesParts: boolean,
): FlowRunRejection | null {
  if (flowRunState(plan, usage.runsThisMonth).blocked) return 'FLOW_RUN_LIMIT';
  if (usesParts && flowPartCallState(plan, usage.partCallsThisMonth).blocked) return 'FLOW_PART_LIMIT';
  return null;
}

/** 当月（UTC の暦月）の始まり。月間件数の数え方（ページの K27・AI の上限と同じ） */
export function flowMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * 実行履歴を消してよい境目（これより前の行を消す）。保持日数を引き、当月の始まりより後にはしない
 * （当月の行は月間件数の正本なので消さない）。
 */
export function flowHistoryCutoff(plan: Plan | string, now: Date): Date {
  const byDays = new Date(now.getTime() - flowLimitsOf(plan).historyDays * 24 * 60 * 60_000);
  const monthStart = flowMonthStartUtc(now);
  return byDays < monthStart ? byDays : monthStart;
}
