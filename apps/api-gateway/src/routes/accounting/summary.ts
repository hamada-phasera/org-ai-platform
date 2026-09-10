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
import { AuthPayload, fail, jstThisMonth, jstToday, monthRange } from './shared';

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

    // ⚠️ UTC の暦月を既定にしてはいけない。JST の 0:00〜9:00 のあいだ「先月」になり、
    //    毎月1日の朝に「今月の原価」が先月分として出る
    const ym = month ?? jstThisMonth();
    const range = monthRange(ym);
    if (!range) return fail(reply, 400, 'VALIDATION_ERROR', 'month は YYYY-MM 形式で指定してください');

    const unfinishedStatuses = PROJECT_STATUSES.filter(isUnfinished);

    const [projects, monthRows, draftCount, unfinishedCount, wipRows] = await Promise.all([
      prisma.project.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
      // 未成工事支出金と規則を揃える。同じ画面の中で確定分と DRAFT 込みが混在すると、
      // どの数字が何なのか読み手が判断できない
      prisma.costEntry.groupBy({
        by: ['category'],
        where: { orgId, status: 'CONFIRMED', incurredOn: { gte: range.start, lt: range.end } },
        _sum: { amount: true },
      }),
      prisma.costEntry.count({ where: { orgId, status: 'DRAFT' } }),
      prisma.project.count({ where: { orgId, status: { in: [...unfinishedStatuses] } } }),
      // 未成工事支出金: 未完成の工事に積まれた原価の累計。
      // 確定分だけを見る（AI が読んだだけの DRAFT を資産計上の数字に混ぜない）。
      // ⚠️ 工事 id を全件取ってから IN に入れない。工事が増えるとクエリが肥大するので
      //    リレーションフィルタで DB 側に絞らせる。
      prisma.costEntry.groupBy({
        by: ['category'],
        where: {
          orgId,
          status: 'CONFIRMED',
          project: { status: { in: [...unfinishedStatuses] } },
        },
        _sum: { amount: true },
      }),
    ]);

    const wip = groupToTotals(wipRows);
    const wipTotal = COST_CATEGORIES.reduce((s, c) => s + wip[c], 0);

    const monthTotals = groupToTotals(monthRows);
    const monthTotal = COST_CATEGORIES.reduce((s, c) => s + monthTotals[c], 0);

    // 経過措置の判定も JST の暦日で行う（切り替え当日の朝9時間、旧い率を出さないため）
    const today = jstToday();
    const transition = nextTransition(today);

    return reply.send({
      success: true,
      data: {
        month: ym,
        projectCounts: Object.fromEntries(projects.map((p) => [p.status, p._count._all])),
        /** 未成工事支出金（確定分のみ） */
        workInProgress: { byCategory: wip, total: wipTotal, projectCount: unfinishedCount },
        monthlyCost: { byCategory: monthTotals, total: monthTotal },
        /** 人の確認待ちの原価明細（チャット・LINE から入ってきたもの） */
        pendingCostEntries: draftCount,
        invoice: {
          currentRate: deductionRateAt(today),
          next: transition,
        },
      },
    });
  });
}
