// 定期実行のディスパッチ共通実装。
// 呼び出し元は 3 つ: n8n schedule-dispatcher（webhooks.ts の 2 エンドポイント経由）と
// gateway 内 tick（startInternalScheduler）。どこから呼ばれても enqueue 前の
// atomic claim（lastRunAt を条件付き updateMany で塗る）が二重発火を防ぐ。
// 「n8n は加速レイヤーで依存先ではない」という FLOW の思想どおり、
// n8n に schedule-dispatcher ワークフローが無くても定期実行はここだけで成立する。

import type { AgentStepDef } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { dispatchQueuedTask, dispatchAgentTask } from './task-executor';
import { runAgentTask } from './step-runner';

/** 現在時刻の「時」の頭（UTC）。この時刻以降に lastRunAt があれば当該時間帯は実行済み。 */
export function startOfCurrentHourUtc(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** frequency + 曜日/日付が現在時刻に合致するか（hourUtc の一致は呼び出し側の where で済み）。 */
export function matchesSchedule(
  st: { frequency: string; dayOfWeek: number | null; dayOfMonth: number | null },
  now: Date,
): boolean {
  if (st.frequency === 'daily') return true;
  if (st.frequency === 'weekly') return st.dayOfWeek === now.getUTCDay();
  if (st.frequency === 'monthly') return st.dayOfMonth === now.getUTCDate();
  return false;
}

export type EnqueueResult =
  | { enqueued: true; taskId: string }
  | { enqueued: false; reason: 'already_ran' | 'not_found' | 'agent_gone' };

/**
 * 定期タスク 1 件を（まだ当該時間帯に走っていなければ）Task 化して発火する。
 * claim: enabled かつ lastRunAt が当該時間帯より前のときだけ lastRunAt を塗れる。
 * count=0 なら他の経路が先に走らせた = 冪等 skip。
 */
export async function claimAndEnqueueScheduledTask(
  scheduledTaskId: string,
  now: Date = new Date(),
): Promise<EnqueueResult> {
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

  // ── エージェント紐付きの定期実行 ──
  if (st.agentId) {
    const agent = await prisma.agent.findUnique({ where: { id: st.agentId } });
    if (!agent || !agent.enabled) {
      console.warn(`[schedule] agent ${st.agentId} が削除/無効のため skip (scheduledTask=${st.id})`);
      return { enqueued: false, reason: 'agent_gone' };
    }
    const task = await prisma.task.create({
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
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' },
    });
    const steps = (agent.steps as unknown as AgentStepDef[] | null) ?? [];
    if (steps.length > 0) {
      void runAgentTask(
        { id: task.id, orgId: task.orgId, input: task.input },
        {
          id: agent.id,
          instructions: agent.instructions,
          department: agent.department,
          createdBy: agent.createdBy,
          steps,
        },
      );
    } else {
      // steps 無しエージェント: instructions を効かせた単発実行
      // （従来は dispatchQueuedTask に流れて instructions が無視されていたギャップの修正）
      void dispatchAgentTask(
        { id: task.id, orgId: task.orgId, title: task.title, input: task.input, taskType: 'agent' },
        {
          id: agent.id,
          instructions: agent.instructions,
          department: agent.department,
          webhookPath: agent.webhookPath,
          n8nStatus: agent.n8nStatus,
        },
      );
    }
    return { enqueued: true, taskId: task.id };
  }

  // ── 従来どおり部署ワークフロー実行 ──
  const task = await prisma.task.create({
    data: {
      orgId: st.orgId,
      title: `[定期] ${st.title}`,
      department: st.department,
      input: st.input,
      status: 'QUEUED',
      taskType: st.taskType,
    },
  });
  await prisma.taskLog.create({
    data: { taskId: task.id, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' },
  });
  void dispatchQueuedTask(task);
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
    select: { id: true, frequency: true, dayOfWeek: true, dayOfMonth: true },
  });
  let count = 0;
  for (const st of candidates) {
    if (!matchesSchedule(st, now)) continue;
    const result = await claimAndEnqueueScheduledTask(st.id, now);
    if (result.enqueued) count += 1;
  }
  return count;
}

const TICK_INTERVAL_MS = 5 * 60_000;

/** gateway 内の定期 tick。INTERNAL_SCHEDULER_ENABLED=false で無効化できる。 */
export function startInternalScheduler(): void {
  if ((process.env.INTERNAL_SCHEDULER_ENABLED ?? 'true') === 'false') {
    console.log('[schedule] internal scheduler disabled (INTERNAL_SCHEDULER_ENABLED=false)');
    return;
  }
  const tick = async (): Promise<void> => {
    try {
      const n = await enqueueDueScheduledTasks();
      if (n > 0) console.log(`[schedule] ${n} 件の定期タスクを発火`);
    } catch (e) {
      console.error('[schedule] tick failed:', e);
    }
  };
  void tick();
  setInterval(() => void tick(), TICK_INTERVAL_MS).unref?.();
}
