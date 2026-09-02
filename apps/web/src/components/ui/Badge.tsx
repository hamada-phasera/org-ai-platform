import type { ReactNode } from 'react';
import { DEPT_ACCENT, DEPT_LABEL } from '../../constants/departments';

type Variant = 'solid' | 'glass' | 'outline' | 'soft';
type Size = 'xs' | 'sm' | 'md';

interface BadgeProps {
  variant?: Variant;
  size?: Size;
  tone?: keyof typeof DEPT_ACCENT | string;
  color?: string;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
}

const sizeClass: Record<Size, string> = {
  xs: 'text-micro px-1.5 py-0.5 gap-1 rounded-xs',
  sm: 'text-xs px-2.5 py-1 gap-1 rounded-full',
  md: 'text-xs px-3 py-1.5 gap-1.5 rounded-full',
};

/* 意味の色。CSS変数なので hex 連結できず、color-mix でアルファを作る */
const SEMANTIC_TONE: Record<string, string> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  accent: 'var(--accent)',
};

/**
 * Badge — ラベル・タグ・ステータスピル（旧 GlassBadge）。
 * 色は tone（部署キー or success/warning/danger/info/accent）か
 * color（データの色）で。どちらも無ければニュートラル（bg-sunken）—
 * hex の既定色は持たない。
 */
export function Badge({
  variant = 'soft',
  size = 'sm',
  tone,
  color,
  icon,
  children,
  className = '',
  onClick,
}: BadgeProps) {
  const toneColor =
    color ??
    (tone && tone in DEPT_ACCENT
      ? DEPT_ACCENT[tone as keyof typeof DEPT_ACCENT]
      : tone
        ? SEMANTIC_TONE[tone]
        : undefined);

  const variantStyle = (() => {
    if (!toneColor) return undefined;
    /* hex連結（#RRGGBB + "1A"）は CSS 変数で壊れるので color-mix で統一 */
    switch (variant) {
      case 'solid':
        return { background: toneColor, color: 'white' };
      case 'soft':
        return {
          background: `color-mix(in srgb, ${toneColor} 11%, transparent)`,
          color: toneColor,
        };
      case 'outline':
        return {
          background: 'transparent',
          color: toneColor,
          border: `1px solid color-mix(in srgb, ${toneColor} 34%, transparent)`,
        };
      case 'glass':
        return undefined;
    }
  })();

  const neutralClass = toneColor
    ? variant === 'glass'
      ? 'bg-elevated border border-border text-primary'
      : ''
    : 'bg-sunken border border-border text-secondary';

  const interactive = onClick
    ? 'cursor-pointer transition-all duration-fast hover:scale-105 active:scale-95'
    : '';

  return (
    <span
      onClick={onClick}
      className={`inline-flex items-center font-medium ${sizeClass[size]} ${neutralClass} ${interactive} ${className}`}
      style={variantStyle}
    >
      {icon}
      {children}
    </span>
  );
}

/** 部署バッジ: ラベルと部署色をまとめて出す */
export function DeptBadge({
  dept,
  size = 'sm',
  variant = 'soft',
}: {
  dept: string;
  size?: Size;
  variant?: Variant;
}) {
  return (
    <Badge tone={dept} size={size} variant={variant}>
      {DEPT_LABEL[dept] ?? dept}
    </Badge>
  );
}
