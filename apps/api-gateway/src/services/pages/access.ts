// 業務ページの見え方（docs/design/custom-pages.md §5.1・T14）と当月の送信数（§6）。
//
// ■ 見える
//   minRole を満たし、かつ（公開済み か 管理者以上）。満たさないものは一覧にも出さず、個別は 404（存在を漏らさない）。
// ■ 管理できる
//   管理者以上で、かつ minRole を満たすページだけ（ADMIN がオーナー限定のページを見つけて minRole を下げる抜け道を塞ぐ）。

import { hasRoleAtLeast, isUserRole, pageActionState, type PageActionUsage, type UserRole } from '@org-ai/shared-types';
import type { TenantDb } from '../../tenancy/tenant-db';

export interface PageAccessRow {
  status: string;
  minRole: string;
}

/** 行の minRole（DB の String）。知らない値はオーナー限定として扱う＝fail-closed */
function minRoleOf(page: PageAccessRow): UserRole {
  return isUserRole(page.minRole) ? page.minRole : 'OWNER';
}

export function canViewPage(page: PageAccessRow, role: UserRole | null): boolean {
  if (!role || !hasRoleAtLeast(role, minRoleOf(page))) return false;
  return page.status === 'PUBLISHED' || hasRoleAtLeast(role, 'ADMIN');
}

export function canManagePage(page: PageAccessRow, role: UserRole | null): boolean {
  return !!role && hasRoleAtLeast(role, 'ADMIN') && hasRoleAtLeast(role, minRoleOf(page));
}

/**
 * 当月の始まり。AI の月間上限（routes/organizations.ts の /me/usage）と同じ UTC の暦月で数える
 * （設計書 Q3。表示の「今月」が AI と業務ページでずれないようにする）。
 */
export function startOfMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 組織のプラン（行が無い・知らない値は梅＝安全側。判定は shared-types 側でも梅に倒す） */
export async function planOf(db: TenantDb): Promise<string> {
  const org = await db.organization.findUnique({ where: { id: db.orgId }, select: { plan: true } });
  return org?.plan ?? 'STARTER';
}

/** 当月の送信（submit）の回数と上限。数えるのは PageActionLog の件数だけ（query は記録しない） */
export async function pageUsageOf(db: TenantDb, plan: string, now: Date = new Date()): Promise<PageActionUsage> {
  const used = await db.pageActionLog.count({ where: { createdAt: { gte: startOfMonthUTC(now) } } });
  return pageActionState(plan, used);
}
