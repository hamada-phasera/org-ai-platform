import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, X } from 'lucide-react';
import { FLOW_NODE_TYPE_LABEL, type FlowDefinition, type FlowNode, type FlowNodeType, type FlowStepState } from '@org-ai/shared-types';
import { Button, Input } from '../ui';
import { NodeTypeIcon, StatusText } from './FlowBits';
import { formatDuration, labelOfStepStatus, mobileTextFields, stepOutputHead, stepRows } from './flowModel';

/**
 * スマホのステップの縦リスト（§4.3）。DAG の段の順に番号、同じ段は「3a / 3b」と字下げ 1 段。
 * 行を押すと下から出るシート: 設定の閲覧・文字の項目の変更（ADMIN 以上）・直近の結果。
 * ⚠️ zod の値も `@xyflow/react` も import しない（K20）。
 */

export interface StepTextChange {
  id: string;
  label?: string;
  config?: Record<string, string>;
}

export function StepList({
  definition,
  steps,
  partTitle,
  canEdit,
  onSaveText,
}: {
  definition: FlowDefinition;
  /** 表示中の実行のステップ結果（無ければ状態を出さない） */
  steps: Record<string, FlowStepState> | null;
  /** 部品のキー → 一語（カタログ） */
  partTitle: (key: string) => string | null;
  canEdit: boolean;
  onSaveText: (change: StepTextChange) => Promise<string | null>;
}) {
  const rows = stepRows(definition);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.node.id === openId)?.node ?? null;

  return (
    <>
      <ol className="divide-y divide-hairline border-y border-border" aria-label="手順">
        {rows.map(({ node, number, depth }) => {
          const step = steps?.[node.id];
          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => setOpenId(node.id)}
                className={`flex min-h-14 w-full items-center gap-3 py-2.5 pr-1 text-left transition-colors duration-fast hover:bg-sunken ${depth ? 'pl-7' : 'pl-1'}`}
                aria-label={`${number} ${node.label}${step ? ` ${labelOfStepStatus(step.status)}` : ''}`}
              >
                <span className="w-7 shrink-0 text-right font-mono text-sm text-text-muted tabular">{number}</span>
                <NodeTypeIcon type={node.type} size={16} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-body font-bold text-primary">{node.label}</span>
                {step && <StatusText status={step.status} label={labelOfStepStatus(step.status)} />}
                <ChevronRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {open && (
        <StepSheet
          key={open.id}
          node={open}
          step={steps?.[open.id]}
          partTitle={partTitle}
          canEdit={canEdit}
          onSaveText={onSaveText}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/** 設定の要約（閲覧）。値はすべて React のテキストで出す（T13） */
function summaryOf(node: FlowNode, partTitle: (key: string) => string | null): { k: string; v: string }[] {
  switch (node.type) {
    case 'trigger':
      if (node.config.mode === 'form') return [{ k: '項目', v: node.config.fields.map((f) => f.label).join('・') }];
      if (node.config.mode === 'schedule') return [{ k: '定期', v: `${({ daily: '毎日', weekly: '毎週', monthly: '毎月' } as const)[node.config.frequency]} ${node.config.hourJst} 時` }];
      return [{ k: '開始', v: '手動' }];
    case 'ai':
      return [{ k: '入力', v: node.config.input }];
    case 'data':
      return [{ k: '資源', v: `${node.config.resource} / ${node.config.op}` }];
    case 'part':
      return [{ k: '部品', v: partTitle(node.config.part) ?? node.config.part }];
    case 'branch':
      return [{ k: '条件', v: `${node.config.left} ${node.config.op}${node.config.right !== undefined ? ` ${String(node.config.right)}` : ''}` }];
    case 'output':
      if (node.config.kind === 'page') return [{ k: '出力', v: Object.keys(node.config.values).join('・') || 'ページ' }];
      if (node.config.kind === 'notify') return [{ k: '送り先', v: node.config.channel }];
      return [];
    default:
      return [];
  }
}

function StepSheet({
  node,
  step,
  partTitle,
  canEdit,
  onSaveText,
  onClose,
}: {
  node: FlowNode;
  step: FlowStepState | undefined;
  partTitle: (key: string) => string | null;
  canEdit: boolean;
  onSaveText: (change: StepTextChange) => Promise<string | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const fields = mobileTextFields(node);
  const [label, setLabel] = useState(node.label);
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  const changedConfig = Object.fromEntries(fields.filter((f) => texts[f.key] !== f.value).map((f) => [f.key, texts[f.key] ?? '']));
  const dirty = label !== node.label || Object.keys(changedConfig).length > 0;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(null);
    const err = await onSaveText({
      id: node.id,
      ...(label !== node.label ? { label } : {}),
      ...(Object.keys(changedConfig).length ? { config: changedConfig } : {}),
    });
    setSaving(false);
    if (err) setMessage(err);
    else onClose();
  };

  const head = stepOutputHead(step, 400);
  const typeLabel = FLOW_NODE_TYPE_LABEL[node.type as FlowNodeType] ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-overlay" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full overflow-y-auto rounded-t-panel border-t border-border bg-elevated pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2">
          <NodeTypeIcon type={node.type} size={16} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-body font-bold text-primary">
            {node.label}
          </h2>
          <span className="text-xs font-bold text-text-muted">{typeLabel}</span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="flex h-11 w-11 items-center justify-center text-secondary">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <dl className="divide-y divide-hairline px-5">
          {summaryOf(node, partTitle).map((s) => (
            <div key={s.k} className="flex gap-3 py-2.5 text-sm">
              <dt className="w-16 shrink-0 text-text-muted">{s.k}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-secondary">{s.v}</dd>
            </div>
          ))}
        </dl>

        {canEdit ? (
          <div className="space-y-3 border-t border-border px-5 py-3">
            <div>
              <label htmlFor={`${titleId}-label`} className="mb-1 block text-sm font-semibold text-primary">
                名前
              </label>
              <Input id={`${titleId}-label`} value={label} maxLength={8} onChange={(e) => setLabel(e.target.value)} />
            </div>
            {fields.map((f) => (
              <div key={f.key}>
                <label htmlFor={`${titleId}-${f.key}`} className="mb-1 block text-sm font-semibold text-primary">
                  {f.label}
                </label>
                {f.multiline ? (
                  <Input
                    id={`${titleId}-${f.key}`}
                    multiline
                    rows={4}
                    maxLength={f.max}
                    value={texts[f.key] ?? ''}
                    onChange={(e) => setTexts((t) => ({ ...t, [f.key]: e.target.value }))}
                  />
                ) : (
                  <Input
                    id={`${titleId}-${f.key}`}
                    maxLength={f.max}
                    value={texts[f.key] ?? ''}
                    onChange={(e) => setTexts((t) => ({ ...t, [f.key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
            <div aria-live="polite" className="min-h-5 text-sm text-danger">
              {message}
            </div>
            <Button fullWidth variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={saving} onClick={() => void save()}>
              保存
            </Button>
          </div>
        ) : (
          fields.length > 0 && (
            <dl className="divide-y divide-hairline border-t border-border px-5">
              {fields.map((f) => (
                <div key={f.key} className="flex gap-3 py-2.5 text-sm">
                  <dt className="w-16 shrink-0 text-text-muted">{f.label}</dt>
                  <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-secondary">{f.value}</dd>
                </div>
              ))}
            </dl>
          )
        )}

        <section className="border-t border-border px-5 py-3" aria-label="結果" aria-live="polite">
          <h3 className="text-sm font-bold text-text-muted">結果</h3>
          {step ? (
            <div className="mt-1 space-y-1 text-sm">
              <p className="text-primary">
                {labelOfStepStatus(step.status)}
                {step.durationMs !== undefined && <span className="ml-2 font-mono text-text-muted tabular">{formatDuration(step.durationMs)}</span>}
              </p>
              {step.error && <p className="text-danger">{step.error.message}</p>}
              {step.status === 'WAITING_APPROVAL' && (
                <Link to="/inbox?tab=approvals" className="inline-flex min-h-11 items-center font-bold text-accent">
                  受信で承認
                </Link>
              )}
              {head && <p className="whitespace-pre-wrap break-words text-secondary">{head}</p>}
            </div>
          ) : (
            <p className="mt-1 text-sm text-text-muted">—</p>
          )}
        </section>
      </div>
    </div>
  );
}
