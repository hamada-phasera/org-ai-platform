// 確認: 止まって人を待つ（§7.4）。ここは受信ページに積む中身（文言とプレビュー）を組み立てるだけ。
// 外へ送るノードの手前の強制停止（定義に確認ノードが無くても止める。K12）も同じ形で積む。
// 送る中身（gateArgs）は止める時点で展開して FlowRun.steps に固定し、承認の後はそれをそのまま送る（K57）。
import {
  FLOW_DEFINITION_LIMITS as L,
  FLOW_PARTS,
  findFlowPart,
  renderTemplate,
  type FlowNode,
  type FlowScope,
  type FlowStepApprovalData,
  type UserRole,
} from '@org-ai/shared-types';
import { renderNotify } from './output';
import { renderPartInput } from './part';
import { Renderer } from './types';

/** 外へ送るノードの、送る中身（展開済み）。外へ送らないノードは undefined */
export function gateArgsOf(node: FlowNode, scope: FlowScope): Record<string, string> | undefined {
  if (node.type === 'output' && node.config.kind === 'notify') return renderNotify(node.config, scope).values;
  if (node.type === 'part') {
    const spec = findFlowPart(node.config.part, FLOW_PARTS);
    // 知らない部品でも止める（fail-closed）。中身は定義の文字をそのまま見せる
    if (!spec) return Object.fromEntries(Object.entries(node.config.input).map(([k, v]) => [k, String(v)]));
    return renderPartInput(node, spec, scope).values;
  }
  return undefined;
}

function gatePreview(node: FlowNode, args: Record<string, string>): string {
  if (node.type === 'output' && node.config.kind === 'notify') {
    return `${args.to ? `宛先: ${args.to}\n` : ''}${args.body ?? ''}`;
  }
  if (node.type === 'part') {
    const spec = findFlowPart(node.config.part, FLOW_PARTS);
    return Object.entries(args)
      .map(([k, v]) => `${spec?.input.find((f) => f.key === k)?.label ?? k}: ${v}`)
      .join('\n');
  }
  return '';
}

export function approvalDataOf(runId: string, node: FlowNode, scope: FlowScope, gateArgs?: Record<string, string>): FlowStepApprovalData {
  if (node.type === 'approval') {
    const r = new Renderer(scope, renderTemplate);
    return {
      kind: 'flow_step',
      runId,
      nodeId: node.id,
      label: node.label,
      message: r.text(node.config.message).slice(0, L.approvalMessageMax * 4),
      preview: r.text(node.config.preview).slice(0, L.approvalPreviewMax * 4),
      minRole: (node.config.minRole ?? 'MEMBER') as UserRole,
      gate: false,
    };
  }
  // 外へ送るノード: 送る中身と宛先を見せて止める
  const args = gateArgs ?? gateArgsOf(node, scope) ?? {};
  return {
    kind: 'flow_step',
    runId,
    nodeId: node.id,
    label: node.label,
    message: `「${node.label}」を送ります`,
    preview: gatePreview(node, args).slice(0, L.approvalPreviewMax * 4),
    minRole: 'MEMBER',
    gate: true,
  };
}
