// 保存エージェント用の n8n ワークフローを Public API で動的生成・有効化するモジュール。
//
// scripts/n8n-import-workflows.mjs の実績ある Public API ロジックを移植している。
// dept-general.json をテンプレ参照する代わりに、エージェント用の最小グラフ
// (Webhook → Log Start → Build Prompt → AI Engine Chat → Callback) をコードで組み立てる。
// これにより rootDir 外の JSON import 依存を避け、instructions の埋め込みも JSON.stringify で安全に行う。
//
// n8n が落ちている / コールドスタート中でも作成自体は失敗させない設計:
// すべての API 呼び出しを timeout 付き fetch + try/catch で包み、呼び出し側 (routes/agents.ts) が
// 例外時に Agent.n8nStatus = PENDING を設定してフォールバック実行できるようにする。

const N8N_URL = (process.env.N8N_CLOUD_URL ?? process.env.N8N_URL ?? 'http://localhost:5678').replace(
  /\/$/,
  '',
);
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const N8N_WEBHOOK_AUTH_TOKEN = process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'org-ai-n8n-secret-token';

const CREDENTIAL_NAME = 'org-ai webhook token';
const CREDENTIAL_HEADER_NAME = 'x-org-ai-token';
const API_TIMEOUT_MS = 15_000;

const apiHeaders = {
  'Content-Type': 'application/json',
  'X-N8N-API-KEY': N8N_API_KEY,
};

/** Public API へのエージェント定義（Prisma の Agent をそのまま渡せる最小形）。 */
export interface AgentWorkflowInput {
  id: string;
  name: string;
  department: string;
  instructions: string;
}

export interface CreateAgentWorkflowResult {
  workflowId: string;
  webhookPath: string;
  active: boolean;
}

/** エージェント ID から webhook パスを導出 (cuid は URL-safe)。 */
export function agentWebhookPath(agentId: string): string {
  return `agent-${agentId}`;
}

/** n8n 上で一意に識別できるワークフロー名。isWebhookAvailableByName と対で使う。 */
export function agentWorkflowName(agentId: string): string {
  return `org-ai Agent ${agentId}`;
}

function n8nFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${N8N_URL}${path}`, {
    ...init,
    headers: { ...apiHeaders, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

/** エージェント用のワークフロー JSON をコードで構築する。
 *  instructions は JSON.stringify で安全に jsCode へ埋め込む（バッククォート等のエスケープ不要）。
 *  Webhook body に systemPrompt があれば優先（編集時の再 import 無しで上書き可能）。
 */
export function buildAgentWorkflowJson(agent: AgentWorkflowInput): Record<string, unknown> {
  const path = agentWebhookPath(agent.id);
  const tokenExpr = "={{ $env.N8N_WEBHOOK_AUTH_TOKEN || 'org-ai-n8n-secret-token' }}";

  const buildPromptCode = [
    "const rd = $('Webhook').item.json.body;",
    `const systemPrompt = (rd.systemPrompt && String(rd.systemPrompt)) || ${JSON.stringify(
      agent.instructions,
    )};`,
    'const messages = [',
    '  { role: "system", content: systemPrompt },',
    '  { role: "user", content: rd.input }',
    '];',
    'return [{ json: { messages, department: ' +
      `${JSON.stringify(agent.department)}` +
      ", org_id: rd.orgId, plan: rd.plan ?? 'STARTER', aiEngineUrl: rd.aiEngineUrl ?? 'http://ai-engine:8000', useJsonMode: false } }];",
  ].join('\n');

  return {
    name: agentWorkflowName(agent.id),
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path,
          responseMode: 'onReceived',
          authentication: 'headerAuth',
          options: {},
        },
        id: 'trigger',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [240, 300],
      },
      {
        parameters: {
          url: '={{ $json.body.logUrl }}',
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'x-webhook-token', value: tokenExpr },
            ],
          },
          sendBody: true,
          bodyParameters: {
            parameters: [
              { name: 'taskId', value: '={{ $json.body.taskId }}' },
              { name: 'message', value: `エージェント「${agent.name}」ワークフロー開始` },
              { name: 'level', value: 'INFO' },
            ],
          },
          options: {},
        },
        id: 'log-start',
        name: 'Log Start',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        position: [460, 300],
      },
      {
        parameters: { jsCode: buildPromptCode },
        id: 'build-prompt',
        name: 'Build Prompt',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [680, 300],
      },
      {
        parameters: {
          method: 'POST',
          url: '={{ $json.aiEngineUrl }}/llm/chat',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
          sendBody: true,
          contentType: 'raw',
          rawContentType: 'application/json',
          body: '={{ JSON.stringify({ messages: $json.messages, department: $json.department, org_id: $json.org_id, plan: $json.plan, json_mode: $json.useJsonMode }) }}',
          options: {},
        },
        id: 'ai-chat',
        name: 'AI Engine Chat',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        position: [900, 300],
      },
      {
        parameters: {
          url: '={{ $(\'Webhook\').item.json.body.callbackUrl }}',
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'x-webhook-token', value: tokenExpr },
            ],
          },
          sendBody: true,
          bodyParameters: {
            parameters: [
              { name: 'taskId', value: '={{ $(\'Webhook\').item.json.body.taskId }}' },
              { name: 'status', value: 'DONE' },
              { name: 'output', value: '={{ $(\'AI Engine Chat\').item.json.content }}' },
              { name: 'workflowId', value: '={{ $workflow.id }}' },
            ],
          },
          options: {},
        },
        id: 'callback-done',
        name: 'Callback (Done)',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        position: [1120, 300],
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Log Start', type: 'main', index: 0 }]] },
      'Log Start': { main: [[{ node: 'Build Prompt', type: 'main', index: 0 }]] },
      'Build Prompt': { main: [[{ node: 'AI Engine Chat', type: 'main', index: 0 }]] },
      'AI Engine Chat': { main: [[{ node: 'Callback (Done)', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    staticData: null,
  };
}

/** Header Auth credential を作成または既存を返す（best-effort。一覧不可でも作成を試みる）。 */
async function ensureHeaderAuthCredential(): Promise<{ id: string; name: string } | null> {
  let existing: { id: string; name: string; type: string }[] = [];
  try {
    const res = await n8nFetch('/api/v1/credentials');
    if (res.ok) {
      const j = (await res.json()) as { data?: { id: string; name: string; type: string }[] };
      existing = j.data ?? [];
    }
  } catch {
    // 一覧が取れなくても作成は試みる
  }
  const hit = existing.find((c) => c.name === CREDENTIAL_NAME && c.type === 'httpHeaderAuth');
  if (hit) return { id: hit.id, name: hit.name };

  const res = await n8nFetch('/api/v1/credentials', {
    method: 'POST',
    body: JSON.stringify({
      name: CREDENTIAL_NAME,
      type: 'httpHeaderAuth',
      data: { name: CREDENTIAL_HEADER_NAME, value: N8N_WEBHOOK_AUTH_TOKEN },
    }),
  });
  if (!res.ok) throw new Error(`credential create failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data?: { id: string }; id?: string };
  const id = j.data?.id ?? j.id;
  if (!id) throw new Error('credential create returned no id');
  return { id, name: CREDENTIAL_NAME };
}

/** Webhook ノードに httpHeaderAuth credential を注入する。 */
function attachCredentialToWebhookNodes(
  wf: Record<string, unknown>,
  credential: { id: string; name: string },
): void {
  const nodes = (wf.nodes as Record<string, unknown>[]) ?? [];
  for (const node of nodes) {
    const params = node.parameters as { authentication?: string } | undefined;
    if (node.type === 'n8n-nodes-base.webhook' && params?.authentication === 'headerAuth') {
      node.credentials = {
        ...(node.credentials as Record<string, unknown> | undefined),
        httpHeaderAuth: { id: credential.id, name: credential.name },
      };
    }
  }
}

function workflowApiBody(wf: Record<string, unknown>): string {
  return JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? { executionOrder: 'v1' },
  });
}

async function n8nCreateWorkflow(wf: Record<string, unknown>): Promise<string> {
  const res = await n8nFetch('/api/v1/workflows', { method: 'POST', body: workflowApiBody(wf) });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data?: { id: string }; id?: string };
  const id = j.data?.id ?? j.id;
  if (!id) throw new Error('workflow create returned no id');
  return id;
}

async function n8nUpdateWorkflow(id: string, wf: Record<string, unknown>): Promise<void> {
  const res = await n8nFetch(`/api/v1/workflows/${id}`, { method: 'PUT', body: workflowApiBody(wf) });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
}

async function n8nActivateWorkflow(id: string): Promise<boolean> {
  try {
    const res = await n8nFetch(`/api/v1/workflows/${id}/activate`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** 削除（best-effort）。エージェント削除時に呼ぶ。失敗しても無視。 */
export async function deleteAgentWorkflow(id: string): Promise<void> {
  try {
    await n8nFetch(`/api/v1/workflows/${id}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

/** エージェントの専用ワークフローを生成 + 有効化する。
 *  N8N_API_KEY 未設定や n8n 不達のときは throw → 呼び出し側で n8nStatus=PENDING にする。
 */
export async function createAgentWorkflow(
  agent: AgentWorkflowInput,
): Promise<CreateAgentWorkflowResult> {
  if (!N8N_API_KEY) throw new Error('N8N_API_KEY not configured');

  const wf = buildAgentWorkflowJson(agent);
  const credential = await ensureHeaderAuthCredential();
  if (credential) attachCredentialToWebhookNodes(wf, credential);

  const workflowId = await n8nCreateWorkflow(wf);
  const active = await n8nActivateWorkflow(workflowId);
  return { workflowId, webhookPath: agentWebhookPath(agent.id), active };
}

/** 既存エージェントワークフローを再構築して PUT 更新（PATCH 時に使用、best-effort）。 */
export async function syncAgentWorkflow(
  workflowId: string,
  agent: AgentWorkflowInput,
): Promise<boolean> {
  if (!N8N_API_KEY) return false;
  try {
    const wf = buildAgentWorkflowJson(agent);
    const credential = await ensureHeaderAuthCredential();
    if (credential) attachCredentialToWebhookNodes(wf, credential);
    await n8nUpdateWorkflow(workflowId, wf);
    await n8nActivateWorkflow(workflowId);
    return true;
  } catch {
    return false;
  }
}
