import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { NodeTypeIcon, StepDot } from './FlowBits';
import { labelOfStepStatus } from './flowModel';

/**
 * フロー画面のノードと線（PC。@xyflow/react を読むので FlowEditor からだけ使う）。
 * ノードはホームと同じ見た目: 白い面 1 枚・影なし・型のアイコン＋ラベル一語。型ごとの色分けはしない（§3.4）。
 * 選択中は border-accent＋bg-accent-soft。検証エラーは danger の点、実行の状態は右肩の点（§3.4）。
 */

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  type: string;
  /** 表示中の実行のこのノードの状態 */
  status?: string;
  /** 保存の検証エラー（1 行目） */
  issue?: string;
  /** 部品の未接続・上位プラン */
  notice?: string;
  editable: boolean;
  onActivate: (id: string) => void;
}

function FlowCanvasNodeImpl({ id, data, selected }: NodeProps<Node<FlowNodeData, 'step'>>) {
  const frame = selected ? 'border-accent bg-accent-soft' : data.issue ? 'border-danger bg-elevated' : 'border-border bg-elevated';
  const extra = [data.status ? labelOfStepStatus(data.status) : '', data.issue ? `エラー: ${data.issue}` : '', data.notice ?? ''].filter(Boolean).join('、');
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={data.editable} />
      <button
        type="button"
        data-flow-node={id}
        onClick={() => data.onActivate(id)}
        aria-label={`${data.label}${extra ? `（${extra}）` : ''}`}
        aria-pressed={!!selected}
        className={`relative flex h-12 w-[150px] items-center gap-2 rounded-md border px-3 text-left transition-colors duration-fast hover:border-border-strong ${frame} ${
          data.editable ? 'cursor-grab' : 'cursor-pointer'
        }`}
      >
        <NodeTypeIcon type={data.type} size={16} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-primary">{data.label}</span>
        {data.notice && <span className="shrink-0 text-micro font-bold text-warning">{data.notice}</span>}
        {(data.status || data.issue) && (
          <span className="absolute -right-1 -top-1 flex gap-0.5">
            {data.issue && <span className="h-2.5 w-2.5 rounded-full border border-elevated bg-danger" aria-hidden="true" />}
            {data.status && <StepDot status={data.status} className="h-2.5 w-2.5 border border-elevated" />}
          </span>
        )}
      </button>
      <Handle type="source" position={Position.Bottom} isConnectable={data.editable} />
    </>
  );
}

export const FlowCanvasNode = memo(FlowCanvasNodeImpl);

export interface FlowEdgeData extends Record<string, unknown> {
  when?: 'yes' | 'no';
  editable: boolean;
  onInsert: (from: string, to: string, when?: 'yes' | 'no') => void;
}

/** 線（1px・矢印 1 つ）。分岐から出る線だけ「はい / いいえ」。編集できるときは途中に「＋」（挿入） */
function FlowEdgeImpl({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<Edge<FlowEdgeData, 'step'>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  const when = data?.when;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {(when || data?.editable) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {when && <span className="rounded-sm border border-border bg-elevated px-1 text-micro font-bold text-secondary">{when === 'yes' ? 'はい' : 'いいえ'}</span>}
            {data?.editable && (
              <button
                type="button"
                aria-label="ここに挿入"
                onClick={() => data.onInsert(source, target, when)}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-elevated text-secondary hover:border-accent hover:text-accent"
              >
                <Plus size={11} aria-hidden="true" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FlowEdgeView = memo(FlowEdgeImpl);
