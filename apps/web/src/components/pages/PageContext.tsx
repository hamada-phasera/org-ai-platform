/**
 * 1 ページぶんの状態（定義・取得結果・送信）をブロックへ配る。
 * 同じ action を参照するブロックは 1 回の取得を共有する（queryKey ['page-data', slug, actionId]）。
 */
import { createContext, useContext } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectedBlock, PublicPageDefinition } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { apiErrorOf, type PageConnection, type PageQueryData } from './pagesApi';

export interface PageContextValue {
  slug: string;
  definition: PublicPageDefinition;
  isAdmin: boolean;
  connection: PageConnection;
  data: Record<string, UseQueryResult<PageQueryData>>;
}

export const PageCtx = createContext<PageContextValue | null>(null);

export function usePageContext(): PageContextValue {
  const ctx = useContext(PageCtx);
  if (!ctx) throw new Error('usePageContext は PageCtx の中で使う');
  return ctx;
}

/** ブロックが参照している query の action（定義の順、重複なし） */
export function queryActionIdsOf(def: PublicPageDefinition): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    // flow_query は業務フローの結果ページ（直近の実行の値と履歴。canvas-home.md §6.3）
    const kind = def.actions[id]?.kind;
    if ((kind === 'query' || kind === 'flow_query') && !ids.includes(id)) ids.push(id);
  };
  for (const block of def.blocks) {
    if (block.type === 'kpi') block.items.forEach((item) => add(item.source.action));
    else if (block.type === 'table' || block.type === 'list') add(block.source.action);
  }
  return ids;
}

export function pageDataKey(slug: string, actionId: string) {
  return ['page-data', slug, actionId] as const;
}

/** query をまとめて取る。未接続のページでは取りに行かない（503 になるだけなので） */
export function usePageData(
  slug: string,
  actionIds: string[],
  enabled: boolean,
): Record<string, UseQueryResult<PageQueryData>> {
  const results = useQueries({
    queries: actionIds.map((actionId) => ({
      queryKey: pageDataKey(slug, actionId),
      queryFn: async () => {
        const res = await api.get<{ success: boolean; data: PageQueryData }>(
          `/pages/${encodeURIComponent(slug)}/data/${encodeURIComponent(actionId)}`,
        );
        return res.data.data;
      },
      enabled,
      // 再試行は gateway が 1 回やる（接続エラーのとき）。ここで重ねると n8n を叩きすぎる
      retry: false,
      staleTime: 30_000,
    })),
  });
  const map: Record<string, UseQueryResult<PageQueryData>> = {};
  actionIds.forEach((id, i) => {
    map[id] = results[i] as UseQueryResult<PageQueryData>;
  });
  return map;
}

/** ブロック 1 つぶんのデータの状態 */
export type BlockData =
  | { state: 'loading' }
  | { state: 'not_connected' }
  | { state: 'failed'; retry: () => void }
  | { state: 'invalid' }
  | { state: 'ok'; block: Exclude<ProjectedBlock, { error: 'INVALID_RESPONSE' }> };

export function blockDataOf(ctx: PageContextValue, actionId: string, index: number): BlockData {
  if (ctx.connection === 'not_configured') return { state: 'not_connected' };
  const q = ctx.data[actionId];
  if (!q) return { state: 'invalid' };
  if (q.isError) {
    const { code } = apiErrorOf(q.error);
    if (code === 'PAGE_NOT_CONNECTED') return { state: 'not_connected' };
    return { state: 'failed', retry: () => void q.refetch() };
  }
  if (!q.data) return { state: 'loading' };
  const block = q.data.blocks.find((b) => b.index === index);
  if (!block || 'error' in block) return { state: 'invalid' };
  return { state: 'ok', block };
}
