import { prisma } from '../utils/prisma';
import { agentWorkflowName } from './n8n-workflow-builder';

const N8N_URL = (process.env.N8N_CLOUD_URL ?? process.env.N8N_URL ?? 'http://localhost:5678').replace(
  /\/$/,
  '',
);
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const N8N_WEBHOOK_AUTH_TOKEN = process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'org-ai-n8n-secret-token';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DEPT_WEBHOOK_PATHS: Record<string, string> = {
  SALES: 'dept-sales',
  MARKETING: 'dept-marketing',
  ACCOUNTING: 'dept-accounting',
  ANALYTICS: 'dept-analytics',
  GENERAL: 'dept-general',
};

const cachedActiveWebhooks = new Map<string, boolean>();

/** n8n の Public API を使い、対応するワークフローが「アクティブ」かを判定。
 *  API キー無しなら確認スキップして true 扱い（呼び出し側で 404 をフォールバック処理する）。
 */
async function isWebhookAvailable(department: string): Promise<boolean> {
  if (cachedActiveWebhooks.has(department)) return cachedActiveWebhooks.get(department)!;
  if (!N8N_API_KEY) {
    cachedActiveWebhooks.set(department, true);
    return true;
  }
  const path = DEPT_WEBHOOK_PATHS[department];
  if (!path) {
    cachedActiveWebhooks.set(department, false);
    return false;
  }
  try {
    const res = await fetch(`${N8N_URL}/api/v1/workflows?active=true`, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY },
    });
    if (!res.ok) {
      cachedActiveWebhooks.set(department, false);
      return false;
    }
    const json = (await res.json()) as { data: { id: string; name: string; active: boolean }[] };
    const targetName = `org-ai ${department.charAt(0)}${department.slice(1).toLowerCase()}`;
    const hit = json.data.find(
      (w) =>
        w.active &&
        (w.name === `org-ai Dept ${department.charAt(0)}${department.slice(1).toLowerCase()}` ||
          w.name.toLowerCase().includes(`dept ${department.toLowerCase()}`) ||
          w.name === targetName),
    );
    const ok = !!hit;
    cachedActiveWebhooks.set(department, ok);
    return ok;
  } catch (e) {
    console.error(`[n8n] isWebhookAvailable(${department}) failed:`, e);
    cachedActiveWebhooks.set(department, false);
    return false;
  }
}

interface TriggerableTask {
  id: string;
  orgId: string;
  title: string;
  input: string;
  department: string;
  taskType?: string | null;
}

/** 任意の webhook パスへ POST する共通実装。systemPrompt を渡すとエージェント workflow が優先利用する。 */
export async function triggerN8nWorkflowByPath(
  path: string,
  task: TriggerableTask,
  systemPrompt?: string,
): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: task.orgId },
    select: { plan: true },
  });
  const gatewayUrl = process.env.API_GATEWAY_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${N8N_URL}/webhook/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Webhook ノードの Header Auth でこのトークンを受ける
        'x-org-ai-token': N8N_WEBHOOK_AUTH_TOKEN,
      },
      body: JSON.stringify({
        taskId: task.id,
        orgId: task.orgId,
        title: task.title,
        input: task.input,
        department: task.department,
        taskType: task.taskType ?? null,
        ...(systemPrompt ? { systemPrompt } : {}),
        plan: org?.plan ?? 'STARTER',
        callbackUrl: `${gatewayUrl}/api/webhooks/n8n/task-complete`,
        logUrl: `${gatewayUrl}/api/webhooks/n8n/task-log`,
        aiEngineUrl: process.env.AI_ENGINE_URL ?? 'http://localhost:8000',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[n8n] webhook ${path} failed: ${res.status} ${body}`);
      return false;
    }
    console.log(`[n8n] webhook ${path} accepted (taskId=${task.id})`);
    return true;
  } catch (e) {
    console.error(`[n8n] webhook ${path} trigger failed:`, e);
    return false;
  }
}

export async function triggerN8nWorkflow(task: TriggerableTask): Promise<boolean> {
  const path = DEPT_WEBHOOK_PATHS[task.department];
  if (!path) {
    console.warn(`[n8n] webhook path not defined for ${task.department}`);
    return false;
  }
  return triggerN8nWorkflowByPath(path, task);
}

export async function executeTaskViaAiEngine(task: {
  id: string;
  orgId: string;
  title: string;
  input: string;
  department: string;
}): Promise<void> {
  const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
  const org = await prisma.organization.findUnique({
    where: { id: task.orgId },
    select: { plan: true },
  });
  try {
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'AI Engineで直接実行を開始', level: 'INFO' },
    });
    const res = await fetch(`${aiEngineUrl}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: task.input,
        org_id: task.orgId,
        session_id: task.id,
        department: task.department,
        plan: org?.plan ?? 'STARTER',
      }),
    });
    if (!res.ok) throw new Error(`AI Engine returned ${res.status}`);
    const result = (await res.json()) as { content: string; department: string };
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE', output: result.content, executedAt: new Date() },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'AI Engineで実行完了', level: 'INFO' },
    });
  } catch (e) {
    console.error('[ai-engine-fallback] failed:', e);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'FAILED', lastError: String(e) },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `実行失敗: ${String(e)}`, level: 'ERROR' },
    });
  }
}

/** QUEUED 状態の Task を n8n もしくは AI Engine で発火する共通エントリ */
export async function dispatchQueuedTask(task: {
  id: string;
  orgId: string;
  title: string;
  input: string;
  department: string;
  taskType?: string | null;
}): Promise<void> {
  const useN8n = await isWebhookAvailable(task.department);
  if (useN8n) {
    const ok = await triggerN8nWorkflow(task);
    if (ok) return;
    console.warn(`[n8n] webhook 呼び出し失敗 → AI Engine にフォールバック (task=${task.id})`);
  }
  await executeTaskViaAiEngine(task);
}

// ───────────────────────── エージェント実行 ─────────────────────────

/** 名前 (org-ai Agent <id>) でアクティブな n8n ワークフローが存在するか判定。
 *  保存エージェントの専用 webhook 用。API キー無しなら true 扱い（404 は呼び出し側でフォールバック）。
 */
async function isWebhookAvailableByName(workflowName: string): Promise<boolean> {
  if (cachedActiveWebhooks.has(workflowName)) return cachedActiveWebhooks.get(workflowName)!;
  if (!N8N_API_KEY) {
    cachedActiveWebhooks.set(workflowName, true);
    return true;
  }
  try {
    const res = await fetch(`${N8N_URL}/api/v1/workflows?active=true`, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY },
    });
    if (!res.ok) {
      cachedActiveWebhooks.set(workflowName, false);
      return false;
    }
    const json = (await res.json()) as { data: { name: string; active: boolean }[] };
    const ok = json.data.some((w) => w.active && w.name === workflowName);
    cachedActiveWebhooks.set(workflowName, ok);
    return ok;
  } catch (e) {
    console.error(`[n8n] isWebhookAvailableByName(${workflowName}) failed:`, e);
    cachedActiveWebhooks.set(workflowName, false);
    return false;
  }
}

export interface AgentRunContext {
  id: string;
  instructions: string;
  department: string;
  webhookPath?: string | null;
  n8nStatus?: string | null;
}

/** AI Engine /llm/chat にエージェントの system プロンプトを注入して直接実行する（n8n フォールバック）。 */
export async function executeTaskViaAgentEngine(
  task: { id: string; orgId: string; input: string },
  agent: AgentRunContext,
): Promise<void> {
  const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
  const org = await prisma.organization.findUnique({
    where: { id: task.orgId },
    select: { plan: true },
  });
  try {
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'AI Engine でエージェントを直接実行', level: 'INFO' },
    });
    const res = await fetch(`${aiEngineUrl}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: agent.instructions },
          { role: 'user', content: task.input },
        ],
        department: agent.department,
        org_id: task.orgId,
        plan: org?.plan ?? 'STARTER',
        json_mode: false,
      }),
    });
    if (!res.ok) throw new Error(`AI Engine returned ${res.status}`);
    const result = (await res.json()) as { content: string };
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE', output: result.content, executedAt: new Date() },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'AI Engine で実行完了', level: 'INFO' },
    });
  } catch (e) {
    console.error('[agent-engine-fallback] failed:', e);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'FAILED', lastError: String(e) },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `実行失敗: ${String(e)}`, level: 'ERROR' },
    });
  }
}

const AGENT_WEBHOOK_RETRY_DELAYS_MS = [0, 5_000, 15_000];

/** 保存エージェントの Task を発火する。
 *  専用 n8n webhook がアクティブなら優先（コールドスタート対策でリトライ）、不達なら AI Engine フォールバック。
 *  途中経過は TaskLog に書き、フロントが「n8n起動中…」を可視化できるようにする。
 */
export async function dispatchAgentTask(
  task: { id: string; orgId: string; title: string; input: string; taskType?: string | null },
  agent: AgentRunContext,
): Promise<void> {
  const wantsN8n = !!agent.webhookPath && agent.n8nStatus === 'ACTIVE';
  if (wantsN8n) {
    const workflowName = agentWorkflowName(agent.id);
    const available = await isWebhookAvailableByName(workflowName);
    if (available) {
      const triggerTask: TriggerableTask = {
        id: task.id,
        orgId: task.orgId,
        title: task.title,
        input: task.input,
        department: agent.department,
        taskType: task.taskType ?? 'agent',
      };
      for (let attempt = 0; attempt < AGENT_WEBHOOK_RETRY_DELAYS_MS.length; attempt++) {
        const delay = AGENT_WEBHOOK_RETRY_DELAYS_MS[attempt];
        if (delay > 0) {
          await prisma.taskLog.create({
            data: {
              taskId: task.id,
              message: `n8n起動中… (${Math.round(delay / 1000)}秒待機して再試行)`,
              level: 'INFO',
            },
          });
          await sleep(delay);
        }
        const ok = await triggerN8nWorkflowByPath(agent.webhookPath!, triggerTask, agent.instructions);
        if (ok) return; // 受理。完了は n8n コールバックが Task を DONE に更新する
      }
      await prisma.taskLog.create({
        data: { taskId: task.id, message: 'n8n 応答なし → AI Engine で実行に切替', level: 'WARN' },
      });
    }
  }
  await executeTaskViaAgentEngine(task, agent);
}
