// 分岐: 値を比べるだけ（設計書 §6.2）。出る線は yes / no。
import { resolveRef } from '@org-ai/shared-types';
import type { NodeResult, NodeRunContext } from './types';

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function compareBranch(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case 'empty':
      return isEmpty(left);
    case 'not_empty':
      return !isEmpty(left);
    case 'eq':
      return typeof right === 'number' ? Number(left) === right : String(left ?? '') === String(right);
    case 'ne':
      return typeof right === 'number' ? Number(left) !== right : String(left ?? '') !== String(right);
    case 'gt':
    case 'lt': {
      const l = typeof left === 'number' ? left : Number(left);
      if (!Number.isFinite(l) || typeof right !== 'number' || (typeof left === 'string' && left.trim() === '')) return false;
      return op === 'gt' ? l > right : l < right;
    }
    case 'contains':
      return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    default:
      return false;
  }
}

export async function runBranchNode(ctx: NodeRunContext): Promise<NodeResult> {
  if (ctx.node.type !== 'branch') return { ok: false, error: { code: 'FLOW_NODE_TYPE', message: '型が違います' } };
  const { left, op, right } = ctx.node.config;
  return { ok: true, output: { result: compareBranch(resolveRef(left, ctx.scope), op, right) } };
}
