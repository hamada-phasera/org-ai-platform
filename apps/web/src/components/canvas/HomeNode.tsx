import { memo, useId } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Loader2 } from 'lucide-react';
import type { PageIcon } from '@org-ai/shared-types';
import { PageIconGlyph } from './PageIconGlyph';
import type { ResolvedTarget } from './canvasToList';
import { isUncreated } from './canvasToList';

export interface HomeNodeData extends Record<string, unknown> {
  label: string;
  icon: PageIcon;
  target: ResolvedTarget;
  /** 承認件数（承認のノードだけ。0 は出さない） */
  count: number;
  editing: boolean;
  /** 閲覧モードで押せるか */
  canOpen: boolean;
  pending: boolean;
  onActivate: (id: string) => void;
}

/**
 * ホームキャンバスの業務ノード（§3.2）。白い面 1 枚・影なし・アイコン 1 つ＋ラベル一語。
 * 左アクセントバーなし・カードの入れ子なし・説明文なし。未作成は点線の枠、選択中は accent。
 * ノード全体が 1 つの button（Enter / Space で開く）。
 */
function HomeNodeImpl({ id, data, selected }: NodeProps<Node<HomeNodeData, 'home'>>) {
  const uncreated = isUncreated(data.target);
  const disabled = !data.editing && !data.canOpen;
  const descId = useId();
  // 名前は「〇〇を開く」のまま（K68）。未作成・承認待ちは aria-describedby で読ませる
  const describedBy = [uncreated && `${descId}-new`, data.count > 0 && `${descId}-count`].filter(Boolean).join(' ');
  const frame = selected
    ? 'border-accent bg-accent-soft'
    : uncreated
      ? 'border-dashed border-border-strong bg-elevated'
      : 'border-border bg-elevated';
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={data.editing} />
      <button
        type="button"
        data-canvas-node={id}
        onClick={() => data.onActivate(id)}
        aria-disabled={disabled || undefined}
        aria-busy={data.pending || undefined}
        aria-label={data.editing ? `${data.label}を選ぶ` : `${data.label}を開く`}
        aria-pressed={data.editing ? !!selected : undefined}
        aria-describedby={describedBy || undefined}
        className={`relative flex h-12 w-[140px] items-center gap-2 rounded-md border px-3 text-left transition-colors duration-fast ${frame} ${
          disabled ? 'cursor-default' : data.editing ? 'cursor-grab' : 'cursor-pointer hover:border-border-strong'
        }`}
      >
        {data.pending ? (
          <Loader2 size={16} className="shrink-0 animate-spin text-text-muted" aria-hidden="true" />
        ) : (
          <PageIconGlyph name={data.icon} size={16} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
        )}
        <span className={`min-w-0 flex-1 truncate text-sm font-bold ${uncreated ? 'text-secondary' : 'text-primary'}`}>
          {data.label}
        </span>
        {uncreated && (
          <span id={`${descId}-new`} className="sr-only">
            未作成
          </span>
        )}
        {data.count > 0 && (
          <span
            id={`${descId}-count`}
            className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border border-warning bg-elevated px-1 font-mono text-micro font-bold text-warning tabular"
            aria-label={`承認待ち ${data.count}件`}
          >
            {data.count}
          </span>
        )}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={data.editing} />
    </>
  );
}

export const HomeNode = memo(HomeNodeImpl);
