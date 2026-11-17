import { Link } from 'react-router-dom';
import { LEGAL_DOCS } from './content';

/** 法務 3 頁へのリンク（登録・ログイン・契約の画面の下）。ラベルは一語 */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="規約" className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs ${className}`}>
      {LEGAL_DOCS.map((d) => (
        <Link key={d.path} to={d.path} className="inline-flex items-center text-muted hover:text-primary hover:underline max-lg:min-h-11">
          {d.short}
        </Link>
      ))}
    </nav>
  );
}
