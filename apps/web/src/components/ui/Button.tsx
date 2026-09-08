import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { DEPT_ACCENT } from '../../constants/departments';

type Variant = 'primary' | 'secondary' | 'ghost' | 'glass' | 'danger';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: Size;
  tone?: keyof typeof DEPT_ACCENT | string;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

const sizeClass: Record<Size, string> = {
  xs: 'text-xs px-2.5 py-1.5 gap-1 rounded-xs',
  sm: 'text-xs px-3.5 py-2 gap-1.5 rounded-sm',
  md: 'text-sm px-5 py-2.5 gap-2 rounded-sm',
  lg: 'text-body px-6 py-3 gap-2 rounded-md',
};

const iconSize: Record<Size, number> = { xs: 11, sm: 13, md: 14, lg: 16 };

/**
 * Button — ボタンの正本（旧 GlassButton）。
 *
 * v3: primary はブランドのブルーバイオレット塗り（--action）。塗り面積は小さく保つ。
 * 部署色 tone を渡したときはその単色になる（データの色）。
 * v1 の重複 ui/Button.tsx（紫の直書きだったもの）はこのファイルに置き換えられた。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      tone,
      icon,
      trailingIcon,
      loading = false,
      fullWidth = false,
      className = '',
      disabled,
      children,
      style,
      ...rest
    },
    ref,
  ) {
    const toneColor =
      tone && tone in DEPT_ACCENT ? DEPT_ACCENT[tone as keyof typeof DEPT_ACCENT] : undefined;

    const variantBase = (() => {
      switch (variant) {
        case 'primary':
          return toneColor
            ? {
                className: 'text-inverse font-semibold shadow-elev-1 hover:shadow-elev-2',
                style: { background: toneColor },
              }
            : {
                className:
                  'bg-action text-white font-bold shadow-[0_1px_2px_rgba(10,37,64,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-action-hover',
                style: undefined,
              };
        case 'secondary':
          return {
            className: 'bg-elevated border border-border-strong text-primary font-bold shadow-elev-1',
            style: undefined,
          };
        case 'ghost':
          return {
            className: 'bg-transparent text-secondary hover:text-primary hover:bg-sunken',
            style: undefined,
          };
        case 'glass':
          return {
            className: 'bg-elevated border border-border text-primary font-medium shadow-elev-1 hover:shadow-elev-2',
            style: undefined,
          };
        case 'danger':
          return { className: 'bg-danger text-white font-semibold shadow-elev-1', style: undefined };
      }
    })();

    const isDisabled = disabled || loading;

    return (
      <motion.button
        ref={ref}
        className={`relative inline-flex items-center justify-center ${sizeClass[size]} ${variantBase.className} ${fullWidth ? 'w-full' : ''} transition-all duration-base ease-standard disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden ${className}`}
        style={{ ...variantBase.style, ...style }}
        whileHover={!isDisabled ? { scale: 1.02 } : undefined}
        whileTap={!isDisabled ? { scale: 0.97 } : undefined}
        disabled={isDisabled}
        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
        {...rest}
      >
        {loading ? <Loader2 size={iconSize[size]} className="animate-spin" /> : icon}
        {children && <span className="relative">{children}</span>}
        {!loading && trailingIcon}
      </motion.button>
    );
  },
);
