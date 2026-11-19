// 出力: page は FlowRun.output に、document は対の Task を成果物にする（§6.2・K11）。
// notify（外へ送る）は承認の後に既存の capability で送る＝チャンク 6。それまでは送らずに失敗させる。
import { resolveRef, renderTemplate } from '@org-ai/shared-types';
import { Renderer, fail, type NodeResult, type NodeRunContext } from './types';

const MAX_ROWS = 50;

/** 表の行をスカラーだけに切り詰める（オブジェクト・配列の値は捨てる） */
export function scalarRows(value: unknown): Record<string, string | number | boolean | null>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_ROWS).flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'boolean' || v === null) out[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return [out];
  });
}

/** document の出力が持つもの（ランナーが Task に写す） */
export interface DocumentOutput {
  title: string;
  body: string;
  department: string;
}

export async function runOutputNode(ctx: NodeRunContext & { taskId: string | null }): Promise<NodeResult & { document?: DocumentOutput }> {
  if (ctx.node.type !== 'output') return fail('FLOW_NODE_TYPE', '型が違います');
  const c = ctx.node.config;
  const r = new Renderer(ctx.scope, renderTemplate);
  if (c.kind === 'page') {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.values)) output[k] = r.text(v);
    if (c.rows !== undefined) {
      const rows = scalarRows(resolveRef(c.rows, ctx.scope));
      if (rows === undefined) r.warnings.push(`${c.rows} が表ではありません`);
      output.rows = rows ?? [];
    }
    return { ok: true, output, warnings: r.warnings, truncated: r.truncated };
  }
  if (c.kind === 'document') {
    const document = { title: r.text(c.title).slice(0, 200), body: r.text(c.body), department: c.department ?? 'GENERAL' };
    return { ok: true, output: { taskId: ctx.taskId ?? '' }, warnings: r.warnings, truncated: r.truncated, document };
  }
  return fail('FLOW_NOTIFY_UNAVAILABLE', '送信はまだ使えません');
}
