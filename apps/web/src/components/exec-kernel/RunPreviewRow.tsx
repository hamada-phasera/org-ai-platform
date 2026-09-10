import { Play, X } from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * 実行前プレビュー行 — 実行カーネル UX の席（docs/architecture-execution-kernel.md §5）。
 *
 * 承認制の要は「送る内容を人が読めること」。値は呼び出し側で切り詰めず、
 * そのまま渡してよい（長い値・改行入りの値はここで折り返して表示する）。
 * ChatPage の成果物確認と InboxPage のエージェント承認の両方から使う。
 */
export interface RunPreview {
  /** 実行しようとしている capability の表示名（例: 「Google ドキュメント作成」） */
  capabilityLabel: string;
  /** 解決済み引数の要約行（キー: 値）。長い値はそのまま渡す（この部品が折り返す） */
  args: Array<{ key: string; value: string }>;
}

/** 1行に収まらない値の判定。改行入り or 長文は折り返し表示に切り替える */
const NEEDS_WRAP = 48;

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
      <dl className="space-y-1.5 mb-3">
        {preview.args.map((a) => {
          /* 送信前に人が読めることが承認の前提。truncate すると読めないので、
             長い値・改行入りの値は折り返して出し、最大高さ＋スクロールでカード肥大を防ぐ */
          const wrap = a.value.includes('\n') || a.value.length > NEEDS_WRAP;
          return (
            <div key={a.key} className="flex gap-2 text-xs">
              <dt className="w-24 shrink-0 text-text-muted">{a.key}</dt>
              <dd
                className={
                  wrap
                    ? 'min-w-0 flex-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-secondary'
                    : 'min-w-0 flex-1 truncate text-secondary'
                }
              >
                {a.value}
              </dd>
            </div>
          );
        })}
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
