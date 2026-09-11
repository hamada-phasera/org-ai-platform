export type Plan = 'STARTER' | 'PRO' | 'MAX';

/** 容量の単位。1000 ではなく 1024 で数える（OS の表示と揃える） */
const MB = 1024 * 1024;
export type PlanTier = Plan;

/**
 * プランごとの上限と、**実際に動くモデル**。
 *
 * ⚠️ modelLabel は画面に出る。ai-engine の router.py が実際に選ぶモデルと必ず揃えること。
 *    以前ここは全プラン Claude の名前を書いていたが、router は梅・竹を Gemini に流しており、
 *    3プラン中2つで顧客が受け取っていないモデル名を表示していた。
 *
 * ⚠️ この表が「本文生成」のモデルを決める。判定・設計・抽出は
 *    プランに関係なく共通（router.py の TaskKind を参照）。安いプランだと
 *    領収書を読み違える、といった値段で説明できない差を作らないため。
 */
export const PLAN_LIMITS: Record<
  Plan,
  {
    aiCallsPerMonth: number;
    model: string;
    modelLabel: string;
    /** 込みのストレージ容量（バイト）。超えた分は追加課金で増やす */
    storageBytes: number;
    /** 1ファイルの上限（バイト） */
    maxFileBytes: number;
    /** 組織に入れられる人数の上限 */
    memberLimit: number;
  }
> = {
  STARTER: {
    aiCallsPerMonth: 3000,
    model: 'gemini-2.5-flash-lite',
    modelLabel: 'Gemini 2.5 Flash-Lite',
    storageBytes: 100 * MB,
    maxFileBytes: 10 * MB,
    memberLimit: 5,
  },
  PRO: {
    aiCallsPerMonth: 8000,
    model: 'gemini-2.5-flash',
    modelLabel: 'Gemini 2.5 Flash',
    storageBytes: 300 * MB,
    maxFileBytes: 20 * MB,
    memberLimit: 20,
  },
  MAX: {
    aiCallsPerMonth: 20000,
    model: 'claude-opus-4-7',
    modelLabel: 'Claude Opus 4.7',
    storageBytes: 1024 * MB,
    maxFileBytes: 50 * MB,
    memberLimit: 100,
  },
};

/**
 * 追加ストレージ。込みの容量を超えたぶんを 1GB 単位で増やせる。
 * ⚠️ 金額はここに書かない。Stripe の price ID を環境変数で指すこと
 *    （コードに金額を直書きすると、値上げのたびにデプロイが要る）。
 */
export const STORAGE_ADDON_UNIT_BYTES = 1024 * MB;

/** 使用量の警告を出す割合。ここを超えたら画面に出す。 */
export const STORAGE_WARN_RATIO = 0.8;

/** 容量の表示（1.5GB / 240MB など）。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) {
    const gb = bytes / (1024 * MB);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
  }
  // 1MB 未満を 0MB と出すと「保存されていない」と読めてしまうので KB で出す
  if (bytes >= MB || bytes <= 0) return `${Math.max(0, Math.round(bytes / MB))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * その組織がいま使える容量（込み + 追加購入分）。
 * 純粋関数にしてあるので、上限の判定は必ずここを通すこと。
 */
export function storageQuotaBytes(plan: Plan, addonUnits = 0): number {
  return PLAN_LIMITS[plan].storageBytes + Math.max(0, addonUnits) * STORAGE_ADDON_UNIT_BYTES;
}

/** アップロードを受け付けてよいか。超過分は受け付けないが、既存ファイルは読める。 */
export function canUpload(
  plan: Plan,
  usedBytes: number,
  incomingBytes: number,
  addonUnits = 0,
): { ok: boolean; reason?: 'FILE_TOO_LARGE' | 'QUOTA_EXCEEDED'; quota: number } {
  const quota = storageQuotaBytes(plan, addonUnits);
  if (incomingBytes > PLAN_LIMITS[plan].maxFileBytes) {
    return { ok: false, reason: 'FILE_TOO_LARGE', quota };
  }
  if (usedBytes + incomingBytes > quota) {
    return { ok: false, reason: 'QUOTA_EXCEEDED', quota };
  }
  return { ok: true, quota };
}
/**
 * 組織内の役割。DB は String カラムで運用し、値域はこの型で縛る。
 *
 *   OWNER  契約者。人の出し入れと組織/請求先の変更ができる。組織に必ず1人以上いる。
 *   ADMIN  管理者。連携の接続・外部APIノードの登録・エージェントの定義・監査の閲覧。
 *   MEMBER 一般。チャット・エージェントの実行・成果物の閲覧・受信箱の対応。
 *
 * ⚠️ VIEWER は作らない。読み取り専用の需要が具体化していない段階で3値目を増やすと、
 *    「MEMBER と VIEWER のどちらを配るか」を毎回考えることになる。必要になったら足す。
 */
export type UserRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** 強い順。requireRole の比較に使う（数値が大きいほど強い）。 */
export const ROLE_RANK: Record<UserRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export const ROLE_LABEL: Record<UserRole, string> = {
  OWNER: 'オーナー',
  ADMIN: '管理者',
  MEMBER: 'メンバー',
};

export function isUserRole(value: unknown): value is UserRole {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}

/** その役割が要求水準を満たすか。未知の値は必ず false（fail-closed）。 */
export function hasRoleAtLeast(role: unknown, required: UserRole): boolean {
  if (!isUserRole(role)) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** 利用者の状態。退職者は物理削除せず DISABLED にする（作成者参照を壊さないため）。 */
export type UserStatus = 'ACTIVE' | 'DISABLED';
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
  /** 使用中の保存容量。Organization.storageUsedBytes（アップロード/削除で増減するカウンタ） */
  storageUsedBytes: number;
  /** プランの無料枠 + 追加容量 */
  storageQuotaBytes: number;
  /** 追加購入した容量の口数（1口 = STORAGE_ADDON_UNIT_BYTES） */
  storageAddonUnits: number;
  /** 1ファイルの上限 */
  maxFileBytes: number;
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
  /** 保存場所の移行で本体を失っている。行（とRAGの索引）は残してあり、再アップロードで直る */
  needsReupload?: boolean;
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
