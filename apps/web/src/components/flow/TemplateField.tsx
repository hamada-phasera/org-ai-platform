import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { InsertCandidate } from './flowModel';

/**
 * 式を埋め込める文字の項目（§3.4「＋値を差し込む → 上流のノードの出力キーの一覧から選ぶと {{node.key}} が入る」）。
 * 手で式を書かせない（§6.4）。入れる位置はカーソルの位置。
 */

export const FIELD_CLASS =
  'w-full rounded-sm border border-border bg-elevated px-3 py-2 text-sm text-primary outline-none transition-colors duration-fast focus:border-accent';
export const SELECT_CLASS = 'h-9 w-full rounded-sm border border-border bg-elevated px-2.5 text-sm text-primary';

export function InsertMenu({
  candidates,
  onPick,
  onClose,
}: {
  candidates: InsertCandidate[];
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="差し込む値"
      className="absolute right-0 top-full z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-md border border-border bg-elevated py-1 shadow-elev-2"
    >
      {candidates.length === 0 ? (
        <p className="px-3 py-2 text-sm text-text-muted">前のノードがありません</p>
      ) : (
        candidates.map((c, i) => (
          <div key={c.node} className={i > 0 ? 'border-t border-border' : ''}>
            <p className="px-3 pb-0.5 pt-1.5 text-xs font-bold text-text-muted">{c.label}</p>
            {c.keys.map((k) => (
              <button
                key={k.ref}
                type="button"
                role="menuitem"
                onClick={() => onPick(k.ref)}
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-primary hover:bg-sunken focus:bg-sunken"
              >
                {k.title}
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export function TemplateField({
  id,
  label,
  value,
  onChange,
  candidates,
  multiline = false,
  max,
  rows = 4,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  candidates: InsertCandidate[];
  multiline?: boolean;
  max: number;
  rows?: number;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const insert = (ref: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${ref}${value.slice(end)}`;
    onChange(next.slice(0, max));
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = Math.min(start + ref.length, max);
      el?.setSelectionRange?.(pos, pos);
    });
  };

  return (
    <div className="relative">
      <div className="mb-1 flex items-center gap-2">
        <label htmlFor={id} className="text-xs font-bold text-text-muted">
          {label}
        </label>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-accent hover:text-accent-hover"
        >
          <Plus size={12} aria-hidden="true" />
          値を差し込む
        </button>
      </div>
      {multiline ? (
        <textarea
          ref={(el) => {
            input.current = el;
          }}
          id={id}
          rows={rows}
          maxLength={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD_CLASS} resize-y`}
        />
      ) : (
        <input
          ref={(el) => {
            input.current = el;
          }}
          id={id}
          maxLength={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={FIELD_CLASS}
        />
      )}
      {open && <InsertMenu candidates={candidates} onPick={insert} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 文字の項目（式なし） */
export function TextField({
  id,
  label,
  value,
  onChange,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-bold text-text-muted">
        {label}
      </label>
      <input id={id} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD_CLASS} />
    </div>
  );
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-bold text-text-muted">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={SELECT_CLASS}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
