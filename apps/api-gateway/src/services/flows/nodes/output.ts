// 出力: page は FlowRun.output に、document は対の Task を成果物にする（§6.2・K11）。
// notify（外へ送る）は、ランナーが手前で必ず止め（K12）、人が承認したときの中身（gateArgs）をそのまま既存の capability で送る（K57）。
//   slack → notify_slack、email → send_email、line → send_line_push（未登録なら「設定されていません」で失敗。送ったことにしない）。
import { resolveRef, renderTemplate, type FlowNodeOf, type FlowScope } from '@org-ai/shared-types';
import { callCapability } from '../part-client';
import { Renderer, fail, scalarRows, type NodeResult, type NodeRunContext } from './types';

/** 通知の本文の上限（承認の画面のプレビューに全文が収まる長さ） */
export const NOTIFY_BODY_MAX = 4000;

type NotifyConfig = Extract<FlowNodeOf<'output'>['config'], { kind: 'notify' }>;

/** 通知の宛先と本文を展開する（承認の手前で見せる中身と、送る中身は同じこの関数で作る） */
export function renderNotify(c: NotifyConfig, scope: FlowScope): { values: Record<string, string>; warnings: string[]; truncated: boolean } {
  const r = new Renderer(scope, renderTemplate);
  const to = r.text(c.to).trim();
  let body = r.text(c.body);
  // 承認の画面に全文が出る長さまで（人が見ていない部分を送らない）
  if (body.length > NOTIFY_BODY_MAX) {
    body = body.slice(0, NOTIFY_BODY_MAX);
    r.truncated = true;
    r.warnings.push(`本文を ${NOTIFY_BODY_MAX} 文字で切りました`);
  }
  return { values: { to: to.slice(0, 200), body }, warnings: r.warnings, truncated: r.truncated };
}

const NOTIFY_CAPS = {
  slack: { name: 'notify_slack', title: 'Slack' },
  email: { name: 'send_email', title: 'メール' },
  line: { name: 'send_line_push', title: 'LINE' },
} as const;

/** 件名（メール）は本文の最初の 1 行を 100 文字まで */
export function subjectOf(body: string): string {
  const first = body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return first.trim().slice(0, 100) || 'お知らせ';
}

async function runNotify(ctx: NodeRunContext, c: NotifyConfig): Promise<NodeResult> {
  const rendered = ctx.gateArgs ? { values: ctx.gateArgs, warnings: [], truncated: false } : renderNotify(c, ctx.scope);
  const to = rendered.values.to ?? '';
  const body = rendered.values.body ?? '';
  if (body.trim() === '') return fail('FLOW_NOTIFY_INPUT', '送る本文が空です');
  if (to === '') return fail('FLOW_NOTIFY_INPUT', '宛先が空です');
  const cap = NOTIFY_CAPS[c.channel];
  const args: Record<string, unknown> =
    c.channel === 'slack' ? { channel: to, text: body } : c.channel === 'email' ? { to, subject: subjectOf(body), body } : { to, text: body };
  const res = await callCapability(ctx.db, { name: cap.name, args, actorId: ctx.run.actorId, plan: ctx.plan, title: cap.title });
  if (!res.ok) return fail(res.code === 'FLOW_PART_NOT_CONNECTED' ? 'FLOW_NOTIFY_UNAVAILABLE' : res.code, res.message);
  return { ok: true, output: { sent: true }, warnings: rendered.warnings, truncated: rendered.truncated };
}

export { scalarRows };

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
  return runNotify(ctx, c);
}
