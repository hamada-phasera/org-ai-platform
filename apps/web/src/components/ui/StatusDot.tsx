import { motion } from 'framer-motion';

interface StatusDotProps {
  status: 'active' | 'processing' | 'idle';
  size?: 'sm' | 'md';
}

const statusConfig = {
  active: { color: 'bg-success', pulse: true, label: '稼働中' },
  processing: { color: 'bg-warning', pulse: true, label: '処理中' },
  idle: { color: 'bg-ink-decorative', pulse: false, label: '待機中' },
};

export function StatusDot({ status, size = 'sm' }: StatusDotProps) {
  const config = statusConfig[status];
  const sizeClass = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';

  return (
    <span className="relative inline-flex" role="img" aria-label={config.label}>
      {config.pulse && (
        <motion.span
          className={`absolute inline-flex h-full w-full rounded-full ${config.color} opacity-40`}
          animate={{ scale: [1, 1.8, 1], opacity: [0.4, 0, 0.4] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}
      <span className={`relative inline-flex rounded-full ${sizeClass} ${config.color}`} />
    </span>
  );
}
