import { useEffect, useRef } from 'react';
import { FLOW_NODE_TYPE_LABEL, type FlowNodeType } from '@org-ai/shared-types';
import { NodeTypeIcon } from './FlowBits';

/**
 * ノードの追加メニュー（§3.4「型の一覧。区切り線の行、各行は一語＋アイコン」）。浮くものなので shadow-elev-2。
 */
export function NodeTypeMenu({
  types,
  onPick,
  onClose,
  className = '',
}: {
  types: FlowNodeType[];
  onPick: (t: FlowNodeType) => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} role="menu" aria-label="ノードを追加" className={`w-44 overflow-hidden rounded-md border border-border bg-elevated shadow-elev-2 ${className}`}>
      <ul className="divide-y divide-hairline">
        {types.map((t) => (
          <li key={t}>
            <button
              type="button"
              role="menuitem"
              onClick={() => onPick(t)}
              className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm font-bold text-primary hover:bg-sunken focus:bg-sunken"
            >
              <NodeTypeIcon type={t} size={15} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
              {FLOW_NODE_TYPE_LABEL[t]}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
