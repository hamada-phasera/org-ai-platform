import type { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import {
  COST_CATEGORIES,
  PROJECT_STATUSES,
  emptyTotals,
  isUnfinished,
  nextTransition,
  deductionRateAt,
  type CostCategory,
} from './accounting-core';
import { AuthPayload, fail, monthRange } from './shared';

/**
 * 経理トップの月次サマリ。prefix: `/api/accounting/summary`
 *
 * 出すのは3つだけに絞る:
 *   1. 未成工事支出金 — 完成していない工事に積まれた原価の累計。建設業特有の資産科目で、
 *      月次で見ておかないと決算で急に出てくる。
 *   2. 今月の原価（4分類）と承認待ち件数 — 「今どれだけ溜まっているか」。
 *   3. インボイス経過措置の次の切り替えまでの残日数 — 期日は黙って来る。
 *
 * ⚠️ 税務判断はしない。数字の可視化までに留める（画面にもその旨を出す）。
 */

function groupToTotals(rows: Array<{ category: string; _sum: { amount: number | null } }>) {
  const totals = emptyTotals();
  for (const r of rows) {
    const key = (COST_CATEGORIES as readonly string[]).includes(r.category)
      ? (r.category as CostCategory)
      : 'OTHER';
    totals[key] += r._sum.amount ?? 0;
  }
  return totals;
}

export async function accountingSummaryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { month } = request.query as { month?: string };

    const now = new Date();
    const ym = month ?? now.toISOString().slice(0, 7);
    const range = monthRange(ym);
    if (!range) return fail(reply, 400, 'VALIDATION_ERROR', 'month は YYYY-MM 形式で指定してください');

    const unfinishedStatuses = PROJECT_STATUSES.filter(isUnfinished);

    const [projects, monthRows, draftCount, unfinishedProjects] = await Promise.all([
      prisma.project.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
      prisma.costEntry.groupBy({
        by: ['category'],
        where: { orgId, incurredOn: { gte: range.start, lt: range.end } },
        _sum: { amount: true },
      }),
      prisma.costEntry.count({ where: { orgId, status: 'DRAFT' } }),
      prisma.project.findMany({
        where: { orgId, status: { in: [...unfinishedStatuses] } },
        select: { id: true },
      }),
    ]);

    // 未成工事支出金: 未完成の工事に積まれた原価の累計。
    // 確定分だけを見る（AI が読んだだけの DRAFT を資産計上の数字に混ぜない）。
    const unfinishedIds = unfinishedProjects.map((p) => p.id);
    const wipRows =
      unfinishedIds.length > 0
        ? await prisma.costEntry.groupBy({
            by: ['category'],
            where: { orgId, projectId: { in: unfinishedIds }, status: 'CONFIRMED' },
            _sum: { amount: true },
          })
        : [];
    const wip = groupToTotals(wipRows);
    const wipTotal = COST_CATEGORIES.reduce((s, c) => s + wip[c], 0);

    const monthTotals = groupToTotals(monthRows);
    const monthTotal = COST_CATEGORIES.reduce((s, c) => s + monthTotals[c], 0);

    const transition = nextTransition(now);

    return reply.send({
      success: true,
      data: {
        month: ym,
        projectCounts: Object.fromEntries(projects.map((p) => [p.status, p._count._all])),
        /** 未成工事支出金（確定分のみ） */
        workInProgress: { byCategory: wip, total: wipTotal, projectCount: unfinishedIds.length },
        monthlyCost: { byCategory: monthTotals, total: monthTotal },
        /** 人の確認待ちの原価明細（チャット・LINE から入ってきたもの） */
        pendingCostEntries: draftCount,
        invoice: {
          currentRate: deductionRateAt(now),
          next: transition,
        },
      },
    });
  });
}
