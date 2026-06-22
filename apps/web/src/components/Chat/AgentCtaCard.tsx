import { motion } from 'framer-motion';
import { Sparkles, X, Bot } from 'lucide-react';
import { DEPT_LABEL, DEPT_ACCENT, DEPT_CHARACTER } from '../../constants/departments';

export interface AgentDraft {
  name: string;
  department: string;
  instructions: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  reasoning?: string;
}

interface Props {
  draft: AgentDraft;
  onCreate: () => void;
  onDismiss: () => void;
}

/**
 * 会話が「繰り返し使える定型業務」に育ったときに表示する、エージェント化への訴求カード。
 * 押し付けがましくならないよう、控えめなトーン＋「あとで」で閉じられる。
 */
export function AgentCtaCard({ draft, onCreate, onDismiss }: Props) {
  const accent = DEPT_ACCENT[draft.department] ?? '#4F46E5';
  const char = DEPT_CHARACTER[draft.department];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md rounded-2xl border bg-white p-3.5 shadow-sm"
      style={{ borderColor: `${accent}33` }}
    >
      <div className="flex items-start gap-3">
        {char ? (
          <img
            src={char.image}
            alt=""
            className="h-10 w-10 flex-shrink-0 rounded-full bg-muted object-cover"
            style={{ boxShadow: `0 0 0 2px ${accent}33` }}
          />
        ) : (
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
            style={{ background: `${accent}15` }}
          >
            <Bot size={18} style={{ color: accent }} />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            <Sparkles size={13} style={{ color: accent }} />
            <span className="text-xs font-semibold text-primary">この作業、エージェント化できます</span>
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-secondary">
            次回からワンタップで自動実行できる
            <span className="font-semibold text-primary">「{draft.name}」</span>
            を作成しますか？
            <span
              className="ml-1 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium align-middle"
              style={{ backgroundColor: `${accent}15`, color: accent }}
            >
              {DEPT_LABEL[draft.department] ?? draft.department}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCreate}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
              style={{ background: accent }}
            >
              ✨ エージェントを作成
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="px-2 py-1.5 text-xs text-text-muted transition-colors hover:text-secondary"
            >
              あとで
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="閉じる"
          className="flex-shrink-0 text-text-muted transition-colors hover:text-secondary"
        >
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
}
