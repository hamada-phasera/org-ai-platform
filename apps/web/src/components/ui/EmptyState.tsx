import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Card } from './Card';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; icon?: ReactNode };
  className?: string;
  tone?: string;
}

export function EmptyState({ icon, title, description, action, className = '', tone }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex items-center justify-center py-12 ${className}`}
    >
      <Card variant="thin" padding="lg" radius="2xl" tone={tone} className="max-w-md w-full text-center">
        {icon && (
          <div className="mx-auto mb-4 w-14 h-14 rounded-2xl flex items-center justify-center bg-elevated border border-border text-primary">
            {icon}
          </div>
        )}
        <h3 className="text-body font-semibold text-primary mb-1.5">{title}</h3>
        {description && <p className="text-sm text-muted leading-relaxed">{description}</p>}
        {action && (
          <div className="mt-5 flex justify-center">
            <Button variant="primary" size="sm" onClick={action.onClick} icon={action.icon}>
              {action.label}
            </Button>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
