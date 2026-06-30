import { forwardRef } from 'react';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className = '', hover = true, children, ...props }, ref) => (
    <div
      ref={ref}
      className={`bg-white border border-[#eae8e3] rounded-3xl shadow-sm ${hover ? 'hover:shadow-md hover:border-[#8b85ff]/20 transition-all' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
);
GlassCard.displayName = 'GlassCard';

export default GlassCard;
