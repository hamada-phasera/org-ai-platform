import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, ChevronDown, ChevronUp, Copy, Check, CalendarPlus } from 'lucide-react';
import GlassCard from '../ui/GlassCard';
import type { Task, ExecutionResult } from '../../types/index';
import { downloadICS } from '../../utils/ics';

const TYPE_ICONS: Record<string, string> = {
  email: '📧',
  coding: '💻',
  research: '🔍',
  document: '📄',
  schedule: '📅',
};

const TYPE_LABELS: Record<string, string> = {
  email: 'メール',
  coding: 'コーディング',
  research: 'リサーチ',
  document: '文書',
  schedule: 'スケジュール',
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handle}
      className="flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 transition-colors"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'コピー済み' : 'コピー'}
    </button>
  );
}

function ResultContent({ result }: { result: ExecutionResult }) {
  switch (result.type) {
    case 'email':
      return result.email ? (
        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-start gap-2">
            <div className="space-y-1 flex-1 min-w-0">
              <p>
                <span className="text-slate-400">件名: </span>
                <span className="text-slate-700 font-semibold">{result.email.subject}</span>
              </p>
              {result.email.to && (
                <p className="text-slate-400">To: {result.email.to}</p>
              )}
            </div>
            <CopyButton text={`件名: ${result.email.subject}\n\n${result.email.body}`} />
          </div>
          <pre className="bg-white/80 rounded-lg p-2.5 text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto font-sans border border-slate-100 leading-relaxed">
            {result.email.body}
          </pre>
        </div>
      ) : null;

    case 'document':
      return result.document ? (
        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-start gap-2">
            <p className="font-semibold text-slate-700">{result.document.title}</p>
            <CopyButton text={`# ${result.document.title}\n\n${result.document.content}`} />
          </div>
          <p className="text-slate-500 leading-relaxed">{result.document.summary}</p>
          <pre className="bg-slate-50 rounded-lg p-2.5 text-slate-700 whitespace-pre-wrap max-h-48 overflow-y-auto font-sans border border-slate-200/80 leading-relaxed">
            {result.document.content}
          </pre>
        </div>
      ) : null;

    case 'research':
      return result.research ? (
        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-start gap-2">
            <p className="font-semibold text-slate-700 leading-snug">{result.research.title}</p>
            <CopyButton
              text={`# ${result.research.title}\n\n${result.research.summary}\n\n${result.research.sections.map((s) => `## ${s.heading}\n${s.content}`).join('\n\n')}\n\n## 結論\n${result.research.conclusion}`}
            />
          </div>
          <p className="text-slate-600 bg-indigo-50/60 rounded-xl p-2.5 border border-indigo-100 leading-relaxed">
            {result.research.summary}
          </p>
          {result.research.sections.slice(0, 3).map((s, i) => (
            <div key={i} className="border-l-2 border-slate-200 pl-2.5">
              <p className="font-semibold text-slate-500">{s.heading}</p>
              <p className="text-slate-600 leading-relaxed line-clamp-3">{s.content}</p>
            </div>
          ))}
          {result.research.conclusion && (
            <p className="text-slate-600 bg-emerald-50/60 rounded-xl p-2.5 border border-emerald-100 leading-relaxed">
              <span className="font-semibold text-emerald-700">結論: </span>
              {result.research.conclusion}
            </p>
          )}
        </div>
      ) : null;

    case 'coding':
      return result.coding ? (
        <div className="space-y-2 text-xs">
          <p className="text-slate-600 leading-relaxed">{result.coding.description}</p>
          <div className="space-y-1">
            {result.coding.files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 bg-slate-100 rounded-lg px-2.5 py-1.5">
                <span className="font-mono text-slate-600 flex-1 min-w-0 truncate">{f.filename}</span>
                <span className="text-slate-400 flex-shrink-0">{f.language}</span>
              </div>
            ))}
          </div>
          {result.coding.setupInstructions && (
            <p className="text-slate-500 bg-amber-50 rounded-lg p-2 border border-amber-100 leading-relaxed">
              {result.coding.setupInstructions}
            </p>
          )}
        </div>
      ) : null;

    case 'schedule':
      return result.schedule ? (
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-slate-700">{result.schedule.title}</p>
            <button
              className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 transition-colors flex-shrink-0"
              onClick={() => downloadICS(result.schedule!, `${result.schedule!.title}.ics`)}
            >
              <CalendarPlus size={11} />
              追加
            </button>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {result.schedule.items.map((item, i) => (
              <div
                key={i}
                className={`flex gap-2 items-start p-2 rounded-lg ${
                  item.milestone ? 'bg-indigo-50 border border-indigo-200/80' : 'bg-white/60 border border-slate-100'
                }`}
              >
                <span className={`font-mono w-24 flex-shrink-0 ${item.milestone ? 'text-indigo-700 font-bold' : 'text-slate-400'}`}>
                  {item.date}
                </span>
                <span className={`flex-1 min-w-0 leading-snug ${item.milestone ? 'font-semibold text-indigo-800' : 'text-slate-700'}`}>
                  {item.task}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null;

    default:
      return null;
  }
}

interface ProjectResultsPanelProps {
  tasks: Task[];
  projectName: string;
  onClose: () => void;
}

export default function ProjectResultsPanel({ tasks, projectName, onClose }: ProjectResultsPanelProps) {
  const completedCount = tasks.filter((t) => t.executionResult).length;
  const [expandedId, setExpandedId] = useState<string | null>(tasks[0]?.id ?? null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <GlassCard hover={false} className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start gap-2 border-b border-white/60 pb-3">
          <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-slate-700 text-sm">プロジェクト完了</h3>
            {projectName && (
              <p className="text-xs text-indigo-600 font-medium truncate mt-0.5">{projectName}</p>
            )}
          </div>
          <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold flex-shrink-0">
            {completedCount}/{tasks.length}件
          </span>
        </div>

        {/* Task results accordion */}
        <div className="space-y-2 max-h-[56vh] overflow-y-auto pr-0.5">
          {tasks.map((task, i) => {
            const result = task.executionResult;
            const isExpanded = expandedId === task.id;

            return (
              <div key={task.id} className="border border-slate-200/80 rounded-xl overflow-hidden">
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-white/60 hover:bg-white/80 transition-colors text-left"
                  onClick={() => setExpandedId(isExpanded ? null : task.id)}
                >
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="text-sm flex-shrink-0">{TYPE_ICONS[task.type] ?? '📌'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-700 truncate leading-snug">{task.title}</p>
                    <p className="text-xs text-slate-400">{TYPE_LABELS[task.type] ?? task.type}</p>
                  </div>
                  {result ? (
                    <CheckCircle2 size={13} className="text-emerald-500 flex-shrink-0" />
                  ) : (
                    <span className="text-xs text-amber-500 flex-shrink-0">待機中</span>
                  )}
                  {isExpanded ? (
                    <ChevronUp size={13} className="text-slate-400 flex-shrink-0" />
                  ) : (
                    <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                  )}
                </button>

                <AnimatePresence initial={false}>
                  {isExpanded && result && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="border-t border-slate-200/60 bg-slate-50/80 px-3 py-3 overflow-hidden"
                    >
                      <ResultContent result={result} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>

        {/* Close button */}
        <button
          className="w-full text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-full py-2 transition-colors"
          onClick={onClose}
        >
          閉じる
        </button>
      </GlassCard>
    </motion.div>
  );
}
