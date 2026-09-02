import { Play, X } from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * 実行前プレビュー行 — 実行カーネル UX の席（docs/architecture-execution-kernel.md §5）。
 *
 * P2（実行カーネル）実装時にチャット/タスク画面へ配線する。現時点では
 * どこからも使われていない**描画だけの部品**。ここに置いておくのは、
 * 後から画面を作り直さずに済ませるため。
 */
export interface RunPreview {
  /** 実行しようとしている capability の表示名（例: 「Google ドキュメント作成」） */
  capabilityLabel: string;
  /** 解決済み引数の要約行（キー: 値）。長い値は呼び出し側で切り詰める */
  args: Array<{ key: string; value: string }>;
}

export function RunPreviewRow({
  preview,
  onApprove,
  onCancel,
  busy = false,
}: {
  preview: RunPreview;
  onApprove: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={`実行プレビュー: ${preview.capabilityLabel}`}
      className="rounded-lg border border-border bg-elevated shadow-elev-1 p-3.5"
    >
      <p className="text-xs font-bold text-primary mb-2">
        この操作を実行します — {preview.capabilityLabel}
      </p>
      <dl className="space-y-1 mb-3">
        {preview.args.map((a) => (
          <div key={a.key} className="flex gap-2 text-xs">
            <dt className="w-24 shrink-0 text-text-muted">{a.key}</dt>
            <dd className="min-w-0 flex-1 truncate text-secondary">{a.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2">
        <Button size="sm" icon={<Play size={12} />} loading={busy} onClick={onApprove}>
          実行する
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={12} />} disabled={busy} onClick={onCancel}>
          やめる
        </Button>
      </div>
    </div>
  );
}
