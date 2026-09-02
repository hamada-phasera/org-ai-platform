import { AlertTriangle, RotateCcw } from 'lucide-react';
import { motion } from 'framer-motion';
import { Card } from './Card';
import { Button } from './Button';

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'エラーが発生しました',
  description = '通信に失敗しました。しばらくしてから再度お試しください。',
  onRetry,
  retryLabel = '再試行',
  className = '',
}: ErrorStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-center justify-center py-12 ${className}`}
      role="alert"
    >
      <Card
        variant="thin"
        padding="lg"
        radius="2xl"
        className="max-w-md w-full text-center"
        /* var() 色は Tailwind のアルファ修飾（ring-danger/30 等）が効かないので color-mix */
        style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--danger) 30%, transparent)' }}
      >
        <div
          className="mx-auto mb-4 w-12 h-12 rounded-2xl flex items-center justify-center text-danger"
          style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}
        >
          <AlertTriangle size={22} />
        </div>
        <h3 className="text-body font-semibold text-primary mb-1.5">{title}</h3>
        <p className="text-sm text-muted leading-relaxed">{description}</p>
        {onRetry && (
          <div className="mt-5 flex justify-center">
            <Button variant="secondary" size="sm" onClick={onRetry} icon={<RotateCcw size={14} />}>
              {retryLabel}
            </Button>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
