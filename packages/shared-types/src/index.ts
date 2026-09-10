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
// Task.status の値域（DB は String カラムで運用。DB enum 化は本番の migrate deploy 失敗リスクを避けて見送り）。
// - 実行系: PENDING → QUEUED（n8n dispatch 待ち）→ RUNNING → DONE / FAILED
// - 承認系（SNS 下書き等・自動実行しない）: PENDING_APPROVAL → APPROVED / REJECTED
export type TaskStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'DONE'
  | 'FAILED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED';
// LINE 受信箱（ChannelConnection / InboundMessage）。DB は String カラムで運用し、値域はこの型で縛る。
export type ChannelProvider = 'line';
// - RECEIVED → DRAFTED / DRAFT_FAILED（AI 下書き生成）
// - DRAFTED / DRAFT_FAILED → SENT（承認 push 成功）/ SEND_FAILED（push 失敗、再承認可）/ REJECTED
// - SKIPPED: 1:1 の非テキストメッセージ等、下書き対象外として記録だけしたもの
export type InboundMessageStatus =
  | 'RECEIVED'
  | 'DRAFTED'
  | 'DRAFT_FAILED'
  | 'SENT'
  | 'REJECTED'
  | 'SEND_FAILED'
  | 'SKIPPED';
// セルフサーブ連携（ProviderConnection）。DB は String カラムで運用し、値域はこの型で縛る。
export type ProviderConnectionProvider = 'slack' | 'google';
export type ProviderConnectionStatus = 'CONNECTED' | 'NEEDS_RECONNECT' | 'DISABLED';

// ── エージェントのステップ実行（step-runner） ──────────────────────
/** Agent.steps の 1 要素。argTemplate の値は {{input}} / {{prev}} プレースホルダを使える。 */
export interface AgentStepDef {
  capabilityName: string;
  argTemplate?: Record<string, string>;
}
export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'AWAITING_APPROVAL' | 'REJECTED';
export interface StepState {
  index: number;
  capabilityName: string;
  status: StepStatus;
  args?: Record<string, unknown>;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}
/** Task.executionResult に JSON 文字列で保存する run 全体の状態。 */
export interface AgentRunState {
  version: 1;
  input: string;
  currentIndex: number;
  steps: StepState[];
}
/** 外部送信 = 実行前に必ず承認待ちへ積む capability（全自動化しない）。
 *  post_to_x / send_line_push は現状未登録だが、登録された瞬間からゲートが効くよう先置き。 */
export const APPROVAL_REQUIRED_CAPS = ['send_email', 'notify_slack', 'post_to_x', 'send_line_push'] as const;
/** capability レジストリを引かずに AI Engine /llm/chat で変換する予約ステップ名。 */
export const LLM_TRANSFORM_STEP = 'llm_transform';
/** Task.approvalData に入れる、ステップ承認待ちの内容（承認 UI が RunPreviewRow で表示）。 */
export interface AgentStepApprovalData {
  kind: 'agent_step';
  stepIndex: number;
  capabilityName: string;
  capabilityLabel: string;
  args: Record<string, unknown>;
}

// ── ユーザー定義ノード（カスタム HTTP capability） ──────────────
/** 'native' は adapter レジストリからの派生表示値で DB には保存しない。 */
export type CapabilityKind = 'n8n' | 'native' | 'http';
export type HttpNodeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type HttpNodeParamType = 'string' | 'number' | 'integer' | 'boolean';

export interface HttpNodeParam {
  /** 英数字とアンダースコアのみ。url/headers/body から {{name}} で参照する */
  name: string;
  type: HttpNodeParamType;
  required: boolean;
  /** LLM が値を埋めるための手がかり */
  description?: string;
}

export interface HttpNodeHeader {
  name: string;
  /** secret=false は平文。secret=true は secret-box の暗号文（API では常に伏字）。 */
  value: string;
  secret?: boolean;
}

export interface HttpNodeConfig {
  version: 1;
  method: HttpNodeMethod;
  /** https 固定。origin（scheme+host+port）に {{...}} を含めてはならない。 */
  url: string;
  headers: HttpNodeHeader[];
  bodyEncoding?: 'json';
  /** オブジェクトのみ。文字列リーフに {{param}} を書ける（文字列連結で JSON を組まない）。 */
  bodyTemplate?: Record<string, unknown> | null;
  /** レスポンスから取り出すドットパス（例: 'data.items[0].id'）。未指定はボディ全体。 */
  outputPath?: string | null;
  timeoutMs?: number;
  params: HttpNodeParam[];
}

/** API レスポンス用の公開形。secret ヘッダは伏字になっている。 */
export interface HttpNodeConfigPublic extends Omit<HttpNodeConfig, 'headers'> {
  headers: Array<{ name: string; secret: boolean; value: string }>;
}

/** ユーザーがカスタムノード名に使えない予約名（seed / native / 予約ステップ）。 */
export const RESERVED_CAPABILITY_NAMES = [
  ...APPROVAL_REQUIRED_CAPS,
  LLM_TRANSFORM_STEP,
  'draft_email',
  'summarize_sheet',
  'create_google_doc',
  'create_google_sheet',
  'create_google_slides',
] as const;

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
  /** 予約投稿日時（SNS 下書き等）。Prisma の scheduledAt カラム。未設定は null。 */
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
  /** 紐づくエージェント。null は従来の部署ワークフロー実行。 */
  agentId: string | null;
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
