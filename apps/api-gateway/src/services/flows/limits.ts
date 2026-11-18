// 業務フローのプラン上限と月間の数え方（docs/design/canvas-home.md §7.6）。判定そのものは shared-types の
// flows-plan.ts（canAddFlow / flowRunState / flowPartCallState）1 か所。ここは DB から数えるだけ。
//
// ■ 月間実行数 = 当月（UTC の暦月）の FlowRun の件数。CANCELED で一度も着手していない（startedAt が null）ものは除く。
// ■ 部品の呼び出し = 同じ範囲の partCalls の合計（aggregate _sum。raw SQL は使わない）。
// ■ FlowRun.flowId は FK ではないので、フローを消して作り直しても当月の件数は残る（K25）。

import {
  canAddFlow,
  flowLimitsOf,
  flowMonthStartUtc,
  flowPartCallState,
  flowRunState,
  type FlowUsage,
} from '@org-ai/shared-types';
import type { TenantDb, TenantTx } from '../../tenancy/tenant-db';

export { planOf } from '../pages/access';

export interface FlowUsageSummary {
  flows: { count: number; limit: number };
  runs: FlowUsage;
  partCalls: FlowUsage;
}

/** 当月の実行数（数え方は上の説明） */
export async function flowRunsThisMonth(db: Pick<TenantTx, 'flowRun'>, now: Date = new Date()): Promise<number> {
  return db.flowRun.count({
    where: {
      createdAt: { gte: flowMonthStartUtc(now) },
      NOT: { status: 'CANCELED', startedAt: null },
    },
  });
}

/** 当月の部品の呼び出し数 */
export async function partCallsThisMonth(db: Pick<TenantTx, 'flowRun'>, now: Date = new Date()): Promise<number> {
  const agg = await db.flowRun.aggregate({
    where: { createdAt: { gte: flowMonthStartUtc(now) } },
    _sum: { partCalls: true },
  });
  return agg._sum?.partCalls ?? 0;
}

export async function flowUsageOf(db: TenantDb, plan: string, now: Date = new Date()): Promise<FlowUsageSummary> {
  const [count, runs, parts] = await Promise.all([db.flow.count(), flowRunsThisMonth(db, now), partCallsThisMonth(db, now)]);
  return {
    flows: { count, limit: flowLimitsOf(plan).maxFlows },
    runs: flowRunState(plan, runs),
    partCalls: flowPartCallState(plan, parts),
  };
}

/**
 * もう 1 つ作れるか。`exceptSlug` は数えない（同じ slug の同時作成で、先に入った方を数えて上限で断らないため。
 * その場合は create の P2002 → 既存を返す、に回る）。
 */
export async function canCreateFlow(db: Pick<TenantTx, 'flow'>, plan: string, exceptSlug?: string): Promise<boolean> {
  const count = await db.flow.count(exceptSlug ? { where: { slug: { not: exceptSlug } } } : undefined);
  return canAddFlow(plan, count);
}
