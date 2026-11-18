import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '../ui';

/**
 * 送信前の確認（定義の `confirm`）。既存のモーダル作法: role="dialog"・aria-modal・Escape・初期フォーカス・フォーカス復帰。
 * 初期フォーカスは「やめる」（外への送信を Enter 一発で起こさない）。
 * - 開いている間に親が再描画されても（onCancel が作り直されても）フォーカスを動かさない: effect は開いたとき 1 回だけ（L1）。
 * - Tab / Shift+Tab は 2 つのボタンの間で回し、背後のフォームに抜けさせない。
 * - 影は付けない（§7.3。枠線と背景の暗さで区切る）。
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
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-elevated p-5"
      >
        <h2 id={titleId} className="text-sm font-bold text-primary">
          {message}
        </h2>
        <div className="flex justify-end gap-2 max-lg:flex-col-reverse">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
            やめる
          </Button>
          <Button ref={confirmRef} type="button" onClick={onConfirm}>
            実行
          </Button>
        </div>
      </div>
    </div>
  );
}
