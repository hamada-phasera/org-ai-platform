// 業務フローの見え方と管理の可否（docs/design/canvas-home.md §7.1・T15）。
//
// ■ 見える・実行できる  役割が minRole 以上。満たさないものは一覧に出さず、個別は 404（存在を漏らさない）。
// ■ 編集できる          ADMIN 以上、かつ minRole を満たすもの（ADMIN がオーナー限定のフローを見つけて minRole を下げる抜け道を塞ぐ）。
// ■ minRole を付ける    自分より上の役割は付けられない（付けた瞬間に自分が触れなくなる）。

import { hasRoleAtLeast, isUserRole, type UserRole } from '@org-ai/shared-types';

export interface FlowAccessRow {
  minRole: string;
}

/** 行の minRole（DB の String）。知らない値はオーナー限定として扱う＝fail-closed */
function minRoleOf(flow: FlowAccessRow): UserRole {
  return isUserRole(flow.minRole) ? flow.minRole : 'OWNER';
}

export function canViewFlow(flow: FlowAccessRow, role: UserRole | null): boolean {
  return !!role && hasRoleAtLeast(role, minRoleOf(flow));
}

export function canManageFlow(flow: FlowAccessRow, role: UserRole | null): boolean {
  return !!role && hasRoleAtLeast(role, 'ADMIN') && hasRoleAtLeast(role, minRoleOf(flow));
}

export function minRoleAllowed(minRole: UserRole | undefined, role: UserRole | null): boolean {
  return minRole === undefined || (!!role && hasRoleAtLeast(role, minRole));
}

/** フロー ID（cuid）の形。違えば DB に聞かずに 404 */
export const FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
