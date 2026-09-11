import { Activity, HardDrive } from 'lucide-react';
import type { OrganizationUsage } from '@org-ai/shared-types';
import { STORAGE_ADDON_UNIT_BYTES, STORAGE_WARN_RATIO, formatBytes } from '@org-ai/shared-types';
import { Card } from '../ui';

interface UsageCardProps {
  usage: OrganizationUsage;
  modelLabel: string;
}

type Tone = 'normal' | 'warn' | 'over';

/** 使用率のバー。警告域と上限到達で色を変える（意味色トークンのみ） */
function Meter({ ratio, tone }: { ratio: number; tone: Tone }) {
  const bar = tone === 'over' ? 'bg-danger' : tone === 'warn' ? 'bg-warning' : 'bg-accent';
  return (
    <div className="w-full h-2 rounded-full bg-sunken overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-base ${bar}`}
        style={{ width: `${Math.round(Math.min(ratio, 1) * 100)}%` }}
      />
    </div>
  );
}

const TONE_TEXT: Record<Tone, string> = { normal: 'text-muted', warn: 'text-warning', over: 'text-danger' };

export default function UsageCard({ usage, modelLabel }: UsageCardProps) {
  const { aiCallsThisMonth, planLimit, resetAt } = usage;
  const ratio = planLimit > 0 ? Math.min(aiCallsThisMonth / planLimit, 1) : 0;
  const percent = Math.round(ratio * 100);
  const overLimit = aiCallsThisMonth >= planLimit;
  const resetLabel = new Date(resetAt).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });

  // 容量を返さない古い API に当たっても画面を落とさない（デプロイ順がずれたとき）
  const storageUsed = usage.storageUsedBytes ?? 0;
  const storageQuota = usage.storageQuotaBytes ?? 0;
  const storageRatio = storageQuota > 0 ? storageUsed / storageQuota : 0;
  const storageTone: Tone = storageRatio >= 1 ? 'over' : storageRatio >= STORAGE_WARN_RATIO ? 'warn' : 'normal';
  const addonBytes = (usage.storageAddonUnits ?? 0) * STORAGE_ADDON_UNIT_BYTES;
  const storageNote =
    storageTone === 'over'
      ? '容量の上限に達しています。不要なファイルを削除すると、また保存できます。'
      : storageTone === 'warn'
        ? '残りが少なくなっています。不要なファイルの削除をおすすめします。'
        : addonBytes > 0
          ? `追加容量 ${formatBytes(addonBytes)} を含みます。`
          : 'プランに含まれる容量です。';

  return (
    <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-primary">今月の利用量</h3>
        <span className="ml-auto text-xs text-muted">{modelLabel}</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-primary tabular">
            <span className="font-semibold">{aiCallsThisMonth.toLocaleString()}</span>
            <span className="text-muted"> / {planLimit.toLocaleString()} コール</span>
          </span>
          <span className={`text-xs tabular ${overLimit ? 'text-danger' : 'text-muted'}`}>{percent}%</span>
        </div>
        <Meter ratio={ratio} tone={overLimit ? 'over' : 'normal'} />
        <p className="text-xs text-muted">{resetLabel} にリセットされます</p>
      </div>

      {storageQuota > 0 && (
        <div className="mt-5 pt-5 border-t border-hairline space-y-2">
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-accent" />
            <span className="text-xs font-semibold text-primary">保存容量</span>
            {usage.maxFileBytes ? (
              <span className="ml-auto text-xs text-muted">1ファイル {formatBytes(usage.maxFileBytes)} まで</span>
            ) : null}
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-primary tabular">
              <span className="font-semibold">{formatBytes(storageUsed)}</span>
              <span className="text-muted"> / {formatBytes(storageQuota)}</span>
            </span>
            <span className={`text-xs tabular ${TONE_TEXT[storageTone]}`}>
              {Math.round(Math.min(storageRatio, 1) * 100)}%
            </span>
          </div>
          <Meter ratio={storageRatio} tone={storageTone} />
          <p className={`text-xs ${TONE_TEXT[storageTone]}`}>{storageNote}</p>
        </div>
      )}
    </Card>
  );
}
