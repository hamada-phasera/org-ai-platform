export interface Agent {
  id: string;
  department: string;
  name: string;
  color: string;
  colorLight: string;
  icon: string;
  personality: string;
  image: string;
  rating: number;
  status: 'active' | 'processing' | 'idle';
  taskCount: number;
  description: string;
  latestReport: string;
  rank: number;
  rankLabel: string;
}

export type AgentN8nStatus = 'PENDING' | 'CREATED' | 'ACTIVE' | 'FAILED' | 'FALLBACK_ONLY';

export interface AgentStepDef {
  capabilityName: string;
  argTemplate?: Record<string, string>;
}

/** ユーザーが作成・保存した再利用可能な業務効率化エージェント（バックエンドの Agent モデルに対応）。 */
export interface SavedAgent {
  id: string;
  name: string;
  description: string | null;
  department: string;
  instructions: string;
  steps: AgentStepDef[] | null;
  trigger: 'MANUAL' | 'SCHEDULED';
  enabled: boolean;
  n8nWorkflowId: string | null;
  webhookPath: string | null;
  n8nStatus: AgentN8nStatus;
  icon: string | null;
  color: string | null;
  createdAt: string;
}

/** n8n 連携状態の表示ラベル（保存エージェントカード用）。 */
export const AGENT_N8N_STATUS_LABEL: Record<AgentN8nStatus, string> = {
  ACTIVE: 'n8n稼働',
  CREATED: 'n8n作成済',
  PENDING: 'AIエンジン実行',
  FAILED: 'AIエンジン実行',
  FALLBACK_ONLY: 'AIエンジン実行',
};
