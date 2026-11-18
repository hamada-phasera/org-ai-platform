import { Link } from 'react-router-dom';
import { Badge, PageHeader, Skeleton } from '../components/ui';
import { pageIconOf } from '../components/pages/icons';
import { usePagesList } from '../components/pages/pagesApi';

/** 業務ページの一覧（スマホのメニュー「業務」の行き先）。区切り線の行 */
export default function CustomPagesIndex() {
  const { data, isError } = usePagesList();
  return (
    <div className="min-h-full bg-elevated">
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-6 sm:px-6">
      <PageHeader title="業務" />
      {isError ? (
        <p className="text-sm text-muted">開けませんでした</p>
      ) : !data ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted">まだありません</p>
      ) : (
        <ul className="divide-y divide-hairline border-y border-border">
          {data.map((p) => {
            const Icon = pageIconOf(p.icon);
            return (
              <li key={p.slug}>
                <Link
                  to={`/p/${encodeURIComponent(p.slug)}`}
                  className="flex h-[52px] items-center gap-3 px-1 text-sm font-semibold text-primary"
                >
                  <Icon size={18} strokeWidth={2} aria-hidden="true" />
                  <span className="flex-1 truncate">{p.title}</span>
                  {p.status !== 'PUBLISHED' && <Badge size="xs">下書き</Badge>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
    </div>
  );
}
