import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface GlassPanelProps {
  side?: 'left' | 'right' | 'bottom' | 'center';
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  width?: string;
  className?: string;
  withBackdrop?: boolean;
  /** If true, panel is 'absolute' (contained). Otherwise 'fixed' (overlay). */
  contained?: boolean;
  zIndex?: number;
}

/**
 * GlassPanel — large sliding glass surface.
 * See DESIGN.md §10.5. Used for sidebars, drawers, and modals.
 */
export function GlassPanel({
  side = 'right',
  open,
  onClose,
  children,
  width = 'w-80',
  className = '',
  withBackdrop = true,
  contained = false,
  zIndex = 40,
}: GlassPanelProps) {
  const positionClass = contained ? 'absolute' : 'fixed';
  const sideClass = (() => {
    switch (side) {
      case 'left':
        return `${positionClass} left-0 top-0 h-full ${width} border-r border-glass-border-bright`;
      case 'right':
        return `${positionClass} right-0 top-0 h-full ${width} border-l border-glass-border-bright`;
      case 'bottom':
        return `${positionClass} left-0 right-0 bottom-0 rounded-t-xl border-t border-glass-border-bright`;
      case 'center':
        return `${positionClass} left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${width} max-w-[92vw] rounded-xl border border-glass-border-bright`;
    }
  })();

  const motionProps = (() => {
    switch (side) {
      case 'left':
        return { initial: { x: '-100%' }, animate: { x: 0 }, exit: { x: '-100%' } };
      case 'right':
        return { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' } };
      case 'bottom':
        return { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } };
      case 'center':
        return {
          initial: { opacity: 0, scale: 0.92, y: '-50%', x: '-50%' },
          animate: { opacity: 1, scale: 1, y: '-50%', x: '-50%' },
          exit: { opacity: 0, scale: 0.92, y: '-50%', x: '-50%' },
        };
    }
  })();

  return (
    <AnimatePresence>
      {open && (
        <>
          {withBackdrop && (
            <motion.div
              className={`${positionClass} inset-0 bg-overlay`}
              style={{ zIndex: zIndex - 1 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onClose}
            />
          )}
          <motion.aside
            className={`${sideClass} glass-chrome glass-reflection-top flex flex-col ${className}`}
            style={{ zIndex }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            {...motionProps}
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
