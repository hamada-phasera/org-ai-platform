import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { X, Loader2, CheckCircle2, AlertCircle, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { SavedAgent } from '../../types/agent';

interface TaskLogEntry {
  id: string;
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  createdAt: string;
}

/** awaiting_approval / rejected も終端。WS の done は DONE/FAILED でしか飛んでこない */
type RunStatus = 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'awaiting_approval' | 'rejected';

/** GET /tasks/:id の返す Task のうち、ここで見るぶんだけ */
interface TaskSnapshot {
  status: string;
  output?: string | null;
  lastError?: string | null;
}

/** Task.status を確認する間隔（ms） */
const STATUS_POLL_MS = 2500;

interface Props {
  agent: SavedAgent;
  onClose: () => void;
}

/** 保存エージェントを実行し、Task の進捗ログ（n8n起動中… → 完了/フォールバック）を WebSocket で可視化する。 */
export function AgentRunModal({ agent, onClose }: Props) {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<RunStatus>('idle');
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /** 監視をすべて止める（終端に到達したとき / アンマウント時） */
  const stopWatching = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopWatching();
  }, [stopWatching]);

  /* a11y: Escape で閉じる */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* a11y: マウント時に最初のフォーカス可能要素へフォーカス */
  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, []);

  /**
   * Task の status を直接見にいき、終端なら実行中表示をやめる。
   *
   * WS `/api/tasks/:taskId/stream` は DONE / FAILED でしか done を送らないため、
   * 承認必須の capability（send_email など）で PENDING_APPROVAL に止まった実行は
   * これが無いとモーダルが永久にスピナーのままになる。REJECTED も終端として扱う。
   */
  const syncTaskStatus = useCallback(
    async (taskId: string) => {
      try {
        const res = await api.get<{ success: boolean; data: TaskSnapshot }>(`/tasks/${taskId}`);
        const task = res.data.data;
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

  const connectStream = useCallback((taskId: string) => {
    const token = useAuthStore.getState().token;
    const wsBase =
      import.meta.env.VITE_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const ws = new WebSocket(`${wsBase}/api/tasks/${taskId}/stream?token=${token}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'logs') {
          setLogs((prev) => [...prev, ...(data.data as TaskLogEntry[])]);
          setStatus('running');
          /* ログが動いた直後は状態も動いている可能性が高い（承認待ち停止の検知を早める） */
          void syncTaskStatus(taskId);
        } else if (data.type === 'done') {
          /* status の反映と監視停止は syncTaskStatus に一本化する。
             GET が失敗してもポーリングが残っているので取りこぼさない */
          void syncTaskStatus(taskId);
        }
      } catch {
        /* skip malformed frame */
      }
    };
    ws.onerror = () => ws.close();

    /* WS だけでは PENDING_APPROVAL / REJECTED を検知できないので status も定期確認する */
    pollRef.current = window.setInterval(() => {
      void syncTaskStatus(taskId);
    }, STATUS_POLL_MS);
  }, [syncTaskStatus]);

  const handleRun = useCallback(async () => {
    stopWatching();
    setStatus('starting');
    setLogs([]);
    setOutput(null);
    setError(null);
    try {
      const res = await api.post<{ success: boolean; data: { taskId: string } }>(
        `/agents/${agent.id}/run`,
        { input: input.trim() || undefined },
      );
      connectStream(res.data.data.taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '実行リクエストに失敗しました');
      setStatus('failed');
    }
  }, [agent.id, input, connectStream, stopWatching]);

  const busy = status === 'starting' || status === 'running';

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-run-title"
        className="bg-elevated border border-border rounded-panel overflow-hidden w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 shadow-elev-3"
        initial={{ scale: 0.95, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="brand-strip -mx-6 -mt-6 mb-5 rounded-none" aria-hidden="true" />
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xl">{agent.icon ?? '🤖'}</span>
            <h2 id="agent-run-title" className="text-body font-semibold text-primary">
              {agent.name} を実行
            </h2>
          </div>
          <button onClick={onClose} aria-label="閉じる" className="text-muted hover:text-primary">
            <X size={18} />
          </button>
        </div>
        {agent.description && <p className="text-xs text-secondary mb-4">{agent.description}</p>}

        <label htmlFor="agent-run-input" className="block text-xs text-secondary mb-1">
          追加の指示（任意）
        </label>
        <Input
          id="agent-run-input"
          multiline
          rows={3}
          placeholder="例: 今週分のデータでお願い"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />

        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={handleRun} loading={busy} disabled={busy}>
            {busy ? '実行中…' : 'エージェントを実行'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            閉じる
          </Button>
        </div>

        {(logs.length > 0 || busy) && (
          <div className="mt-5" aria-live="polite">
            <div className="text-xs text-secondary mb-2 flex items-center gap-1.5">
              {status === 'done' ? (
                <CheckCircle2 size={14} className="text-success" />
              ) : status === 'failed' || status === 'rejected' ? (
                <AlertCircle size={14} className="text-danger" />
              ) : status === 'awaiting_approval' ? (
                <ShieldCheck size={14} className="text-warning" />
              ) : (
                <Loader2 size={14} className="animate-spin" />
              )}
              実行ログ
            </div>
            <div className="bg-sunken border border-border rounded-sm p-3 space-y-1 max-h-40 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="text-xs flex items-start gap-1.5">
                  {log.message.includes('n8n起動中') && (
                    <Clock size={12} className="mt-0.5 text-warning flex-shrink-0" />
                  )}
                  <span
                    className={
                      log.level === 'ERROR'
                        ? 'text-danger'
                        : log.level === 'WARN'
                          ? 'text-warning'
                          : 'text-secondary'
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))}
              {busy && logs.length === 0 && (
                <div className="text-xs text-muted">起動を待っています…</div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {/* 外部送信の直前で止まった実行。ここで終端にしないと「実行中…」が終わらない */}
        {status === 'awaiting_approval' && (
          <div
            aria-live="polite"
            className="mt-4 rounded-card border border-warning/40 bg-warning/10 p-3 flex items-start gap-2"
          >
            <ShieldCheck size={14} className="mt-0.5 flex-shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-primary">送信前の承認待ちです</p>
              <p className="mt-1 text-xs text-secondary">
                受信ページで内容を確認して承認してください。承認すると残りのステップが続きます。
              </p>
              <Link
                to="/inbox"
                onClick={onClose}
                className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-action hover:text-action-hover"
              >
                受信ページを開く
                <ArrowRight size={12} />
              </Link>
            </div>
          </div>
        )}
        {status === 'rejected' && (
          <p aria-live="polite" className="mt-3 text-xs text-danger">
            この実行は承認されず、却下されました。
          </p>
        )}

        {output && (
          <div className="mt-4" aria-live="polite">
            <div className="text-xs text-secondary mb-1">結果</div>
            <div className="bg-sunken border border-border rounded-sm p-3 text-sm text-primary whitespace-pre-wrap">
              {output}
            </div>
          </div>
        )}
        {error && status === 'failed' && (
          <p aria-live="polite" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
      </motion.div>
    </motion.div>
  );
}
