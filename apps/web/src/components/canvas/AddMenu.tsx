import { useEffect, useRef } from 'react';
import { PageIconGlyph } from './PageIconGlyph';
import type { AddMenuEntry, AddMenuSections } from './canvasEdit';

interface Props {
  sections: AddMenuSections;
  onPick: (entry: AddMenuEntry) => void;
  onClose: () => void;
}

const TITLES: { key: keyof AddMenuSections; title: string }[] = [
  { key: 'templates', title: 'テンプレート' },
  { key: 'flows', title: 'フロー' },
  { key: 'screens', title: '画面' },
];

/**
 * 追加メニュー（§3.2）。ポップオーバーに 3 区分の区切り線の一覧。各行は一語＋アイコン。
 * 既にキャンバスにある行き先は押せない（同じ行き先を 2 つ置かない）。Escape・外側の押下で閉じる。
 */
export function AddMenu({ sections, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="追加"
      className="absolute right-0 top-full z-20 mt-2 max-h-[420px] w-[240px] overflow-y-auto rounded-md border border-border bg-elevated py-1 shadow-elev-2"
    >
      {TITLES.filter((s) => sections[s.key].length > 0).map((s, i) => (
        <section key={s.key} className={i > 0 ? 'border-t border-border' : ''} aria-label={s.title}>
          <h3 className="px-3 pb-1 pt-2.5 text-micro font-bold text-text-muted">{s.title}</h3>
          <ul>
            {sections[s.key].map((entry) => {
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    disabled={entry.onCanvas}
                    onClick={() => onPick(entry)}
                    className="flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm font-semibold text-primary transition-colors duration-fast hover:bg-sunken disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent"
                  >
                    <PageIconGlyph name={entry.icon} size={15} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.onCanvas && <span className="shrink-0 text-micro text-text-muted">配置済み</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
