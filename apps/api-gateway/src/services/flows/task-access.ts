// 業務フローの Task（taskType='flow'）の見え方と承認の役割（docs/design/canvas-home.md §7.4・T15。レビュー指摘 1・2）。
//
// ■ フローの実行と対になる Task は、フローの minRole を満たす人にだけ見せる（一覧から外し、個別は 404）。
//   入力・AI の出力・送信前のプレビュー（宛先・本文）・成果物が Task に載るため。
// ■ フローが消えていれば ADMIN 以上だけ（実行の写しに minRole は無い。消した側に倒す＝fail-closed）。
// ■ 承認に要る役割は max(フローの minRole, ノードの minRole)。
// ■ フローの Task は状態・出力を汎用の PATCH / DELETE / approve で書き換えさせない（409 FLOW_MANAGED。ランナーだけが書く）。

import { ROLE_RANK, isUserRole, type UserRole } from '@org-ai/shared-types';
import type { TenantDb } from '../../tenancy/tenant-db';

export const FLOW_TASK_TYPE = 'flow';
export const FLOW_TASK_MANAGED_MESSAGE = 'この項目は業務フローの実行です。フロー画面か受信の承認から操作してください';

/** フローが消えた実行に要る役割 */
const DELETED_FLOW_ROLE: UserRole = 'ADMIN';

export function maxRole(a: UserRole, b: UserRole): UserRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

function roleOfRow(minRole: string | null | undefined): UserRole {
  return isUserRole(minRole) ? minRole : 'OWNER';
}

/** taskId → その実行のフローに要る役割（FlowRun が無い flow Task は消えたフローと同じ扱い） */
async function requiredRolesOf(db: TenantDb, taskIds: string[]): Promise<Map<string, UserRole>> {
  const out = new Map<string, UserRole>();
  if (taskIds.length === 0) return out;
  const runs = await db.flowRun.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, flowId: true } });
  const flowIds = [...new Set(runs.map((r) => r.flowId))];
  const flows = flowIds.length > 0 ? await db.flow.findMany({ where: { id: { in: flowIds } }, select: { id: true, minRole: true } }) : [];
  const roleByFlow = new Map(flows.map((f) => [f.id, roleOfRow(f.minRole)] as const));
  const flowByTask = new Map(runs.filter((r) => r.taskId).map((r) => [r.taskId as string, r.flowId] as const));
  for (const id of taskIds) {
    const flowId = flowByTask.get(id);
    out.set(id, (flowId && roleByFlow.get(flowId)) || DELETED_FLOW_ROLE);
  }
  return out;
}

/** 実行（runId）のフローに要る役割。承認で使う */
export async function requiredRoleOfRun(db: TenantDb, run: { flowId: string }): Promise<UserRole> {
  const flow = await db.flow.findUnique({ where: { id: run.flowId }, select: { minRole: true } });
  return flow ? roleOfRow(flow.minRole) : DELETED_FLOW_ROLE;
}

function allowed(role: UserRole | null, required: UserRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[required];
}

/** 一覧から外す flow Task の id。OWNER は全部見えるので DB に聞かない */
export async function hiddenFlowTaskIds(db: TenantDb, role: UserRole | null, tasks: { id: string; taskType: string | null }[]): Promise<Set<string>> {
  const flowTaskIds = tasks.filter((t) => t.taskType === FLOW_TASK_TYPE).map((t) => t.id);
  const hidden = new Set<string>();
  if (flowTaskIds.length === 0 || role === 'OWNER') return hidden;
  const required = await requiredRolesOf(db, flowTaskIds);
  for (const [id, r] of required) if (!allowed(role, r)) hidden.add(id);
  return hidden;
}

/** 1 件の Task が見えるか（flow 以外は常に true） */
export async function canSeeTask(db: TenantDb, role: UserRole | null, task: { id: string; taskType: string | null }): Promise<boolean> {
  return (await hiddenFlowTaskIds(db, role, [task])).size === 0;
}
