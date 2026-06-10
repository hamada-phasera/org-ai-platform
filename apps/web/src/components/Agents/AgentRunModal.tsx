import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, Loader2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { GlassButton } from '../ui/GlassButton';
import { GlassInput } from '../ui/GlassInput';
import type { SavedAgent } from '../../types/agent';

interface TaskLogEntry {
  id: string;
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  createdAt: string;
}

type RunStatus = 'idle' | 'starting' | 'running' | 'done' | 'failed';

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
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    return () => wsRef.current?.close();
  }, []);

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
        } else if (data.type === 'done') {
          const finished = data.status === 'DONE' ? 'done' : 'failed';
          api
            .get<{ success: boolean; data: { output?: string; lastError?: string } }>(`/tasks/${taskId}`)
            .then((res) => {
              setOutput(res.data.data.output ?? null);
              if (finished === 'failed') setError(res.data.data.lastError ?? '実行に失敗しました');
              setStatus(finished);
            })
            .catch(() => setStatus(finished));
          ws.close();
        }
      } catch {
        /* skip malformed frame */
      }
    };
    ws.onerror = () => ws.close();
  }, []);

  const handleRun = useCallback(async () => {
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
  }, [agent.id, input, connectStream]);

  const busy = status === 'starting' || status === 'running';

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="glass-regular rounded-lg w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 shadow-elev-3"
        initial={{ scale: 0.95, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xl">{agent.icon ?? '🤖'}</span>
            <h2 className="text-body font-semibold text-primary">{agent.name} を実行</h2>
          </div>
          <button onClick={onClose} aria-label="閉じる" className="text-muted hover:text-primary">
            <X size={18} />
          </button>
        </div>
        {agent.description && <p className="text-xs text-secondary mb-4">{agent.description}</p>}

        <label className="block text-xs text-secondary mb-1">追加の指示（任意）</label>
        <GlassInput
          multiline
          rows={3}
          placeholder="例: 今週分のデータでお願い"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />

        <div className="mt-4 flex gap-2">
          <GlassButton variant="primary" onClick={handleRun} loading={busy} disabled={busy}>
            {busy ? '実行中…' : 'エージェントを実行'}
          </GlassButton>
          <GlassButton variant="ghost" onClick={onClose} disabled={busy}>
            閉じる
          </GlassButton>
        </div>

        {(logs.length > 0 || busy) && (
          <div className="mt-5">
            <div className="text-xs text-secondary mb-2 flex items-center gap-1.5">
              {status === 'done' ? (
                <CheckCircle2 size={14} className="text-green-500" />
              ) : status === 'failed' ? (
                <AlertCircle size={14} className="text-danger" />
              ) : (
                <Loader2 size={14} className="animate-spin" />
              )}
              実行ログ
            </div>
            <div className="glass-thin rounded-sm p-3 space-y-1 max-h-40 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="text-xs flex items-start gap-1.5">
                  {log.message.includes('n8n起動中') && (
                    <Clock size={12} className="mt-0.5 text-amber-500 flex-shrink-0" />
                  )}
                  <span
                    className={
                      log.level === 'ERROR'
                        ? 'text-danger'
                        : log.level === 'WARN'
                          ? 'text-amber-600'
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

        {output && (
          <div className="mt-4">
            <div className="text-xs text-secondary mb-1">結果</div>
            <div className="glass-thin rounded-sm p-3 text-sm text-primary whitespace-pre-wrap">
              {output}
            </div>
          </div>
        )}
        {error && status === 'failed' && (
          <p className="mt-3 text-xs text-danger">{error}</p>
        )}
      </motion.div>
    </motion.div>
  );
}
