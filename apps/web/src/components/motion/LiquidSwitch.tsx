import { motion } from 'framer-motion';
import { useMotion } from './springs';

interface LiquidSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** スクリーンリーダー向けにこのスイッチが何を切り替えるのかを述べる。 */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * リキッドガラスのスイッチ。
 *
 * OFF＝素通しのガラスの溝、ON＝コバルト・スモーク。「濃い方が選択」の原則。
 * つまみは真珠の球（上左からの光）。位置は layout アニメーションで滑る。
 */
export function LiquidSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  className = '',
}: LiquidSwitchProps) {
  const transition = useMotion('indicator');

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-10 w-[74px] shrink-0 items-center rounded-full p-1 transition-colors duration-base ease-standard ${
        checked ? 'liquid-trough-on justify-end' : 'liquid-trough-off justify-start'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
    >
      <motion.span
        layout
        transition={transition}
        aria-hidden="true"
        className="liquid-thumb block h-8 w-8 rounded-full"
      />
    </button>
  );
}

export default LiquidSwitch;
