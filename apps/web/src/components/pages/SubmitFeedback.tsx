import { Link } from 'react-router-dom';
import { usePageContext } from './PageContext';
import type { SubmitResult } from './useSubmit';

/**
 * 送信の結果を 1 行（aria-live）。上限（PAGE_ACTION_LIMIT）のときは管理者以上にだけプランへの導線
 * （メンバーには押しても何もできないリンクを出さない。PlanNotice と同じ扱い）。
 */
export function SubmitFeedback({ result }: { result: SubmitResult | null }) {
  const { isAdmin } = usePageContext();
  return (
    <p aria-live="polite" className={`min-h-5 text-sm ${result && !result.ok ? 'text-danger' : 'text-secondary'}`}>
      {result?.message}
      {result?.code === 'PAGE_ACTION_LIMIT' && isAdmin && (
        <>
          {' '}
          <Link to="/settings?tab=billing" className="font-semibold text-accent underline">
            プラン
          </Link>
        </>
      )}
    </p>
  );
}
