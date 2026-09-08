import { AlertTriangle, ExternalLink, FileText } from 'lucide-react';

/**
 * 事実の出典チップ — 実行カーネル UX の席
 * （docs/architecture-execution-kernel.md §5）。未配線の描画専用部品。
 *
 * AI の出力が何に基づいたかをチップで示す。出典が空のときは
 * 「根拠なし」を隠さず警告する（無根拠の断定を成果物に混ぜない）。
 */
export interface FactSource {
  label: string;
  url?: string;
}

export function SourceChips({ sources }: { sources: FactSource[] }) {
  if (sources.length === 0) {
    return (
      <p className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-micro font-semibold text-warning">
        <AlertTriangle size={11} aria-hidden="true" />
        データに根拠がありません — 内容を確認してから使ってください
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="出典">
      {sources.map((s) => (
        <li key={s.label}>
          {s.url ? (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-sunken px-2.5 py-1 text-micro font-medium text-secondary transition-colors duration-fast hover:border-accent hover:text-accent"
            >
              <FileText size={10} aria-hidden="true" />
              {s.label}
              <ExternalLink size={9} aria-hidden="true" />
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-sunken px-2.5 py-1 text-micro font-medium text-secondary">
              <FileText size={10} aria-hidden="true" />
              {s.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
