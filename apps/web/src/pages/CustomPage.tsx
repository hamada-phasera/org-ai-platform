import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { hasRoleAtLeast } from '@org-ai/shared-types';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { Badge, Button, PageHeader, Skeleton } from '../components/ui';
import { BlockRenderer, isKnownBlock } from '../components/pages/BlockRenderer';
import { PageCtx, queryActionIdsOf, usePageData, type PageContextValue } from '../components/pages/PageContext';
import { apiErrorOf, type PageDetail } from '../components/pages/pagesApi';

/**
 * 組織ごとの業務ページ `/p/:slug`（docs/design/custom-pages.md §7）。
 * 白い面 1 枚。ブロックはカードで包まず、間は余白と区切り線だけ。
 */
export default function CustomPage() {
  const { slug = '' } = useParams();
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = hasRoleAtLeast(role, 'ADMIN');

  const q = useQuery<PageDetail>({
    queryKey: ['page', slug],
    queryFn: async () =>
      (await api.get<{ success: boolean; data: PageDetail }>(`/pages/${encodeURIComponent(slug)}`)).data.data,
    retry: false,
    enabled: slug !== '',
  });

  if (q.isError) {
    const { status } = apiErrorOf(q.error);
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <p className="text-sm text-muted">{status === 404 ? 'ページが見つかりません' : '開けませんでした'}</p>
        <Link to="/p" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
          一覧
        </Link>
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-3 px-4 py-6 sm:px-6" aria-busy="true">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  return <PageView page={q.data} isAdmin={isAdmin} />;
}

export function PageView({ page, isAdmin }: { page: PageDetail; isAdmin: boolean }) {
  const qc = useQueryClient();
  const actionIds = queryActionIdsOf(page.definition);
  const data = usePageData(page.slug, actionIds, page.connection !== 'not_configured');
  const ctx: PageContextValue = {
    slug: page.slug,
    definition: page.definition,
    isAdmin,
    connection: page.connection,
    data,
  };
  const refreshing = Object.values(data).some((d) => d.isFetching);
  const blocks = page.definition.blocks.map((block, index) => ({ block, index })).filter(({ block }) => isKnownBlock(block));
  const usage = page.usage;

  return (
    <PageCtx.Provider value={ctx}>
      <div className="min-h-full bg-elevated">
      <div className="mx-auto max-w-5xl px-4 pb-10 pt-6 sm:px-6">
        <PageHeader
          title={page.title}
          actions={
            <>
              {page.connection === 'sample' && <Badge size="xs">サンプル</Badge>}
              {page.status !== 'PUBLISHED' && <Badge size="xs">下書き</Badge>}
              {actionIds.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw size={13} aria-hidden="true" />}
                  loading={refreshing}
                  onClick={() => {
                    void qc.invalidateQueries({ queryKey: ['page-data', page.slug] });
                    void qc.invalidateQueries({ queryKey: ['page', page.slug] });
                  }}
                >
                  更新
                </Button>
              )}
            </>
          }
        />

        {isAdmin && usage && usage.state !== 'ok' && (
          <p className={`mb-5 text-sm ${usage.state === 'over' ? 'text-danger' : 'text-secondary'}`}>
            今月の実行 <span className="tabular font-mono">{usage.used.toLocaleString('ja-JP')} / {usage.limit.toLocaleString('ja-JP')}</span>
            {usage.state === 'over' ? '（送信は来月 1 日まで止まります）' : ''}{' '}
            <Link to="/settings?tab=billing" className="font-semibold text-accent underline">
              プラン
            </Link>
          </p>
        )}

        <div className="divide-y divide-border">
          {blocks.map(({ block, index }) => (
            <section key={index} className="py-6 first:pt-0">
              <BlockRenderer block={block} index={index} />
            </section>
          ))}
        </div>
      </div>
      </div>
    </PageCtx.Provider>
  );
}
