import { Activity } from 'lucide-react';
import type { OrganizationUsage } from '@org-ai/shared-types';
import { GlassCard } from '../ui';

interface UsageCardProps {
  usage: OrganizationUsage;
  modelLabel: string;
}

export default function UsageCard({ usage, modelLabel }: UsageCardProps) {
  const { aiCallsThisMonth, planLimit, resetAt } = usage;
  const ratio = planLimit > 0 ? Math.min(aiCallsThisMonth / planLimit, 1) : 0;
  const percent = Math.round(ratio * 100);
  const overLimit = aiCallsThisMonth >= planLimit;
  const resetLabel = new Date(resetAt).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });

  return (
    <GlassCard variant="thin" padding="lg" radius="2xl" className="mb-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-primary">今月の利用量</h3>
        <span className="ml-auto text-xs text-muted">{modelLabel}</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-primary">
            <span className="font-semibold">{aiCallsThisMonth.toLocaleString()}</span>
            <span className="text-muted"> / {planLimit.toLocaleString()} コール</span>
          </span>
          <span className={`text-xs ${overLimit ? 'text-danger' : 'text-muted'}`}>{percent}%</span>
        </div>
        <div className="w-full h-2 rounded-full bg-sunken/30 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-base ${overLimit ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs text-muted">{resetLabel} にリセットされます</p>
      </div>
    </GlassCard>
  );
}
