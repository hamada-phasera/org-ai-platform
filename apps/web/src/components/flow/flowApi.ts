import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  isFlowRunFinal,
  type FlowDefinition,
  type FlowPartSpec,
  type FlowStepState,
  type UsageState,
} from '@org-ai/shared-types';
import { api } from '../../services/api';
import type { FlowIssueLike, FlowLayoutMap } from './flowModel';

/**
 * フロー画面の API（gateway `routes/flows.ts`）。
 * ⚠️ zod の値も `@xyflow/react` も import しない（スマホのステップリストが読む）。検証の正本は gateway。
 */

export interface FlowUsageInfo {
  flows: { count: number; limit: number };
  runs: { used: number; limit: number; state: UsageState; blocked: boolean };
  partCalls: { used: number; limit: number; state: UsageState; blocked: boolean };
}

export interface FlowDetail {
  id: string;
  slug: string;
  name: string;
  icon: string;
  enabled: boolean;
  minRole: string;
  templateKey: string | null;
  version: number;
  /** 古い形の行もありうる（valid: false）。描く前に normalizeDefinition を通す */
  definition: FlowDefinition;
  layout: FlowLayoutMap;
  valid: boolean;
  canEdit: boolean;
  usage: FlowUsageInfo;
  connection: { n8n: 'ok' | 'not_configured' };
}

export type PartConnection = 'ok' | 'not_configured' | 'needs_auth';

/** `GET /api/flows/parts` の 1 件。カタログの形＋プランで使えるか・接続状態（運営にだけ editorUrl） */
export interface PartInfo extends Omit<FlowPartSpec, 'via' | 'idempotent' | 'timeoutMs'> {
  via: 'n8n' | 'capability';
  allowed: boolean;
  connection: PartConnection;
  editorUrl?: string;
}

export interface FlowRunSummary {
  id: string;
  flowId: string;
  flowVersion: number;
  trigger: string;
  actorId: string | null;
  actorName?: string | null;
  status: string;
  error: { nodeId?: string; code?: string; message?: string } | null;
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface FlowRunDetail extends FlowRunSummary {
  input: Record<string, unknown> | null;
  steps: Record<string, FlowStepState> | null;
  output: Record<string, unknown> | null;
}

/** 実行ごとの UUID（二重実行を gateway の unique で止める。§7.2）。crypto.randomUUID が無ければ getRandomValues で v4 */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const flowKey = (id: string) => ['flow', id] as const;
export const flowRunsKey = (id: string) => ['flow-runs', id] as const;
export const FLOW_PARTS_KEY = ['flow-parts'] as const;

export function useFlow(id: string) {
  return useQuery<FlowDetail>({
    queryKey: flowKey(id),
    queryFn: async () => (await api.get(`/flows/${encodeURIComponent(id)}`)).data.data as FlowDetail,
    enabled: !!id,
    retry: false,
  });
}

export function useFlowParts() {
  return useQuery<PartInfo[]>({
    queryKey: FLOW_PARTS_KEY,
    queryFn: async () => ((await api.get('/flows/parts')).data.data as { parts: PartInfo[] }).parts,
    staleTime: 5 * 60_000,
  });
}

export function useFlowRuns(id: string, enabled = true) {
  return useQuery<FlowRunSummary[]>({
    queryKey: flowRunsKey(id),
    queryFn: async () => ((await api.get(`/flows/${encodeURIComponent(id)}/runs`)).data.data as { runs: FlowRunSummary[] }).runs,
    enabled: !!id && enabled,
  });
}

export async function fetchRun(runId: string): Promise<FlowRunDetail> {
  return (await api.get(`/flows/runs/${encodeURIComponent(runId)}`)).data.data as FlowRunDetail;
}

export interface ApiError {
  status: number | null;
  code: string | null;
  message: string;
  issues: FlowIssueLike[];
}

/** 利用者向けのエラー（gateway の message は利用者向けの日本語）。保存の検証エラーは issues（場所だけ・値なし。K48） */
export function apiErrorOf(e: unknown, fallback: string): ApiError {
  if (isAxiosError(e)) {
    const body = e.response?.data as { error?: { code?: unknown; message?: unknown; issues?: unknown } } | undefined;
    const raw = Array.isArray(body?.error?.issues) ? (body?.error?.issues as unknown[]) : [];
    const issues = raw
      .map((i) => i as { path?: unknown; message?: unknown })
      .filter((i) => Array.isArray(i.path) && typeof i.message === 'string')
      .map((i) => ({ path: (i.path as unknown[]).filter((p): p is string | number => typeof p === 'string' || typeof p === 'number'), message: i.message as string }));
    return {
      status: e.response?.status ?? null,
      code: typeof body?.error?.code === 'string' ? body.error.code : null,
      message: typeof body?.error?.message === 'string' && body.error.message ? body.error.message : fallback,
      issues,
    };
  }
  return { status: null, code: null, message: fallback, issues: [] };
}

export interface SaveFlowBody {
  definition: FlowDefinition;
  layout: FlowLayoutMap;
  name?: string;
  minRole?: string;
  baseVersion: number;
}

export async function saveFlow(id: string, body: SaveFlowBody): Promise<{ version: number; changed: boolean }> {
  return (await api.put(`/flows/${encodeURIComponent(id)}`, body)).data.data as { version: number; changed: boolean };
}

/** スマホの簡単な変更（名前・有効/無効・1 ノードの文字項目。§4.1・K46） */
export async function patchFlow(
  id: string,
  body: { enabled?: boolean; name?: string; node?: { id: string; label?: string; config?: Record<string, string> }; baseVersion?: number },
): Promise<{ version: number }> {
  return (await api.patch(`/flows/${encodeURIComponent(id)}`, body)).data.data as { version: number };
}

/** 終わった・承認待ちなら止まった扱い（もう待たない） */
export function runSettled(status: string | undefined): boolean {
  return !!status && (isFlowRunFinal(status) || status === 'WAITING_APPROVAL');
}

/** 取りに行く間隔: 2 秒おき、30 秒過ぎたら 5 秒おき（§7.2） */
export function pollDelayMs(elapsedMs: number): number {
  return elapsedMs < 30_000 ? 2_000 : 5_000;
}

/** 10 分で取りに行くのをやめる（履歴から開き直せる） */
const POLL_GIVE_UP_MS = 10 * 60_000;

/**
 * 実行と、その回の状態の取得。`start` は requestId を作って POST し、まだなら `GET /runs/:runId` を取りに行く。
 * `show` は履歴の 1 回を開く（その回のステップ結果をキャンバス・リストに重ねる）。
 */
export function useFlowRunner(flowId: string) {
  const qc = useQueryClient();
  const [run, setRun] = useState<FlowRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    token.current += 1;
  }, []);

  useEffect(() => stop, [stop]);

  const follow = useCallback(
    (runId: string, startedAt: number) => {
      const my = token.current;
      const tick = async () => {
        if (my !== token.current) return;
        try {
          const next = await fetchRun(runId);
          if (my !== token.current) return;
          setRun(next);
          if (runSettled(next.status)) {
            void qc.invalidateQueries({ queryKey: flowRunsKey(flowId) });
            return;
          }
        } catch {
          /* 一時的な失敗は次で取り直す */
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed > POLL_GIVE_UP_MS) return;
        timer.current = setTimeout(() => void tick(), pollDelayMs(elapsed));
      };
      timer.current = setTimeout(() => void tick(), pollDelayMs(0));
    },
    [flowId, qc],
  );

  const start = useCallback(
    async (input: Record<string, unknown>): Promise<boolean> => {
      if (busy) return false;
      stop();
      setBusy(true);
      setError(null);
      try {
        const res = await api.post(`/flows/${encodeURIComponent(flowId)}/runs`, { input, requestId: newRequestId() });
        const data = res.data.data as { runId: string; run: FlowRunDetail | null };
        if (data.run) setRun(data.run);
        void qc.invalidateQueries({ queryKey: flowRunsKey(flowId) });
        if (!runSettled(data.run?.status)) follow(data.runId, Date.now());
        return true;
      } catch (e) {
        setError(apiErrorOf(e, '実行できませんでした。もう一度お試しください。'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, flowId, follow, qc, stop],
  );

  const show = useCallback(
    async (runId: string) => {
      stop();
      setError(null);
      try {
        const detail = await fetchRun(runId);
        setRun(detail);
        if (!runSettled(detail.status)) follow(runId, Date.now());
      } catch (e) {
        setError(apiErrorOf(e, '読み込めませんでした。'));
      }
    },
    [follow, stop],
  );

  const clear = useCallback(() => {
    stop();
    setRun(null);
    setError(null);
  }, [stop]);

  return { run, busy, error, start, show, clear, clearError: () => setError(null) };
}

/** 実行できない理由（無ければ null）。未保存・無効・月間の上限（§3.4・§7.6） */
export function runBlockReason(opts: { dirty: boolean; enabled: boolean; usage?: FlowUsageInfo; valid: boolean }): string | null {
  if (opts.dirty) return '保存してから実行してください';
  if (!opts.valid) return '保存できる形に直してから実行してください';
  if (!opts.enabled) return '無効になっています';
  if (opts.usage?.runs.blocked) return '今月の実行数の上限です';
  return null;
}
