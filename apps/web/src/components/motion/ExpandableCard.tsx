import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMotion } from './springs';

interface ExpandableCardProps {
  /** このカードを一意に識別する ID。layoutId の衝突を避けるため必須。 */
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 畳んだ状態の中身。押すと展開する。 */
  collapsed: ReactNode;
  /** 開いた状態の中身。 */
  children: ReactNode;
  /** ボタンに読ませるラベル（畳んだ中身が図やアイコン中心のとき用）。 */
  label?: string;
  className?: string;
  collapsedClassName?: string;
  expandedClassName?: string;
}

/**
 * 押した位置から広がって詳細になるカード。
 *
 * 畳んだボタンと開いたパネルが同じ layoutId を共有するので、
 * 「どこから来たか」が目で追える。ページ遷移はしない。
 *
 * 注意: 開いた面はガラスにしない。中身が数字の表になることが多く、
 * 背景が透けると読めなくなる（src/index.css のコメント参照）。
 */
export function ExpandableCard({
  id,
  open,
  onOpenChange,
  collapsed,
  children,
  label,
  className = '',
  collapsedClassName = '',
  expandedClassName = '',
}: ExpandableCardProps) {
  const transition = useMotion('morph');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(open);

  // Escape で閉じる。閉じたらフォーカスを開いた元のボタンに返す。
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  const layoutId = `expandable-${id}`;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {open ? (
        <motion.section
          key="expanded"
          layoutId={layoutId}
          transition={transition}
          aria-label={label}
          className={`overflow-hidden rounded-xl border border-border bg-elevated shadow-elev-3 ${className} ${expandedClassName}`}
        >
          {children}
        </motion.section>
      ) : (
        <motion.button
          key="collapsed"
          ref={triggerRef}
          layoutId={layoutId}
          transition={transition}
          type="button"
          aria-expanded={false}
          aria-label={label}
          onClick={() => onOpenChange(true)}
          className={`bg-elevated border border-border shadow-elev-2 block w-full overflow-hidden rounded-xl text-left ${className} ${collapsedClassName}`}
        >
          {collapsed}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export default ExpandableCard;
