import Ajv, { type Schema } from 'ajv';
import addFormats from 'ajv-formats';
import { prisma } from '../utils/prisma';
import { executeCapability, type N8nEnvelope } from './capability-executor';
import { nativeProviderFor } from './adapters/provider-map';
import { httpMethodOf } from './http-node/template';
import { scrubJson } from './secret-scrubber';
import { aiEngineHeaders } from './ai-engine-auth';

// 型は capability-executor に移設済み。既存 import 互換のため re-export する。
export type { ErrorType, N8nEnvelope } from './capability-executor';

const AI_ENGINE_URL = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
const N8N_URL = process.env.N8N_CLOUD_URL ?? process.env.N8N_URL ?? 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const CREDS_CACHE_TTL_MS = 3 * 60 * 1000;
const ADMIN_SLACK_CHANNEL = process.env.ADMIN_SLACK_CHANNEL ?? '#org-ai-admin';
// rawInput 推論の確信度がこれ未満なら実行せず NEEDS_CONFIRMATION を返す（人が確認して確定実行）。
const CONFIDENCE_THRESHOLD = Number(process.env.CAPABILITY_CONFIDENCE_THRESHOLD ?? 0.7);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export type ResolveOutcome =
  | { outcome: 'EXECUTED'; capability: string; envelope: N8nEnvelope; executionLogId: string }
  | { outcome: 'NEEDS_AUTH'; capability: string; missing: string[] }
  | { outcome: 'UNSUPPORTED'; inferredName: string | null; reasoning: string; gapId: string }
  | { outcome: 'VALIDATION_ERROR'; capability: string; errors: string[] }
  | {
      outcome: 'NEEDS_CONFIRMATION';
      capability: string;
      displayName: string;
      args: Record<string, unknown>;
      confidence: number;
      reasoning: string;
    };

type PlanFromAi = {
  capability_name: string | null;
  args: Record<string, unknown>;
  confidence: number;
  reasoning: string;
  inferred_name?: string | null;
};

// 内部再呼び出しの無限再帰を防ぐ
let resolvingNotifySlack = false;

export async function resolveAndExecute(input: {
  rawInput?: string;
  name?: string | null;
  args?: Record<string, unknown>;
  userId: string;
  orgId: string;
  plan?: string;
  /** preview = 実行せず内容確認（NEEDS_CONFIRMATION）を返す。既定は execute。 */
  mode?: 'execute' | 'preview';
}): Promise<ResolveOutcome> {
  let { name, args = {} } = input;
  let reasoning = '';
  let inferredName: string | null = null;
  // name 明示指定（承認後の確定実行・step-runner）は confidence ゲートを素通りさせる。
  // rawInput からの推論時のみ確信度を見る。
  let inferredConfidence: number | null = null;

  if (!name) {
    const planResult = await fetchPlanFromAiEngine(input.rawInput ?? '', input.orgId, input.plan ?? 'STARTER', input.userId);
    name = planResult.capability_name ?? null;
    args = planResult.args ?? {};
    reasoning = planResult.reasoning;
    inferredName = planResult.inferred_name ?? null;
    inferredConfidence = typeof planResult.confidence === 'number' ? planResult.confidence : null;
    if (!name) {
      const gap = await recordGap({
        orgId: input.orgId,
        userId: input.userId,
        rawRequest: input.rawInput ?? '',
        inferredName,
      });
      await notifyAdmins(input.orgId, gap.rawRequest, gap.inferredName);
      return { outcome: 'UNSUPPORTED', inferredName, reasoning, gapId: gap.id };
    }
  }

  const capability = await prisma.capability.findUnique({
    where: { orgId_name: { orgId: input.orgId, name } },
    include: { requiredCreds: true },
  });
  if (!capability || capability.status === 'DISABLED') {
    const gap = await recordGap({
      orgId: input.orgId,
      userId: input.userId,
      rawRequest: input.rawInput ?? '',
      inferredName: name,
    });
    await notifyAdmins(input.orgId, gap.rawRequest, gap.inferredName);
    return { outcome: 'UNSUPPORTED', inferredName: name, reasoning: 'レジストリに該当 capability なし or DISABLED', gapId: gap.id };
  }

  // 実行前確認ゲート: preview 指定は常に、rawInput 推論は確信度不足のときだけ止める。
  // 承認後は name + args を明示指定して呼び直す（→ このゲートを通らず確定実行）。
  const lowConfidence = inferredConfidence !== null && inferredConfidence < CONFIDENCE_THRESHOLD;
  // チャット経路は step-runner を通らないため承認ゲートが効かない。書き込み系の
  // カスタムノードを AI 推論で選んだ場合は、確信度によらず必ず人に確認させる
  // （＝「AI が推論した宛先へ人の確認なしで POST」を成立させない）。
  const isCustomWrite =
    capability.kind === 'http' && (httpMethodOf(capability.httpConfig) ?? '') !== 'GET';
  if (input.mode === 'preview' || lowConfidence || (isCustomWrite && inferredConfidence !== null)) {
    return {
      outcome: 'NEEDS_CONFIRMATION',
      capability: capability.name,
      displayName: capability.displayName,
      args,
      confidence: inferredConfidence ?? 1,
      reasoning,
    };
  }

  const validation = validateArgs(capability.inputSchema as Schema, args);
  if (!validation.ok) {
    await prisma.executionLog.create({
      data: {
        orgId: input.orgId,
        capabilityId: capability.id,
        status: 'error',
        errorType: 'VALIDATION_ERROR',
        requestArgs: args as object,
        responseData: { errors: validation.errors },
      },
    });
    return { outcome: 'VALIDATION_ERROR', capability: capability.name, errors: validation.errors };
  }

  const missing = await checkCredentials(capability.id, input.orgId);
  if (missing.length > 0) {
    return { outcome: 'NEEDS_AUTH', capability: capability.name, missing };
  }

  const envelope = await executeCapability(capability, args, input.orgId);

  // ⚠️ カスタム HTTP ノードの応答は「利用者が指定した任意の外部API」が返したもの。
  //    トークン更新系の API は平気で access_token を返すし、ExecutionLog は
  //    org のメンバーなら誰でも読める。永続化する前に一度落とす。
  //    （native / n8n は宛先が自社管理なので対象外にして、正当なデータを壊さない）
  const isCustomHttp = capability.kind === 'http';
  const execLog = await prisma.executionLog.create({
    data: {
      orgId: input.orgId,
      capabilityId: capability.id,
      status: envelope.status,
      errorType: envelope.error_type ?? null,
      requestArgs: (isCustomHttp ? scrubJson(args) : args) as object,
      responseData: (isCustomHttp ? scrubJson(envelope.data) : envelope.data) as object,
    },
  });
  return { outcome: 'EXECUTED', capability: capability.name, envelope, executionLogId: execLog.id };
}

async function fetchPlanFromAiEngine(message: string, orgId: string, plan: string, _userId: string): Promise<PlanFromAi> {
  const caps = await prisma.capability.findMany({
    where: { orgId, status: { not: 'DISABLED' } },
    select: { name: true, displayName: true, description: true, department: true, inputSchema: true },
  });
  const payload = JSON.stringify({
    message,
    org_id: orgId,
    plan,
    available_capabilities: caps.map((c) => ({
      name: c.name,
      displayName: c.displayName,
      description: c.description,
      department: c.department,
      inputSchema: c.inputSchema,
    })),
  });
  // /plan は LLM 呼び出しを含み、一時的に 5xx/タイムアウトしうる（Anthropic の瞬間的な失敗等）。
  // 単発の失敗で「未対応」と誤表示しないよう 1 回リトライする。
  let lastReason = 'AI Engine /plan 失敗';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${AI_ENGINE_URL}/plan`, {
        method: 'POST',
        headers: aiEngineHeaders(),
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as PlanFromAi;
      lastReason = `AI Engine /plan ${res.status}`;
      console.error(`[capability-resolver] AI Engine /plan returned ${res.status} (attempt ${attempt + 1})`);
    } catch (e) {
      lastReason = 'AI Engine 到達不可';
      console.error(`[capability-resolver] fetchPlanFromAiEngine failed (attempt ${attempt + 1}):`, e);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  return { capability_name: null, args: {}, confidence: 0, reasoning: lastReason };
}

function validateArgs(schema: Schema, args: unknown): { ok: true } | { ok: false; errors: string[] } {
  try {
    const validate = ajv.compile(schema);
    if (validate(args)) return { ok: true };
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
    return { ok: false, errors };
  } catch (e) {
    return { ok: false, errors: [`schema compile error: ${String(e)}`] };
  }
}

async function checkCredentials(capabilityId: string, orgId: string): Promise<string[]> {
  const creds = await prisma.requiredCredential.findMany({ where: { capabilityId } });
  if (creds.length === 0) return [];
  const now = Date.now();
  const missing: string[] = [];
  for (const cred of creds) {
    let status: string = cred.status;
    const nativeProvider = nativeProviderFor(cred.provider);
    if (nativeProvider) {
      // セルフサーブ接続（自社DB）が真実の源。org 単位で正確に判定できる
      // （旧 n8n 部分一致判定の「org 分離なし・誤判定」問題はここで解消）。
      const conn = await prisma.providerConnection.findUnique({
        where: { orgId_provider: { orgId, provider: nativeProvider } },
      });
      status = conn?.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED';
      if (status !== cred.status) {
        await prisma.requiredCredential.update({
          where: { id: cred.id },
          data: { status: status as 'CONNECTED' | 'DISCONNECTED', lastCheckedAt: new Date() },
        });
      }
    } else {
      // 従来経路（gmail / x / google_sheets）: n8n credential 一覧の部分一致判定を維持
      const stale = !cred.lastCheckedAt || now - cred.lastCheckedAt.getTime() > CREDS_CACHE_TTL_MS;
      if (stale && N8N_API_KEY) {
        const refreshed = await refreshCredentialFromN8n(cred.provider);
        if (refreshed !== null) {
          status = refreshed ? 'CONNECTED' : 'DISCONNECTED';
          await prisma.requiredCredential.update({
            where: { id: cred.id },
            data: { status: status as 'CONNECTED' | 'DISCONNECTED', lastCheckedAt: new Date() },
          });
        }
      }
    }
    if (status !== 'CONNECTED') missing.push(cred.provider);
  }
  return missing;
}

const n8nCredsCache = new Map<string, { ok: boolean; at: number }>();

async function refreshCredentialFromN8n(provider: string): Promise<boolean | null> {
  const cached = n8nCredsCache.get(provider);
  if (cached && Date.now() - cached.at < CREDS_CACHE_TTL_MS) return cached.ok;
  try {
    const ctrl = AbortSignal.timeout(10_000);
    const res = await fetch(`${N8N_URL}/api/v1/credentials`, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY },
      signal: ctrl,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { name?: string; type?: string }[] };
    const hit = (j.data ?? []).some(
      (c) =>
        (c.type ?? '').toLowerCase().includes(provider.toLowerCase()) ||
        (c.name ?? '').toLowerCase().includes(provider.toLowerCase()),
    );
    n8nCredsCache.set(provider, { ok: hit, at: Date.now() });
    return hit;
  } catch (e) {
    console.error(`[capability-resolver] n8n credentials check failed (${provider}):`, e);
    return null;
  }
}

async function recordGap(input: {
  orgId: string;
  userId: string;
  rawRequest: string;
  inferredName: string | null;
}): Promise<{ id: string; rawRequest: string; inferredName: string | null }> {
  const key = input.inferredName ?? input.rawRequest.slice(0, 60);
  const existing = await prisma.capabilityGap.findFirst({
    where: { orgId: input.orgId, inferredName: key },
  });
  if (existing) {
    const updated = await prisma.capabilityGap.update({
      where: { id: existing.id },
      data: { count: { increment: 1 }, rawRequest: input.rawRequest, requestedBy: input.userId },
    });
    return { id: updated.id, rawRequest: updated.rawRequest, inferredName: updated.inferredName };
  }
  const created = await prisma.capabilityGap.create({
    data: {
      orgId: input.orgId,
      requestedBy: input.userId,
      rawRequest: input.rawRequest,
      inferredName: key,
    },
  });
  return { id: created.id, rawRequest: created.rawRequest, inferredName: created.inferredName };
}

async function notifyAdmins(orgId: string, rawRequest: string, inferredName: string | null): Promise<void> {
  if (resolvingNotifySlack) return;
  resolvingNotifySlack = true;
  try {
    await resolveAndExecute({
      name: 'notify_slack',
      args: {
        channel: ADMIN_SLACK_CHANNEL,
        text: `[未対応ケイパビリティ] org=${orgId}\n要求: ${rawRequest.slice(0, 200)}\n推定名: ${inferredName ?? '不明'}`,
      },
      userId: 'system',
      orgId,
    });
  } catch (e) {
    console.error('[capability-resolver] notifyAdmins failed:', e);
  } finally {
    resolvingNotifySlack = false;
  }
}
