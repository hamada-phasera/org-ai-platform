import type { FastifyInstance } from 'fastify';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';

const DEPARTMENTS = ['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL', 'ASSISTANT'];

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // 部署別エージェント統計
  app.get('/stats', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const orgId = payload.orgId;

    // 部署別タスク数を一括取得
    const [totalCounts, runningCounts, queuedCounts, doneCounts] = await Promise.all([
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'RUNNING' },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'QUEUED' },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'DONE' },
      }),
    ]);

    // マップに変換
    const totalMap = new Map(totalCounts.map((r) => [r.department, r._count]));
    const runningMap = new Map(runningCounts.map((r) => [r.department, r._count]));
    const queuedMap = new Map(queuedCounts.map((r) => [r.department, r._count]));
    const doneMap = new Map(doneCounts.map((r) => [r.department, r._count]));

    // 各部署の最新完了タスクを取得
    const latestTasks = await Promise.all(
      DEPARTMENTS.map(async (dept) => {
        const task = await prisma.task.findFirst({
          where: { orgId, department: dept, status: 'DONE' },
          orderBy: { updatedAt: 'desc' },
          select: { output: true, title: true },
        });
        return { dept, task };
      }),
    );

    // 完了タスクがない部署はAILogから最新を取得
    const latestReports = new Map<string, string | null>();
    for (const { dept, task } of latestTasks) {
      if (task?.output) {
        // outputが長い場合は先頭100文字に切り詰め
        latestReports.set(dept, task.output.slice(0, 100));
      } else {
        const log = await prisma.aILog.findFirst({
          where: { orgId, department: dept },
          orderBy: { createdAt: 'desc' },
          select: { outputText: true },
        });
        latestReports.set(dept, log?.outputText?.slice(0, 100) ?? null);
      }
    }

    // レスポンス構築
    const data: Record<string, {
      taskCount: number;
      status: 'active' | 'processing' | 'idle';
      latestReport: string | null;
      completedCount: number;
      runningCount: number;
    }> = {};

    for (const dept of DEPARTMENTS) {
      const running = runningMap.get(dept) ?? 0;
      const queued = queuedMap.get(dept) ?? 0;
      let status: 'active' | 'processing' | 'idle' = 'idle';
      if (running > 0) status = 'active';
      else if (queued > 0) status = 'processing';

      data[dept] = {
        taskCount: totalMap.get(dept) ?? 0,
        status,
        latestReport: latestReports.get(dept) ?? null,
        completedCount: doneMap.get(dept) ?? 0,
        runningCount: running,
      };
    }

    return reply.send({ success: true, data });
  });
}
