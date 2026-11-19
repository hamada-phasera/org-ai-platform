import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import type { FlowPartSpec } from '@org-ai/shared-types';
import { Button } from '../ui';
import { READ_ONLY_REASON, useReadOnlyOrg } from '../../hooks/useReadOnlyOrg';
import { LiquidTabs } from '../motion/LiquidTabs';
import { PageIconGlyph } from '../canvas/PageIconGlyph';
import { RunForm, fieldErrorsOf } from './RunForm';
import { RunHistory } from './RunHistory';
import { StepList, type StepTextChange } from './StepList';
import { RunStatusLine, useRunAction } from './useRunAction';
import { apiErrorOf, flowKey, patchFlow, runBlockReason, useFlowRunner, useFlowRuns, type FlowDetail, type PartInfo } from './flowApi';
import { normalizeDefinition } from './flowModel';

/**
 * フロー画面（スマホ。§4.3）。ステップの縦リスト・実行・承認待ち・履歴。ADMIN 以上は文字の設定と有効/無効だけ。
 * ノードの追加・削除・接続・出力ビルダーは PC（§4.1）。
 * ⚠️ zod の値も `@xyflow/react` も import しない（K20）。
 */
type Tab = 'steps' | 'history';

export function FlowMobile({ flow, parts }: { flow: FlowDetail; parts: PartInfo[] }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('steps');
  const def = normalizeDefinition(flow.definition);
  const runner = useFlowRunner(flow.id);
  const runs = useFlowRuns(flow.id, tab === 'history');
  const action = useRunAction(def, runner);
  const [toggleMsg, setToggleMsg] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const readOnly = useReadOnlyOrg();
  const blocked = readOnly ? READ_ONLY_REASON : runBlockReason({ dirty: false, enabled: flow.enabled, usage: flow.usage, valid: flow.valid });
  const partTitle = (key: string) => (parts as Pick<FlowPartSpec, 'key' | 'title'>[]).find((p) => p.key === key)?.title ?? null;

  const saveText = async (change: StepTextChange): Promise<string | null> => {
    try {
      await patchFlow(flow.id, { node: change, baseVersion: flow.version });
      await qc.invalidateQueries({ queryKey: flowKey(flow.id) });
      return null;
    } catch (e) {
      return apiErrorOf(e, '保存できませんでした。もう一度お試しください。').message;
    }
  };

  const toggle = async () => {
    if (toggling || readOnly) return;
    setToggleMsg(null);
    setToggling(true);
    try {
      await patchFlow(flow.id, { enabled: !flow.enabled });
      await qc.invalidateQueries({ queryKey: flowKey(flow.id) });
    } catch (e) {
      setToggleMsg(apiErrorOf(e, '変更できませんでした。').message);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-5 pb-16 pt-4">
        <div className="flex items-center gap-2">
          <Link to="/" aria-label="ホーム" className="flex h-11 w-11 shrink-0 items-center justify-center text-secondary hover:text-primary">
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <h1 className="flex min-w-0 flex-1 items-center gap-2 text-h3 font-extrabold">
            <PageIconGlyph name={flow.icon} size={18} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
            <span className="truncate">{flow.name}</span>
          </h1>
          <Button icon={<Play size={14} />} onClick={action.onRun} disabled={!!blocked} loading={runner.busy}>
            実行
          </Button>
        </div>
        {blocked && <p className="mt-1 text-sm text-text-muted">{blocked}</p>}

        <div className="mt-3">
          <LiquidTabs<Tab>
            id="flow-mobile-tabs"
            label="フロー画面の表示切り替え"
            items={[
              { value: 'steps', label: '手順' },
              { value: 'history', label: '履歴' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        <RunStatusLine run={runner.run} error={action.formOpen ? null : runner.error} onClear={runner.clear} />

        <div className="mt-3">
          {tab === 'steps' ? (
            <>
              <StepList definition={def} steps={runner.run?.steps ?? null} partTitle={partTitle} canEdit={flow.canEdit} onSaveText={saveText} />
              {flow.canEdit && (
                <label className="mt-4 flex min-h-11 items-center gap-3 text-sm font-semibold text-primary">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--action)]"
                    checked={flow.enabled}
                    disabled={toggling || readOnly}
                    aria-busy={toggling || undefined}
                    onChange={() => void toggle()}
                  />
                  有効
                </label>
              )}
              {toggleMsg && <p className="text-sm text-danger">{toggleMsg}</p>}
            </>
          ) : (
            <RunHistory
              runs={runs.data}
              loading={runs.isLoading}
              error={runs.isError}
              selectedId={runner.run?.id ?? null}
              onRetry={() => void runs.refetch()}
              onSelect={(runId) => {
                void runner.show(runId);
                setTab('steps');
              }}
            />
          )}
        </div>
      </div>

      {action.formOpen && action.fields && (
        <RunForm
          title={flow.name}
          fields={action.fields}
          busy={runner.busy}
          serverErrors={fieldErrorsOf(runner.error?.code === 'VALIDATION_ERROR' ? runner.error.issues : [])}
          message={runner.error && runner.error.code !== 'VALIDATION_ERROR' ? runner.error.message : null}
          onSubmit={(input) => void action.submit(input)}
          onClose={action.closeForm}
        />
      )}
    </div>
  );
}
