import { Link } from 'react-router-dom';
import { ExternalLink, Lock, Plus, Trash2 } from 'lucide-react';
import {
  FLOW_DATA_RESOURCES,
  FLOW_DEFINITION_LIMITS as L,
  FLOW_NODE_TYPE_LABEL,
  FLOW_PARTS,
  type FlowDataResource,
  type FlowDefinition,
  type FlowNode,
  type FlowNodeOf,
  type FlowStepState,
  type PageField,
} from '@org-ai/shared-types';
import { Button } from '../ui';
import { BILLING_PATH } from '../../utils/planNotice';
import { NodeTypeIcon } from './FlowBits';
import { describeRef, formatDuration, insertCandidates, labelOfStepStatus, stepOutputHead, type SlotAccepts } from './flowModel';
import type { PartInfo } from './flowApi';
import { FIELD_CLASS, SELECT_CLASS, SelectField, TemplateField, TextField } from './TemplateField';

/**
 * 右パネル（§3.4）。幅 340px・白・左に区切り線 1 本。ノードの型ごとの設定・値の差し込み・結果・削除。
 * 入れ子のカードを作らない（項目は縦に並べ、区切りは border-t）。値はすべて React のテキストで出す（T13）。
 */

const DEPARTMENTS = [
  { value: '', label: '—' },
  { value: 'SALES', label: '営業' },
  { value: 'MARKETING', label: 'SNS' },
  { value: 'ACCOUNTING', label: '経理' },
  { value: 'ANALYTICS', label: '分析' },
  { value: 'GENERAL', label: '総務' },
] as const;
type Dept = (typeof DEPARTMENTS)[number]['value'];

const ROLES = [
  { value: 'MEMBER', label: 'メンバー' },
  { value: 'ADMIN', label: '管理者' },
  { value: 'OWNER', label: 'オーナー' },
] as const;

const FIELD_TYPES: { value: PageField['type']; label: string }[] = [
  { value: 'text', label: '文字' },
  { value: 'textarea', label: '長文' },
  { value: 'number', label: '数' },
  { value: 'date', label: '日付' },
  { value: 'select', label: '選択' },
  { value: 'checkbox', label: 'チェック' },
  { value: 'email', label: 'メール' },
  { value: 'tel', label: '電話' },
];

const RESOURCE_LABEL: Record<FlowDataResource, string> = {
  deal: '商談',
  project: '工事',
  vendor: '取引先',
  cost_entry: '原価',
  deliverable: '成果物',
};
const OP_LABEL = { list: '一覧', get: '取得', create: '作成', update: '更新' } as const;

/** カンマ区切りの文字 ⇔ 配列（選択肢） */
const splitList = (v: string) =>
  v
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean);

function nextKey(existing: readonly string[], prefix: string): string {
  for (let i = 1; ; i++) if (!existing.includes(`${prefix}${i}`)) return `${prefix}${i}`;
}

interface Props {
  node: FlowNode;
  def: FlowDefinition;
  parts: PartInfo[];
  canEdit: boolean;
  issues: string[];
  step: FlowStepState | undefined;
  onChange: (node: FlowNode) => void;
  onDelete: () => void;
}

export function NodePanel({ node, def, parts, canEdit, issues, step, onChange, onDelete }: Props) {
  const cand = (accepts: SlotAccepts = 'text') => insertCandidates(def, node.id, FLOW_PARTS, accepts);
  const id = (k: string) => `np-${node.id}-${k}`;
  const head = stepOutputHead(step, 300);

  return (
    <div className="flex h-full flex-col" aria-live="polite">
      <div className="flex items-center gap-2 px-4 py-3">
        <NodeTypeIcon type={node.type} size={16} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
        <h2 className="text-sm font-bold text-primary">{FLOW_NODE_TYPE_LABEL[node.type]}</h2>
      </div>
      {issues.length > 0 && (
        <p className="border-t border-border px-4 py-2 text-sm text-danger" role="alert">
          {issues[0]}
        </p>
      )}

      <fieldset disabled={!canEdit} className="min-w-0 space-y-3 border-t border-border px-4 py-3">
        <TextField id={id('label')} label="名前" value={node.label} max={L.labelMax} onChange={(label) => onChange({ ...node, label } as FlowNode)} />
        {node.type === 'trigger' && <TriggerFields node={node} onChange={onChange} id={id} />}
        {node.type === 'ai' && <AiFields node={node} onChange={onChange} id={id} cand={cand} />}
        {node.type === 'approval' && <ApprovalFields node={node} onChange={onChange} id={id} cand={cand} />}
        {node.type === 'data' && <DataFields node={node} onChange={onChange} id={id} cand={cand} />}
        {node.type === 'part' && <PartFields node={node} onChange={onChange} id={id} cand={cand} parts={parts} />}
        {node.type === 'branch' && <BranchFields node={node} onChange={onChange} id={id} cand={cand} def={def} />}
        {node.type === 'output' && <OutputFields node={node} onChange={onChange} id={id} cand={cand} def={def} />}
      </fieldset>

      <section className="border-t border-border px-4 py-3" aria-label="結果">
        <h3 className="text-xs font-bold text-text-muted">結果</h3>
        {step ? (
          <div className="mt-1 space-y-1 text-sm">
            <p className="text-primary">
              {labelOfStepStatus(step.status)}
              {step.durationMs !== undefined && <span className="ml-2 font-mono text-text-muted tabular">{formatDuration(step.durationMs)}</span>}
            </p>
            {step.error && <p className="text-danger">{step.error.message}</p>}
            {step.warnings && step.warnings.length > 0 && <p className="text-warning">{step.warnings[0]}</p>}
            {head && <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-secondary">{head}</p>}
          </div>
        ) : (
          <p className="mt-1 text-sm text-text-muted">—</p>
        )}
      </section>

      {canEdit && node.type !== 'trigger' && (
        <div className="mt-auto border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onDelete}>
            削除
          </Button>
        </div>
      )}
    </div>
  );
}

type Sub<T extends FlowNode['type']> = {
  node: FlowNodeOf<T>;
  onChange: (n: FlowNode) => void;
  id: (k: string) => string;
  cand?: (accepts?: SlotAccepts) => ReturnType<typeof insertCandidates>;
};

// ── きっかけ ─────────────────────────────────────────────

function TriggerFields({ node, onChange, id }: Sub<'trigger'>) {
  const c = node.config;
  const set = (config: FlowNodeOf<'trigger'>['config']) => onChange({ ...node, config });
  const setMode = (mode: 'manual' | 'form' | 'schedule') => {
    if (mode === c.mode) return;
    if (mode === 'manual') set({ mode });
    else if (mode === 'form') set({ mode, fields: [{ key: 'f1', label: '内容', type: 'text', required: true }] });
    else set({ mode, frequency: 'daily', hourJst: 9 });
  };
  return (
    <>
      <SelectField
        id={id('mode')}
        label="開始"
        value={c.mode}
        options={[
          { value: 'manual', label: '手動' },
          { value: 'form', label: 'フォーム' },
          { value: 'schedule', label: '定期' },
        ]}
        onChange={setMode}
      />
      {c.mode === 'form' && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-text-muted">項目</p>
          <ul className="divide-y divide-hairline border-y border-border">
            {c.fields.map((f, i) => {
              const update = (patch: Partial<PageField>) => {
                const fields = c.fields.map((x, j) => (j === i ? ({ ...x, ...patch } as PageField) : x));
                set({ ...c, fields });
              };
              return (
                <li key={f.key} className="space-y-1.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <label htmlFor={id(`f-${f.key}`)} className="sr-only">
                      項目名
                    </label>
                    <input id={id(`f-${f.key}`)} value={f.label} maxLength={40} onChange={(e) => update({ label: e.target.value })} className={FIELD_CLASS} />
                    <label htmlFor={id(`ft-${f.key}`)} className="sr-only">
                      種類
                    </label>
                    <select
                      id={id(`ft-${f.key}`)}
                      value={f.type}
                      onChange={(e) => {
                        const type = e.target.value as PageField['type'];
                        const next: PageField = { key: f.key, label: f.label, type, ...(f.required ? { required: true } : {}) };
                        if (type === 'select') next.options = [{ value: 'a', label: 'A' }];
                        const fields = c.fields.map((x, j) => (j === i ? next : x));
                        set({ ...c, fields });
                      }}
                      className={`${SELECT_CLASS} w-24 shrink-0`}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`${f.label}を削除`}
                      disabled={c.fields.length <= 1}
                      onClick={() => set({ ...c, fields: c.fields.filter((_, j) => j !== i) })}
                      className="flex h-9 w-9 shrink-0 items-center justify-center text-text-muted hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-secondary">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={!!f.required} onChange={(e) => update({ required: e.target.checked || undefined })} />
                      必須
                    </label>
                    {f.type === 'select' && (
                      <>
                        <label htmlFor={id(`fo-${f.key}`)} className="sr-only">
                          選択肢
                        </label>
                        <input
                          id={id(`fo-${f.key}`)}
                          placeholder="選択肢（カンマ区切り）"
                          defaultValue={(f.options ?? []).map((o) => o.label).join(', ')}
                          onBlur={(e) => {
                            const labels = splitList(e.target.value).slice(0, 20);
                            update({ options: labels.map((l) => ({ value: l, label: l })) });
                          }}
                          className={`${FIELD_CLASS} py-1`}
                        />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {c.fields.length < L.formFieldsMax && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={() => set({ ...c, fields: [...c.fields, { key: nextKey(c.fields.map((f) => f.key), 'f'), label: '項目', type: 'text' }] })}
            >
              項目
            </Button>
          )}
        </div>
      )}
      {c.mode === 'schedule' && (
        <>
          <SelectField
            id={id('freq')}
            label="間隔"
            value={c.frequency}
            options={[
              { value: 'daily', label: '毎日' },
              { value: 'weekly', label: '毎週' },
              { value: 'monthly', label: '毎月' },
            ]}
            onChange={(frequency) =>
              set({
                mode: 'schedule',
                frequency,
                hourJst: c.hourJst,
                ...(frequency === 'weekly' ? { dayOfWeek: 1 } : {}),
                ...(frequency === 'monthly' ? { dayOfMonth: 1 } : {}),
              })
            }
          />
          {c.frequency === 'weekly' && (
            <SelectField
              id={id('dow')}
              label="曜日"
              value={String(c.dayOfWeek ?? 1)}
              options={['日', '月', '火', '水', '木', '金', '土'].map((d, i) => ({ value: String(i), label: d }))}
              onChange={(v) => set({ ...c, dayOfWeek: Number(v) })}
            />
          )}
          {c.frequency === 'monthly' && (
            <SelectField
              id={id('dom')}
              label="日"
              value={String(c.dayOfMonth ?? 1)}
              options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 日` }))}
              onChange={(v) => set({ ...c, dayOfMonth: Number(v) })}
            />
          )}
          <SelectField
            id={id('hour')}
            label="時刻"
            value={String(c.hourJst)}
            options={Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${i} 時` }))}
            onChange={(v) => set({ ...c, hourJst: Number(v) })}
          />
        </>
      )}
    </>
  );
}

// ── AI ───────────────────────────────────────────────────

function AiFields({ node, onChange, id, cand }: Sub<'ai'>) {
  const c = node.config;
  const set = (patch: Partial<FlowNodeOf<'ai'>['config']>) => {
    const next = { ...c, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
    onChange({ ...node, config: next as FlowNodeOf<'ai'>['config'] });
  };
  const setOp = (op: FlowNodeOf<'ai'>['config']['op']) =>
    set({
      op,
      fields: op === 'extract' ? (c.fields ?? [{ key: 'value', label: '値', type: 'text' }]) : undefined,
      choices: op === 'classify' ? (c.choices ?? ['はい', 'いいえ']) : undefined,
    });
  return (
    <>
      <SelectField
        id={id('op')}
        label="種類"
        value={c.op}
        options={[
          { value: 'generate', label: '生成' },
          { value: 'summarize', label: '要約' },
          { value: 'extract', label: '抽出' },
          { value: 'classify', label: '分類' },
        ]}
        onChange={setOp}
      />
      <TemplateField id={id('instruction')} label="指示" value={c.instruction} max={L.instructionMax} multiline candidates={cand!()} onChange={(instruction) => set({ instruction })} />
      <TemplateField id={id('input')} label="入力" value={c.input} max={L.aiInputMax} multiline rows={3} candidates={cand!()} onChange={(input) => set({ input })} />
      {c.op === 'extract' && (
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-text-muted">取り出す項目</p>
          {(c.fields ?? []).map((f, i) => (
            <div key={f.key} className="flex items-center gap-1.5">
              <label htmlFor={id(`x-${f.key}`)} className="sr-only">
                項目名
              </label>
              <input
                id={id(`x-${f.key}`)}
                value={f.label}
                maxLength={L.labelMax}
                onChange={(e) => set({ fields: (c.fields ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                className={FIELD_CLASS}
              />
              <label htmlFor={id(`xt-${f.key}`)} className="sr-only">
                型
              </label>
              <select
                id={id(`xt-${f.key}`)}
                value={f.type}
                onChange={(e) =>
                  set({ fields: (c.fields ?? []).map((x, j) => (j === i ? { ...x, type: e.target.value as 'text' | 'number' | 'boolean' } : x)) })
                }
                className={`${SELECT_CLASS} w-20 shrink-0`}
              >
                <option value="text">文字</option>
                <option value="number">数</option>
                <option value="boolean">真偽</option>
              </select>
              <button
                type="button"
                aria-label={`${f.label}を削除`}
                disabled={(c.fields ?? []).length <= 1}
                onClick={() => set({ fields: (c.fields ?? []).filter((_, j) => j !== i) })}
                className="flex h-9 w-9 shrink-0 items-center justify-center text-text-muted hover:text-danger disabled:opacity-40"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
          {(c.fields ?? []).length < L.extractFieldsMax && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={() => set({ fields: [...(c.fields ?? []), { key: nextKey((c.fields ?? []).map((f) => f.key), 'v'), label: '項目', type: 'text' }] })}
            >
              項目
            </Button>
          )}
        </div>
      )}
      {c.op === 'classify' && (
        <div>
          <label htmlFor={id('choices')} className="mb-1 block text-xs font-bold text-text-muted">
            選択肢
          </label>
          <input
            id={id('choices')}
            defaultValue={(c.choices ?? []).join(', ')}
            onBlur={(e) => set({ choices: splitList(e.target.value).slice(0, L.classifyChoicesMax) })}
            placeholder="カンマ区切り"
            className={FIELD_CLASS}
          />
        </div>
      )}
      <SelectField<Dept>
        id={id('dept')}
        label="部署"
        value={(c.department ?? '') as Dept}
        options={DEPARTMENTS}
        onChange={(d) => set({ department: d === '' ? undefined : d })}
      />
    </>
  );
}

// ── 確認 ─────────────────────────────────────────────────

function ApprovalFields({ node, onChange, id, cand }: Sub<'approval'>) {
  const c = node.config;
  const set = (patch: Partial<FlowNodeOf<'approval'>['config']>) => {
    const next = { ...c, ...patch } as Record<string, unknown>;
    if (patch.preview === '') delete next.preview;
    onChange({ ...node, config: next as FlowNodeOf<'approval'>['config'] });
  };
  return (
    <>
      <TemplateField id={id('message')} label="文言" value={c.message} max={L.approvalMessageMax} candidates={cand!()} onChange={(message) => set({ message })} />
      <TemplateField id={id('preview')} label="見せる内容" value={c.preview ?? ''} max={L.approvalPreviewMax} multiline candidates={cand!()} onChange={(preview) => set({ preview })} />
      <SelectField id={id('role')} label="承認できる人" value={c.minRole ?? 'MEMBER'} options={ROLES} onChange={(minRole) => set({ minRole })} />
    </>
  );
}

// ── データ ────────────────────────────────────────────────

function DataFields({ node, onChange, id, cand }: Sub<'data'>) {
  const c = node.config;
  const spec = FLOW_DATA_RESOURCES[c.resource];
  const set = (config: FlowNodeOf<'data'>['config']) => onChange({ ...node, config });
  const reset = (resource: FlowDataResource, op: FlowNodeOf<'data'>['config']['op']) => {
    const s = FLOW_DATA_RESOURCES[resource];
    const o = s.ops.includes(op) ? op : s.ops[0];
    if (o === 'list') set({ resource, op: o, limit: 10 });
    else if (o === 'get') set({ resource, op: o, where: [{ field: s.filterable[0] ?? 'id', value: '' }] });
    else if (o === 'create') set({ resource, op: o, values: Object.fromEntries(s.required.map((k) => [k, ''])) });
    else set({ resource, op: o, where: [{ field: 'id', value: '' }], values: { [s.writable[0] ?? 'title']: '' } });
  };
  const canWhere = c.op === 'list' || c.op === 'get';
  return (
    <>
      <SelectField
        id={id('res')}
        label="資源"
        value={c.resource}
        options={(Object.keys(FLOW_DATA_RESOURCES) as FlowDataResource[]).map((r) => ({ value: r, label: RESOURCE_LABEL[r] }))}
        onChange={(r) => reset(r, c.op)}
      />
      <SelectField id={id('op')} label="操作" value={c.op} options={spec.ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} onChange={(o) => reset(c.resource, o)} />
      {(canWhere || c.op === 'update') && spec.filterable.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-text-muted">条件</p>
          {(c.where ?? []).map((w, i) => (
            <div key={`${w.field}-${i}`} className="space-y-1">
              <select
                aria-label="列"
                value={w.field}
                disabled={c.op === 'update'}
                onChange={(e) => set({ ...c, where: (c.where ?? []).map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}
                className={SELECT_CLASS}
              >
                {spec.filterable.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <TemplateField
                id={id(`w-${i}`)}
                label="値"
                value={w.value}
                max={L.branchRightMax}
                candidates={cand!()}
                onChange={(value) => set({ ...c, where: (c.where ?? []).map((x, j) => (j === i ? { ...x, value } : x)) })}
              />
            </div>
          ))}
          {canWhere && (c.where ?? []).length < L.dataWhereMax && (
            <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => set({ ...c, where: [...(c.where ?? []), { field: spec.filterable[0], value: '' }] })}>
              条件
            </Button>
          )}
        </div>
      )}
      {(c.op === 'create' || c.op === 'update') &&
        spec.writable.map((k) => (
          <TemplateField
            key={k}
            id={id(`v-${k}`)}
            label={k}
            value={c.values?.[k] ?? ''}
            max={L.dataValueMax}
            candidates={cand!()}
            onChange={(v) => {
              const values = { ...(c.values ?? {}) };
              if (v === '' && !spec.required.includes(k)) delete values[k];
              else values[k] = v;
              set({ ...c, values });
            }}
          />
        ))}
      {c.op === 'list' && (
        <SelectField
          id={id('limit')}
          label="件数"
          value={String(c.limit ?? 10)}
          options={[5, 10, 20, 50].map((n) => ({ value: String(n), label: `${n} 件` }))}
          onChange={(v) => set({ ...c, limit: Number(v) })}
        />
      )}
      {c.resource === 'cost_entry' && <p className="text-xs text-text-muted">下書きとして積みます</p>}
    </>
  );
}

// ── 部品 ─────────────────────────────────────────────────

function PartFields({ node, onChange, id, cand, parts }: Sub<'part'> & { parts: PartInfo[] }) {
  const c = node.config;
  const part = parts.find((p) => p.key === c.part);
  const setPart = (key: string) => {
    const p = parts.find((x) => x.key === key);
    onChange({ ...node, label: p ? p.title.slice(0, L.labelMax) : node.label, config: { part: key, input: Object.fromEntries((p?.input ?? []).map((f) => [f.key, ''])) } });
  };
  return (
    <>
      <div>
        <label htmlFor={id('part')} className="mb-1 block text-xs font-bold text-text-muted">
          部品
        </label>
        <select id={id('part')} value={c.part} onChange={(e) => setPart(e.target.value)} className={SELECT_CLASS}>
          {!part && <option value={c.part}>{c.part}</option>}
          {parts.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title}
              {!p.allowed ? '（上位プラン）' : p.connection !== 'ok' ? '（未接続）' : ''}
            </option>
          ))}
        </select>
      </div>
      {part && !part.allowed && (
        <p className="flex items-center gap-1.5 text-sm text-secondary">
          <Lock size={13} aria-hidden="true" />
          上位プラン
          <Link to={BILLING_PATH} className="ml-1 font-bold text-accent hover:text-accent-hover">
            プラン
          </Link>
        </p>
      )}
      {part && part.allowed && part.connection !== 'ok' && (
        <p className="text-sm text-warning">
          {part.connection === 'needs_auth' ? '連携が切れています' : '未接続'}
          {part.via === 'capability' && (
            <Link to="/settings?tab=integrations" className="ml-2 font-bold text-accent hover:text-accent-hover">
              連携
            </Link>
          )}
        </p>
      )}
      {part?.editorUrl && (
        <a href={part.editorUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-accent hover:text-accent-hover">
          <ExternalLink size={12} aria-hidden="true" />
          n8n で開く
        </a>
      )}
      {(part?.input ?? []).map((f) => (
        <TemplateField
          key={f.key}
          id={id(`in-${f.key}`)}
          label={f.required ? `${f.label}（必須）` : f.label}
          value={c.input[f.key] ?? ''}
          max={L.partInputMax}
          multiline={f.type === 'textarea'}
          rows={3}
          candidates={cand!()}
          onChange={(v) => onChange({ ...node, config: { ...c, input: { ...c.input, [f.key]: v } } })}
        />
      ))}
      {part?.sideEffect === 'external_send' && <p className="text-xs text-text-muted">送る前に必ず止まり、受信で承認します</p>}
    </>
  );
}

// ── 分岐 ─────────────────────────────────────────────────

const BRANCH_OPS = [
  { value: 'eq', label: '等しい' },
  { value: 'ne', label: '等しくない' },
  { value: 'gt', label: 'より大きい' },
  { value: 'lt', label: 'より小さい' },
  { value: 'contains', label: '含む' },
  { value: 'empty', label: '空' },
  { value: 'not_empty', label: '空でない' },
] as const;

function BranchFields({ node, onChange, id, cand, def }: Sub<'branch'> & { def: FlowDefinition }) {
  const c = node.config;
  const options = cand!('any').flatMap((g) => g.keys.map((k) => ({ value: k.ref, label: `${g.label} › ${k.title}` })));
  const setOp = (op: FlowNodeOf<'branch'>['config']['op']) => {
    const base = { left: c.left, op };
    if (op === 'empty' || op === 'not_empty') onChange({ ...node, config: base });
    else if (op === 'gt' || op === 'lt') onChange({ ...node, config: { ...base, right: typeof c.right === 'number' ? c.right : 0 } });
    else onChange({ ...node, config: { ...base, right: typeof c.right === 'string' ? c.right : '' } });
  };
  const needsRight = c.op !== 'empty' && c.op !== 'not_empty';
  return (
    <>
      <div>
        <label htmlFor={id('left')} className="mb-1 block text-xs font-bold text-text-muted">
          比べる値
        </label>
        <select id={id('left')} value={c.left} onChange={(e) => onChange({ ...node, config: { ...c, left: e.target.value } })} className={SELECT_CLASS}>
          <option value="">—</option>
          {c.left && !options.some((o) => o.value === c.left) && <option value={c.left}>{describeRef(def, c.left) || c.left}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <SelectField id={id('bop')} label="条件" value={c.op} options={BRANCH_OPS} onChange={setOp} />
      {needsRight && (
        <div>
          <label htmlFor={id('right')} className="mb-1 block text-xs font-bold text-text-muted">
            相手
          </label>
          <input
            id={id('right')}
            inputMode={c.op === 'gt' || c.op === 'lt' ? 'decimal' : undefined}
            value={c.right === undefined ? '' : String(c.right)}
            maxLength={L.branchRightMax}
            onChange={(e) => {
              const v = e.target.value;
              const right = c.op === 'gt' || c.op === 'lt' ? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : 0) : v;
              onChange({ ...node, config: { ...c, right } });
            }}
            className={FIELD_CLASS}
          />
        </div>
      )}
      <p className="text-xs text-text-muted">線は「はい」「いいえ」の順に引きます</p>
    </>
  );
}

// ── 出力 ─────────────────────────────────────────────────

function OutputFields({ node, onChange, id, cand, def }: Sub<'output'> & { def: FlowDefinition }) {
  const c = node.config;
  const set = (config: FlowNodeOf<'output'>['config']) => onChange({ ...node, config });
  const setKind = (kind: 'page' | 'document' | 'notify') => {
    if (kind === c.kind) return;
    if (kind === 'page') set({ kind, values: {} });
    else if (kind === 'document') set({ kind, title: '文書', body: '本文' });
    else set({ kind, channel: 'slack', body: '本文' });
  };
  const rowsOptions = cand!('rows').flatMap((g) => g.keys.map((k) => ({ value: k.ref, label: `${g.label} › ${k.title}` })));
  return (
    <>
      <SelectField
        id={id('kind')}
        label="種類"
        value={c.kind}
        options={[
          { value: 'page', label: 'ページ' },
          { value: 'document', label: '文書' },
          { value: 'notify', label: '通知' },
        ]}
        onChange={setKind}
      />
      {c.kind === 'page' && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-bold text-text-muted">値</p>
            {Object.entries(c.values).map(([k, v]) => (
              <div key={k} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">{k}</span>
                  <button
                    type="button"
                    aria-label={`${k}を削除`}
                    onClick={() => {
                      const values = { ...c.values };
                      delete values[k];
                      set({ ...c, values });
                    }}
                    className="flex h-7 w-7 items-center justify-center text-text-muted hover:text-danger"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
                <TemplateField id={id(`pv-${k}`)} label="中身" value={v} max={L.pageValueMax} candidates={cand!()} onChange={(nv) => set({ ...c, values: { ...c.values, [k]: nv } })} />
              </div>
            ))}
            {Object.keys(c.values).length < L.pageValuesMax && (
              <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => set({ ...c, values: { ...c.values, [nextKey(Object.keys(c.values), 'value')]: '' } })}>
                値
              </Button>
            )}
          </div>
          <div>
            <label htmlFor={id('rows')} className="mb-1 block text-xs font-bold text-text-muted">
              表
            </label>
            <select
              id={id('rows')}
              value={c.rows ?? ''}
              onChange={(e) => {
                const next = { ...c } as Record<string, unknown>;
                if (e.target.value) next.rows = e.target.value;
                else delete next.rows;
                set(next as FlowNodeOf<'output'>['config']);
              }}
              className={SELECT_CLASS}
            >
              <option value="">—</option>
              {c.rows && !rowsOptions.some((o) => o.value === c.rows) && <option value={c.rows}>{describeRef(def, c.rows) || c.rows}</option>}
              {rowsOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {c.kind === 'document' && (
        <>
          <TemplateField id={id('title')} label="題名" value={c.title} max={L.documentTitleMax} candidates={cand!()} onChange={(title) => set({ ...c, title })} />
          <TemplateField id={id('body')} label="本文" value={c.body} max={L.documentBodyMax} multiline rows={6} candidates={cand!()} onChange={(body) => set({ ...c, body })} />
          <SelectField<Dept>
            id={id('ddept')}
            label="部署"
            value={(c.department ?? '') as Dept}
            options={DEPARTMENTS}
            onChange={(d) => {
              const next = { ...c } as Record<string, unknown>;
              if (d) next.department = d;
              else delete next.department;
              set(next as FlowNodeOf<'output'>['config']);
            }}
          />
        </>
      )}
      {c.kind === 'notify' && (
        <>
          <SelectField
            id={id('ch')}
            label="送り先"
            value={c.channel}
            options={[
              { value: 'slack', label: 'Slack' },
              { value: 'email', label: 'メール' },
              { value: 'line', label: 'LINE' },
            ]}
            onChange={(channel) => set({ ...c, channel })}
          />
          <TemplateField
            id={id('to')}
            label="宛先"
            value={c.to ?? ''}
            max={L.notifyToMax}
            candidates={cand!()}
            onChange={(to) => {
              const next = { ...c } as Record<string, unknown>;
              if (to) next.to = to;
              else delete next.to;
              set(next as FlowNodeOf<'output'>['config']);
            }}
          />
          <TemplateField id={id('nbody')} label="本文" value={c.body} max={L.notifyBodyMax} multiline candidates={cand!()} onChange={(body) => set({ ...c, body })} />
          <p className="text-xs text-text-muted">送る前に必ず止まり、受信で承認します</p>
        </>
      )}
    </>
  );
}

/** 何も選んでいないとき: フローの設定（名前は上部・見られる役割・有効/無効。§3.4） */
export function FlowSettingsPanel({
  minRole,
  enabled,
  canEdit,
  onMinRole,
  onToggleEnabled,
  enabledBusy,
}: {
  minRole: string;
  enabled: boolean;
  canEdit: boolean;
  onMinRole: (r: 'MEMBER' | 'ADMIN' | 'OWNER') => void;
  onToggleEnabled: () => void;
  enabledBusy: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <h2 className="px-4 py-3 text-sm font-bold text-primary">フロー</h2>
      <fieldset disabled={!canEdit} className="space-y-3 border-t border-border px-4 py-3">
        <SelectField id="flow-min-role" label="見られる人" value={minRole as 'MEMBER' | 'ADMIN' | 'OWNER'} options={ROLES} onChange={onMinRole} />
        <label className="flex items-center gap-2 text-sm font-semibold text-primary">
          <input type="checkbox" className="h-4 w-4 accent-[var(--action)]" checked={enabled} disabled={enabledBusy} onChange={onToggleEnabled} />
          有効
        </label>
      </fieldset>
    </div>
  );
}
