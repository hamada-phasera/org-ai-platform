import type { FastifyInstance } from 'fastify';
import { authOf } from '../tenancy';
import { requireAuth } from '../middleware/auth';

// タスク種別ごとの「人がやったら掛かる時間（分）」プリセット。
// 完了タスク1件 = この分数の業務をAIが肩代わりした、とみなして削減時間を集計する。
// 種別は Task.taskType（小文字化して照合）。未知の種別は default。
const MINUTES_SAVED_BY_TYPE: Record<string, number> = {
  email: 15,
  draft_email: 15,
  send_email: 10,
  document: 60,
  report: 60,
  analysis: 45,
  analytics: 45,
  research: 40,
  sns: 30,
  marketing: 30,
  coding: 50,
  schedule: 20,
  accounting: 40,
  sales: 35,
  agent: 30,
  general: 20,
};
const DEFAULT_MINUTES = 25;

// 1営業日 = 8h = 480分。目標は1日の業務の25% = 120分/日の削減。
const WORKDAY_MINUTES = 480;
const TARGET_PERCENT = 25;
const TARGET_MINUTES_PER_DAY = Math.round((WORKDAY_MINUTES * TARGET_PERCENT) / 100); // 120

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function minutesFor(taskType: string | null | undefined): number {
  if (!taskType) return DEFAULT_MINUTES;
  return MINUTES_SAVED_BY_TYPE[taskType.toLowerCase()] ?? DEFAULT_MINUTES;
}

/** UTC Date を JST の YYYY-MM-DD に変換 */
function jstDateKey(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // 業務効率化ダッシュボードの集計
  app.get('/efficiency', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const orgId = payload.orgId;

    // 完了タスクを取得（削減時間の算定対象）
    const tasks = await db.task.findMany({
      where: { orgId, status: 'DONE' },
      select: { taskType: true, department: true, executedAt: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });

    const todayKey = jstDateKey(new Date());
    // 直近7日(今日含む)の JST 日付キー
    const last7Keys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      last7Keys.push(jstDateKey(new Date(Date.now() - i * 86400000)));
    }
    const weekKeySet = new Set(last7Keys);

    let allMinutes = 0;
    let allCount = 0;
    let todayMinutes = 0;
    let todayCount = 0;
    let weekMinutes = 0;
    let weekCount = 0;
    const trendMap = new Map<string, { minutes: number; tasks: number }>();
    last7Keys.forEach((k) => trendMap.set(k, { minutes: 0, tasks: 0 }));
    const deptMap = new Map<string, { minutes: number; tasks: number }>();

    for (const t of tasks) {
      const m = minutesFor(t.taskType);
      const when = t.executedAt ?? t.updatedAt ?? t.createdAt;
      const key = jstDateKey(when);
      allMinutes += m;
      allCount += 1;

      const dept = t.department || 'GENERAL';
      const d = deptMap.get(dept) ?? { minutes: 0, tasks: 0 };
      d.minutes += m;
      d.tasks += 1;
      deptMap.set(dept, d);

      if (key === todayKey) {
        todayMinutes += m;
        todayCount += 1;
      }
      if (weekKeySet.has(key)) {
        weekMinutes += m;
        weekCount += 1;
        const tr = trendMap.get(key)!;
        tr.minutes += m;
        tr.tasks += 1;
      }
    }

    const data = {
      target: {
        percent: TARGET_PERCENT,
        workdayMinutes: WORKDAY_MINUTES,
        minutesPerDay: TARGET_MINUTES_PER_DAY,
      },
      today: {
        minutesSaved: todayMinutes,
        tasksCompleted: todayCount,
        percentOfWorkday: Math.round((todayMinutes / WORKDAY_MINUTES) * 100),
        percentOfTarget: Math.min(999, Math.round((todayMinutes / TARGET_MINUTES_PER_DAY) * 100)),
        targetReached: todayMinutes >= TARGET_MINUTES_PER_DAY,
      },
      week: {
        minutesSaved: weekMinutes,
        tasksCompleted: weekCount,
        // 週の達成率: 平日5日想定の目標(120分×5=600分)に対する比
        percentOfTarget: Math.min(999, Math.round((weekMinutes / (TARGET_MINUTES_PER_DAY * 5)) * 100)),
        avgPerActiveDay: weekCount
          ? Math.round(weekMinutes / new Set(last7Keys.filter((k) => (trendMap.get(k)?.tasks ?? 0) > 0)).size || 1)
          : 0,
      },
      allTime: { minutesSaved: allMinutes, tasksCompleted: allCount, hoursSaved: Math.round(allMinutes / 6) / 10 },
      dailyTrend: last7Keys.map((k) => ({
        date: k,
        minutesSaved: trendMap.get(k)!.minutes,
        tasks: trendMap.get(k)!.tasks,
      })),
      byDepartment: Array.from(deptMap.entries())
        .map(([department, v]) => ({ department, minutesSaved: v.minutes, tasks: v.tasks }))
        .sort((a, b) => b.minutesSaved - a.minutesSaved),
      presets: MINUTES_SAVED_BY_TYPE,
    };

    return reply.send({ success: true, data });
  });
}
