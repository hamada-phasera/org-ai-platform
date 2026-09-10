import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentRunState } from '@org-ai/shared-types';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';

/**
 * 保存エージェントを実行し、進捗を監視するフック。
 *
 * AgentRunModal と エージェント詳細ページの両方が使う。
 * WebSocket `/api/tasks/:taskId/stream` はログを流すが **DONE / FAILED でしか done を送らない**ため、
 * 承認必須の capability で PENDING_APPROVAL に止まった実行を検知できない。
 * そのため status のポーリングを併走させ、承認待ち・却下も終端として扱う。
 *
 * executionResult（AgentRunState）も読むので、キャンバスがステップ単位で光る。
 */

export type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'awaiting_approval'
  | 'rejected';

export interface TaskLogEntry {
  message: string;
  level: string;
  createdAt: string;
}

/** GET /tasks/:id の返す Task のうち、ここで見るぶんだけ */
interface TaskSnapshot {
  status: string;
  output?: string | null;
  lastError?: string | null;
  /** AgentRunState の JSON 文字列。ステップ単位の進捗はここにしか無い */
  executionResult?: string | null;
}

/** Task.status を確認する間隔（ms） */
const STATUS_POLL_MS = 2500;

/** executionResult を AgentRunState として読む。壊れていたら null（描画を止めない）。 */
export function parseRunState(raw: string | null | undefined): AgentRunState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentRunState;
    return parsed && parsed.version === 1 && Array.isArray(parsed.steps) ? parsed : null;
  } catch {
    return null;
  }
}

export function useAgentRun(agentId: string | undefined) {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<AgentRunState | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);

  /** 監視をすべて止める（終端に到達したとき / アンマウント時） */
  const stopWatching = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopWatching(), [stopWatching]);

  const syncTaskStatus = useCallback(
    async (id: string) => {
      try {
        const res = await api.get<{ success: boolean; data: TaskSnapshot }>(`/tasks/${id}`);
        const task = res.data.data;
        /* ステップ単位の進捗は終端かどうかに関わらず常に反映する（キャンバスが光る） */
        setRunState(parseRunState(task.executionResult));
        if (task.status === 'PENDING_APPROVAL') {
          stopWatching();
          setStatus('awaiting_approval');
        } else if (task.status === 'REJECTED') {
          stopWatching();
          setStatus('rejected');
        } else if (task.status === 'DONE') {
          stopWatching();
          setOutput(task.output ?? null);
          setStatus('done');
        } else if (task.status === 'FAILED') {
          stopWatching();
          setOutput(task.output ?? null);
          setError(task.lastError ?? '実行に失敗しました');
          setStatus('failed');
        }
      } catch {
        /* 一時的な失敗は次のポーリングで拾う（監視は止めない） */
      }
    },
    [stopWatching],
  );

  const connectStream = useCallback(
    (id: string) => {
      const token = useAuthStore.getState().token;
      const wsBase =
        import.meta.env.VITE_WS_URL ||
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
      const ws = new WebSocket(`${wsBase}/api/tasks/${id}/stream?token=${token}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'logs') {
            setLogs((prev) => [...prev, ...(data.data as TaskLogEntry[])]);
            setStatus('running');
            /* ログが動いた直後は状態も動いている可能性が高い（承認待ち停止の検知を早める） */
            void syncTaskStatus(id);
          } else if (data.type === 'done') {
            /* status の反映と監視停止は syncTaskStatus に一本化する */
            void syncTaskStatus(id);
          }
        } catch {
          /* skip malformed frame */
        }
      };
      ws.onerror = () => ws.close();

      /* WS だけでは PENDING_APPROVAL / REJECTED を検知できないので status も定期確認する */
      pollRef.current = window.setInterval(() => {
        void syncTaskStatus(id);
      }, STATUS_POLL_MS);
    },
    [syncTaskStatus],
  );

  const run = useCallback(
    async (input?: string) => {
      if (!agentId) return;
      stopWatching();
      setStatus('starting');
      setLogs([]);
      setOutput(null);
      setError(null);
      setRunState(null);
      try {
        const res = await api.post<{ success: boolean; data: { taskId: string } }>(
          `/agents/${agentId}/run`,
          { input: input?.trim() || undefined },
        );
        setTaskId(res.data.data.taskId);
        connectStream(res.data.data.taskId);
      } catch (e) {
        setError(e instanceof Error ? e.message : '実行リクエストに失敗しました');
        setStatus('failed');
      }
    },
    [agentId, connectStream, stopWatching],
  );

  const busy = status === 'starting' || status === 'running';

  return { status, busy, logs, output, error, runState, taskId, run, stop: stopWatching };
}
