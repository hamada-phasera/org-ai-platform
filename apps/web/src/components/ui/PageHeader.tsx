import { type ReactNode } from 'react';
import { motion } from 'framer-motion';

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, actions, className = '' }: PageHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex items-start justify-between gap-4 pb-5 mb-5 border-b border-border ${className}`}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl sm:text-2xl font-bold text-primary tracking-tight truncate">{title}</h1>
        {description && <p className="text-sm text-muted mt-1 leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </motion.header>
  );
}
