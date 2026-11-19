// きっかけ: 受け付けで検証済みの入力を流すだけ（フォームの各 key が出力）。
import type { NodeResult, NodeRunContext } from './types';

export async function runTriggerNode(ctx: NodeRunContext): Promise<NodeResult> {
  if (ctx.node.type !== 'trigger') return { ok: false, error: { code: 'FLOW_NODE_TYPE', message: '型が違います' } };
  if (ctx.node.config.mode !== 'form') return { ok: true, output: {} };
  const output: Record<string, unknown> = {};
  for (const f of ctx.node.config.fields) {
    if (Object.prototype.hasOwnProperty.call(ctx.run.input, f.key)) output[f.key] = ctx.run.input[f.key];
  }
  return { ok: true, output };
}
