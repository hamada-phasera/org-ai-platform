import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { AlertTriangle, Check, Loader2, ShieldCheck, X } from 'lucide-react';
import type { StepStatus } from '@org-ai/shared-types';
import type { StepNodeData } from './stepsToFlow';

/**
 * ワークフローの1ステップ。読み取り専用（編集操作は持たない）。
 *
 * ステータスの色は既存の意味色トークンに揃える:
 *   実行中=accent / 完了=success / 失敗=danger / 承認待ち=warning / 却下=装飾グレー。
 * ⚠️ hex 直書きは check:tokens が禁止するので、必ず Tailwind のトークンクラスで書く。
 */

const STATUS_STYLE: Record<StepStatus, { ring: string; badge: string; label: string }> = {
  PENDING: { ring: 'border-border', badge: 'bg-sunken text-text-muted', label: '待機' },
  RUNNING: { ring: 'border-accent shadow-glow-primary', badge: 'bg-accent-soft text-accent', label: '実行中' },
  DONE: { ring: 'border-success/40', badge: 'bg-success/10 text-success', label: '完了' },
  FAILED: { ring: 'border-danger/50', badge: 'bg-danger/10 text-danger', label: '失敗' },
  AWAITING_APPROVAL: { ring: 'border-warning/50', badge: 'bg-warning/10 text-warning', label: '承認待ち' },
  REJECTED: { ring: 'border-border', badge: 'bg-sunken text-ink-decorative', label: '却下' },
};

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'RUNNING') return <Loader2 size={12} className="animate-spin" aria-hidden="true" />;
  if (status === 'DONE') return <Check size={12} aria-hidden="true" />;
  if (status === 'FAILED') return <X size={12} aria-hidden="true" />;
  if (status === 'AWAITING_APPROVAL') return <ShieldCheck size={12} aria-hidden="true" />;
  return null;
}

export function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const style = STATUS_STYLE[data.status] ?? STATUS_STYLE.PENDING;
  return (
    <div
      className={`w-[300px] rounded-card border bg-elevated p-3.5 shadow-elev-1 transition-colors ${style.ring}`}
    >
      {/* 線を繋ぐためだけのハンドル。CSS で非表示にしている */}
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sunken text-micro font-bold text-secondary tabular">
          {data.index + 1}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-primary">{data.label}</p>
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-micro font-bold ${style.badge}`}
        >
          <StatusIcon status={data.status} />
          {style.label}
        </span>
      </div>

      {data.argSummary ? (
        <p className="truncate text-micro text-text-muted" title={data.argSummary}>
          {data.argSummary}
        </p>
      ) : (
        <p className="text-micro text-ink-decorative">引数なし</p>
      )}

      {(data.requiresApproval || data.unknown || data.error) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {data.requiresApproval && (
            <span className="flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-micro font-bold text-warning">
              <ShieldCheck size={10} aria-hidden="true" />
              送信前に承認
            </span>
          )}
          {data.unknown && (
            <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-micro font-bold text-danger">
              <AlertTriangle size={10} aria-hidden="true" />
              未登録のノード
            </span>
          )}
        </div>
      )}

      {data.error && (
        <p className="mt-2 line-clamp-2 text-micro text-danger" title={data.error}>
          {data.error}
        </p>
      )}

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default StepNode;
