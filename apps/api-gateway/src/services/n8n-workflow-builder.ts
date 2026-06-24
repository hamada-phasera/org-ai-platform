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
  /** 順序付き capability ステップ。対応 cap は実 provider ノードへ展開（チェーン型）。 */
  steps?: { capabilityName: string; argTemplate?: Record<string, unknown> }[];
}

/** 実ノードに展開できる（チェーン型対応）capability。Doc 先行で順次拡張。 */
export const CHAINED_STEP_CAPS = new Set(['create_google_doc']);

/** steps から対応済み capability 名を順序保持・重複除去で抽出。 */
export function agentSupportedSteps(steps?: { capabilityName: string }[]): string[] {
  if (!steps) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of steps) {
    if (CHAINED_STEP_CAPS.has(s.capabilityName) && !seen.has(s.capabilityName)) {
      seen.add(s.capabilityName);
      out.push(s.capabilityName);
    }
  }
  return out;
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
  // n8n は式内の $env アクセスを既定でブロックする（"access to env vars denied"）。
  // コールバックの x-webhook-token は生成時に literal 値を埋め込む（gateway の
  // N8N_WEBHOOK_AUTH_TOKEN と一致 → /api/webhooks/n8n/task-complete を通過）。
  const tokenExpr = N8N_WEBHOOK_AUTH_TOKEN;

  // 重要: n8n は Render の WAF (Cloudflare 系) 配下にあり、Code ノードの複雑な jsCode を含む
  // ワークフロー作成リクエストは「Blocked」403 で弾かれる。そのため Code ノードを使わず、
  // LLM リクエスト本文 (messages 等) は gateway 側で組み立てて webhook body の `llmBody`
  // (JSON 文字列) として流す。作成 payload には単純な式しか含めない（WAF 回避）。
  // ノード構成: Webhook → AI Engine Chat (/llm/chat に llmBody をそのまま POST) → Callback。
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
          method: 'POST',
          url: '={{ $json.body.aiEngineUrl }}/llm/chat',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
          sendBody: true,
          contentType: 'raw',
          rawContentType: 'application/json',
          // gateway が組み立て済みの /llm/chat リクエスト JSON 文字列をそのまま転送
          body: '={{ $json.body.llmBody }}',
          options: {},
        },
        id: 'ai-chat',
        name: 'AI Engine Chat',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        position: [520, 300],
      },
      {
        parameters: {
          method: 'POST',
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
        position: [800, 300],
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'AI Engine Chat', type: 'main', index: 0 }]] },
      'AI Engine Chat': { main: [[{ node: 'Callback (Done)', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    staticData: null,
  };
}

/** provider OAuth credential を type で検索（例: googleDocsOAuth2Api）。未接続なら null。 */
async function findProviderCredential(type: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await n8nFetch('/api/v1/credentials');
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id: string; name: string; type: string }[] };
    const hit = (j.data ?? []).find((c) => c.type === type);
    return hit ? { id: hit.id, name: hit.name } : null;
  } catch {
    return null;
  }
}

/** steps を実 provider ノードへ展開したチェーン型ワークフロー。
 *  Webhook → AI Plan(/llm/chat) → Parse Args(Code, ```fence耐性) → [step nodes] → Callback。
 *  AI Plan は gateway が組む llmBody（各 step の引数 JSON を要求）をそのまま /llm/chat へ転送する。
 *  呼び出し側は対応 cred が揃っている step のみ creds に渡すこと（揃わない時は簡易シェルにフォールバック）。
 */
export function buildChainedAgentWorkflowJson(
  agent: AgentWorkflowInput,
  creds: { googleDocs?: { id: string; name: string } },
): Record<string, unknown> {
  const path = agentWebhookPath(agent.id);
  const token = N8N_WEBHOOK_AUTH_TOKEN;
  const parseCode =
    "let raw=($('AI Plan').item.json.content)||'{}';\n" +
    "raw=raw.replace(/```json/g,'').replace(/```/g,'').trim();\n" +
    'let p={};\ntry{p=JSON.parse(raw);}catch(e){p={};}\n' +
    'const doc=p.create_google_doc||p;\n' +
    "return [{ json: { docTitle: doc.title||'(無題)', docContent: doc.content||'' } }];";

  const nodes: Record<string, unknown>[] = [
    {
      parameters: { httpMethod: 'POST', path, responseMode: 'onReceived', authentication: 'headerAuth', options: {} },
      id: 'trigger', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [240, 300],
    },
    {
      parameters: {
        method: 'POST', url: '={{ $json.body.aiEngineUrl }}/llm/chat', sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
        sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: '={{ $json.body.llmBody }}', options: {},
      },
      id: 'ai', name: 'AI Plan', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [460, 300],
    },
    {
      parameters: { jsCode: parseCode },
      id: 'parse', name: 'Parse Args', type: 'n8n-nodes-base.code', typeVersion: 2, position: [670, 300],
    },
  ];
  const conns: Record<string, unknown> = {
    Webhook: { main: [[{ node: 'AI Plan', type: 'main', index: 0 }]] },
    'AI Plan': { main: [[{ node: 'Parse Args', type: 'main', index: 0 }]] },
  };
  let prev = 'Parse Args';
  let x = 880;
  const supported = agentSupportedSteps(agent.steps);

  if (supported.includes('create_google_doc') && creds.googleDocs) {
    nodes.push({
      parameters: { operation: 'create', title: "={{ $('Parse Args').item.json.docTitle }}", folderId: { __rl: true, mode: 'id', value: 'root' } },
      id: 'gdoc-create', name: 'Create Doc', type: 'n8n-nodes-base.googleDocs', typeVersion: 2, position: [x, 300],
      credentials: { googleDocsOAuth2Api: creds.googleDocs },
    });
    conns[prev] = { main: [[{ node: 'Create Doc', type: 'main', index: 0 }]] };
    prev = 'Create Doc'; x += 210;
    nodes.push({
      parameters: { operation: 'update', documentURL: '={{ $json.documentId || $json.id }}', actionsUi: { actionFields: [{ action: 'insert', text: "={{ $('Parse Args').item.json.docContent }}" }] } },
      id: 'gdoc-insert', name: 'Insert Content', type: 'n8n-nodes-base.googleDocs', typeVersion: 2, position: [x, 300],
      credentials: { googleDocsOAuth2Api: creds.googleDocs },
    });
    conns[prev] = { main: [[{ node: 'Insert Content', type: 'main', index: 0 }]] };
    prev = 'Insert Content'; x += 210;
  }

  nodes.push({
    parameters: {
      method: 'POST', url: "={{ $('Webhook').item.json.body.callbackUrl }}", sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'x-webhook-token', value: token }] },
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'taskId', value: "={{ $('Webhook').item.json.body.taskId }}" },
          { name: 'status', value: 'DONE' },
          { name: 'output', value: "={{ JSON.stringify({ docUrl: 'https://docs.google.com/document/d/' + ($('Create Doc').item.json.documentId || $('Create Doc').item.json.id) + '/edit', title: $('Parse Args').item.json.docTitle }) }}" },
          { name: 'workflowId', value: '={{ $workflow.id }}' },
        ],
      },
      options: { retry: { retry: { maxTries: 3 } } },
    },
    id: 'callback-done', name: 'Callback (Done)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [x, 300],
  });
  conns[prev] = { main: [[{ node: 'Callback (Done)', type: 'main', index: 0 }]] };

  return { name: agentWorkflowName(agent.id), nodes, connections: conns, settings: { executionOrder: 'v1', saveManualExecutions: true }, staticData: null };
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

/** steps に対応 cap があり provider 資格情報が接続済みならチェーン型、無ければ簡易シェルを返す。 */
async function resolveAgentWorkflow(agent: AgentWorkflowInput): Promise<Record<string, unknown>> {
  const supported = agentSupportedSteps(agent.steps);
  if (supported.includes('create_google_doc')) {
    const googleDocs = await findProviderCredential('googleDocsOAuth2Api');
    if (googleDocs) return buildChainedAgentWorkflowJson(agent, { googleDocs });
  }
  return buildAgentWorkflowJson(agent);
}

/** エージェントの専用ワークフローを生成 + 有効化する。
 *  N8N_API_KEY 未設定や n8n 不達のときは throw → 呼び出し側で n8nStatus=PENDING にする。
 */
export async function createAgentWorkflow(
  agent: AgentWorkflowInput,
): Promise<CreateAgentWorkflowResult> {
  if (!N8N_API_KEY) throw new Error('N8N_API_KEY not configured');

  const wf = await resolveAgentWorkflow(agent);
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
    const wf = await resolveAgentWorkflow(agent);
    const credential = await ensureHeaderAuthCredential();
    if (credential) attachCredentialToWebhookNodes(wf, credential);
    await n8nUpdateWorkflow(workflowId, wf);
    await n8nActivateWorkflow(workflowId);
    return true;
  } catch {
    return false;
  }
}
