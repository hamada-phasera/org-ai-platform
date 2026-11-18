import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, X } from 'lucide-react';
import { PAGE_LIMITS, hasRoleAtLeast, type PageActionUsage, type Plan } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { Badge, Button, Input, SkeletonList } from '../ui';
import { ConfirmDialog } from '../pages/ConfirmDialog';
import { PAGES_QUERY_KEY, apiErrorOf } from '../pages/pagesApi';

/**
 * 設定 > 業務ページ（docs/design/custom-pages.md §7.4）。管理者以上。
 *
 * - ページ一覧: 公開/非公開・並び替え・削除。定義の編集はしない（構築は n8n。K18）
 * - 利用状況: ページ数と今月の実行数（上限はプランごと。§6）
 * - 接続: n8n の有無と、Webhook のパスに書く組織 ID
 * - 登録トークン: オーナーのみ・パソコンのみ（長い値の扱いはパソコン。DESIGN.md §4）。生値は発行直後に 1 回だけ
 *
 * 見た目は白い面に区切り線と表だけ（カードで包まない）。
 */

export interface AdminPageRow {
  slug: string;
  title: string;
  icon: string;
  status: string;
  minRole: string;
  sortOrder: number;
  version: number;
  source: string;
  updatedAt: string;
}

export interface PagesAdminData {
  pages: AdminPageRow[];
  pageCount: number;
  plan: string;
  usage: PageActionUsage;
  orgId: string;
  connection: 'ok' | 'not_configured';
}

export interface PageTokenRow {
  id: string;
  label: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface IssuedToken extends PageTokenRow {
  token: string;
  registerUrlBase: string;
}

export const PAGES_ADMIN_KEY = ['pages-admin'] as const;
export const PAGE_TOKENS_KEY = ['page-tokens'] as const;
/** 有効な登録トークンの上限（gateway の MAX_ACTIVE_PAGE_TOKENS と同じ値） */
const MAX_ACTIVE_TOKENS = 2;

const SOURCE_LABEL: Record<string, string> = { N8N: 'n8n', MANUAL: '手動', SEED: 'サンプル' };

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ja-JP') : '—');
const fmtNum = (n: number) => n.toLocaleString('ja-JP');

function errorText(err: unknown, fallback: string): string {
  return apiErrorOf(err).message ?? fallback;
}

type Confirming = { message: string; run: () => void } | null;

/**
 * 並び替えで割り当てる番号。見えている行が今持っている番号の集合を小さい順に並べ、同じ番号が続くところだけ +1 ずつ押し出す。
 * 管理者に見えないページ（オーナー限定。K28）の番号には触れないので、オーナーのナビの並びが作成日時で決まり直すことがない（レビュー L4）。
 */
export function reorderSlots(current: readonly number[]): number[] {
  const sorted = [...current].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! <= sorted[i - 1]!) sorted[i] = sorted[i - 1]! + 1;
  }
  return sorted;
}

export function PagesSection() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const isOwner = hasRoleAtLeast(role, 'OWNER');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const adminQ = useQuery<PagesAdminData>({
    queryKey: PAGES_ADMIN_KEY,
    queryFn: async () => (await api.get<{ success: boolean; data: PagesAdminData }>('/pages/admin/list')).data.data,
  });

  const refreshPages = () => {
    void qc.invalidateQueries({ queryKey: PAGES_ADMIN_KEY });
    // サイドバー・メニューの並びも取り直す
    void qc.invalidateQueries({ queryKey: PAGES_QUERY_KEY });
  };

  const patchMut = useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: { status?: string; sortOrder?: number } }) =>
      api.patch(`/pages/${encodeURIComponent(slug)}`, body),
    onSuccess: () => setError(null),
    onError: (err) => setError(errorText(err, '変更できませんでした')),
    onSettled: refreshPages,
  });

  const deleteMut = useMutation({
    mutationFn: (slug: string) => api.delete(`/pages/${encodeURIComponent(slug)}`),
    onSuccess: () => setError(null),
    onError: (err) => setError(errorText(err, '削除できませんでした')),
    onSettled: refreshPages,
  });

  const reorderMut = useMutation({
    /** 入れ替えた後の並びに、見えている行が今持っている番号を割り当て直す。番号がずれた行だけ書く（reorderSlots） */
    mutationFn: async (next: AdminPageRow[]) => {
      const slots = reorderSlots(next.map((p) => p.sortOrder));
      for (const [index, page] of next.entries()) {
        if (page.sortOrder !== slots[index]) {
          await api.patch(`/pages/${encodeURIComponent(page.slug)}`, { sortOrder: slots[index] });
        }
      }
    },
    onSuccess: () => setError(null),
    onError: (err) => setError(errorText(err, '並び替えできませんでした')),
    onSettled: refreshPages,
  });

  const data = adminQ.data;
  const pages = data?.pages ?? [];
  const busy = patchMut.isPending || deleteMut.isPending || reorderMut.isPending;

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= pages.length) return;
    const next = [...pages];
    [next[index], next[to]] = [next[to], next[index]];
    reorderMut.mutate(next);
  };

  const togglePublish = (p: AdminPageRow) =>
    patchMut.mutate({ slug: p.slug, body: { status: p.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED' } });

  const askDelete = (p: AdminPageRow) =>
    setConfirming({ message: `「${p.title}」を削除しますか`, run: () => deleteMut.mutate(p.slug) });

  if (adminQ.isLoading) return <SkeletonList count={3} />;
  if (adminQ.isError || !data) {
    return (
      <p role="alert" className="text-sm text-muted">
        読み込めませんでした
      </p>
    );
  }

  return (
    <div className="divide-y divide-border bg-elevated">
      {/* ── ページ ── */}
      <section aria-labelledby="pages-list-heading" className="space-y-3 pb-6">
        <h2 id="pages-list-heading" className="text-sm font-semibold text-primary">
          ページ
        </h2>

        {pages.length === 0 ? (
          <p className="border-t border-border py-3 text-sm text-muted">まだありません</p>
        ) : (
          <>
            {/* パソコン: 表 */}
            <table className="hidden w-full text-sm lg:table">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">タイトル</th>
                  <th scope="col" className="py-2 pr-3 font-medium">状態</th>
                  <th scope="col" className="py-2 pr-3 font-medium">版</th>
                  <th scope="col" className="py-2 pr-3 font-medium">作成元</th>
                  <th scope="col" className="py-2 pr-3 font-medium">更新日</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {pages.map((p, i) => (
                  <tr key={p.slug} data-testid={`page-row-${p.slug}`}>
                    <td className="py-2.5 pr-3">
                      <Link to={`/p/${encodeURIComponent(p.slug)}`} className="text-primary hover:text-accent">
                        {p.title}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge size="xs">{p.status === 'PUBLISHED' ? '公開' : '下書き'}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-secondary">{p.version}</td>
                    <td className="py-2.5 pr-3 text-xs text-secondary">{SOURCE_LABEL[p.source] ?? p.source}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-secondary">{fmtDate(p.updatedAt)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => togglePublish(p)}>
                          {p.status === 'PUBLISHED' ? '非公開' : '公開'}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`${p.title} を上へ`}
                          icon={<ArrowUp size={12} aria-hidden="true" />}
                          disabled={busy || i === 0}
                          onClick={() => move(i, -1)}
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`${p.title} を下へ`}
                          icon={<ArrowDown size={12} aria-hidden="true" />}
                          disabled={busy || i === pages.length - 1}
                          onClick={() => move(i, 1)}
                        />
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => askDelete(p)}>
                          削除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* スマホ: 縦積みの行。操作は公開/非公開だけ */}
            <ul className="divide-y divide-hairline border-t border-border lg:hidden">
              {pages.map((p) => (
                <li key={p.slug} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-primary">{p.title}</span>
                  <Badge size="xs">{p.status === 'PUBLISHED' ? '公開' : '下書き'}</Badge>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => togglePublish(p)}>
                    {p.status === 'PUBLISHED' ? '非公開' : '公開'}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </section>

      <UsageRows data={data} />

      {/* ── 接続 ── */}
      <section aria-labelledby="pages-conn-heading" className="space-y-3 py-6">
        <h2 id="pages-conn-heading" className="text-sm font-semibold text-primary">
          接続
        </h2>
        <dl className="divide-y divide-hairline border-t border-border text-sm">
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-secondary">n8n</dt>
            <dd className={data.connection === 'ok' ? 'text-primary' : 'text-warning'}>
              {data.connection === 'ok' ? '接続済み' : '未接続'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-secondary">組織ID</dt>
            <dd className="min-w-0 break-all font-mono text-xs text-primary">{data.orgId}</dd>
          </div>
        </dl>
      </section>

      {isOwner && <TokensSection onConfirm={setConfirming} />}

      {confirming && (
        <ConfirmDialog
          message={confirming.message}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            confirming.run();
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

function UsageRows({ data }: { data: PagesAdminData }) {
  const maxPages = (PAGE_LIMITS[data.plan as Plan] ?? PAGE_LIMITS.STARTER).maxPages;
  const pagesFull = data.pageCount >= maxPages;
  const usage = data.usage;
  const tone = (state: string) => (state === 'over' ? 'text-danger' : state === 'warn' ? 'text-warning' : 'text-primary');

  return (
    <section aria-labelledby="pages-usage-heading" className="space-y-3 py-6">
      <h2 id="pages-usage-heading" className="text-sm font-semibold text-primary">
        利用状況
      </h2>
      <dl className="divide-y divide-hairline border-t border-border text-sm">
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-secondary">ページ</dt>
          <dd className={`font-mono ${pagesFull ? 'text-warning' : 'text-primary'}`} data-testid="pages-count">
            {fmtNum(data.pageCount)} / {fmtNum(maxPages)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-secondary">今月の実行</dt>
          <dd className={`font-mono ${tone(usage.state)}`} data-testid="pages-usage">
            {fmtNum(usage.used)} / {fmtNum(usage.limit)}
          </dd>
        </div>
      </dl>
      {(pagesFull || usage.state !== 'ok') && (
        <p className="text-xs text-secondary">
          {usage.blocked ? '送信は来月 1 日（日本時間 9 時）まで止まります' : pagesFull ? 'ページは上限です' : '実行が上限の 8 割を超えました'}{' '}
          <Link to="/settings?tab=billing" className="font-semibold text-accent underline">
            プラン
          </Link>
        </p>
      )}
    </section>
  );
}

function TokensSection({ onConfirm }: { onConfirm: (c: Confirming) => void }) {
  const qc = useQueryClient();
  const labelId = useId();
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokensQ = useQuery<PageTokenRow[]>({
    queryKey: PAGE_TOKENS_KEY,
    queryFn: async () => (await api.get<{ success: boolean; data: PageTokenRow[] }>('/pages/tokens')).data.data,
  });

  const issueMut = useMutation({
    mutationFn: async (name: string) =>
      (await api.post<{ success: boolean; data: IssuedToken }>('/pages/tokens', { label: name })).data.data,
    onSuccess: (row) => {
      setIssued(row);
      setLabel('');
      setError(null);
    },
    onError: (err) => setError(errorText(err, '発行できませんでした')),
    onSettled: () => void qc.invalidateQueries({ queryKey: PAGE_TOKENS_KEY }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/pages/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => setError(null),
    onError: (err) => setError(errorText(err, '失効できませんでした')),
    onSettled: () => void qc.invalidateQueries({ queryKey: PAGE_TOKENS_KEY }),
  });

  const tokens = tokensQ.data ?? [];
  const active = tokens.filter((t) => !t.revokedAt).length;
  const canIssue = active < MAX_ACTIVE_TOKENS;

  return (
    <section aria-labelledby="pages-token-heading" className="space-y-3 pt-6">
      <h2 id="pages-token-heading" className="text-sm font-semibold text-primary">
        トークン
      </h2>
      <p className="text-xs text-muted lg:hidden">パソコンで開いてください</p>

      <div className="hidden space-y-3 lg:block" data-testid="token-desktop">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = label.trim();
            if (name && canIssue) issueMut.mutate(name);
          }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor={labelId} className="mb-1 block text-xs text-secondary">
              名前
            </label>
            <Input id={labelId} size="sm" maxLength={24} placeholder="n8n 本番" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <Button type="submit" size="sm" loading={issueMut.isPending} disabled={!label.trim() || !canIssue}>
            発行
          </Button>
        </form>
        {!canIssue && <p className="text-xs text-secondary">有効なトークンは {MAX_ACTIVE_TOKENS} 本までです</p>}

        {issued && (
          <IssuedTokenRows
            issued={issued}
            onClose={() => {
              setIssued(null);
              // 生トークンはミューテーションの状態にも残っている。閉じたらそこからも消す（「閉じたら二度と出ない」。L5）
              issueMut.reset();
            }}
          />
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {tokens.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">名前</th>
                <th scope="col" className="py-2 pr-3 font-medium">先頭</th>
                <th scope="col" className="py-2 pr-3 font-medium">最終使用</th>
                <th scope="col" className="py-2 pr-3 font-medium">状態</th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td className="py-2.5 pr-3 text-primary">{t.label}</td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-secondary">{t.prefix}…</td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-secondary">{fmtDate(t.lastUsedAt)}</td>
                  <td className="py-2.5 pr-3">
                    <Badge size="xs">{t.revokedAt ? '失効' : '有効'}</Badge>
                  </td>
                  <td className="py-2.5 text-right">
                    {!t.revokedAt && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={revokeMut.isPending}
                        onClick={() =>
                          onConfirm({ message: `「${t.label}」を失効しますか`, run: () => revokeMut.mutate(t.id) })
                        }
                      >
                        失効
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** 発行直後だけの表示。閉じたら二度と出ない（サーバはハッシュしか持っていない） */
function IssuedTokenRows({ issued, onClose }: { issued: IssuedToken; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const registerUrl = `${issued.registerUrlBase}/<slug>`;
  return (
    <div className="space-y-2 border-y border-border py-3" aria-live="polite">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs font-semibold text-primary">閉じると二度と表示できません</p>
        <Button size="xs" variant="ghost" aria-label="閉じる" icon={<X size={12} aria-hidden="true" />} onClick={onClose} />
      </div>
      <dl className="divide-y divide-hairline text-sm">
        <div className="flex items-center gap-3 py-2">
          <dt className="w-20 shrink-0 text-xs text-secondary">トークン</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-xs text-primary" data-testid="issued-token">
            {issued.token}
          </dd>
          <Button
            size="xs"
            variant="secondary"
            icon={<Copy size={12} aria-hidden="true" />}
            onClick={() => {
              void navigator.clipboard?.writeText(issued.token).then(() => setCopied(true));
            }}
          >
            {copied ? '済み' : 'コピー'}
          </Button>
        </div>
        <div className="flex items-center gap-3 py-2">
          <dt className="w-20 shrink-0 text-xs text-secondary">登録先</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-xs text-primary">{registerUrl}</dd>
        </div>
      </dl>
    </div>
  );
}
