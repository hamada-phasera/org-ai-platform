// 定期実行のディスパッチ共通実装。
// 呼び出し元は 3 つ: n8n schedule-dispatcher（webhooks.ts の 2 エンドポイント経由）と
// gateway 内 tick（startInternalScheduler）。どこから呼ばれても enqueue 前の
// atomic claim（lastRunAt を条件付き updateMany で塗る）が二重発火を防ぐ。
// 「n8n は加速レイヤーで依存先ではない」という FLOW の思想どおり、
// n8n に schedule-dispatcher ワークフローが無くても定期実行はここだけで成立する。

import type { AgentStepDef } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { runAsTenant } from '../tenancy/context';
import { tenantDb, type TenantDb } from '../tenancy/tenant-db';
import { dispatchQueuedTask, dispatchAgentTask } from './task-executor';
import { runAgentTask } from './step-runner';
import { orgEntitlement } from './org-entitlement';
import { acceptRun, pumpOrg } from './flows/queue';
import { FLOW_SELECT, FlowServiceError, type FlowRow } from './flows/store';
import { planOf } from './flows/limits';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';

const scheduleLog = createLogger('schedule');

/** 現在時刻の「時」の頭（UTC）。この時刻以降に lastRunAt があれば当該時間帯は実行済み。 */
export function startOfCurrentHourUtc(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * frequency + 曜日/日付が現在時刻に合致するか（hourUtc の一致は呼び出し側の where で済み）。
 * 業務フローの行（flowId あり）の曜日・日付は**日本時間**で持つので、日本時間の暦で比べる
 * （hourUtc は UTC に直してある。services/flows/schedule.ts・canvas-home.md K57）。それ以外は従来どおり UTC。
 */
export function matchesSchedule(
  st: { frequency: string; dayOfWeek: number | null; dayOfMonth: number | null; flowId?: string | null },
  now: Date,
): boolean {
  const cal = st.flowId ? new Date(now.getTime() + JST_OFFSET_MS) : now;
  if (st.frequency === 'daily') return true;
  if (st.frequency === 'weekly') return st.dayOfWeek === cal.getUTCDay();
  if (st.frequency === 'monthly') return st.dayOfMonth === cal.getUTCDate();
  return false;
}

const JST_OFFSET_MS = 9 * 60 * 60_000;

/**
 * fire-and-forget 実行の共通ラッパー。
 * 定期実行は誰も見ていない時間に走るので、握りきれない例外（Prisma の一時障害など）が
 * unhandled rejection になると Node の既定挙動で gateway プロセスごと落ち、全機能が止まる。
 * ここで必ず握り、ログと Task の FAILED 記録まで best-effort で行う。
 * start() が同期 throw しても Promise 化して受けられるよう Promise.resolve().then() を挟む。
 */
function fireAndForget(db: TenantDb, taskId: string, label: string, start: () => Promise<void> | void): void {
  void Promise.resolve()
    .then(start)
    .catch((e) => markDispatchFailed(db, taskId, label, e));
}

/** 発火に失敗した Task を FAILED + TaskLog(ERROR) に落とす。この更新自体の失敗も握りつぶす。 */
async function markDispatchFailed(db: TenantDb, taskId: string, label: string, error: unknown): Promise<void> {
  scheduleLog.error(`${label} failed (task=${taskId}):`, error);
  try {
    await db.task.update({
      where: { id: taskId },
      data: { status: 'FAILED', lastError: String(error) },
    });
    await db.taskLog.create({
      data: { taskId, message: `定期実行の起動に失敗: ${String(error)}`, level: 'ERROR' },
    });
  } catch (e) {
    // DB 側が死んでいるときはここも失敗する。プロセスを落とさないことを最優先にして諦める。
    scheduleLog.error(`FAILED マークにも失敗 (task=${taskId}):`, e);
  }
}

export type EnqueueResult =
  | { enqueued: true; taskId: string }
  | { enqueued: false; reason: 'already_ran' | 'not_found' | 'agent_gone' | 'flow_gone' | 'flow_rejected' | 'read_only' };

/**
 * 定期タスク 1 件を（まだ当該時間帯に走っていなければ）Task 化して発火する。
 * claim: enabled かつ lastRunAt が当該時間帯より前のときだけ lastRunAt を塗れる。
 * count=0 なら他の経路が先に走らせた = 冪等 skip。
 */
export async function claimAndEnqueueScheduledTask(
  scheduledTaskId: string,
  now: Date = new Date(),
): Promise<EnqueueResult> {
  /* 閲覧のみ（期限切れ・解約済み）の組織は発火しない。claim より前に見るので lastRunAt も進めない
     （契約し直せば、その時間帯のうちに次の tick で走る）。docs/plan/saas-review.md #1 */
  const head = await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId }, select: { orgId: true } });
  if (!head) return { enqueued: false, reason: 'not_found' };
  if (head.orgId) {
    const decision = await orgEntitlement(tenantDb(head.orgId), now);
    if (decision.access === 'read_only') {
      scheduleLog.info(
        `契約が無いため定期実行を skip (scheduledTask=${scheduledTaskId}, org=${head.orgId}, reason=${decision.reason})`,
      );
      return { enqueued: false, reason: 'read_only' };
    }
  }

  const hourStart = startOfCurrentHourUtc(now);
  const claimed = await prisma.scheduledTask.updateMany({
    where: {
      id: scheduledTaskId,
      enabled: true,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: hourStart } }],
    },
    data: { lastRunAt: now },
  });
  if (claimed.count === 0) {
    const exists = await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId }, select: { id: true } });
    return { enqueued: false, reason: exists ? 'already_ran' : 'not_found' };
  }

  const st = await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId } });
  if (!st) return { enqueued: false, reason: 'not_found' };

  /* claim と候補のスキャンは全テナント横断（素の prisma）。ここから先は定期タスクの組織に閉じる:
     エージェント・Task はテナントクライアントで引いて作り、起動した実行（fire-and-forget を含む）にも
     テナントコンテキスト（ai-engine への X-Org-Id）が伝わる。 */
  return runAsTenant({ orgId: st.orgId, userId: null, role: null, source: 'scheduler' }, () =>
    enqueueClaimed(tenantDb(st.orgId), st, hourStart),
  );
}

type ScheduledTaskRow = NonNullable<Awaited<ReturnType<typeof prisma.scheduledTask.findUnique>>>;

/**
 * 業務フローの定期実行（canvas-home.md §5.5・§7.4）。受け付けは手で押したときと同じ acceptRun（上限・部品の接続・入力の検証）。
 * requestId は `sched:<flowId>:<その時間の開始>`＝同じ時間帯に 2 回受け付けない（claim に加えた二重の守り。§7.3）。
 * 外へ送るノードは無人でも必ず承認で止まる（ランナーが止める）。
 */
async function enqueueFlowRun(db: TenantDb, st: ScheduledTaskRow & { flowId: string }, hourStart: Date): Promise<EnqueueResult> {
  const flow = (await db.flow.findUnique({ where: { id: st.flowId }, select: FLOW_SELECT })) as FlowRow | null;
  if (!flow || !flow.enabled) {
    scheduleLog.warn(`flow ${st.flowId} が削除/無効のため skip (scheduledTask=${st.id})`);
    return { enqueued: false, reason: 'flow_gone' };
  }
  try {
    const accepted = await acceptRun(db, {
      flow,
      input: {},
      requestId: `sched:${flow.id}:${hourStart.getTime()}`,
      trigger: 'schedule',
      actorId: null,
      plan: await planOf(db),
    });
    await db.taskLog
      .create({ data: { taskId: accepted.taskId, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' } })
      .catch(() => undefined);
    void pumpOrg(db.orgId);
    return { enqueued: true, taskId: accepted.taskId };
  } catch (e) {
    // 上限・未接続・二重など。断った理由（コード）だけ残す（値は出さない）
    const code = e instanceof FlowServiceError ? e.code : e instanceof Error ? e.name : 'error';
    scheduleLog.warn(`業務フローの定期実行を受け付けませんでした flow=${flow.id} scheduledTask=${st.id} code=${code}`);
    return { enqueued: false, reason: 'flow_rejected' };
  }
}

async function enqueueClaimed(db: TenantDb, st: ScheduledTaskRow, hourStart: Date): Promise<EnqueueResult> {
  // ── 業務フローの定期実行 ──
  if (st.flowId) return enqueueFlowRun(db, { ...st, flowId: st.flowId }, hourStart);

  // ── エージェント紐付きの定期実行 ──
  if (st.agentId) {
    // ⚠️ 同じ組織のエージェントだけを使う（E5）。作成時（assertOwnAgent）にも確かめているが、
    //    DB を直接いじった場合や将来の経路で、他組織の instructions/steps で走らせないための二重の照合。
    const agent = await db.agent.findUnique({ where: { id: st.agentId } });
    if (!agent || agent.orgId !== st.orgId || !agent.enabled) {
      scheduleLog.warn(`agent ${st.agentId} が削除/無効のため skip (scheduledTask=${st.id})`);
      return { enqueued: false, reason: 'agent_gone' };
    }
    const task = await db.task.create({
      data: {
        orgId: st.orgId,
        agentId: agent.id,
        title: `[定期] ${agent.name}`,
        department: agent.department,
        input: st.input || agent.instructions,
        status: 'QUEUED',
        taskType: 'agent',
      },
    });
    await db.taskLog.create({
      data: { taskId: task.id, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' },
    });
    const steps = (agent.steps as unknown as AgentStepDef[] | null) ?? [];
    if (steps.length > 0) {
      fireAndForget(db, task.id, 'runAgentTask', () =>
        runAgentTask(
          { id: task.id, orgId: task.orgId, input: task.input },
          {
            id: agent.id,
            instructions: agent.instructions,
            department: agent.department,
            createdBy: agent.createdBy,
            steps,
          },
        ),
      );
    } else {
      // steps 無しエージェント: instructions を効かせた単発実行
      // （従来は dispatchQueuedTask に流れて instructions が無視されていたギャップの修正）
      fireAndForget(db, task.id, 'dispatchAgentTask', () =>
        dispatchAgentTask(
          { id: task.id, orgId: task.orgId, title: task.title, input: task.input, taskType: 'agent' },
          {
            id: agent.id,
            instructions: agent.instructions,
            department: agent.department,
            webhookPath: agent.webhookPath,
            n8nStatus: agent.n8nStatus,
          },
        ),
      );
    }
    return { enqueued: true, taskId: task.id };
  }

  // ── 従来どおり部署ワークフロー実行 ──
  const task = await db.task.create({
    data: {
      orgId: st.orgId,
      title: `[定期] ${st.title}`,
      department: st.department,
      input: st.input,
      status: 'QUEUED',
      taskType: st.taskType,
    },
  });
  await db.taskLog.create({
    data: { taskId: task.id, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' },
  });
  fireAndForget(db, task.id, 'dispatchQueuedTask', () => dispatchQueuedTask(task));
  return { enqueued: true, taskId: task.id };
}

/** 現在の時間帯に該当する定期タスクをすべて enqueue する。戻り値は発火数。 */
export async function enqueueDueScheduledTasks(now: Date = new Date()): Promise<number> {
  const hourStart = startOfCurrentHourUtc(now);
  const candidates = await prisma.scheduledTask.findMany({
    where: {
      enabled: true,
      hourUtc: now.getUTCHours(),
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: hourStart } }],
    },
    select: { id: true, frequency: true, dayOfWeek: true, dayOfMonth: true, flowId: true },
  });
  let count = 0;
  for (const st of candidates) {
    if (!matchesSchedule(st, now)) continue;
    // 1 件の失敗（DB 瞬断など）で残り全件を止めない。ここで握って次の候補へ進む。
    try {
      const result = await claimAndEnqueueScheduledTask(st.id, now);
      if (result.enqueued) count += 1;
    } catch (e) {
      scheduleLog.error(`scheduledTask=${st.id} の発火に失敗（残りは続行）:`, e);
    }
  }
  return count;
}

const TICK_INTERVAL_MS = 5 * 60_000;

/** gateway 内の定期 tick。INTERNAL_SCHEDULER_ENABLED=false で無効化できる。 */
export function startInternalScheduler(): void {
  if (!config.internalSchedulerEnabled) {
    scheduleLog.info('internal scheduler disabled (INTERNAL_SCHEDULER_ENABLED=false)');
    return;
  }
  const tick = async (): Promise<void> => {
    try {
      const n = await enqueueDueScheduledTasks();
      if (n > 0) scheduleLog.info(`${n} 件の定期タスクを発火`);
    } catch (e) {
      scheduleLog.error('tick failed:', e);
    }
  };
  // tick 内でも catch しているが、万一こぼれても unhandled rejection にしない（上の方針と同じ）。
  const safeTick = (): void => {
    void tick().catch((e) => scheduleLog.error('tick crashed:', e));
  };
  safeTick();
  setInterval(safeTick, TICK_INTERVAL_MS).unref?.();
}
