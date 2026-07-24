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
