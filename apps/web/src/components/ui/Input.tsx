import { forwardRef, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type BaseProps = {
  prefix?: ReactNode;
  suffix?: ReactNode;
  error?: boolean;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
};

/* ネイティブの size?: number は BaseProps の size と交差して never になるので外す */
type InputOnlyProps = BaseProps & {
  multiline?: false;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>;

type TextareaProps = BaseProps & {
  multiline: true;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

type InputProps = InputOnlyProps | TextareaProps;

const sizeClass = {
  sm: 'text-xs px-3 py-2 rounded-sm',
  md: 'text-sm px-4 py-2.5 rounded-sm',
  lg: 'text-body px-5 py-3 rounded-md',
} as const;

/**
 * Input — テキスト入力の正本（旧 GlassInput）。
 * フラットな面＋フォーカスでアクセントの枠。ラベルは呼び出し側で
 * <label htmlFor> を紐付けること。
 */
export const Input = forwardRef<HTMLInputElement | HTMLTextAreaElement, InputProps>(
  function Input(props, ref) {
    const {
      prefix,
      suffix,
      error = false,
      size = 'md',
      fullWidth = true,
      className = '',
      ...rest
    } = props as BaseProps & { className?: string };

    const wrapperClass = `relative bg-elevated border ${error ? 'border-danger' : 'border-border'} ${sizeClass[size]} ${fullWidth ? 'w-full' : ''} flex items-center gap-2 transition-all duration-base ease-standard focus-within:border-accent focus-within:shadow-glow-primary ${className}`;

    const fieldClass =
      'flex-1 bg-transparent border-0 outline-none text-primary placeholder:text-muted resize-none';

    if ('multiline' in props && props.multiline) {
      const { multiline: _m, ...textareaProps } = rest as TextareaHTMLAttributes<HTMLTextAreaElement> & {
        multiline?: boolean;
      };
      void _m;
      return (
        <div className={wrapperClass}>
          {prefix && <span className="text-muted flex items-center">{prefix}</span>}
          <textarea ref={ref as React.Ref<HTMLTextAreaElement>} className={fieldClass} {...textareaProps} />
          {suffix && <span className="text-muted flex items-center">{suffix}</span>}
        </div>
      );
    }

    return (
      <div className={wrapperClass}>
        {prefix && <span className="text-muted flex items-center">{prefix}</span>}
        <input
          ref={ref as React.Ref<HTMLInputElement>}
          className={fieldClass}
          {...(rest as InputHTMLAttributes<HTMLInputElement>)}
        />
        {suffix && <span className="text-muted flex items-center">{suffix}</span>}
      </div>
    );
  },
);
