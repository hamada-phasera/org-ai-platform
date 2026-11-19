// 確認: 止まって人を待つ（§7.4）。ここは受信ページに積む中身（文言とプレビュー）を組み立てるだけ。
// 外へ送るノードの手前の強制停止（定義に確認ノードが無くても止める。K12）も同じ形で積む。
import { FLOW_DEFINITION_LIMITS as L, renderTemplate, type FlowNode, type FlowScope, type FlowStepApprovalData, type UserRole } from '@org-ai/shared-types';
import { Renderer } from './types';

export function approvalDataOf(runId: string, node: FlowNode, scope: FlowScope): FlowStepApprovalData {
  const r = new Renderer(scope, renderTemplate);
  if (node.type === 'approval') {
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
  let preview = '';
  if (node.type === 'output' && node.config.kind === 'notify') {
    const to = r.text(node.config.to);
    preview = `${to ? `宛先: ${to}\n` : ''}${r.text(node.config.body)}`;
  } else if (node.type === 'part') {
    preview = Object.entries(node.config.input)
      .map(([k, v]) => `${k}: ${r.text(v)}`)
      .join('\n');
  }
  return {
    kind: 'flow_step',
    runId,
    nodeId: node.id,
    label: node.label,
    message: `「${node.label}」を送ります`,
    preview: preview.slice(0, L.approvalPreviewMax * 4),
    minRole: 'MEMBER',
    gate: true,
  };
}
