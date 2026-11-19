import type { LucideIcon, LucideProps } from 'lucide-react';
import { CheckCircle2, Database, FileOutput, GitBranch, Play, Puzzle, Sparkles } from 'lucide-react';
import { createElement } from 'react';
import type { FlowNodeType } from '@org-ai/shared-types';
import { labelOfStepStatus, stepTone, type Tone } from './flowModel';

/**
 * フロー画面の小物（PC・スマホ共用）。⚠️ zod の値も `@xyflow/react` も import しない。
 * 型の見分けはアイコンだけ（型ごとの色分けはしない。§3.4）。
 */

const TYPE_ICON: Record<FlowNodeType, LucideIcon> = {
  trigger: Play,
  ai: Sparkles,
  approval: CheckCircle2,
  data: Database,
  part: Puzzle,
  branch: GitBranch,
  output: FileOutput,
};

export function NodeTypeIcon({ type, ...props }: { type: string } & LucideProps) {
  return createElement(TYPE_ICON[type as FlowNodeType] ?? Play, props);
}

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-info',
  muted: 'bg-border-strong',
};

/** 状態の点（待ち・実行中・完了・失敗・承認待ち）。色だけに頼らず aria-label で状態名を持つ */
export function StepDot({ status, className = '' }: { status: string | undefined; className?: string }) {
  if (!status) return null;
  return (
    <span
      role="img"
      aria-label={labelOfStepStatus(status)}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[stepTone(status)]} ${status === 'RUNNING' ? 'animate-pulse motion-reduce:animate-none' : ''} ${className}`}
    />
  );
}

const TEXT_TONE: Record<Tone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
  muted: 'text-text-muted',
};

/** 状態の一語（「完了」「承認待ち」） */
export function StatusText({ status, label }: { status: string; label: string }) {
  return <span className={`shrink-0 text-xs font-bold ${TEXT_TONE[stepTone(status)]}`}>{label}</span>;
}
