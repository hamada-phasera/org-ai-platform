import { Link } from 'react-router-dom';
import { Skeleton } from '../ui';
import type { BlockData } from './PageContext';
import { usePageContext } from './PageContext';

/** データ部の「読み込み・未接続・失敗・形違い」。ページの見出しと他のブロックは出したまま、ここだけ差し替える */
export function DataNotice({ data }: { data: Exclude<BlockData, { state: 'ok' }> }) {
  const { isAdmin } = usePageContext();
  switch (data.state) {
    case 'loading':
      return (
        <div className="space-y-2 py-2" aria-busy="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      );
    case 'not_connected':
      return (
        <p className="py-2 text-sm text-muted">
          未接続
          {isAdmin && (
            <>
              {'　'}
              <Link to="/settings?tab=pages" className="font-semibold text-accent underline">
                設定
              </Link>
            </>
          )}
        </p>
      );
    case 'failed':
      return (
        <p className="flex items-center gap-3 py-2 text-sm text-muted">
          取得できませんでした
          <button
            type="button"
            onClick={data.retry}
            className="font-semibold text-accent underline max-lg:min-h-11"
          >
            再試行
          </button>
        </p>
      );
    case 'invalid':
      return (
        <p className="py-2 text-sm text-muted">
          {isAdmin ? 'ワークフローの応答が定義と合いません' : '表示できません'}
        </p>
      );
  }
}
