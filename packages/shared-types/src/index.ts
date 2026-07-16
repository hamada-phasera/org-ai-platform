export type Plan = 'STARTER' | 'PRO' | 'MAX';
export type PlanTier = Plan;

// プラン別の Claude モデル ID と利用量上限。
// 全プラン Anthropic Claude を使用し、モデル品質と月間 AI コール数で差別化する。
export const PLAN_LIMITS: Record<Plan, { aiCallsPerMonth: number; model: string; modelLabel: string }> = {
  STARTER: {
    aiCallsPerMonth: 100,
    model: 'claude-haiku-4-5-20251001',
    modelLabel: 'Claude Haiku 4.5',
  },
  PRO: {
    aiCallsPerMonth: 1000,
    model: 'claude-sonnet-4-6',
    modelLabel: 'Claude Sonnet 4.6',
  },
  MAX: {
    aiCallsPerMonth: 10000,
    model: 'claude-opus-4-7',
    modelLabel: 'Claude Opus 4.7',
  },
};
export type UserRole = 'OWNER' | 'MEMBER' | 'VIEWER';
export type AgentDepartment = 'SALES' | 'MARKETING' | 'ACCOUNTING' | 'ANALYTICS' | 'GENERAL';
export const AGENT_DEPARTMENTS: AgentDepartment[] = ['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL'];

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
/**
 * Task のライフサイクル状態（DB 列は自由文字列だがこの値域を正本とする）。
 * - QUEUED: 実行待ち（dispatchQueuedTask / dispatchGenerationTask が拾う）
 * - PENDING_APPROVAL/APPROVED/REJECTED: 人間承認ゲート（SNS 下書き等。承認しても自動投稿はしない）
 */
export type TaskStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'DONE'
  | 'FAILED';
export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskType = 'PII_DETECTED' | 'HARMFUL_CONTENT' | 'ANOMALY' | 'COST_ANOMALY';
export type MessageRole = 'user' | 'assistant' | 'system';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  orgId: string | null;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  plan: Plan;
  billingEmail: string | null;
  createdAt: string;
}

export interface OrganizationUsage {
  aiCallsThisMonth: number;
  planLimit: number;
  resetAt: string;
}

export interface ChatSession {
  id: string;
  orgId: string;
  title: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  department: AgentDepartment | null;
  createdAt: string;
}

export interface Task {
  id: string;
  orgId: string;
  title: string;
  status: TaskStatus;
  department: AgentDepartment;
  input: string;
  output: string | null;
  /** 予約日時 (ISO)。SNS 投稿準備 cron 等が参照する。未予約は null。 */
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLog {
  id: string;
  taskId: string;
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  createdAt: string;
}

export interface AILog {
  id: string;
  orgId: string;
  department: AgentDepartment;
  provider: string;
  model: string;
  inputText: string;
  outputText: string | null;
  tokens: number | null;
  latencyMs: number | null;
  riskScore: number | null;
  createdAt: string;
}

export interface RiskEvent {
  id: string;
  orgId: string;
  aiLogId: string | null;
  type: RiskType;
  description: string;
  severity: RiskSeverity;
  resolved: boolean;
  createdAt: string;
}

export interface ScheduledTask {
  id: string;
  orgId: string;
  title: string;
  department: AgentDepartment;
  taskType: string;
  input: string;
  recipientEmail: string | null;
  frequency: ScheduleFrequency;
  hourUtc: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadedFile {
  id: string;
  orgId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface JWTPayload {
  sub: string;
  orgId: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// ─────────────────────────────────────────────────────────────
// 営業パイプライン（サイクル1 R1 のローカルモックから昇格・正本）
// ─────────────────────────────────────────────────────────────

/** 商談ステージ（リード→商談→提案→受注）。 */
export const PIPELINE_STAGES = ['LEAD', 'NEGOTIATION', 'PROPOSAL', 'WON'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  LEAD: 'リード',
  NEGOTIATION: '商談',
  PROPOSAL: '提案',
  WON: '受注',
};

/** 値が有効な商談ステージかどうかの型ガード。 */
export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * ステージ遷移が許可されるか。
 * 受注(WON)は終端ステージなので、そこから他ステージへは戻せない。
 * それ以外は前後どちらへの移動も許可（差し戻し・再交渉を想定）。
 */
export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  if (!isPipelineStage(from) || !isPipelineStage(to)) return false;
  if (from === 'WON' && to !== 'WON') return false;
  return true;
}

/** 商談（Prisma Deal モデルの API 表現。日時は ISO 文字列）。 */
export interface Deal {
  id: string;
  orgId: string;
  title: string;
  company: string | null;
  amount: number;
  stage: PipelineStage;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// 提案書テンプレート（営業 S-3 のローカルモックから昇格・正本）
// ─────────────────────────────────────────────────────────────

export interface ProposalSection {
  key: string;
  title: string;
  /** その章に何を書くかの指示（LLM へのガイド）。 */
  guidance: string;
}

export interface ProposalTemplate {
  id: string;
  name: string;
  tone: 'formal' | 'casual';
  language: 'ja';
  sections: ProposalSection[];
}

// ─────────────────────────────────────────────────────────────
// 分析 KPI イベント（A-1 スキーマ v1 のローカルモックから昇格・正本）
// 「発火」= 既存レコード (AILog/Task/ExecutionLog/RiskEvent) からの構築。
// ─────────────────────────────────────────────────────────────

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

/** 部署別ロールアップ。母数0の率・データ無しの値は null。 */
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
