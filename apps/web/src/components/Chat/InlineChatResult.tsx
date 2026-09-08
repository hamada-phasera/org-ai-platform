import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronDown, ChevronUp, Check, X, Loader2, AlertCircle, Zap,
  Mail, Send, Copy, FileText, Calendar, BarChart3, Share2,
  Twitter, Instagram, Linkedin,
} from 'lucide-react';
import { DEPT_ACCENT, DEPT_LABEL } from '../../constants/departments';
import { PLATFORM_COLOR } from '../../constants/brand';
import { parseOutputJson } from '../../utils/parseTaskOutput';

interface TaskLog {
  message: string;
  level: string;
  createdAt: string;
}

interface InlineChatResultProps {
  taskId: string;
  taskTitle: string;
  department: string;
  logs: TaskLog[];
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';
  output?: string;
  onApprove: () => void;
  onReject: () => void;
  onAction?: (action: string) => void;
}

const STEP_LABELS = [
  'Intent分析中...',
  'エージェント割り当て中...',
  'タスク実行中...',
  'リスク評価中...',
  '結果を整形中...',
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="flex items-center gap-1 text-micro text-text-muted hover:text-accent transition-colors px-1.5 py-0.5 rounded-lg"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'コピー済' : 'コピー'}
    </button>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EmailPreview({ data, onAction }: { data: any; onAction?: (action: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <Mail size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">メール</span>
        <CopyButton text={`To: ${data.to}\n件名: ${data.subject}\n\n${data.body}`} />
      </div>
      <div className="text-xs space-y-1">
        <p><span className="text-text-muted">To:</span> {data.to}</p>
        {data.cc && <p><span className="text-text-muted">CC:</span> {data.cc}</p>}
        <p><span className="text-text-muted">件名:</span> {data.subject}</p>
      </div>
      <div className="p-2.5 bg-sunken rounded-xl text-xs whitespace-pre-wrap max-h-36 overflow-y-auto text-primary leading-relaxed">
        {data.body}
      </div>
      {onAction && (
        <motion.button
          onClick={() => onAction('send_email')}
          className="w-full bg-action hover:bg-action-hover text-inverse text-xs font-semibold py-2 rounded-xl flex items-center justify-center gap-1.5"
          whileTap={{ scale: 0.98 }}
        >
          <Send size={12} /> Gmail で送信
        </motion.button>
      )}
    </div>
  );
}

const PLATFORM_ICON: Record<string, typeof Twitter> = { twitter: Twitter, instagram: Instagram, linkedin: Linkedin };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SNSPreview({ data, onAction }: { data: any; onAction?: (action: string) => void }) {
  const Icon = PLATFORM_ICON[data.platform] ?? Share2;
  const color = PLATFORM_COLOR[data.platform] ?? 'var(--text-secondary)';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon size={14} style={{ color }} />
        <span className="text-xs font-semibold text-primary">{data.platform?.toUpperCase()}</span>
        <CopyButton text={data.content + '\n' + (data.hashtags ?? []).map((t: string) => `#${t}`).join(' ')} />
      </div>
      <div className="p-2.5 bg-sunken rounded-xl text-xs whitespace-pre-wrap text-primary">
        {data.content}
      </div>
      {data.hashtags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.hashtags.map((tag: string) => (
            <span key={tag} className="text-micro text-accent font-medium">#{tag}</span>
          ))}
        </div>
      )}
      {onAction && (
        <motion.button
          onClick={() => onAction('post_sns')}
          className="w-full text-white text-xs font-semibold py-2 rounded-xl flex items-center justify-center gap-1.5"
          style={{ backgroundColor: color }}
          whileTap={{ scale: 0.98 }}
        >
          <Send size={12} /> 投稿する
        </motion.button>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DocumentPreview({ data }: { data: any }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">{data.title}</span>
        <CopyButton text={data.content ?? data.summary ?? ''} />
      </div>
      {data.summary && <p className="text-xs text-text-muted">{data.summary}</p>}
      {data.content && (
        <div className="p-2.5 bg-sunken rounded-xl text-xs whitespace-pre-wrap max-h-40 overflow-y-auto text-primary leading-relaxed">
          {typeof data.content === 'string' ? data.content.slice(0, 800) : JSON.stringify(data.content, null, 2).slice(0, 800)}
          {(data.content?.length ?? 0) > 800 ? '...' : ''}
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SchedulePreview({ data, onAction }: { data: any; onAction?: (action: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Calendar size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">{data.title}</span>
      </div>
      {data.preferredDates && (
        <div className="space-y-1">
          {data.preferredDates.map((d: string, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs text-primary bg-sunken rounded-lg px-3 py-1.5">
              <Calendar size={10} className="text-accent" /> {d}
              {data.duration && <span className="text-text-muted">({data.duration}分)</span>}
            </div>
          ))}
        </div>
      )}
      {data.participants?.length > 0 && (
        <p className="text-xs text-text-muted">参加者: {data.participants.join(', ')}</p>
      )}
      {onAction && (
        <motion.button
          onClick={() => onAction('create_event')}
          className="w-full bg-action hover:bg-action-hover text-inverse text-xs font-semibold py-2 rounded-xl flex items-center justify-center gap-1.5"
          whileTap={{ scale: 0.98 }}
        >
          <Calendar size={12} /> カレンダーに登録
        </motion.button>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MeetingNotesPreview({ data }: { data: any }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">{data.title}</span>
        {data.date && <span className="text-micro text-text-muted">{data.date}</span>}
      </div>
      {data.attendees?.length > 0 && (
        <p className="text-xs text-text-muted">参加者: {data.attendees.join(', ')}</p>
      )}
      {data.decisions?.length > 0 && (
        <div className="space-y-1">
          <p className="text-micro font-semibold text-text-muted">決定事項</p>
          {data.decisions.map((d: string, i: number) => (
            <div key={i} className="flex gap-1.5 text-xs text-primary">
              <Check size={10} className="text-success mt-0.5 flex-shrink-0" /> {d}
            </div>
          ))}
        </div>
      )}
      {data.actionItems?.length > 0 && (
        <div className="space-y-1">
          <p className="text-micro font-semibold text-text-muted">アクションアイテム</p>
          {data.actionItems.map((a: { assignee: string; task: string; deadline?: string }, i: number) => (
            <div key={i} className="text-xs text-primary bg-sunken rounded-lg px-2.5 py-1.5">
              <span className="font-medium">{a.assignee}</span>: {a.task}
              {a.deadline && <span className="text-text-muted ml-1">({a.deadline})</span>}
            </div>
          ))}
        </div>
      )}
      {data.summary && <p className="text-xs text-text-muted italic">{data.summary}</p>}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ReceiptSummaryPreview({ data }: { data: any }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">経費まとめ</span>
      </div>
      {data.receipts?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-muted border-b border-border">
                <th className="text-left py-1 pr-2">日付</th>
                <th className="text-left py-1 pr-2">取引先</th>
                <th className="text-left py-1 pr-2">分類</th>
                <th className="text-right py-1">金額</th>
              </tr>
            </thead>
            <tbody>
              {data.receipts.map((r: { date: string; vendor: string; category: string; amount: number }, i: number) => (
                <tr key={i} className="border-b border-hairline">
                  <td className="py-1 pr-2 text-text-muted">{r.date}</td>
                  <td className="py-1 pr-2 text-primary">{r.vendor}</td>
                  <td className="py-1 pr-2 text-text-muted">{r.category}</td>
                  <td className="py-1 text-right text-primary font-medium">¥{r.amount?.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={3} className="py-1.5 text-text-muted">合計</td>
                <td className="py-1.5 text-right text-primary">¥{data.totalAmount?.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {data.summary && <p className="text-xs text-text-muted">{data.summary}</p>}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function AnalyticsPreview({ data }: { data: any }) {
  const maxVal = Math.max(...(data.data ?? []).map((d: { value: number }) => d.value || 0), 1);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <BarChart3 size={14} className="text-accent" />
        <span className="text-xs font-semibold text-primary">{data.title}</span>
      </div>
      {data.summary && <p className="text-xs text-text-muted">{data.summary}</p>}
      {/* Simple bar chart */}
      {data.chartType === 'bar' && data.data?.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {data.data.slice(0, 8).map((d: { label: string; value: number }, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-text-muted truncate flex-shrink-0">{d.label}</span>
              <div className="flex-1 h-4 bg-sunken rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-accent"
                  initial={{ width: 0 }}
                  animate={{ width: `${(d.value / maxVal) * 100}%` }}
                  transition={{ duration: 0.5, delay: i * 0.05 }}
                />
              </div>
              <span className="text-primary font-medium w-12 text-right">{d.value}</span>
            </div>
          ))}
        </div>
      )}
      {/* Sections for market analysis */}
      {data.sections?.length > 0 && (
        <div className="space-y-2 pt-1">
          {data.sections.slice(0, 4).map((s: { heading: string; content: string }, i: number) => (
            <div key={i}>
              <p className="text-xs font-semibold text-primary">{s.heading}</p>
              <p className="text-xs text-text-muted line-clamp-3">{s.content}</p>
            </div>
          ))}
        </div>
      )}
      {data.conclusion && (
        <div className="p-2 bg-accent-soft rounded-lg">
          <p className="text-xs text-accent font-medium">{data.conclusion}</p>
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TaskResultPanel({ data, onAction }: { data: any; onAction?: (action: string) => void }) {
  const taskType = data?.taskType;
  if (!taskType) return <pre className="text-xs text-text-muted whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>;

  switch (taskType) {
    case 'email': return <EmailPreview data={data} onAction={onAction} />;
    case 'sns': return <SNSPreview data={data} onAction={onAction} />;
    case 'proposal':
    case 'content_calendar': return <DocumentPreview data={data} />;
    case 'meeting_notes': return <MeetingNotesPreview data={data} />;
    case 'schedule': return <SchedulePreview data={data} onAction={onAction} />;
    case 'receipt_summary':
    case 'expense_report':
    case 'invoice_check': return <ReceiptSummaryPreview data={data} />;
    case 'market_analysis':
    case 'data_visualization': return <AnalyticsPreview data={data} />;
    default: return <DocumentPreview data={data} />;
  }
}

export function InlineChatResult({ taskTitle, department, logs, status, output, onApprove, onReject, onAction }: InlineChatResultProps) {
  const [expanded, setExpanded] = useState(true);
  const accent = DEPT_ACCENT[department] ?? DEPT_ACCENT.GENERAL;
  const currentStep = Math.min(logs.length, STEP_LABELS.length - 1);

  const parsedOutput = useMemo(() => parseOutputJson(output), [output]);

  return (
    <motion.div
      className="bg-elevated border border-border rounded-2xl overflow-hidden shadow-elev-1"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <button
        type="button"
        className="w-full text-left flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-sunken transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}15` }}
        >
          <Zap size={15} style={{ color: accent }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-primary truncate">{taskTitle}</p>
          <p className="text-micro text-text-muted">
            {DEPT_LABEL[department] ?? department} タスク
          </p>
        </div>
        {status === 'executing' && <Loader2 size={14} className="text-accent animate-spin" />}
        {status === 'done' && <Check size={14} className="text-success" />}
        {status === 'failed' && <AlertCircle size={14} className="text-danger" />}
        {status === 'rejected' && <X size={14} className="text-danger" />}
        {expanded ? <ChevronUp size={14} className="text-text-muted" /> : <ChevronDown size={14} className="text-text-muted" />}
      </button>

      {/* Content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3">
              {/* Executing */}
              {status === 'executing' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-accent font-medium" aria-live="polite">
                    <Loader2 size={12} className="animate-spin" />
                    {STEP_LABELS[currentStep]}
                  </div>
                  <div className="w-full h-1.5 bg-sunken rounded-full overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: accent }}
                      initial={{ width: '5%' }}
                      animate={{ width: `${Math.max(10, Math.min(90, (logs.length / 5) * 100))}%` }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                    />
                  </div>
                  {logs.length > 0 && (
                    <div className="max-h-32 overflow-y-auto space-y-1 pt-1">
                      {logs.map((log, i) => (
                        <motion.div key={i} className="flex items-start gap-2 text-xs" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
                          <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${log.level === 'ERROR' ? 'bg-danger' : log.level === 'WARN' ? 'bg-warning' : 'bg-success'}`} />
                          <span className="text-text-muted">{log.message}</span>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Done: タスクタイプ別リッチ表示 */}
              {status === 'done' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-success font-medium">
                    <Check size={12} />
                    タスク完了
                  </div>
                  {parsedOutput ? (
                    <TaskResultPanel data={parsedOutput} onAction={onAction} />
                  ) : output ? (
                    <div className="p-2.5 bg-sunken rounded-xl text-xs whitespace-pre-wrap max-h-48 overflow-y-auto text-primary">
                      {output}
                    </div>
                  ) : null}
                </div>
              )}

              {/* Failed */}
              {status === 'failed' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-danger font-medium">
                    <AlertCircle size={12} /> タスク失敗
                  </div>
                  {logs.length > 0 && (
                    <div className="max-h-24 overflow-y-auto space-y-1 pt-1">
                      {logs.slice(-3).map((log, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${log.level === 'ERROR' ? 'bg-danger' : 'bg-ink-decorative'}`} />
                          <span className="text-text-muted">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Rejected */}
              {status === 'rejected' && (
                <div className="flex items-center gap-2 text-xs text-text-muted py-1">
                  <X size={12} /> タスクをキャンセルしました
                </div>
              )}

              {/* Pending */}
              {status === 'pending' && (
                <div className="flex gap-2 pt-2">
                  <motion.button onClick={onApprove} className="flex-1 bg-action hover:bg-action-hover text-inverse text-xs font-semibold py-2.5 rounded-xl flex items-center justify-center gap-1.5" whileTap={{ scale: 0.98 }}>
                    <Check size={13} /> 承認・実行
                  </motion.button>
                  <motion.button onClick={onReject} className="flex-1 bg-sunken hover:bg-border text-text-muted text-xs font-semibold py-2.5 rounded-xl flex items-center justify-center gap-1.5" whileTap={{ scale: 0.98 }}>
                    <X size={13} /> 却下
                  </motion.button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
