import { forwardRef, type ReactNode, type HTMLAttributes } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { DEPT_ACCENT } from '../../constants/departments';

/* v2: カード・表・パネルはフラットな白。ガラス（半透明）は使わない。
 * elevation は影の段階（旧 GlassVariant thin/regular/thick/chrome を継承）。 */
type Elevation = 'thin' | 'regular' | 'thick' | 'chrome';
type DeptTone = keyof typeof DEPT_ACCENT;

type CardBaseProps = {
  /** 旧APIとの互換名。実体は「面＋影の段階」 */
  variant?: Elevation;
  tone?: DeptTone | string;
  interactive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  radius?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** v1の名残。v2では効果なし（受け取って無視する） */
  reflectionTop?: boolean;
  children?: ReactNode;
  className?: string;
};

const elevationClass: Record<Elevation, string> = {
  thin: 'bg-sunken border border-border',
  regular: 'bg-elevated border border-border shadow-elev-1',
  thick: 'bg-elevated border border-border shadow-elev-2',
  chrome: 'bg-elevated border border-border shadow-elev-3',
};

const paddingClass = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

const radiusClass = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
} as const;

/**
 * Card — 面の基本プリミティブ（旧 GlassCard）。
 * フラットな白い面。数字や表を載せる場所に半透明は使わない。
 */
export const Card = forwardRef<
  HTMLDivElement,
  CardBaseProps & Omit<HTMLMotionProps<'div'>, keyof CardBaseProps>
>(function Card(
  {
    variant = 'regular',
    tone,
    interactive = false,
    padding = 'md',
    radius = 'lg',
    reflectionTop: _reflectionTop,
    children,
    className = '',
    style,
    ...rest
  },
  ref,
) {
  const toneColor =
    tone && tone in DEPT_ACCENT ? DEPT_ACCENT[tone as DeptTone] : undefined;

  const toneStyle = toneColor
    ? { boxShadow: `inset 0 0 0 1px ${toneColor}2E` }
    : undefined;

  return (
    <motion.div
      ref={ref}
      className={`relative ${elevationClass[variant]} ${radiusClass[radius]} ${paddingClass[padding]} ${className}`}
      style={{ ...toneStyle, ...style }}
      whileHover={interactive ? { y: -2 } : undefined}
      whileTap={interactive ? { scale: 0.995 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      {...rest}
    >
      {children}
    </motion.div>
  );
});

/** 静的版（モーション不要の深い入れ子用）。旧 GlassSurface */
export function Surface({
  variant = 'regular',
  padding = 'md',
  radius = 'lg',
  reflectionTop: _reflectionTop,
  children,
  className = '',
  ...rest
}: CardBaseProps & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`relative ${elevationClass[variant]} ${radiusClass[radius]} ${paddingClass[padding]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
