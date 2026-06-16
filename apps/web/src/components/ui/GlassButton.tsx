import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { DEPT_ACCENT } from '../../constants/departments';

type Variant = 'primary' | 'secondary' | 'ghost' | 'glass' | 'danger';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface GlassButtonProps
  extends Omit<HTMLMotionProps<'button'>, 'children'> {
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
 * GlassButton — the canonical button primitive.
 * See DESIGN.md §10.2. Use instead of raw buttons with Tailwind bg classes.
 */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton(
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
    const toneColor = tone && tone in DEPT_ACCENT ? DEPT_ACCENT[tone as keyof typeof DEPT_ACCENT] : undefined;

    const variantBase = (() => {
      switch (variant) {
        case 'primary':
          return {
            className: 'text-inverse font-semibold shadow-elev-1 hover:shadow-elev-2',
            style: { background: toneColor ?? 'var(--accent)' },
          };
        case 'secondary':
          return {
            className:
              'glass-regular text-primary font-semibold shadow-elev-1 hover:shadow-elev-2',
            style: undefined,
          };
        case 'ghost':
          return {
            className:
              'bg-transparent text-secondary hover:text-primary hover:bg-glass-tint-thin',
            style: undefined,
          };
        case 'glass':
          return {
            className: 'glass-thin text-primary font-medium hover:glass-regular',
            style: undefined,
          };
        case 'danger':
          return {
            className: 'text-inverse font-semibold shadow-elev-2',
            style: {
              background:
                'linear-gradient(135deg, #F87171 0%, #EF4444 50%, #DC2626 100%)',
            },
          };
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
        {/* Inset highlight for glass feel on primary/danger */}
        {(variant === 'primary' || variant === 'danger') && (
          <span
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[inherit]"
            style={{
              boxShadow:
                'inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -1px 0 rgba(0, 0, 0, 0.08)',
            }}
          />
        )}

        {loading ? (
          <Loader2 size={iconSize[size]} className="animate-spin" />
        ) : (
          icon
        )}
        {children && <span className="relative">{children}</span>}
        {!loading && trailingIcon}
      </motion.button>
    );
  },
);
