import type { FastifyInstance } from 'fastify';
import { accountingProjectsRoutes } from './projects';
import { accountingCostsRoutes } from './costs';
import { accountingVendorsRoutes } from './vendors';
import { accountingSummaryRoutes } from './summary';

/**
 * 経理部（建設業向け）API のまとめ役。index.ts から prefix `/api/accounting` で登録する。
 *
 *   /projects  工事台帳（実行予算 vs 実績、粗利）
 *   /costs     原価明細（4分類・DRAFT の承認）
 *   /vendors   取引先とインボイス登録状況、経過措置の負担試算
 *   /summary   月次（未成工事支出金・今月の原価・次の切り替えまでの残日数）
 */
export async function accountingRoutes(app: FastifyInstance): Promise<void> {
  await app.register(accountingProjectsRoutes, { prefix: '/projects' });
  await app.register(accountingCostsRoutes, { prefix: '/costs' });
  await app.register(accountingVendorsRoutes, { prefix: '/vendors' });
  await app.register(accountingSummaryRoutes, { prefix: '/summary' });
}
