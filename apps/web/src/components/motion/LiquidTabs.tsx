import { useRef } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useMotion } from './springs';

export interface LiquidTabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** 件数バッジなど。選択中は白抜きになるので色は指定しないこと。 */
  badge?: ReactNode;
}

interface LiquidTabsProps<T extends string> {
  /**
   * このタブ群を一意に識別する ID。**必須**。
   *
   * v1 の TabSwitch は layoutId="activeTab" というグローバルな固定文字列を使っており、
   * 2 つ同時にマウントすると互いのインジケータを奪い合っていた。
   */
  id: string;
  items: readonly LiquidTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** スクリーンリーダー向けにこのタブ群が何を切り替えるのかを述べる。 */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * 液体的に追従するタブ。インジケータが位置だけでなく**幅も**補間されるのが肝で、
 * これは layoutId を当てるだけで framer-motion が面倒を見てくれる。
 *
 * 選択中は「濃いコバルトのガラス＋白文字」。明るいレンズ方式は
 * スイッチの ON/OFF がほぼ見分けられなかったため不採用（実写比較で確認）。
 *
 * ガラスを使ってよいのはタブ・ボトムナビ・TOPの入口だけ（src/index.css 参照）。
 */
export function LiquidTabs<T extends string>({
  id,
  items,
  value,
  onChange,
  label,
  size = 'md',
  className = '',
}: LiquidTabsProps<T>) {
  const transition = useMotion('indicator');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const height = size === 'sm' ? 'h-7' : 'h-8';
  const padding = size === 'sm' ? 'px-3' : 'px-3.5';
  const text = size === 'sm' ? 'text-xs' : 'text-sm';

  // 左右矢印でタブを移動する。フォーカスと選択を同時に動かす（自動アクティベーション）。
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.value === value);
    const next = items[(index + delta + items.length) % items.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`tab-glass inline-flex items-center gap-0.5 rounded-full p-1 ${className}`}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[item.value] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={`relative ${height} ${padding} ${text} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold transition-colors duration-fast ease-standard ${
              selected ? 'text-white' : 'text-secondary hover:text-primary'
            }`}
          >
            {selected && (
              <motion.span
                layoutId={`liquid-tab-${id}`}
                transition={transition}
                aria-hidden="true"
                className="liquid-smoke absolute inset-0 -z-10 rounded-full"
              />
            )}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

export default LiquidTabs;
