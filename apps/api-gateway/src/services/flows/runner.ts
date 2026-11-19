// 業務フローの実行本体（docs/design/canvas-home.md §7）。DAG をトポロジカル順に進める。
//
// ■ 実行は必ず「着手済み（RUNNING を条件付き updateMany で取れた）」の行に対してだけ走る（queue.ts が取る）。
// ■ 実行の定義は FlowRun に写したもの（実行中にフローが編集されても影響しない）。形だけ検査し、
//   承認の強制停止は定義の検証に頼らずここで必ず見る（K12・T5。DB を直接書かれても止まる）。
// ■ ノードを終えるたびに steps を保存し、30 秒ごとに lockedAt（心拍）を塗る。止まった実行は queue.ts の回収が FAILED にする。
// ■ 状態の書き込みはすべて「status が RUNNING のときだけ」の条件付き。取り消し・回収と競合しても上書きしない。
// ■ 失敗したノードで止め、下流は SKIPPED。中断した実行は自動でやり直さない（K28）。
// ■ ログに値・本文を出さない（runId・nodeId・状態だけ。§7.5）。

import {
  FLOW_PARTS,
  FLOW_RUN_LIMITS as R,
  clipUtf8,
  flowDefinitionShapeSchema,
  isExternalSendNode,
  topoOrder,
  utf8ByteLength,
  type FlowDefinition,
  type FlowNode,
  type FlowScope,
  type FlowStepApprovalData,
  type FlowStepState,
} from '@org-ai/shared-types';
import { tenantDb, type TenantDb } from '../../tenancy/tenant-db';
import { createLogger } from '../../utils/logger';
import { planOf } from './limits';
import { approvalDataOf, gateArgsOf } from './nodes/approval';
import { runAiNode } from './nodes/ai';
import { runBranchNode } from './nodes/branch';
import { runDataNode } from './nodes/data';
import { runOutputNode, type DocumentOutput } from './nodes/output';
import { runPartNode } from './nodes/part';
import { runTriggerNode } from './nodes/trigger';
import type { NodeResult, NodeRunContext } from './nodes/types';

const log = createLogger('flows');

/** 同じ段で同時に走らせるノードの数（§7.3） */
const MAX_PARALLEL = 3;
const HEARTBEAT_MS = 30_000;

/** 止まった・終わったことを、HTTP で待っている受け付け（8 秒の同期待ち）に知らせる */
const waiters = new Map<string, Set<() => void>>();

export function notifyRunSettled(runId: string): void {
  const set = waiters.get(runId);
  if (!set) return;
  waiters.delete(runId);
  for (const fn of set) fn();
}

/** 止まる（終わる・承認待ち）か `ms` が過ぎるまで待つ。true なら止まった */
export function waitForRunSettled(runId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const set = waiters.get(runId) ?? new Set<() => void>();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      set.delete(done);
      if (set.size === 0) waiters.delete(runId);
      resolve(false);
    }, ms);
    timer.unref?.();
    set.add(done);
    waiters.set(runId, set);
  });
}

// ── 保存の大きさ（§5.4） ────────────────────────────────────

function jsonBytes(v: unknown): number {
  return utf8ByteLength(JSON.stringify(v ?? null));
}

/** 保存する出力を `max` バイトに収める（文字は後ろを切り、表は行を減らす）。切ったら truncated */
export function clipForStorage(output: Record<string, unknown>, max: number): { value: Record<string, unknown>; truncated: boolean } {
  const out: Record<string, unknown> = { ...output };
  let truncated = false;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && utf8ByteLength(v) > max) {
      out[k] = clipUtf8(v, max).text;
      truncated = true;
    }
  }
  for (let guard = 0; jsonBytes(out) > max && guard < 64; guard += 1) {
    truncated = true;
    const [key, val] = Object.entries(out).sort((a, b) => jsonBytes(b[1]) - jsonBytes(a[1]))[0] ?? [];
    if (key === undefined) break;
    if (typeof val === 'string') out[key] = clipUtf8(val, Math.floor(utf8ByteLength(val) / 2)).text;
    else if (Array.isArray(val)) out[key] = val.slice(0, Math.floor(val.length / 2));
    else out[key] = null;
  }
  return { value: out, truncated };
}

/** steps 全体を 256KB に収める（大きい出力から 4KB に縮める） */
function fitSteps(steps: Record<string, FlowStepState>): Record<string, FlowStepState> {
  const out: Record<string, FlowStepState> = { ...steps };
  for (let guard = 0; jsonBytes(out) > R.storedStepsMaxBytes && guard < 64; guard += 1) {
    const [id] = Object.entries(out)
      .filter(([, s]) => s.output && jsonBytes(s.output) > 4096)
      .sort((a, b) => jsonBytes(b[1].output) - jsonBytes(a[1].output))[0] ?? [];
    if (id === undefined) break;
    const s = out[id];
    out[id] = { ...s, output: clipForStorage(s.output ?? {}, 4096).value, truncated: true };
  }
  return out;
}

// ── 状態 ───────────────────────────────────────────────

interface RunRow {
  id: string;
  orgId: string;
  status: string;
  definition: unknown;
  input: unknown;
  steps: unknown;
  actorId: string | null;
  taskId: string | null;
  durationMs: number | null;
  aiCalls: number;
  partCalls: number;
}

function initialSteps(def: FlowDefinition, saved: unknown): Record<string, FlowStepState> {
  const prev = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, FlowStepState>) : {};
  const out: Record<string, FlowStepState> = {};
  for (const n of def.nodes) {
    out[n.id] = Object.prototype.hasOwnProperty.call(prev, n.id) ? prev[n.id] : { status: 'PENDING', attempts: 0 };
  }
  return out;
}

/** JST の日付（YYYY-MM-DD）。`{{ run.date }}` */
function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

function scopeOf(def: FlowDefinition, steps: Record<string, FlowStepState>, runId: string, orgName: string): FlowScope {
  const scope: FlowScope = Object.create(null) as FlowScope;
  scope.run = { date: jstDate(new Date()), id: runId };
  scope.org = { name: orgName };
  for (const n of def.nodes) {
    const s = steps[n.id];
    if (s?.status === 'SUCCEEDED' && s.output) scope[n.id] = { ...s.output };
  }
  return scope;
}

function branchTaken(state: FlowStepState | undefined): 'yes' | 'no' {
  return state?.output?.result === true ? 'yes' : 'no';
}

/**
 * まだのノードを見て、実行できるもの（ready）を返す。入る線がどれも通っていなければ SKIPPED にする
 * （分岐の反対側・失敗の下流）。合流するノードは、入る線のうち 1 本でも通っていれば走る（§7.3）。
 */
export function readyNodes(def: FlowDefinition, order: string[], steps: Record<string, FlowStepState>): string[] {
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of order) {
      if (steps[id].status !== 'PENDING') continue;
      const incoming = def.edges.filter((e) => e.to === id);
      if (incoming.length === 0) continue;
      const settled = incoming.every((e) => steps[e.from]?.status === 'SUCCEEDED' || steps[e.from]?.status === 'SKIPPED');
      if (!settled) continue;
      const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
      const active = incoming.some((e) => {
        const from = steps[e.from];
        if (from?.status !== 'SUCCEEDED') return false;
        if (nodeById.get(e.from)?.type === 'branch') return (e.when ?? 'yes') === branchTaken(from);
        return true;
      });
      if (!active) {
        steps[id] = { ...steps[id], status: 'SKIPPED' };
        changed = true;
      }
    }
  }
  return order.filter((id) => {
    if (steps[id].status !== 'PENDING') return false;
    const incoming = def.edges.filter((e) => e.to === id);
    return incoming.every((e) => steps[e.from]?.status === 'SUCCEEDED' || steps[e.from]?.status === 'SKIPPED');
  });
}

/** 人が通すまで止めるノードか（確認ノード、または外へ送るノードで手前の強制停止がまだ）。部品の性質が読めないときも止める */
function needsHuman(node: FlowNode, state: FlowStepState): boolean {
  if (node.type === 'approval') return true;
  return isExternalSendNode(node, FLOW_PARTS) && state.gateApproved !== true;
}

// ── 実行 ───────────────────────────────────────────────

async function executeNode(ctx: NodeRunContext, taskId: string | null): Promise<NodeResult & { document?: DocumentOutput }> {
  // 承認待ちから再開した外へ送るノードは、止めたときに固定した中身だけを送る（K57）
  switch (ctx.node.type) {
    case 'trigger':
      return runTriggerNode(ctx);
    case 'ai':
      return runAiNode(ctx);
    case 'data':
      return runDataNode(ctx);
    case 'branch':
      return runBranchNode(ctx);
    case 'output':
      return runOutputNode({ ...ctx, taskId });
    case 'part':
      return runPartNode(ctx);
    default:
      return { ok: false, error: { code: 'FLOW_NODE_TYPE', message: 'このノードは実行できません' } };
  }
}

class RunWriter {
  constructor(
    private readonly db: TenantDb,
    private readonly runId: string,
  ) {}

  /** status が RUNNING のときだけ書く。取れなければ false（取り消し・回収に負けた） */
  async write(data: Record<string, unknown>): Promise<boolean> {
    const res = await this.db.flowRun.updateMany({ where: { id: this.runId, status: 'RUNNING' }, data: data as never });
    return res.count > 0;
  }
}

/** 対の Task に状態を写す（§5.5。承認待ち→受信、文書→成果物） */
async function syncTask(db: TenantDb, taskId: string | null, data: Record<string, unknown>): Promise<void> {
  if (!taskId) return;
  await db.task.updateMany({ where: { id: taskId }, data: data as never }).catch((e: unknown) => {
    log.warn(`Task への写しに失敗 taskId=${taskId}: ${e instanceof Error ? e.name : 'error'}`);
  });
}

async function taskLog(db: TenantDb, taskId: string | null, message: string, level: 'INFO' | 'ERROR' = 'INFO'): Promise<void> {
  if (!taskId) return;
  await db.taskLog.create({ data: { taskId, message, level } }).catch(() => undefined);
}

/**
 * 着手済み（RUNNING）の実行を、止まる（承認待ち）か終わるまで進める。承認の後の再開も同じ入口。
 * 例外は呼び出し側に投げない（必ず FAILED か WAITING_APPROVAL で出口を作る）。
 */
export async function advanceRun(orgId: string, runId: string): Promise<void> {
  const db = tenantDb(orgId);
  try {
    await advanceInner(db, runId);
  } catch (e) {
    log.error(`実行が例外で止まりました runId=${runId}: ${e instanceof Error ? e.name : 'error'}`);
    const row = await db.flowRun.findUnique({ where: { id: runId }, select: { taskId: true } }).catch(() => null);
    const ok = await new RunWriter(db, runId)
      .write({ status: 'FAILED', error: { nodeId: null, code: 'INTERNAL', message: '実行中に問題が起きました。もう一度実行してください' }, finishedAt: new Date(), lockedAt: null })
      .catch(() => false);
    if (ok) await syncTask(db, row?.taskId ?? null, { status: 'FAILED', lastError: '実行中に問題が起きました' });
  } finally {
    notifyRunSettled(runId);
  }
}

async function advanceInner(db: TenantDb, runId: string): Promise<void> {
  const row = (await db.flowRun.findUnique({ where: { id: runId } })) as RunRow | null;
  if (!row || row.status !== 'RUNNING') return;
  const writer = new RunWriter(db, runId);
  const segmentStart = Date.now();
  const activeBefore = row.durationMs ?? 0;
  const activeMs = (): number => activeBefore + (Date.now() - segmentStart);
  // 呼び出しの回数（失敗で止まったときも書く＝部品の月間数に数える）
  let aiCalls = row.aiCalls;
  let partCalls = row.partCalls;

  const fail = async (nodeId: string | null, code: string, message: string, steps?: Record<string, FlowStepState>): Promise<void> => {
    if (steps) for (const id of Object.keys(steps)) if (steps[id].status === 'PENDING') steps[id] = { ...steps[id], status: 'SKIPPED' };
    const ok = await writer.write({
      status: 'FAILED',
      error: { nodeId, code, message },
      ...(steps ? { steps: fitSteps(steps) } : {}),
      aiCalls,
      partCalls,
      finishedAt: new Date(),
      durationMs: activeMs(),
      lockedAt: null,
    });
    if (ok) {
      await syncTask(db, row.taskId, { status: 'FAILED', lastError: message });
      await taskLog(db, row.taskId, `失敗: ${message}`, 'ERROR');
    }
    log.info(`run=${runId} FAILED node=${nodeId ?? '-'} code=${code}`);
  };

  const parsed = flowDefinitionShapeSchema.safeParse(row.definition);
  const order = parsed.success ? topoOrder(parsed.data as FlowDefinition) : null;
  if (!parsed.success || !order) return fail(null, 'FLOW_INVALID_DEFINITION', 'フローの定義が壊れています。フロー画面で直してください');
  const def = parsed.data as FlowDefinition;
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
  const steps = initialSteps(def, row.steps);
  const input = row.input && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Record<string, unknown>) : {};
  const [plan, org] = await Promise.all([planOf(db), db.organization.findUnique({ where: { id: db.orgId }, select: { name: true } })]);
  const scope = scopeOf(def, steps, runId, org?.name ?? '');

  const heartbeat = setInterval(() => {
    void writer.write({ lockedAt: new Date() }).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    for (;;) {
      if (activeMs() > R.runActiveMaxMs) return fail(null, 'TIMEOUT', '実行の時間の上限（5 分）を超えました', steps);
      const ready = readyNodes(def, order, steps);
      if (ready.length === 0) break;

      const runnable = ready.filter((id) => !needsHuman(nodeById.get(id) as FlowNode, steps[id])).slice(0, MAX_PARALLEL);
      if (runnable.length === 0) {
        // 承認で止める（同時に止めるのは 1 つだけ。独立した残りは先に済ませてある）
        const node = nodeById.get(ready[0]) as FlowNode;
        // 外へ送るノードは、送る中身をここで展開して固定する（承認の後はこれをそのまま送る。K57）
        const gateArgs = node.type === 'approval' ? undefined : gateArgsOf(node, scope);
        const approval: FlowStepApprovalData = approvalDataOf(runId, node, scope, gateArgs);
        steps[node.id] = {
          ...steps[node.id],
          status: 'WAITING_APPROVAL',
          startedAt: new Date().toISOString(),
          ...(gateArgs ? { gateArgs } : {}),
        };
        const ok = await writer.write({
          status: 'WAITING_APPROVAL',
          steps: fitSteps(steps),
          aiCalls,
          partCalls,
          durationMs: activeMs(),
          // 承認待ちでは「待ち始めた時刻」。7 日で EXPIRED にする回収が読む
          lockedAt: new Date(),
        });
        if (ok) {
          await syncTask(db, row.taskId, { status: 'PENDING_APPROVAL', approvalData: JSON.stringify(approval) });
          await taskLog(db, row.taskId, `「${node.label}」で承認を待っています`);
        }
        log.info(`run=${runId} WAITING_APPROVAL node=${node.id} gate=${approval.gate}`);
        return;
      }

      const startedAt = new Date().toISOString();
      for (const id of runnable) steps[id] = { ...steps[id], status: 'RUNNING', startedAt };
      if (!(await writer.write({ steps: fitSteps(steps), lockedAt: new Date() }))) return;

      const results = await Promise.all(
        runnable.map(async (id) => {
          const t0 = Date.now();
          const node = nodeById.get(id) as FlowNode;
          const state = steps[id];
          const gateArgs = state.gateApproved === true && state.gateArgs ? state.gateArgs : undefined;
          const res = await executeNode(
            { db, run: { id: runId, orgId: db.orgId, actorId: row.actorId, input }, plan, scope, node, ...(gateArgs ? { gateArgs } : {}) },
            row.taskId,
          );
          return { id, node, res, durationMs: Date.now() - t0 };
        }),
      );

      let failed: { nodeId: string; code: string; message: string } | null = null;
      for (const { id, node, res, durationMs } of results) {
        aiCalls += res.aiCalls ?? 0;
        partCalls += res.partCalls ?? 0;
        const base = { ...steps[id], finishedAt: new Date().toISOString(), durationMs, attempts: (steps[id].attempts ?? 0) + (res.attempts ?? 1) };
        if (!res.ok) {
          steps[id] = { ...base, status: 'FAILED', error: res.error };
          failed ??= { nodeId: id, ...res.error };
          continue;
        }
        if (jsonBytes(res.output) > R.nodeOutputMaxBytes) {
          steps[id] = { ...base, status: 'FAILED', error: { code: 'TOO_LARGE', message: '出力が大きすぎます' } };
          failed ??= { nodeId: id, code: 'TOO_LARGE', message: '出力が大きすぎます' };
          continue;
        }
        const stored = clipForStorage(res.output, R.storedNodeOutputMaxBytes);
        steps[id] = {
          ...base,
          status: 'SUCCEEDED',
          output: stored.value,
          ...(res.warnings && res.warnings.length > 0 ? { warnings: res.warnings.slice(0, 20) } : {}),
          ...(res.truncated || stored.truncated ? { truncated: true } : {}),
        };
        scope[id] = { ...res.output };
        if (res.document) {
          // 文書は対の Task を成果物にする（終わったときに DONE にする）
          await syncTask(db, row.taskId, {
            title: res.document.title || node.label,
            department: res.document.department,
            output: JSON.stringify({ title: res.document.title, body: res.document.body }),
          });
        }
        log.info(`run=${runId} node=${id} SUCCEEDED ${durationMs}ms`);
      }
      if (failed) return fail(failed.nodeId, failed.code, failed.message, steps);
      if (jsonBytes(scope) > R.runValuesMaxBytes) return fail(null, 'TOO_LARGE', '実行の値の合計が上限（1MB）を超えました', steps);
      if (!(await writer.write({ steps: fitSteps(steps), aiCalls, partCalls, lockedAt: new Date() }))) return;
    }

    // すべて終わった
    const pageNode = def.nodes.find((n) => n.type === 'output' && n.config.kind === 'page' && steps[n.id]?.status === 'SUCCEEDED');
    const output = pageNode ? clipForStorage(steps[pageNode.id].output ?? {}, R.storedOutputMaxBytes).value : null;
    const ok = await writer.write({
      status: 'SUCCEEDED',
      steps: fitSteps(steps),
      output: output as never,
      aiCalls,
      partCalls,
      finishedAt: new Date(),
      durationMs: activeMs(),
      lockedAt: null,
    });
    if (ok) {
      await syncTask(db, row.taskId, { status: 'DONE', executedAt: new Date() });
      await taskLog(db, row.taskId, '完了しました');
    }
    log.info(`run=${runId} SUCCEEDED`);
  } finally {
    clearInterval(heartbeat);
  }
}
