// capability 実行の輸送層。resolveAndExecute（capability-resolver.ts）と
// step-runner の両方がここを通る唯一の実行入口。
// native adapter（gateway 直接実行、セルフサーブ接続のトークン使用）があればそれを、
// 無ければ従来どおり n8n webhook を呼ぶ。

import { getNativeAdapter } from './adapters';
import { executeHttpCapabilityDetailed } from './http-node/executor';
import { prisma } from '../utils/prisma';

const N8N_URL = process.env.N8N_CLOUD_URL ?? process.env.N8N_URL ?? 'http://localhost:5678';
const N8N_WEBHOOK_AUTH_TOKEN = process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'org-ai-n8n-secret-token';
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS ?? 30_000);

export type ErrorType =
  | 'AUTH_MISSING'
  | 'RATE_LIMIT'
  | 'NODE_FAILED'
  | 'TIMEOUT'
  | 'VALIDATION_ERROR'
  | null;

export type N8nEnvelope = {
  status: 'success' | 'error';
  error_type: ErrorType;
  message: string;
  data: unknown;
};

/** capability を実行する。kind='http' → adapter → n8n の順で解決。
 *
 * ⚠️ kind='http' を adapter より**先に**見るのは、カスタムノードが native adapter に
 *    横取りされないようにするため（seed 未投入の org が 'notify_slack' という名前の
 *    http ノードを作れてしまうので、名前一致より kind を優先する）。
 */
export async function executeCapability(
  capability: {
    id?: string;
    name: string;
    webhookPath: string | null;
    kind?: string | null;
    httpConfig?: unknown;
  },
  args: Record<string, unknown>,
  orgId: string,
): Promise<N8nEnvelope> {
  if (capability.kind === 'http') {
    const result = await executeHttpCapabilityDetailed(capability, args, orgId);
    if (result.authDead && capability.id) {
      // 資格情報が死んだ = 再接続が要る。Slack/Google と同じく status を落として可視化する
      await prisma.capability
        .update({ where: { id: capability.id }, data: { status: 'NEEDS_AUTH' } })
        .catch(() => {});
    }
    return result.envelope;
  }
  const adapter = getNativeAdapter(capability.name);
  if (adapter) {
    return adapter(args, { orgId });
  }
  return invokeN8n(capability.webhookPath ?? `cap-${capability.name}`, args);
}

export async function invokeN8n(webhookPath: string, args: Record<string, unknown>): Promise<N8nEnvelope> {
  const url = `${N8N_URL}/webhook/${webhookPath}`;
  try {
    const ctrl = AbortSignal.timeout(N8N_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-org-ai-token': N8N_WEBHOOK_AUTH_TOKEN,
      },
      body: JSON.stringify(args),
      signal: ctrl,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      return {
        status: 'error',
        error_type: res.status === 404 ? 'NODE_FAILED' : res.status === 429 ? 'RATE_LIMIT' : 'NODE_FAILED',
        message: `n8n HTTP ${res.status}: ${text.slice(0, 200)}`,
        data: parsed,
      };
    }
    if (parsed && typeof parsed === 'object' && 'status' in (parsed as object)) {
      const env = parsed as Partial<N8nEnvelope>;
      return {
        status: env.status === 'error' ? 'error' : 'success',
        error_type: (env.error_type ?? null) as ErrorType,
        message: typeof env.message === 'string' ? env.message : '',
        data: env.data ?? null,
      };
    }
    return { status: 'success', error_type: null, message: '', data: parsed ?? text };
  } catch (e: unknown) {
    const isTimeout = (e as { name?: string })?.name === 'AbortError' || /timeout|aborted/i.test(String(e));
    return {
      status: 'error',
      error_type: isTimeout ? 'TIMEOUT' : 'NODE_FAILED',
      message: String(e),
      data: null,
    };
  }
}
