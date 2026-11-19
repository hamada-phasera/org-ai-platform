// 部品の呼び出し（docs/design/canvas-home.md §8.2・§8.3）。部品＝運営が用意した既製の処理。お客さんは入力値を渡して呼ぶだけ。
//
// ■ n8n 経由（via.kind='n8n'）
//   URL は `${config.n8nUrl}/webhook/parts/<key>` だけ。ベースは環境変数、入るのはカタログの key（英小文字・数字・_）だけ。
//   フロー定義にもカタログにも URL・パスを書く欄が無い＝`pages/…` `dept-*` `cap-*` `agent-*` には構造的に届かない（K6・T6・T7）。
//   body の orgId は実行の組織（JWT から。利用者の入力から取らない）。メール・氏名は送らない。
//   応答は JSON・256KB まで。カタログの output に宣言したキーだけを受け取り、他は捨てる（T9）。
//   再試行は idempotent の部品の接続エラーだけ 1 回。n8n が無くても ai-engine へフォールバックしない（K8）。
// ■ capability 経由（via.kind='capability'）
//   既存の resolveAndExecute（name 指定＝確信度ゲートを通らない確定実行）。native adapter → n8n `cap-*` の順は既存のまま（K7）。
//   お客さんが作るカスタム HTTP ノード（kind='http'）は部品にしない（§8.3）。同じ名前でも呼ばない。
// ■ 外へ送る部品（external_send）は、ここに来る前にランナーが必ず承認で止めている（K12）。ここでは止めない。
// ⚠️ n8n の public API（/api/v1/・config.n8nApiKey・n8n-workflow-builder）はここから使わない（D9・T22。architecture.test.ts）。

import {
  FLOW_DEFINITION_LIMITS,
  type FlowPartOutputSpec,
  type FlowPartSpec,
} from '@org-ai/shared-types';
import { config } from '../../config/env';
import type { TenantDb } from '../../tenancy/tenant-db';
import { createLogger } from '../../utils/logger';
import { resolveAndExecute } from '../capability-resolver';
import { callN8nWebhook } from '../n8n/webhook-call';
import { scalarRows } from './nodes/types';

const log = createLogger('flows');

/** カタログの key の形（flow-parts の決まりと同じ）。URL に入るのはこれに合う文字だけ */
export const PART_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
/** 部品の応答の上限（T9） */
export const PART_RESPONSE_MAX_BYTES = 256 * 1024;
const PART_TIMEOUT_DEFAULT_MS = 10_000;
const PART_TIMEOUT_MAX_MS = 30_000;
const MAX_ROWS = 50;

export type PartFailure = { ok: false; code: string; message: string; partCalls: number; attempts: number };
export type PartOutcome = { ok: true; output: Record<string, unknown>; warnings: string[]; partCalls: number; attempts: number } | PartFailure;

const failure = (code: string, message: string, partCalls = 0, attempts = 1): PartFailure => ({ ok: false, code, message, partCalls, attempts });

/**
 * 部品の URL。ベースは環境変数だけ、入るのは key だけ。key はカタログで縛っているが、ここでももう一度確かめる
 * （壊れた行・知らない key で別のパスに届かないように）。
 */
export function buildPartUrl(baseUrl: string, key: string): string {
  if (!PART_KEY_PATTERN.test(key)) throw new Error('invalid part key');
  return `${baseUrl.replace(/\/+$/, '')}/webhook/parts/${key}`;
}

export function partTimeoutMs(spec: Pick<FlowPartSpec, 'timeoutMs'>): number {
  const t = spec.timeoutMs ?? PART_TIMEOUT_DEFAULT_MS;
  return Math.min(PART_TIMEOUT_MAX_MS, Math.max(1_000, t));
}

// ── 応答の切り詰め ─────────────────────────────────────

function scalarOf(type: Exclude<FlowPartOutputSpec['type'], 'rows'>, v: unknown): string | number | boolean | null | undefined {
  if (v === undefined) return undefined;
  if (type === 'text') {
    if (typeof v === 'string') return v.slice(0, FLOW_DEFINITION_LIMITS.documentBodyMax);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return String(v);
    return v === null ? '' : undefined;
  }
  if (type === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

/**
 * 部品の応答を、カタログに宣言した出力だけに切り詰める（他のキー・入れ子は捨てる）。
 * external_send の部品の `sent` は、呼び出しが成功して応答に無ければ true（送った事実だけを次へ渡す）。
 */
export function shapePartOutput(
  spec: Pick<FlowPartSpec, 'output' | 'sideEffect'>,
  json: unknown,
): { ok: true; output: Record<string, unknown>; warnings: string[] } | { ok: false } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false };
  const src = json as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const warnings: string[] = [];
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(src, k);
  for (const o of spec.output) {
    if (o.type === 'rows') {
      const rows = has(o.key) ? scalarRows(src[o.key]) : undefined;
      const cols = o.columns;
      output[o.key] = (rows ?? []).slice(0, MAX_ROWS).map((row) => {
        if (!cols) return row;
        const picked: Record<string, unknown> = {};
        for (const c of cols) picked[c.key] = scalarOf(c.type, row[c.key]) ?? null;
        return picked;
      });
      if (rows === undefined) warnings.push(`部品の応答に ${o.key} がありません`);
      continue;
    }
    if (o.key === 'sent' && o.type === 'boolean' && !has('sent')) {
      output.sent = true;
      continue;
    }
    const v = has(o.key) ? scalarOf(o.type, src[o.key]) : undefined;
    if (v === undefined) {
      warnings.push(`部品の応答に ${o.key} がありません`);
      output[o.key] = o.type === 'text' ? '' : null;
    } else {
      output[o.key] = v;
    }
  }
  return { ok: true, output, warnings };
}

// ── n8n ───────────────────────────────────────────────

export interface N8nPartRequest {
  orgId: string;
  runId: string;
  nodeId: string;
  actor: { userId: string | null; role: string | null };
  plan: string;
  input: Record<string, unknown>;
}

/** n8n の `parts/<key>` を呼ぶ。未設定なら呼ばずに「未接続」（受け付けでも 503 にしているが、実行時にももう一度見る） */
export async function callN8nPart(spec: FlowPartSpec, req: N8nPartRequest): Promise<PartOutcome> {
  if (!config.n8nConfigured) return failure('FLOW_PART_NOT_CONNECTED', `部品「${spec.title}」は未接続です`, 0);
  let url: string;
  try {
    url = buildPartUrl(config.n8nUrl, spec.key);
  } catch {
    return failure('FLOW_PART_UNKNOWN', '知らない部品です', 0);
  }
  const result = await callN8nWebhook({
    url,
    body: {
      orgId: req.orgId,
      part: spec.key,
      input: req.input,
      runId: req.runId,
      nodeId: req.nodeId,
      // 部品側が同じ呼び出しを 1 回だけ処理できるように（§7.3）
      idempotencyKey: `${req.runId}:${req.nodeId}`,
      actor: req.actor,
      plan: req.plan,
      aiEngineUrl: config.aiEngineUrl,
    },
    retryOnConnectionError: spec.idempotent,
    timeoutMs: partTimeoutMs(spec),
    maxBytes: PART_RESPONSE_MAX_BYTES,
  });
  if (!result.ok) {
    log.warn(`部品の呼び出しに失敗 run=${req.runId} node=${req.nodeId} part=${spec.key} reason=${result.reason} ms=${result.durationMs}`);
    if (result.reason === 'TIMEOUT') return failure('FLOW_PART_TIMEOUT', `部品「${spec.title}」の応答が時間内に返りませんでした`, result.attempts, result.attempts);
    if (result.reason === 'INVALID_RESPONSE') return failure('FLOW_PART_BAD_OUTPUT', `部品「${spec.title}」の応答が決めた形ではありませんでした`, result.attempts, result.attempts);
    return failure('FLOW_PART_UNREACHABLE', `部品「${spec.title}」に届きませんでした。もう一度実行してください`, result.attempts, result.attempts);
  }
  const json = result.json as { ok?: unknown } | null;
  if (json && typeof json === 'object' && json.ok === false) {
    // 業務上の失敗。上流の文言は返さない（T19）
    return failure('FLOW_PART_FAILED', `部品「${spec.title}」が失敗を返しました`, result.attempts, result.attempts);
  }
  const shaped = shapePartOutput(spec, result.json);
  if (!shaped.ok) return failure('FLOW_PART_BAD_OUTPUT', `部品「${spec.title}」の応答が決めた形ではありませんでした`, result.attempts, result.attempts);
  return { ok: true, output: shaped.output, warnings: shaped.warnings, partCalls: result.attempts, attempts: result.attempts };
}

// ── capability ─────────────────────────────────────────

/** カンマ区切り（全角の読点・カンマも）を配列に。空の要素は捨てない（列の位置を保つ） */
function splitCells(line: string): string[] {
  return line.split(/[,，、]/).map((c) => c.trim());
}

/**
 * 部品の入力（展開後の文字）を capability の引数に直す。配列の引数（スプレッドシートの headers / rows）は
 * 「カンマ区切り・1 行 1 件」の文字から配列にする（K38）。それ以外はそのまま。
 */
export function toCapabilityArgs(capabilityName: string, input: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') args[k] = v;
  if (capabilityName === 'create_google_sheet') {
    const headers = typeof input.headers === 'string' ? splitCells(input.headers).filter((h) => h !== '') : [];
    const rows =
      typeof input.rows === 'string'
        ? input.rows
            .split(/\r?\n/)
            .filter((l) => l.trim() !== '')
            .slice(0, 500)
            .map(splitCells)
        : [];
    args.headers = headers;
    args.rows = rows;
  }
  return args;
}

export interface CapabilityCallRequest {
  name: string;
  args: Record<string, unknown>;
  actorId: string | null;
  plan: string;
  /** 利用者に見せる名前（「Slack」など） */
  title: string;
}

/**
 * 既存の capability を確定実行する（resolveAndExecute）。組織に登録が無い・無効・カスタム HTTP なら呼ばない。
 * 失敗の文言は利用者向けの決まった文だけ（上流の本文は返さない）。
 */
export async function callCapability(db: TenantDb, req: CapabilityCallRequest): Promise<PartOutcome> {
  const cap = await db.capability.findUnique({
    where: { orgId_name: { orgId: db.orgId, name: req.name } },
    select: { id: true, kind: true, status: true },
  });
  if (!cap || cap.status === 'DISABLED') {
    return failure('FLOW_PART_NOT_CONNECTED', `「${req.title}」が使えるように設定されていません。設定 > 連携 から接続してください`, 0);
  }
  if (cap.kind === 'http') {
    // お客さんが作ったカスタム HTTP ノードは部品にしない（同じ名前を付けても呼ばない。§8.3）
    return failure('FLOW_PART_NOT_CONNECTED', `「${req.title}」は部品として使えません`, 0);
  }
  const outcome = await resolveAndExecute({
    name: req.name,
    args: req.args,
    // 定期実行には操作した人がいない（エージェントと同じく実行の主体を固定の名前にする）
    userId: req.actorId ?? 'flow-runner',
    orgId: db.orgId,
    plan: req.plan,
  });
  switch (outcome.outcome) {
    case 'EXECUTED': {
      if (outcome.envelope.status === 'success') {
        const data = outcome.envelope.data;
        return { ok: true, output: (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>, warnings: [], partCalls: 1, attempts: 1 };
      }
      const auth = /AUTH/i.test(String(outcome.envelope.error_type ?? ''));
      return auth
        ? failure('FLOW_PART_NEEDS_AUTH', `「${req.title}」の連携が切れています。設定 > 連携 から接続し直してください`, 1)
        : failure('FLOW_PART_FAILED', `「${req.title}」の実行に失敗しました`, 1);
    }
    case 'NEEDS_AUTH':
      return failure('FLOW_PART_NEEDS_AUTH', `「${req.title}」の連携が必要です。設定 > 連携 から接続してください`, 0);
    case 'VALIDATION_ERROR':
      return failure('FLOW_PART_INPUT', `「${req.title}」に渡す値が合いません`, 0);
    default:
      return failure('FLOW_PART_NOT_CONNECTED', `「${req.title}」が使えるように設定されていません`, 0);
  }
}

/** capability 経由の部品。応答をカタログの宣言どおりに切り詰める */
export async function callCapabilityPart(
  db: TenantDb,
  spec: FlowPartSpec & { via: { kind: 'capability'; name: string } },
  req: { input: Record<string, unknown>; actorId: string | null; plan: string },
): Promise<PartOutcome> {
  const res = await callCapability(db, {
    name: spec.via.name,
    args: toCapabilityArgs(spec.via.name, req.input),
    actorId: req.actorId,
    plan: req.plan,
    title: spec.title,
  });
  if (!res.ok) return res;
  const shaped = shapePartOutput(spec, res.output);
  if (!shaped.ok) return failure('FLOW_PART_BAD_OUTPUT', `部品「${spec.title}」の応答が決めた形ではありませんでした`, res.partCalls);
  return { ok: true, output: shaped.output, warnings: shaped.warnings, partCalls: res.partCalls, attempts: 1 };
}
