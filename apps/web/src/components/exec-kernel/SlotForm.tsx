import { useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/**
 * 不足スロットの聞き返しフォーム — 実行カーネル UX の席
 * （docs/architecture-execution-kernel.md §5）。未配線の描画専用部品。
 *
 * 実行に必要な引数が会話から埋まらなかったとき、自由文で再質問する
 * のではなく、不足分だけをフォームで確定させる。
 */
export interface MissingSlot {
  key: string;
  label: string;
  placeholder?: string;
  /** 複数行が要る長文スロット */
  multiline?: boolean;
}

export function SlotForm({
  title = 'あと少しだけ教えてください',
  slots,
  onSubmit,
  busy = false,
}: {
  title?: string;
  slots: MissingSlot[];
  onSubmit: (values: Record<string, string>) => void;
  busy?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const allFilled = slots.every((slot) => (values[slot.key] ?? '').trim().length > 0);

  return (
    <form
      className="rounded-lg border border-border bg-elevated shadow-elev-1 p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (allFilled) onSubmit(values);
      }}
    >
      <p className="text-xs font-bold text-primary mb-2.5">{title}</p>
      <div className="space-y-2.5 mb-3">
        {slots.map((slot) => (
          <div key={slot.key}>
            <label htmlFor={`slot-${slot.key}`} className="mb-1 block text-xs font-semibold text-secondary">
              {slot.label}
            </label>
            {slot.multiline ? (
              <Input
                multiline
                id={`slot-${slot.key}`}
                size="sm"
                rows={3}
                placeholder={slot.placeholder}
                value={values[slot.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [slot.key]: e.target.value }))}
              />
            ) : (
              <Input
                id={`slot-${slot.key}`}
                size="sm"
                placeholder={slot.placeholder}
                value={values[slot.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [slot.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <Button type="submit" size="sm" loading={busy} disabled={!allFilled}>
        これで実行
      </Button>
    </form>
  );
}
