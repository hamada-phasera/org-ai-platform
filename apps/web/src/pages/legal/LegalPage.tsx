import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { LegalLinks } from './LegalLinks';
import type { LegalDoc } from './content';

/**
 * 法務の静的な頁。認証の外（未ログインで開ける）。見出しと表だけ。
 * 未記入の項目は空欄にせず「未記入」と出す（埋め忘れを公開前に目で見つけられるように）。
 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  const signedIn = useAuthStore((s) => Boolean(s.token));

  useEffect(() => {
    const prev = document.title;
    document.title = `${doc.title} | FLOW`;
    return () => {
      document.title = prev;
    };
  }, [doc.title]);

  return (
    <div className="min-h-dvh bg-canvas">
      <main className="mx-auto w-full max-w-3xl px-5 py-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
        <header className="mb-8 flex items-center justify-between gap-4 border-b border-border pb-5">
          <h1 className="text-xl font-bold tracking-tight text-primary sm:text-2xl">{doc.title}</h1>
          <Link
            to={signedIn ? '/' : '/login'}
            className="flex min-h-11 items-center text-sm font-semibold text-accent hover:underline lg:min-h-0"
          >
            {signedIn ? 'ホーム' : 'ログイン'}
          </Link>
        </header>

        {doc.sections.map((section) => (
          <section key={section.heading} className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-primary">{section.heading}</h2>
            <table className="w-full border-t border-border text-sm">
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.label} className="border-b border-border align-top">
                    <th scope="row" className="w-2/5 py-3 pr-4 text-left font-medium text-secondary sm:w-1/3">
                      {row.label}
                    </th>
                    <td className="whitespace-pre-wrap py-3 text-primary">
                      {row.value ?? <span className="text-muted">未記入</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="text-xs text-muted">更新日 {doc.updatedAt ?? '未記入'}</p>
          <LegalLinks />
        </footer>
      </main>
    </div>
  );
}
