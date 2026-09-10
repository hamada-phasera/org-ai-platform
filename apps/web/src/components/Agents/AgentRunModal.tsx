import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { X, Loader2, CheckCircle2, AlertCircle, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAgentRun } from '../../hooks/useAgentRun';
import type { SavedAgent } from '../../types/agent';

interface Props {
  agent: SavedAgent;
  onClose: () => void;
}

/** 保存エージェントを実行し、Task の進捗ログ（n8n起動中… → 完了/フォールバック）を WebSocket で可視化する。 */
export function AgentRunModal({ agent, onClose }: Props) {
  const [input, setInput] = useState('');
  /* 実行と監視は useAgentRun が持つ（エージェント詳細ページと同じ振る舞いにする）。
     以前はここに同じロジックが丸ごと複製されており、片方だけ直す事故が起きる形だった。 */
  const { status, busy, logs, output, error, run } = useAgentRun(agent.id);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

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

  const handleRun = () => void run(input);

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
              {logs.map((log, i) => (
                <div key={`${log.createdAt}-${i}`} className="text-xs flex items-start gap-1.5">
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
