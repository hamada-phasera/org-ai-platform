import { useEffect, useId, useRef } from 'react';
import { Button } from '../ui';

/**
 * 送信前の確認（定義の `confirm`）。既存のモーダル作法: role="dialog"・aria-modal・Escape・初期フォーカス・フォーカス復帰。
 * 初期フォーカスは「やめる」（外への送信を Enter 一発で起こさない）。
 */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-elevated p-5 shadow-lg"
      >
        <h2 id={titleId} className="text-sm font-bold text-primary">
          {message}
        </h2>
        <div className="flex justify-end gap-2 max-lg:flex-col-reverse">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
            やめる
          </Button>
          <Button type="button" onClick={onConfirm}>
            実行
          </Button>
        </div>
      </div>
    </div>
  );
}
