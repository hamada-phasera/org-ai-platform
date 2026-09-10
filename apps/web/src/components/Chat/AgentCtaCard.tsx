import { Suspense, lazy } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, X, Bot } from 'lucide-react';
import type { AgentStepDef } from '@org-ai/shared-types';
import { DEPT_LABEL, DEPT_ACCENT, DEPT_CHARACTER } from '../../constants/departments';
import type { CapabilityMeta } from '../workflow/stepsToFlow';
import { useStaggeredReveal } from '../../hooks/useStaggeredReveal';

/* 提案が出たときにだけキャンバスを読む。チャットを開いただけの人に
   @xyflow/react を落とさせない（提案は毎回出るものではない）。 */
const WorkflowCanvas = lazy(() =>
  import('../workflow/WorkflowCanvas').then((m) => ({ default: m.WorkflowCanvas })),
);


export interface AgentDraft {
  name: string;
  department: string;
  instructions: string;
  /** 提案された手順。ミニキャンバスで「もう組み上がっている」ことを見せる */
  steps?: AgentStepDef[];
  trigger: 'MANUAL' | 'SCHEDULED';
  reasoning?: string;
}

interface Props {
  draft: AgentDraft;
  /** ノードの表示名を引くためのレジストリ */
  capabilities?: CapabilityMeta[];
  /** 既存エージェントの修正提案なら true（文言とボタンが変わる） */
  editing?: boolean;
  busy?: boolean;
  onCreate: () => void;
  onDismiss: () => void;
}

/**
 * 会話が「繰り返し使える定型業務」に育ったときに表示する、エージェント化への訴求カード。
 * 押し付けがましくならないよう、控えめなトーン＋「あとで」で閉じられる。
 *
 * 手順が提案されているときは**ミニキャンバスに1つずつ生やして**見せる。
 * 「作りますか？」の時点でもう組み上がっている、という体験にするため。
 */
export function AgentCtaCard({
  draft,
  capabilities = [],
  editing = false,
  busy = false,
  onCreate,
  onDismiss,
}: Props) {
  const steps = draft.steps ?? [];
  const visibleCount = useStaggeredReveal(steps.length);
  const accent = DEPT_ACCENT[draft.department] ?? DEPT_ACCENT.GENERAL;
  const char = DEPT_CHARACTER[draft.department];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md rounded-2xl border bg-elevated p-3.5 shadow-sm"
      style={{ borderColor: `${accent}33` }}
    >
      <div className="flex items-start gap-3">
        {char ? (
          <img
            src={char.image}
            alt=""
            className="h-10 w-10 flex-shrink-0 rounded-full bg-sunken object-cover"
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
            <span className="text-xs font-semibold text-primary">
              {editing ? 'この内容に変更しますか？' : 'この作業、エージェント化できます'}
            </span>
          </div>
          <p className="mb-2 text-xs leading-relaxed text-secondary">
            {editing ? (
              <>
                <span className="font-semibold text-primary">「{draft.name}」</span>
                の手順を次のように変更します。
              </>
            ) : (
              <>
                次回からワンタップで自動実行できる
                <span className="font-semibold text-primary">「{draft.name}」</span>
                を作成しますか？
              </>
            )}
            <span
              className="ml-1 inline-block rounded-full px-1.5 py-0.5 text-micro font-medium align-middle"
              style={{ backgroundColor: `${accent}15`, color: accent }}
            >
              {DEPT_LABEL[draft.department] ?? draft.department}
            </span>
          </p>

          {steps.length > 0 && (
            <div className="mb-2.5">
              <Suspense
                fallback={
                  <div className="h-[220px] rounded-panel border border-border bg-canvas" />
                }
              >
                <WorkflowCanvas
                  steps={steps}
                  capabilities={capabilities}
                  visibleCount={visibleCount}
                  compact
                />
              </Suspense>
              <p className="mt-1 text-micro text-text-muted tabular">
                {visibleCount < steps.length
                  ? `手順を組み立てています… ${visibleCount}/${steps.length}`
                  : `${steps.length} ステップ`}
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCreate}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
              style={{ background: accent }}
            >
              {busy ? '反映中…' : editing ? '✨ この内容に変更' : '✨ エージェントを作成'}
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
