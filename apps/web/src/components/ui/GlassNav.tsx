import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface GlassNavProps {
  children: ReactNode;
  orientation?: 'horizontal' | 'vertical';
  variant?: 'regular' | 'thick' | 'chrome';
  className?: string;
}

/**
 * GlassNav — container for GlassNavItem.
 * See DESIGN.md §10.6. Used for BottomNav, tabs, segmented controls.
 */
export function GlassNav({
  children,
  orientation = 'horizontal',
  variant = 'chrome',
  className = '',
}: GlassNavProps) {
  const variantClass =
    variant === 'chrome' ? 'glass-chrome' : variant === 'thick' ? 'glass-thick' : 'glass-regular';
  const orientationClass =
    orientation === 'horizontal' ? 'flex flex-row items-center gap-1' : 'flex flex-col gap-1';

  return (
    <nav
      className={`relative ${variantClass} glass-reflection-top rounded-xl p-1.5 ${orientationClass} ${className}`}
    >
      {children}
    </nav>
  );
}

interface GlassNavItemProps {
  active?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  label?: string;
  badge?: ReactNode;
  tone?: string;
  layoutId?: string;
  children?: ReactNode;
  className?: string;
  /** If true, render an elevated "center" button (e.g. AI button) */
  elevated?: boolean;
}

export function GlassNavItem({
  active = false,
  onClick,
  icon,
  label,
  badge,
  tone = '#EA580C',
  layoutId = 'glass-nav-indicator',
  children,
  className = '',
  elevated = false,
}: GlassNavItemProps) {
  if (elevated) {
    return (
      <motion.button
        onClick={onClick}
        className={`relative flex flex-col items-center justify-center -mt-6 ${className}`}
        whileHover={{ y: -2, scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      >
        <div
          className="relative w-14 h-14 rounded-full flex items-center justify-center shadow-glow-primary"
          style={{
            background: `linear-gradient(135deg, ${tone}F0, ${tone})`,
            boxShadow: `0 8px 24px ${tone}55, inset 0 1px 0 rgba(255, 255, 255, 0.5)`,
          }}
        >
          <div className="relative z-10 text-inverse">{icon ?? children}</div>
          {/* Halo ring */}
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{ border: `2px solid ${tone}40` }}
            animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
        {label && (
          <span className="text-micro font-semibold mt-1" style={{ color: tone }}>
            {label}
          </span>
        )}
      </motion.button>
    );
  }

  return (
    <motion.button
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center gap-1 min-w-[56px] px-3 py-2 rounded-sm transition-colors duration-base ${className}`}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.95 }}
    >
      {active && (
        <motion.div
          layoutId={layoutId}
          className="absolute inset-0 rounded-sm glass-regular"
          style={{ boxShadow: `inset 0 0 0 1px ${tone}33, 0 0 12px ${tone}22` }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        />
      )}
      <div
        className="relative z-10 flex flex-col items-center gap-1"
        style={{ color: active ? tone : '#6B6258' }}
      >
        <div className="relative">
          {icon ?? children}
          {badge && (
            <span className="absolute -top-1 -right-1">{badge}</span>
          )}
        </div>
        {label && (
          <span
            className="text-micro font-medium"
            style={{ color: active ? tone : '#A8A095' }}
          >
            {label}
          </span>
        )}
      </div>
    </motion.button>
  );
}
