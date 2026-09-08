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
 * セグメントコントロール（v3 / Stripe流）。トラックは沈んだ面、選択中は
 * 白い面＋影で持ち上げる。インジケータは layoutId で位置と幅の両方を補間。
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
      className={`inline-flex items-center gap-0.5 rounded-md bg-sunken p-[3px] ${className}`}
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
            className={`relative ${height} ${padding} ${text} inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] font-semibold transition-colors duration-fast ease-standard ${
              selected ? 'text-primary' : 'text-secondary hover:text-primary'
            }`}
          >
            {selected && (
              <motion.span
                layoutId={`liquid-tab-${id}`}
                transition={transition}
                aria-hidden="true"
                className="absolute inset-0 -z-10 rounded-[7px] bg-elevated shadow-[0_1px_2px_rgba(16,36,64,0.14)]"
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
