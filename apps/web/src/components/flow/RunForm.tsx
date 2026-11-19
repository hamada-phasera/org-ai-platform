import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { PageField } from '@org-ai/shared-types';
import { Button, Input } from '../ui';

/**
 * 実行の入力（§3.4「きっかけがフォームなら入力のモーダル」・§4.3「全画面のシート・1 列・入力 16px 以上」）。
 * 既存のモーダル作法: role="dialog"・aria-modal・Escape・初期フォーカス・フォーカス復帰。
 * 検証の正本は gateway（buildFlowRunInputSchema）。ここは必須の空だけ先に知らせ、400 の issues を項目に出す。
 * ⚠️ zod の値を import しない（スマホで開く）。
 */

type Raw = Record<string, string | boolean>;

function initialValues(fields: readonly PageField[]): Raw {
  const v: Raw = {};
  for (const f of fields) v[f.key] = f.type === 'checkbox' ? false : '';
  return v;
}

/** 画面の値 → 送る値（業務ページのフォームと同じ: 数値の空は送らない、数値にならない文字はそのまま＝gateway が断る） */
export function toRunInput(fields: readonly PageField[], raw: Raw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (f.type === 'checkbox') out[f.key] = v === true;
    else if (f.type === 'number') {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s !== '') out[f.key] = Number.isFinite(Number(s)) ? Number(s) : s;
    } else {
      const s = typeof v === 'string' ? v : '';
      if (s !== '' || f.required) out[f.key] = s;
    }
  }
  return out;
}

export function missingRequired(fields: readonly PageField[], raw: Raw): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (f.required && (v === false || (typeof v === 'string' && v.trim() === ''))) errors[f.key] = '必須です';
  }
  return errors;
}

const NATIVE = 'w-full rounded-sm border border-border bg-elevated px-4 py-2.5 text-sm text-primary max-lg:min-h-11 max-lg:text-base';

export function RunForm({
  title,
  fields,
  busy,
  serverErrors,
  message,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: readonly PageField[];
  busy: boolean;
  /** gateway の 400（項目ごと） */
  serverErrors: Record<string, string>;
  /** 全体の 1 行（上限・未接続など） */
  message: string | null;
  onSubmit: (input: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Raw>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button[type="submit"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  const set = (key: string, v: string | boolean) => setValues((prev) => ({ ...prev, [key]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = missingRequired(fields, values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(toRunInput(fields, values));
  };
  const allErrors = { ...serverErrors, ...errors };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay lg:items-center lg:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-dvh w-full flex-col overflow-y-auto bg-elevated pb-[env(safe-area-inset-bottom)] max-lg:h-dvh lg:max-h-[85vh] lg:max-w-lg lg:rounded-panel lg:border lg:border-border lg:shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-body font-bold text-primary">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="閉じる" className="flex h-11 w-11 items-center justify-center text-secondary hover:text-primary lg:h-8 lg:w-8">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={submit} noValidate className="flex flex-1 flex-col gap-4 px-5 py-4">
          {fields.map((f) => {
            const id = `run-${f.key}`;
            const err = allErrors[f.key];
            const common = {
              id,
              name: f.key,
              'aria-invalid': err ? true : undefined,
              'aria-required': f.required ? true : undefined,
              'aria-describedby': err ? `${id}-error` : undefined,
            } as const;
            const v = values[f.key];
            let control;
            if (f.type === 'checkbox') {
              control = <input {...common} type="checkbox" className="h-5 w-5 accent-[var(--action)]" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />;
            } else if (f.type === 'select') {
              control = (
                <select {...common} className={NATIVE} value={String(v)} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              );
            } else if (f.type === 'textarea') {
              control = <Input {...common} multiline rows={4} maxLength={f.maxLength ?? 2000} error={!!err} value={String(v)} onChange={(e) => set(f.key, e.target.value)} />;
            } else {
              control = (
                <Input
                  {...common}
                  type={f.type === 'number' ? 'text' : f.type}
                  inputMode={f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : undefined}
                  autoComplete="off"
                  maxLength={f.type === 'number' || f.type === 'date' ? undefined : (f.maxLength ?? 200)}
                  error={!!err}
                  value={String(v)}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              );
            }
            return (
              <div key={f.key}>
                {f.type === 'checkbox' ? (
                  <div className="flex min-h-11 items-center gap-3">
                    {control}
                    <label htmlFor={id} className="text-sm font-semibold text-primary">
                      {f.label}
                    </label>
                  </div>
                ) : (
                  <>
                    <label htmlFor={id} className="mb-1 block text-sm font-semibold text-primary">
                      {f.label}
                      {f.required && <span className="ml-1 text-xs text-text-muted">必須</span>}
                    </label>
                    {control}
                  </>
                )}
                {err && (
                  <p id={`${id}-error`} className="mt-1 text-xs text-danger">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
          <div aria-live="polite" className="min-h-5 text-sm text-danger">
            {message}
          </div>
          <div className="mt-auto flex justify-end gap-2 max-lg:flex-col-reverse">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              やめる
            </Button>
            <Button type="submit" loading={busy}>
              実行
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** gateway の 400（`issues: { path: [key], message }`）を項目ごとに */
export function fieldErrorsOf(issues: readonly { path: (string | number)[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = String(i.path[0] ?? '');
    if (key && !out[key]) out[key] = i.message;
  }
  return out;
}
