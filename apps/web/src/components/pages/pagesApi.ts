/**
 * 業務ページ（docs/design/custom-pages.md §5.1・§7）の API の形と、ナビ用の一覧の取得。
 *
 * ⚠️ このファイルは初回ロード（サイドバー・メニュー）から読まれる。zod の値（スキーマ・buildInputSchema）を
 *    import しない。型だけなら載らない（設計書 K20・K21）。
 */
import { useQuery } from '@tanstack/react-query';
import type {
  PageActionUsage,
  PageIcon,
  PageStatus,
  ProjectedQueryResult,
  PublicPageDefinition,
} from '@org-ai/shared-types';
import { api } from '../../services/api';

export interface PageListItem {
  slug: string;
  title: string;
  icon: PageIcon | string;
  status: PageStatus | string;
}

export type PageConnection = 'ok' | 'not_configured' | 'sample';

export interface PageDetail {
  slug: string;
  title: string;
  icon: PageIcon | string;
  status: PageStatus | string;
  minRole: string;
  version: number;
  updatedAt: string;
  definition: PublicPageDefinition;
  connection: PageConnection;
  usage: PageActionUsage;
}

export type PageQueryData = ProjectedQueryResult & { sample: boolean };

export interface PageSubmitData {
  ok: boolean;
  message?: string;
  sample: boolean;
}

/** ナビと一覧で共有するキー（組織の切り替えでクエリキャッシュごと破棄される） */
export const PAGES_QUERY_KEY = ['pages'] as const;

export async function fetchPages(): Promise<PageListItem[]> {
  const res = await api.get<{ success: boolean; data: PageListItem[] }>('/pages');
  return Array.isArray(res.data.data) ? res.data.data : [];
}

/** ナビ用の一覧（サイドバー・メニュー・/p）。見えるものだけがサーバから返る（下書きは管理者以上だけ） */
export function usePagesList() {
  return useQuery<PageListItem[]>({
    queryKey: PAGES_QUERY_KEY,
    queryFn: fetchPages,
    staleTime: 60_000,
  });
}

/** axios の失敗から `{ success:false, error:{ code, message } }` を取り出す */
export function apiErrorOf(err: unknown): { status: number | null; code: string | null; message: string | null } {
  const res = (err as { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown } } } })
    ?.response;
  const code = res?.data?.error?.code;
  const message = res?.data?.error?.message;
  return {
    status: typeof res?.status === 'number' ? res.status : null,
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message : null,
  };
}
