// 部品: 運営が用意した既製の処理を、入力値を渡して呼ぶだけ（§6.2・§8）。中身は part-client.ts。
//
// ■ 入力は部品の Field の分だけ展開し（定義に無い項目は渡さない）、文字の項目は Field の maxLength で切る（切ったら warnings）。
//   その後 buildPartInputSchema（.strict()）を通す。合わなければ n8n / capability に届かない（T8）。
// ■ 外へ送る部品は、ランナーが手前で必ず止め、人が承認したときの中身（gateArgs）をそのまま送る（K12・K57）。
// ■ 上位プランの部品は受け付けで 403（K56）。ここでも念のためもう一度見る（定義が実行の途中で変わることは無いが、降格はありうる）。
import {
  FLOW_PARTS,
  buildPartInputSchema,
  findFlowPart,
  planAllowsPart,
  renderTemplate,
  type FlowNodeOf,
  type FlowPartSpec,
  type FlowScope,
} from '@org-ai/shared-types';
import { callCapabilityPart, callN8nPart } from '../part-client';
import { Renderer, fail, type NodeResult, type NodeRunContext } from './types';

const TEXT_TYPES = new Set(['text', 'textarea', 'email', 'tel', 'date', 'select']);

export interface RenderedPartInput {
  values: Record<string, string>;
  warnings: string[];
  truncated: boolean;
}

/** 部品の入力を展開する（承認の手前で見せる中身と、送る中身は同じこの関数で作る） */
export function renderPartInput(node: FlowNodeOf<'part'>, spec: Pick<FlowPartSpec, 'input'>, scope: FlowScope): RenderedPartInput {
  const r = new Renderer(scope, renderTemplate);
  const values: Record<string, string> = {};
  for (const field of spec.input) {
    if (!Object.prototype.hasOwnProperty.call(node.config.input, field.key)) continue;
    let v = r.text(node.config.input[field.key]);
    const max = 'maxLength' in field && typeof field.maxLength === 'number' ? field.maxLength : undefined;
    if (TEXT_TYPES.has(field.type) && max !== undefined && v.length > max) {
      v = v.slice(0, max);
      r.truncated = true;
      r.warnings.push(`${field.label} を ${max} 文字で切りました`);
    }
    values[field.key] = v;
  }
  return { values, warnings: r.warnings, truncated: r.truncated };
}

/** 検証の失敗を「どの項目か」だけの 1 行にする（値は入れない） */
function inputIssueMessage(spec: FlowPartSpec, issues: { path: (string | number)[] }[]): string {
  const labels = [...new Set(issues.map((i) => spec.input.find((f) => f.key === i.path[0])?.label ?? String(i.path[0] ?? '')))].filter(Boolean);
  return `部品「${spec.title}」に渡す値が合いません${labels.length > 0 ? `（${labels.slice(0, 5).join('・')}）` : ''}`;
}

export async function runPartNode(ctx: NodeRunContext): Promise<NodeResult> {
  if (ctx.node.type !== 'part') return fail('FLOW_NODE_TYPE', '型が違います');
  const node = ctx.node;
  const spec = findFlowPart(node.config.part, FLOW_PARTS);
  if (!spec) return fail('FLOW_PART_UNKNOWN', '知らない部品です');
  if (!planAllowsPart(ctx.plan, spec.minPlan)) return fail('FLOW_PART_PLAN', `部品「${spec.title}」は今のプランでは使えません`);

  const rendered = ctx.gateArgs ? { values: ctx.gateArgs, warnings: [], truncated: false } : renderPartInput(node, spec, ctx.scope);
  const parsed = buildPartInputSchema(spec).safeParse(rendered.values);
  if (!parsed.success) return fail('FLOW_PART_INPUT', inputIssueMessage(spec, parsed.error.issues));
  const input = parsed.data as Record<string, unknown>;

  let actorRole: string | null = null;
  if (ctx.run.actorId && spec.via.kind === 'n8n') {
    const m = await ctx.db.membership.findFirst({ where: { userId: ctx.run.actorId }, select: { role: true } }).catch(() => null);
    actorRole = m?.role ?? null;
  }
  const res =
    spec.via.kind === 'n8n'
      ? await callN8nPart(spec, {
          orgId: ctx.run.orgId,
          runId: ctx.run.id,
          nodeId: node.id,
          actor: { userId: ctx.run.actorId, role: actorRole },
          plan: ctx.plan,
          input,
        })
      : await callCapabilityPart(ctx.db, spec as FlowPartSpec & { via: { kind: 'capability'; name: string } }, {
          input,
          actorId: ctx.run.actorId,
          plan: ctx.plan,
        });
  if (!res.ok) return fail(res.code, res.message, { partCalls: res.partCalls, attempts: res.attempts });
  return {
    ok: true,
    output: res.output,
    warnings: [...rendered.warnings, ...res.warnings],
    truncated: rendered.truncated,
    partCalls: res.partCalls,
    attempts: res.attempts,
  };
}
