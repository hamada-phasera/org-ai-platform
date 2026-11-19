import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FlowDefinition, PageField } from '@org-ai/shared-types';
import { useAuthStore } from '../../store/authStore';
import { BILLING_PATH, canOpenBilling } from '../../utils/planNotice';
import { formatDuration, labelOfRunStatus } from './flowModel';
import type { ApiError, FlowRunDetail, useFlowRunner } from './flowApi';
import { StepDot } from './FlowBits';

/**
 * 「実行」を押したとき（§3.4）: きっかけがフォームなら入力のモーダル → 実行。手動・定期は押した時点で実行。
 * 押しただけでは承認にならない（外へ送るノードは受信で人が通す。§7.4）。
 * ⚠️ zod の値も `@xyflow/react` も import しない。
 */
export function useRunAction(def: FlowDefinition, runner: ReturnType<typeof useFlowRunner>) {
  const [formOpen, setFormOpen] = useState(false);
  const trigger = def.nodes.find((n) => n.type === 'trigger');
  const fields: PageField[] | null = trigger && trigger.type === 'trigger' && trigger.config.mode === 'form' ? trigger.config.fields : null;

  const onRun = () => {
    runner.clearError();
    if (fields && fields.length > 0) setFormOpen(true);
    else void runner.start({});
  };

  const submit = async (input: Record<string, unknown>) => {
    const ok = await runner.start(input);
    if (ok) setFormOpen(false);
  };

  return {
    fields,
    formOpen,
    onRun,
    submit,
    closeForm: () => {
      setFormOpen(false);
      runner.clearError();
    },
  };
}

/** 実行の状態の 1 行（aria-live）。承認待ちは受信への導線、上限はプランへの導線（ADMIN 以上） */
export function RunStatusLine({ run, error, onClear }: { run: FlowRunDetail | null; error: ApiError | null; onClear: () => void }) {
  const role = useAuthStore((s) => s.user?.role);
  return (
    <div aria-live="polite" className="mt-2 min-h-6 text-sm">
      {error ? (
        <p className="text-danger">
          {error.message}
          {(error.code === 'FLOW_RUN_LIMIT' || error.code === 'FLOW_PART_LIMIT' || error.code === 'FLOW_PART_PLAN') && canOpenBilling(role) && (
            <Link to={BILLING_PATH} className="ml-2 font-bold text-accent hover:text-accent-hover">
              プラン
            </Link>
          )}
        </p>
      ) : run ? (
        <p className="flex flex-wrap items-center gap-2 text-secondary">
          <StepDot status={run.status} />
          <span className="font-bold text-primary">{labelOfRunStatus(run.status)}</span>
          {run.durationMs !== null && <span className="font-mono text-text-muted tabular">{formatDuration(run.durationMs)}</span>}
          {run.error?.message && <span className="text-danger">{run.error.message}</span>}
          {run.status === 'WAITING_APPROVAL' && (
            <Link to="/inbox?tab=approvals" className="inline-flex min-h-11 items-center font-bold text-accent hover:text-accent-hover lg:min-h-0">
              受信で承認
            </Link>
          )}
          <button type="button" onClick={onClear} className="ml-auto inline-flex min-h-11 items-center text-xs font-bold text-text-muted hover:text-primary lg:min-h-0">
            閉じる
          </button>
        </p>
      ) : null}
    </div>
  );
}
