import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Workflow } from 'lucide-react';
import type { AgentRunState, AgentStepDef } from '@org-ai/shared-types';
import { EmptyState } from '../ui';
import { StepNode } from './StepNode';
import { NODE_WIDTH, stepsToFlow, type CapabilityMeta, type StepNodeData } from './stepsToFlow';

import '@xyflow/react/dist/base.css';

/**
 * ワークフローの可視化。**完全に読み取り専用**。
 *
 * 追加・削除・並べ替え・接続はすべてチャット側で行う（この画面には編集操作を置かない）。
 * 実行エンジンが線形なので、描くのも必ず1本の縦チェーンにする。
 * 位置は index から導出するだけで永続化しない。
 */

const nodeTypes = { step: StepNode };

interface Props {
  steps: AgentStepDef[] | null | undefined;
  capabilities?: CapabilityMeta[];
  /** 実行中/実行後の状態。渡すとノードがステップ単位で光る */
  runState?: AgentRunState | null;
  /** 構築アニメ用。指定すると先頭から count 個だけ描く */
  visibleCount?: number;
  /** 提案カードに埋める用の小さい表示 */
  compact?: boolean;
  className?: string;
}

export function WorkflowCanvas({
  steps,
  capabilities = [],
  runState,
  visibleCount,
  compact = false,
  className = '',
}: Props) {
  const { nodes, edges } = useMemo(() => {
    const flow = stepsToFlow(steps, capabilities, runState);
    if (visibleCount === undefined) return flow;
    const shown = flow.nodes.slice(0, Math.max(0, visibleCount));
    const shownIds = new Set(shown.map((n) => n.id));
    return {
      nodes: shown,
      edges: flow.edges.filter((e) => shownIds.has(e.source) && shownIds.has(e.target)),
    };
  }, [steps, capabilities, runState, visibleCount]);

  if (nodes.length === 0 && visibleCount === undefined) {
    return (
      <EmptyState
        icon={<Workflow size={22} />}
        title="まだ手順がありません"
        description="チャットで「〜して、そのあと〜して」と伝えると、AI が手順を組み立てます。"
      />
    );
  }

  return (
    <div
      className={`workflow-canvas rounded-panel border border-border bg-canvas ${
        compact ? 'h-[220px]' : 'h-[560px]'
      } ${className}`}
    >
      <ReactFlow
        nodes={nodes as Node<StepNodeData>[]}
        edges={edges as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: compact ? 0.15 : 0.25, maxZoom: 1 }}
        /* 読み取り専用: 動かす・繋ぐ・選ぶ・消すを全部止める */
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        nodesFocusable={false}
        deleteKeyCode={null}
        panOnDrag={!compact}
        zoomOnScroll={!compact}
        zoomOnDoubleClick={false}
        preventScrolling={!compact}
        proOptions={{ hideAttribution: true }}
        style={{ width: '100%', height: '100%' }}
        translateExtent={[
          [-NODE_WIDTH, -200],
          [NODE_WIDTH * 2, Math.max(nodes.length, 1) * 200 + 200],
        ]}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--hairline)" />
        {!compact && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
    </div>
  );
}

export default WorkflowCanvas;
