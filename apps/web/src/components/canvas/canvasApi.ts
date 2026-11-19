import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { defaultCanvasLayout, type CanvasLayout } from '@org-ai/shared-types';
import { api } from '../../services/api';
import type { BusinessRow, CanvasFlowSummary } from './canvasToList';

/**
 * ホームキャンバスの API（gateway `routes/canvas.ts` `routes/flows.ts`）。
 * ⚠️ zod の値も `@xyflow/react` も import しない（スマホと初回ロードに載る）。検証の正本は gateway。
 */

export interface CanvasData {
  layout: CanvasLayout;
  /** 楽観ロックの版。行が無い組織は 0（既定の配置） */
  version: number;
  isDefault: boolean;
  flows: CanvasFlowSummary[];
}

export const CANVAS_QUERY_KEY = ['canvas'] as const;

/** 読み込み前・失敗時に描く既定の配置（行が無い組織と同じもの。保存はしない） */
export function fallbackCanvas(): CanvasData {
  return { layout: defaultCanvasLayout(), version: 0, isDefault: true, flows: [] };
}

export function useCanvas() {
  return useQuery<CanvasData>({
    queryKey: CANVAS_QUERY_KEY,
    queryFn: async () => (await api.get('/canvas')).data.data as CanvasData,
    staleTime: 30_000,
  });
}

/** 利用者向けのエラー文（gateway の message は利用者向けの日本語）。code も返す */
export function apiErrorOf(e: unknown, fallback: string): { code: string | null; message: string } {
  if (isAxiosError(e)) {
    const body = e.response?.data as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    const message = typeof body?.error?.message === 'string' && body.error.message ? body.error.message : fallback;
    return { code, message };
  }
  return { code: null, message: fallback };
}

export async function saveCanvasLayout(layout: CanvasLayout, baseVersion: number): Promise<{ version: number }> {
  const res = await api.put('/canvas', { layout, baseVersion });
  return res.data.data as { version: number };
}

export interface OpenError {
  nodeId: string;
  code: string | null;
  message: string;
}

/**
 * ノードを押したとき（§3.3）。
 * - フロー → `/flows/:id`、画面 → その画面
 * - 未作成（テンプレート）→ ADMIN 以上なら `POST /api/flows/from-template` で作って開く（確認なし・LLM を呼ばない）
 * - フロー数の上限（403 FLOW_LIMIT_REACHED）は作らずに 1 行を出す（ADMIN 以上にはプランへの導線）
 */
export function useOpenCanvasNode() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<OpenError | null>(null);
  /** 二重押しの印。state は古いクロージャから見えないので ref で持つ */
  const inFlight = useRef(false);

  const open = useCallback(
    async (row: Pick<BusinessRow, 'id' | 'target'>, canCreate: boolean) => {
      setError(null);
      const t = row.target;
      if (t.kind === 'flow') return navigate(`/flows/${encodeURIComponent(t.flowId)}`);
      if (t.kind === 'link') return navigate(t.to);
      if (t.kind === 'missing') return;
      if (!canCreate) {
        setError({ nodeId: row.id, code: null, message: 'まだ用意されていません' });
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setPendingId(row.id);
      try {
        const res = await api.post('/flows/from-template', { templateKey: t.templateKey, canvasNodeId: row.id });
        const flowId = (res.data.data as { flow: { id: string } }).flow.id;
        await qc.invalidateQueries({ queryKey: CANVAS_QUERY_KEY });
        navigate(`/flows/${encodeURIComponent(flowId)}`);
      } catch (e) {
        const err = apiErrorOf(e, '作成できませんでした。もう一度お試しください。');
        setError({ nodeId: row.id, ...err });
      } finally {
        inFlight.current = false;
        setPendingId(null);
      }
    },
    [navigate, qc],
  );

  return { open, pendingId, error, clearError: () => setError(null) };
}
