import { useState, type FormEvent } from 'react';
import { buildInputSchema, type PageField } from '@org-ai/shared-types';
import { Button, Input } from '../../ui';
import { usePageContext } from '../PageContext';
import { useSubmit } from '../useSubmit';
import type { BlockProps } from './types';

type Raw = Record<string, string | boolean>;

function initialValues(fields: PageField[]): Raw {
  const v: Raw = {};
  for (const f of fields) v[f.key] = f.type === 'checkbox' ? false : '';
  return v;
}

/** 画面の値 → 送る値。数値の空は null、数値にならない文字はそのまま（zod が「数値を入れてください」） */
export function toInput(fields: PageField[], raw: Raw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (f.type === 'checkbox') out[f.key] = v === true;
    else if (f.type === 'number') {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s === '') out[f.key] = null;
      else out[f.key] = Number.isFinite(Number(s)) ? Number(s) : s;
    } else out[f.key] = typeof v === 'string' ? v : '';
  }
  return out;
}

/** 項目ごとの最初のエラー。必須の空は zod の英語の文言にせず「必須です」 */
export function validateForm(
  fields: PageField[],
  input: Record<string, unknown>,
  schema: ReturnType<typeof buildInputSchema>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = input[f.key];
    if (f.required && (v === null || v === '' || (typeof v === 'string' && v.trim() === '') || v === false)) {
      errors[f.key] = '必須です';
    }
  }
  if (!schema) return errors;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key && !errors[key]) errors[key] = issue.message;
    }
  }
  return errors;
}

const NATIVE = 'w-full rounded-sm border border-border bg-elevated px-4 py-2.5 text-sm text-primary max-lg:min-h-11 max-lg:text-base';

/** 1 列。ラベルは htmlFor で紐付け。送信は主ボタン 1 つ、結果は aria-live の 1 行 */
export function FormBlock({ block, index }: BlockProps<'form'>) {
  const { definition } = usePageContext();
  const submit = useSubmit();
  const [values, setValues] = useState<Raw>(() => initialValues(block.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idOf = (key: string) => `pf-${index}-${key}`;
  const set = (key: string, v: string | boolean) => setValues((prev) => ({ ...prev, [key]: v }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const input = toInput(block.fields, values);
    const errs = validateForm(block.fields, input, buildInputSchema(definition, block.action, { blockIndex: index }));
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    submit.trigger({
      actionId: block.action,
      input,
      origin: { blockIndex: index },
      onDone: (r) => {
        if (r.ok) setValues(initialValues(block.fields));
      },
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      {block.title && <h3 className="text-sm font-bold text-primary">{block.title}</h3>}
      {block.fields.map((f) => {
        const id = idOf(f.key);
        const err = errors[f.key];
        const describedBy = err ? `${id}-error` : undefined;
        const common = {
          id,
          name: f.key,
          'aria-invalid': err ? true : undefined,
          'aria-required': f.required ? true : undefined,
          'aria-describedby': describedBy,
        } as const;
        const v = values[f.key];
        let control;
        if (f.type === 'checkbox') {
          control = (
            <input
              {...common}
              type="checkbox"
              className="h-5 w-5 accent-[var(--action)]"
              checked={v === true}
              onChange={(e) => set(f.key, e.target.checked)}
            />
          );
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
          control = (
            <Input
              {...common}
              multiline
              rows={4}
              maxLength={f.maxLength ?? 200}
              error={!!err}
              value={String(v)}
              onChange={(e) => set(f.key, e.target.value)}
            />
          );
        } else {
          control = (
            <Input
              {...common}
              type={f.type === 'number' ? 'text' : f.type}
              inputMode={f.type === 'number' ? 'decimal' : f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : undefined}
              autoComplete={f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'off'}
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
                <label htmlFor={id} className="mb-1 block text-xs font-bold text-primary">
                  {f.label}
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
      <Button type="submit" loading={submit.busy} className="max-lg:w-full">
        {block.submit}
      </Button>
      {submit.feedback}
      {submit.dialog}
    </form>
  );
}
