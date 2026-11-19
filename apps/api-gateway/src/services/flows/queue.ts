// 業務フローの受け付け・着手・承認の再開・回収（docs/design/canvas-home.md §7.2・K9）。
// キューの基盤は持たず、FlowRun の表をそのまま簡易キューにする（Redis もワーカーも足さない）。
//
// ■ 受け付け: 権限・契約（402 は requireAuth）・上限・入力を検証し、FlowRun(QUEUED) と Task を作る。
//   (orgId, requestId) の unique で二重実行を 409 DUPLICATE_REQUEST。
// ■ 着手: 条件付き updateMany（QUEUED → RUNNING）を取れた 1 回だけが走る（2 台でも二重に走らない）。
//   組織ごとの同時実行（プラン）と gateway 全体（FLOW_MAX_CONCURRENCY）に空きが無ければ QUEUED のまま。
//   終わるたびに次の QUEUED を取りに行く（pump）。
// ■ 承認の再開も条件付き updateMany（WAITING_APPROVAL → RUNNING）を取れた 1 回だけ（§7.3）。
// ■ 回収（60 秒ごと・起動直後）: 30 秒以上 QUEUED → 着手、心拍が 2 分途絶えた RUNNING → FAILED、7 日過ぎた承認待ち → EXPIRED。
//   回収の「全組織の FlowRun を引く」所だけ素の prisma（architecture.test.ts の allowlist に理由付き）。以降は tenantDb。
// ■ 中断した実行は自動でやり直さない（K28）。

import {
  FLOW_PARTS,
  FLOW_RUN_LIMITS as R,
  buildFlowRunInputSchema,
  findFlowPart,
  flowDefinitionSchema,
  flowLimitsOf,
  flowRunAdmission,
  hasRoleAtLeast,
  planAllowsPart,
  utf8ByteLength,
  type FlowDefinition,
  type FlowNodeOf,
  type FlowRunTrigger,
  type FlowStepApprovalData,
  type FlowStepState,
  type UserRole,
} from '@org-ai/shared-types';
import { prisma } from '../../utils/prisma';
import { currentTenant, runAsTenant } from '../../tenancy/context';
import { tenantDb, type TenantDb } from '../../tenancy/tenant-db';
import { tracked } from '../lifecycle-core';
import { orgEntitlement } from '../org-entitlement';
import { config } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { describeIssues } from '../pages/upsert';
import { FlowServiceError, type FlowRow } from './store';
import { flowRunsThisMonth, partCallsThisMonth } from './limits';
import { advanceRun, notifyRunSettled } from './runner';

const log = createLogger('flows');

/** 中断の文言（既存の INTERRUPTED_MESSAGE と同じ言い回し。lifecycle.ts は prisma を読むのでここに写す） */
export const FLOW_INTERRUPTED_MESSAGE = 'デプロイまたは再起動により中断されました。もう一度実行してください';
const EXPIRED_MESSAGE = '承認の期限（7 日）が過ぎました。もう一度実行してください';

/** 調整値（テストで差し替える） */
export const flowQueueTuning = {
  syncWaitMs: R.syncWaitMs as number,
  queuedRecoverAfterMs: 30_000,
  staleRunningMs: 2 * 60_000,
  tickMs: 60_000,
};

// ── 受け付け ───────────────────────────────────────────

export interface AcceptRunInput {
  flow: FlowRow;
  input: unknown;
  requestId: string;
  trigger: FlowRunTrigger;
  actorId: string | null;
  plan: string;
}

export class FlowRunInputError extends Error {
  constructor(
    message: string,
    readonly issues: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
  }
}

function departmentOf(def: FlowDefinition): string {
  const doc = def.nodes.find((n) => n.type === 'output' && n.config.kind === 'document');
  return doc && doc.type === 'output' && doc.config.kind === 'document' ? doc.config.department ?? 'GENERAL' : 'GENERAL';
}

/**
 * 受け付けて FlowRun(QUEUED) と Task を作る。断るときは FlowServiceError（status と code）か FlowRunInputError（400）。
 * 判定の順: 定義 → 有効 → 入力 → 部品（未接続 503・プラン 403）→ 月間上限 429 → QUEUED の上限 429 → 二重 409。
 */
export async function acceptRun(db: TenantDb, req: AcceptRunInput): Promise<{ runId: string; taskId: string }> {
  const parsed = flowDefinitionSchema.safeParse(req.flow.definition);
  if (!parsed.success) throw new FlowServiceError(409, 'FLOW_INVALID_DEFINITION', 'フローの定義が古い形です。フロー画面で直して保存してください');
  const def = parsed.data as FlowDefinition;
  if (!req.flow.enabled) throw new FlowServiceError(409, 'FLOW_DISABLED', 'このフローは無効になっています');

  const trigger = def.nodes.find((n): n is FlowNodeOf<'trigger'> => n.type === 'trigger');
  if (!trigger) throw new FlowServiceError(409, 'FLOW_INVALID_DEFINITION', 'きっかけがありません');
  const input = buildFlowRunInputSchema(trigger.config).safeParse(req.input ?? {});
  if (!input.success) {
    throw new FlowRunInputError(
      describeIssues(input.error.issues),
      input.error.issues.slice(0, 20).map((i) => ({ path: i.path, message: i.message })),
    );
  }
  if (utf8ByteLength(JSON.stringify(input.data)) > R.inputMaxBytes) throw new FlowRunInputError('入力が大きすぎます', []);

  const partNodes = def.nodes.filter((n): n is FlowNodeOf<'part'> => n.type === 'part');
  for (const node of partNodes) {
    const spec = findFlowPart(node.config.part, FLOW_PARTS);
    if (!spec) throw new FlowServiceError(409, 'FLOW_INVALID_DEFINITION', '知らない部品があります');
    if (spec.via.kind === 'n8n' && !config.n8nConfigured) {
      throw new FlowServiceError(503, 'FLOW_PART_NOT_CONNECTED', `部品「${spec.title}」は未接続です`);
    }
    if (!planAllowsPart(req.plan, spec.minPlan)) {
      throw new FlowServiceError(403, 'FLOW_PART_PLAN', `部品「${spec.title}」は今のプランでは使えません`);
    }
  }

  const [runsThisMonth, partCalls, queued, dup] = await Promise.all([
    flowRunsThisMonth(db),
    partNodes.length > 0 ? partCallsThisMonth(db) : Promise.resolve(0),
    db.flowRun.count({ where: { status: 'QUEUED' } }),
    db.flowRun.findFirst({ where: { requestId: req.requestId }, select: { id: true } }),
  ]);
  if (dup) throw new FlowServiceError(409, 'DUPLICATE_REQUEST', 'この実行は受け付け済みです');
  const rejection = flowRunAdmission(req.plan, { runsThisMonth, partCallsThisMonth: partCalls }, partNodes.length > 0);
  if (rejection === 'FLOW_RUN_LIMIT') throw new FlowServiceError(429, 'FLOW_RUN_LIMIT', '今月の実行数の上限に達しました');
  if (rejection === 'FLOW_PART_LIMIT') throw new FlowServiceError(429, 'FLOW_PART_LIMIT', '今月の部品の呼び出し数の上限に達しました');
  if (queued >= R.maxQueuedPerOrg) throw new FlowServiceError(429, 'FLOW_BUSY', '実行待ちが多すぎます。しばらくしてからもう一度実行してください');

  try {
    return await db.$transaction(async (tx) => {
      // Task は QUEUED にしない（n8n の enqueue 一覧が QUEUED の Task を拾う）。実行中として作り、状態を写す
      const task = await tx.task.create({
        data: {
          title: req.flow.name,
          status: 'RUNNING',
          department: departmentOf(def),
          taskType: 'flow',
          input: JSON.stringify(input.data),
        } as never,
        select: { id: true },
      });
      const run = await tx.flowRun.create({
        data: {
          flowId: req.flow.id,
          flowSlug: req.flow.slug,
          flowVersion: req.flow.version,
          definition: def as never,
          trigger: req.trigger,
          actorId: req.actorId,
          requestId: req.requestId,
          status: 'QUEUED',
          input: input.data as never,
          taskId: task.id,
        } as never,
        select: { id: true },
      });
      return { runId: run.id, taskId: task.id };
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new FlowServiceError(409, 'DUPLICATE_REQUEST', 'この実行は受け付け済みです');
    throw e;
  }
}

// ── 着手（pump） ───────────────────────────────────────

/** このプロセスで走っている実行の数（gateway 全体の同時実行数） */
let activeRuns = 0;
/** 組織ごとに pump を直列にする（同じプロセスの中で組織の同時実行数を超えて取らない） */
const orgPumps = new Map<string, Promise<void>>();

export function activeFlowRuns(): number {
  return activeRuns;
}

/** その組織のテナントコンテキストで動かす（HTTP から呼ばれたらそのまま、回収からなら包む） */
function inTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const cur = currentTenant();
  if (cur?.orgId === orgId) return fn();
  if (cur) throw new Error('別組織のコンテキストから実行しようとしました');
  return runAsTenant({ orgId, userId: null, role: null, source: 'flow-runner' }, fn);
}

function startClaimed(orgId: string, runId: string): void {
  activeRuns += 1;
  tracked('flow-run', runId, async () => {
    try {
      await inTenant(orgId, () => advanceRun(orgId, runId));
    } finally {
      activeRuns -= 1;
      void pumpOrg(orgId);
    }
  });
}

async function pumpInner(orgId: string): Promise<void> {
  const db = tenantDb(orgId);
  // 閲覧のみ（解約・期限切れ）の組織は着手しない（T16。受け付けは requireAuth が 402 で止めるので、ここに来るのは回収の経路）
  const ent = await orgEntitlement(db);
  if (ent.access !== 'full') {
    const queued = await db.flowRun.findMany({ where: { status: 'QUEUED' }, select: { id: true, taskId: true } });
    for (const q of queued) {
      const ok = await db.flowRun.updateMany({
        where: { id: q.id, status: 'QUEUED' },
        data: { status: 'FAILED', error: { nodeId: null, code: 'SUBSCRIPTION_REQUIRED', message: '契約が必要です' }, finishedAt: new Date() },
      });
      if (ok.count > 0 && q.taskId) await db.task.updateMany({ where: { id: q.taskId }, data: { status: 'FAILED', lastError: '契約が必要です' } });
      notifyRunSettled(q.id);
    }
    return;
  }
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const limit = flowLimitsOf(org?.plan ?? 'STARTER').concurrency;
  for (;;) {
    if (activeRuns >= config.flowMaxConcurrency) return;
    const running = await db.flowRun.count({ where: { status: 'RUNNING' } });
    if (running >= limit) return;
    const next = await db.flowRun.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!next) return;
    const now = new Date();
    const claimed = await db.flowRun.updateMany({
      where: { id: next.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: now, lockedAt: now },
    });
    if (claimed.count === 0) continue; // 他の台・他の pump が取った
    startClaimed(orgId, next.id);
  }
}

/** 空きがあれば、その組織の QUEUED を古い順に着手する */
export function pumpOrg(orgId: string): Promise<void> {
  const prev = orgPumps.get(orgId) ?? Promise.resolve();
  const next = prev
    .then(() => inTenant(orgId, () => pumpInner(orgId)))
    .catch((e: unknown) => log.error(`pump に失敗 org=${orgId}: ${e instanceof Error ? e.name : 'error'}`));
  orgPumps.set(orgId, next);
  void next.finally(() => {
    if (orgPumps.get(orgId) === next) orgPumps.delete(orgId);
  });
  return next;
}

// ── 承認・却下・取り消し ─────────────────────────────────

export function parseFlowApproval(raw: string | null): FlowStepApprovalData | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FlowStepApprovalData>;
    return v && v.kind === 'flow_step' && typeof v.runId === 'string' && typeof v.nodeId === 'string' ? (v as FlowStepApprovalData) : null;
  } catch {
    return null;
  }
}

export type ApprovalOutcome = { ok: true } | { ok: false; status: number; code: string; message: string };

function isExpired(lockedAt: Date | null, now: Date): boolean {
  return !!lockedAt && now.getTime() - new Date(lockedAt).getTime() > R.approvalExpireMs;
}

/**
 * 承認 → 続きを 1 回だけ走らせる。`POST /api/tasks/:taskId/approve` の flow_step 分岐から呼ぶ。
 * 承認できるのは `approval.minRole` 以上（既定 MEMBER）。実行した本人でも承認できる（既存のエージェントと同じ）。
 */
export async function approveFlowStep(
  db: TenantDb,
  task: { id: string },
  approval: FlowStepApprovalData,
  actor: { userId: string; role: UserRole | null },
): Promise<ApprovalOutcome> {
  if (!actor.role || !hasRoleAtLeast(actor.role, approval.minRole ?? 'MEMBER')) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'この確認を通す権限がありません' };
  }
  const run = await db.flowRun.findUnique({ where: { id: approval.runId }, select: { id: true, status: true, steps: true, lockedAt: true, taskId: true } });
  if (!run || run.taskId !== task.id) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'タスクが見つかりません' };
  const now = new Date();
  if (run.status === 'WAITING_APPROVAL' && isExpired(run.lockedAt, now)) {
    await expireRun(db, run.id, run.taskId);
    return { ok: false, status: 409, code: 'FLOW_RUN_EXPIRED', message: EXPIRED_MESSAGE };
  }
  const steps = { ...((run.steps ?? {}) as unknown as Record<string, FlowStepState>) };
  const step = Object.prototype.hasOwnProperty.call(steps, approval.nodeId) ? steps[approval.nodeId] : undefined;
  if (!step || step.status !== 'WAITING_APPROVAL') return { ok: false, status: 409, code: 'INVALID_STATE', message: 'このタスクは承認待ちではありません' };

  steps[approval.nodeId] = approval.gate
    ? { ...step, status: 'PENDING', gateApproved: true }
    : {
        ...step,
        status: 'SUCCEEDED',
        finishedAt: now.toISOString(),
        output: { approvedBy: actor.userId, approvedAt: now.toISOString() },
      };
  // 二重承認（連打・2 台）でも続きは 1 回だけ（§7.3）
  const claimed = await db.flowRun.updateMany({
    where: { id: run.id, status: 'WAITING_APPROVAL' },
    data: { status: 'RUNNING', steps: steps as never, lockedAt: now },
  });
  if (claimed.count === 0) return { ok: false, status: 409, code: 'INVALID_STATE', message: 'このタスクは承認待ちではありません' };
  await db.task.updateMany({ where: { id: task.id }, data: { status: 'RUNNING' } });
  await db.taskLog.create({ data: { taskId: task.id, message: `「${approval.label}」を承認しました。続きを実行します`, level: 'INFO' } }).catch(() => undefined);
  const orgId = db.orgId;
  activeRuns += 1;
  tracked('flow-run', run.id, async () => {
    try {
      await inTenant(orgId, () => advanceRun(orgId, run.id));
    } finally {
      activeRuns -= 1;
      void pumpOrg(orgId);
    }
  });
  return { ok: true };
}

/** 却下 → 取り消し（CANCELED）。残りは実行しない */
export async function rejectFlowStep(db: TenantDb, task: { id: string }, approval: FlowStepApprovalData, reason?: string): Promise<ApprovalOutcome> {
  const run = await db.flowRun.findUnique({ where: { id: approval.runId }, select: { id: true, taskId: true } });
  if (!run || run.taskId !== task.id) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'タスクが見つかりません' };
  const claimed = await db.flowRun.updateMany({
    where: { id: run.id, status: 'WAITING_APPROVAL' },
    data: { status: 'CANCELED', finishedAt: new Date(), lockedAt: null, error: { nodeId: approval.nodeId, code: 'REJECTED', message: '承認されませんでした' } },
  });
  if (claimed.count === 0) return { ok: false, status: 409, code: 'INVALID_STATE', message: 'このタスクは承認待ちではありません' };
  await db.task.updateMany({ where: { id: task.id }, data: { status: 'REJECTED', lastError: reason ?? null } });
  await db.taskLog.create({ data: { taskId: task.id, message: `承認を却下しました${reason ? `: ${reason}` : ''}`, level: 'INFO' } }).catch(() => undefined);
  return { ok: true };
}

/** 待ち・承認待ちを取り消す（実行した本人か ADMIN 以上。呼び出し側で確かめる）。走っている実行は止めない */
export async function cancelRun(db: TenantDb, run: { id: string; taskId: string | null }): Promise<boolean> {
  const claimed = await db.flowRun.updateMany({
    where: { id: run.id, status: { in: ['QUEUED', 'WAITING_APPROVAL'] } },
    data: { status: 'CANCELED', finishedAt: new Date(), lockedAt: null },
  });
  if (claimed.count === 0) return false;
  if (run.taskId) await db.task.updateMany({ where: { id: run.taskId }, data: { status: 'REJECTED', lastError: '取り消しました' } });
  notifyRunSettled(run.id);
  return true;
}

async function expireRun(db: TenantDb, runId: string, taskId: string | null): Promise<boolean> {
  const ok = await db.flowRun.updateMany({
    where: { id: runId, status: 'WAITING_APPROVAL' },
    data: { status: 'EXPIRED', finishedAt: new Date(), lockedAt: null, error: { nodeId: null, code: 'EXPIRED', message: EXPIRED_MESSAGE } },
  });
  if (ok.count > 0 && taskId) await db.task.updateMany({ where: { id: taskId }, data: { status: 'FAILED', lastError: EXPIRED_MESSAGE } });
  return ok.count > 0;
}

// ── 回収 ───────────────────────────────────────────────

export interface RecoveryResult {
  pumped: number;
  interrupted: number;
  expired: number;
}

/** 心拍が途絶えた RUNNING を FAILED に（行ごとの条件付き。走っている実行は心拍で lockedAt が新しいので巻き込まない） */
async function markInterrupted(orgId: string, runId: string, taskId: string | null, staleBefore: Date): Promise<boolean> {
  return inTenant(orgId, async () => {
    const db = tenantDb(orgId);
    const ok = await db.flowRun.updateMany({
      where: { id: runId, status: 'RUNNING', OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }] },
      data: { status: 'FAILED', finishedAt: new Date(), lockedAt: null, error: { nodeId: null, code: 'INTERRUPTED', message: FLOW_INTERRUPTED_MESSAGE } },
    });
    if (ok.count > 0 && taskId) await db.task.updateMany({ where: { id: taskId }, data: { status: 'FAILED', lastError: FLOW_INTERRUPTED_MESSAGE } });
    if (ok.count > 0) notifyRunSettled(runId);
    return ok.count > 0;
  });
}

/** 60 秒ごと（と起動直後）の回収。全組織の FlowRun を引くのはここだけ（素の prisma） */
export async function recoverFlowRuns(now: Date = new Date()): Promise<RecoveryResult> {
  const result: RecoveryResult = { pumped: 0, interrupted: 0, expired: 0 };
  const staleBefore = new Date(now.getTime() - flowQueueTuning.staleRunningMs);
  const stale = await prisma.flowRun.findMany({
    where: { status: 'RUNNING', OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }] },
    select: { id: true, orgId: true, taskId: true },
    take: 200,
  });
  for (const r of stale) if (await markInterrupted(r.orgId, r.id, r.taskId, staleBefore)) result.interrupted += 1;

  const expireBefore = new Date(now.getTime() - R.approvalExpireMs);
  const waiting = await prisma.flowRun.findMany({
    where: { status: 'WAITING_APPROVAL', lockedAt: { lt: expireBefore } },
    select: { id: true, orgId: true, taskId: true },
    take: 200,
  });
  for (const r of waiting) {
    if (await inTenant(r.orgId, () => expireRun(tenantDb(r.orgId), r.id, r.taskId))) result.expired += 1;
  }

  const queued = await prisma.flowRun.findMany({
    where: { status: 'QUEUED', createdAt: { lt: new Date(now.getTime() - flowQueueTuning.queuedRecoverAfterMs) } },
    select: { orgId: true },
    distinct: ['orgId'],
    take: 100,
  });
  for (const q of queued) {
    await pumpOrg(q.orgId);
    result.pumped += 1;
  }
  if (result.interrupted + result.expired > 0) {
    log.warn(`業務フローの回収: 中断 ${result.interrupted} 件・期限切れ ${result.expired} 件`);
  }
  return result;
}

/** シャットダウン時: このプロセスで走っていた実行に中断の印を付ける（lifecycle.ts から。待たずに印だけ先に） */
export async function markFlowRunsInterrupted(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const rows = await prisma.flowRun.findMany({ where: { id: { in: runIds }, status: 'RUNNING' }, select: { id: true, orgId: true, taskId: true } });
  let n = 0;
  const future = new Date(Date.now() + 60_000);
  for (const r of rows) if (await markInterrupted(r.orgId, r.id, r.taskId, future)) n += 1;
  return n;
}

let recoveryTimer: NodeJS.Timeout | null = null;

/** 回収の tick（INTERNAL_SCHEDULER_ENABLED と同じスイッチ）。起動直後にも 1 回 */
export function startFlowRecovery(): void {
  if (!config.internalSchedulerEnabled || recoveryTimer) return;
  const tick = (): void => {
    void recoverFlowRuns().catch((e: unknown) => log.error(`回収に失敗: ${e instanceof Error ? e.name : 'error'}`));
  };
  tick();
  recoveryTimer = setInterval(tick, flowQueueTuning.tickMs);
  recoveryTimer.unref?.();
}
