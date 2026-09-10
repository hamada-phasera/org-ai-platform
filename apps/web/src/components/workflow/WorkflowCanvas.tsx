import { useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Workflow } from 'lucide-react';
import type { AgentRunState, AgentStepDef } from '@org-ai/shared-types';
import { EmptyState } from '../ui';
import { StepNode } from './StepNode';
import { NODE_WIDTH, stepsToFlow, type CapabilityMeta, type StepNodeData } from './stepsToFlow';
import { usePrefersReducedMotion } from '../motion/springs';

import '@xyflow/react/dist/base.css';

/**
 * ワークフローの可視化。**完全に読み取り専用**。
 *
 * 追加・削除・並べ替え・接続はすべてチャット側で行う（この画面には編集操作を置かない）。
 * 実行エンジンが線形なので、描くのも必ず1本の縦チェーンにする。
 * 位置は index から導出するだけで永続化しない。
 */

const nodeTypes = { step: StepNode };

/**
 * ノードが増えるたびに全体が収まるよう追従する。
 *
 * ⚠️ ReactFlow の `fitView` プロパティは**初回だけ**効く。構築アニメで
 * ノードを1つずつ生やすと、2つ目以降が画面の外に出たまま見えなくなる
 * （compact はドラッグも止めていたので、たどり着く手段が無かった）。
 * ReactFlow の子として置くと、そのインスタンスのストアに繋がる。
 */
function FitViewOnCountChange({ count, padding }: { count: number; padding: number }) {
  const { fitView } = useReactFlow();
  const reduceMotion = usePrefersReducedMotion();
  useEffect(() => {
    // ノードの実測が終わってから合わせる（同フレームだと高さ 0 で計算される）
    const raf = requestAnimationFrame(() => {
      void fitView({ padding, maxZoom: 1, duration: reduceMotion ? 0 : 220 });
    });
    return () => cancelAnimationFrame(raf);
  }, [count, padding, fitView, reduceMotion]);
  return null;
}

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
        /* 読み取り専用でも移動はできる。compact で止めると、はみ出したノードに
           たどり着く手段が無くなる（拡大縮小はページのスクロールを奪うので compact では止める） */
        panOnDrag
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
        <FitViewOnCountChange count={nodes.length} padding={compact ? 0.15 : 0.25} />
      </ReactFlow>
    </div>
  );
}

export default WorkflowCanvas;
