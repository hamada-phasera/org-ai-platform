import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FLOW_PAGE_ACTION_IDS,
  alignFlowPageDefinition,
  flowPageColumnLabel,
  flowTriggerFields,
  projectQueryResult,
  toPublicPageDefinition,
  type FlowDefinition,
  type FlowPageSource,
  type PageAction,
  type PageBlock,
  type PageBlockType,
  type PageDefinition,
} from '@org-ai/shared-types';
import { Button, ErrorState, Spinner } from '../ui';
import { READ_ONLY_REASON, useReadOnlyOrg } from '../../hooks/useReadOnlyOrg';
import { BlockRenderer } from '../pages/BlockRenderer';
import { PageCtx, type PageContextValue } from '../pages/PageContext';
import type { PageQueryData } from '../pages/pagesApi';
import { apiErrorOf, flowPageKey, saveFlowPage, useFlowPage, type FlowDetail, type FlowPageInfo } from './flowApi';
import { BLOCK_LABEL, MAX_BLOCKS, addableBlocks, dummyRaw, issuesByBlock, moveBlock, newBlock, removeAt } from './outputModel';
import { FIELD_CLASS, SELECT_CLASS } from './TemplateField';

/**
 * 出力ビルダー（docs/design/canvas-home.md §3.5）。フロー画面の「出力」タブ（PC・ADMIN 以上）。
 * 左: 部品（押すと末尾に追加）／中央: 結果ページのプレビュー（1 列・ドラッグか矢印で並べ替え）／右: 選んだブロックの設定。
 * ブロックは業務ページの 7 種をそのまま使う。データは**フローの出力ノードが宣言したキー**と履歴から選ぶだけ（自由入力させない）。
 * フォームの項目はきっかけの項目（gateway が保存時に写す）。プレビューは押しても実行しない（fieldset disabled）。
 */

const FLOW_ACTIONS: Record<string, PageAction> = {
  [FLOW_PAGE_ACTION_IDS.query]: { kind: 'flow_query' },
  [FLOW_PAGE_ACTION_IDS.submit]: { kind: 'flow_submit' },
};

interface Item {
  id: string;
  block: PageBlock;
}

let seq = 0;
const nextId = () => `b${++seq}`;

export default function OutputBuilder({ flow }: { flow: FlowDetail }) {
  const q = useFlowPage(flow.id);
  if (q.isLoading) {
    return (
      <div className="flex flex-1 justify-center py-20">
        <Spinner />
      </div>
    );
  }
  if (q.isError || !q.data) {
    const e = apiErrorOf(q.error, '出力を開けませんでした');
    return (
      <div className="mx-auto max-w-[760px] flex-1 px-5 py-10">
        <ErrorState title="出力を開けませんでした" description={e.message} />
      </div>
    );
  }
  // 版では作り直さない（編集中に他の人の保存・取り直しが来ても未保存の編集を消さない）。合わせ方は Builder の中
  return <Builder key={flow.id} flow={flow} info={q.data} />;
}

const EMPTY_DEFINITION: PageDefinition = { blocks: [], actions: {} };
const itemsOf = (blocks: PageBlock[]): Item[] => blocks.map((block) => ({ id: nextId(), block }));

function Builder({ flow, info }: { flow: FlowDetail; info: FlowPageInfo }) {
  const qc = useQueryClient();
  const readOnly = useReadOnlyOrg();
  /**
   * 編集の基準にした結果ページ（楽観ロックの版もこれ）。取り直しで版が変わっても、編集中は差し替えない
   * （未保存の編集を消さない。1 行出し、保存すれば gateway が 409 を返す）。未編集・自分の保存の直後は合わせる。
   */
  const [base, setBase] = useState(info);
  const [ownSave, setOwnSave] = useState(false);
  const initial = base.page?.definition ?? base.draft ?? EMPTY_DEFINITION;
  const initialTitle = base.page?.title ?? flow.name;
  const [items, setItems] = useState<Item[]>(() => itemsOf(initial.blocks));
  const [title, setTitle] = useState(initialTitle);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ blocks: Record<number, string[]>; general: string[] }>({ blocks: {}, general: [] });
  const initialJson = useMemo(() => JSON.stringify(initial.blocks), [initial.blocks]);

  const blocks = items.map((i) => i.block);
  const edited = title !== initialTitle || JSON.stringify(blocks) !== initialJson;
  const dirty = !base.page || edited;

  const external = (info.page?.version ?? null) !== (base.page?.version ?? null);
  if (external && (ownSave || !edited)) {
    // 描画中の state 調整（props の変化に合わせる React の作法）。条件付きなので 1 回で収まる
    setBase(info);
    setItems(itemsOf((info.page?.definition ?? info.draft ?? EMPTY_DEFINITION).blocks));
    setTitle(info.page?.title ?? flow.name);
    setSelected(null);
    setOwnSave(false);
  }
  const outdated = external && !ownSave && edited;

  // 未保存のまま離れる（再読み込み・タブを閉じる）ときはブラウザの確認を出す
  useEffect(() => {
    if (!edited) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [edited]);
  const triggerIsForm = !!flowTriggerFields(flow.definition as FlowDefinition);
  const addable = addableBlocks(info.sources, triggerIsForm);
  const index = items.findIndex((i) => i.id === selected);
  const current = index >= 0 ? items[index] : undefined;

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over?.id);
    setItems((list) => moveBlock(list, from, to));
  };

  const update = (block: PageBlock) => setItems((list) => list.map((it) => (it.id === selected ? { ...it, block } : it)));
  const add = (type: PageBlockType) => {
    if (items.length >= MAX_BLOCKS) return;
    const item = { id: nextId(), block: newBlock(type, info.sources) };
    setItems((list) => [...list, item]);
    setSelected(item.id);
  };

  const definition: PageDefinition = { blocks, actions: FLOW_ACTIONS };

  const save = async () => {
    if (readOnly) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await saveFlowPage(flow.id, { definition, title: title.trim(), ...(base.page ? { baseVersion: base.page.version } : {}) });
      setIssues({ blocks: {}, general: [] });
      if (res.created || res.changed) setOwnSave(true);
      setMessage(res.created ? '作りました' : '保存しました');
      await Promise.all([qc.invalidateQueries({ queryKey: flowPageKey(flow.id) }), qc.invalidateQueries({ queryKey: ['page', res.slug] })]);
    } catch (e) {
      const err = apiErrorOf(e, '保存できませんでした');
      const by = issuesByBlock(err.issues);
      setIssues(by);
      setMessage(by.general[0] ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  // プレビュー: フォームはきっかけの項目に合わせ、値は直近の成功した実行（無ければ項目名のダミー）
  const preview = useMemo(() => {
    let def = definition;
    try {
      def = alignFlowPageDefinition(definition, flow.definition as FlowDefinition);
    } catch {
      /* 古い形のフローは合わせずに描く */
    }
    const raw = info.preview.hasRun ? info.preview.raw : dummyRaw(info.sources);
    const projected = projectQueryResult(def, FLOW_PAGE_ACTION_IDS.query, raw);
    const result = {
      data: { ...projected, sample: false },
      isError: false,
      isFetching: false,
      refetch: async () => undefined,
    } as unknown as UseQueryResult<PageQueryData>;
    const ctx: PageContextValue = {
      slug: base.page?.slug ?? flow.slug,
      definition: toPublicPageDefinition(def),
      isAdmin: true,
      connection: 'ok',
      data: { [FLOW_PAGE_ACTION_IDS.query]: result },
    };
    return { ctx, blocks: def.blocks };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- definition は blocks から作る
  }, [blocks, flow.definition, flow.slug, info, base.page?.slug]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-2">
        <label htmlFor="flow-page-title" className="text-xs font-bold text-text-muted">
          題名
        </label>
        <input
          id="flow-page-title"
          value={title}
          maxLength={24}
          onChange={(e) => setTitle(e.target.value)}
          className={`${FIELD_CLASS} w-56`}
        />
        {base.page && (
          <Link to={`/p/${encodeURIComponent(base.page.slug)}`} className="text-sm font-semibold text-accent underline">
            開く
          </Link>
        )}
        <span className={`ml-auto text-sm ${outdated && !message ? 'text-warning' : 'text-text-muted'}`} aria-live="polite">
          {message ?? (outdated ? '他の人が更新しました' : null)}
        </span>
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'secondary'}
          disabled={!dirty || title.trim() === '' || readOnly}
          title={readOnly ? READ_ONLY_REASON : undefined}
          loading={saving}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="部品" className="w-40 shrink-0 overflow-y-auto border-r border-border bg-elevated">
          <ul className="divide-y divide-border">
            {addable.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => add(t)}
                  disabled={items.length >= MAX_BLOCKS}
                  className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm text-primary hover:bg-sunken disabled:text-text-muted"
                >
                  <Plus size={13} aria-hidden="true" className="text-secondary" />
                  {BLOCK_LABEL[t]}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto bg-elevated px-6 py-5" aria-label="プレビュー">
          {!info.preview.hasRun && <p className="mb-3 text-xs text-text-muted">実行の結果がまだ無いので、項目名で表示しています</p>}
          <PageCtx.Provider value={preview.ctx}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                <ol className="mx-auto max-w-3xl divide-y divide-border">
                  {items.map((it, i) => (
                    <SortableBlock
                      key={it.id}
                      id={it.id}
                      label={BLOCK_LABEL[it.block.type]}
                      selected={it.id === selected}
                      issues={issues.blocks[i] ?? []}
                      onSelect={() => setSelected(it.id)}
                    >
                      <BlockRenderer block={preview.blocks[i] ?? it.block} index={i} />
                    </SortableBlock>
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          </PageCtx.Provider>
          {items.length === 0 && <p className="text-sm text-text-muted">左の部品を押して足してください</p>}
        </div>

        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-border bg-elevated" aria-label="ブロックの設定" aria-live="polite">
          {current ? (
            <BlockPanel
              key={current.id}
              block={current.block}
              sources={info.sources}
              issues={issues.blocks[index] ?? []}
              canUp={index > 0}
              canDown={index < items.length - 1}
              onChange={update}
              onMove={(d) => setItems((list) => moveBlock(list, index, index + d))}
              onDelete={() => {
                setItems((list) => removeAt(list, index));
                setSelected(null);
              }}
            />
          ) : (
            <p className="px-5 py-5 text-sm text-text-muted">ブロックを選ぶと設定が出ます</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function SortableBlock({
  id,
  label,
  selected,
  issues,
  onSelect,
  children,
}: {
  id: string;
  label: string;
  selected: boolean;
  issues: string[];
  onSelect: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`border px-3 py-3 ${selected ? 'rounded-sm border-accent bg-accent-soft' : 'border-transparent'}`}
      data-output-block={id}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs text-text-muted">
        <button type="button" aria-label={`${label}を並べ替え`} className="cursor-grab rounded-sm p-1 hover:text-primary" {...attributes} {...listeners}>
          <GripVertical size={13} aria-hidden="true" />
        </button>
        <button type="button" onClick={onSelect} aria-pressed={selected} className="font-bold hover:text-primary">
          {label}
        </button>
        {issues.length > 0 && <span className="text-danger">{issues[0]}</span>}
      </div>
      <fieldset disabled className="min-w-0">
        {children}
      </fieldset>
    </li>
  );
}

// ── 右パネル ─────────────────────────────────────────────

const KPI_FORMATS = [
  { value: 'text', label: '文字' },
  { value: 'number', label: '数' },
  { value: 'yen', label: '円' },
  { value: 'percent', label: '%' },
] as const;
const CELL_FORMATS = [
  { value: 'text', label: '文字' },
  { value: 'number', label: '数' },
  { value: 'yen', label: '円' },
  { value: 'date', label: '日付' },
  { value: 'badge', label: '印' },
] as const;

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border px-5 py-3 first:border-t-0">
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-bold text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function SourceSelect({
  id,
  value,
  sources,
  onChange,
}: {
  id: string;
  value: string;
  sources: FlowPageSource[];
  onChange: (key: string) => void;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
      {!sources.some((s) => s.key === value) && <option value={value}>—</option>}
      {sources.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

export function BlockPanel({
  block,
  sources,
  issues,
  canUp,
  canDown,
  onChange,
  onMove,
  onDelete,
}: {
  block: PageBlock;
  sources: FlowPageSource[];
  issues: string[];
  canUp: boolean;
  canDown: boolean;
  onChange: (b: PageBlock) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const texts = sources.filter((s) => s.type === 'text');
  const rows = sources.filter((s) => s.type === 'rows');
  const columnsOf = (key: string) => rows.find((s) => s.key === key)?.columns ?? [];

  let body: React.ReactNode = null;
  switch (block.type) {
    case 'heading':
      body = (
        <Row label="文字" htmlFor="ob-heading">
          <input id="ob-heading" maxLength={40} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} className={FIELD_CLASS} />
        </Row>
      );
      break;
    case 'text':
      body = (
        <Row label="文字" htmlFor="ob-text">
          <textarea id="ob-text" rows={5} maxLength={500} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} className={FIELD_CLASS} />
        </Row>
      );
      break;
    case 'kpi':
      body = (
        <>
          {block.items.map((item, i) => (
            <Row key={i} label={`数字 ${i + 1}`}>
              <div className="space-y-2">
                <input
                  aria-label="名前"
                  maxLength={8}
                  value={item.label}
                  onChange={(e) => onChange({ ...block, items: block.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                  className={FIELD_CLASS}
                />
                <SourceSelect
                  id={`ob-kpi-${i}`}
                  value={item.source.key}
                  sources={texts}
                  onChange={(key) => onChange({ ...block, items: block.items.map((x, j) => (j === i ? { ...x, source: { ...x.source, key } } : x)) })}
                />
                <div className="flex gap-2">
                  <select
                    aria-label="表示"
                    value={item.format ?? 'number'}
                    onChange={(e) =>
                      onChange({ ...block, items: block.items.map((x, j) => (j === i ? { ...x, format: e.target.value as (typeof KPI_FORMATS)[number]['value'] } : x)) })
                    }
                    className={SELECT_CLASS}
                  >
                    {KPI_FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {block.items.length > 1 && (
                    <Button size="sm" variant="ghost" onClick={() => onChange({ ...block, items: removeAt(block.items, i) })}>
                      外す
                    </Button>
                  )}
                </div>
              </div>
            </Row>
          ))}
          {block.items.length < 4 && texts[0] && (
            <Row label="">
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus size={12} />}
                onClick={() =>
                  onChange({
                    ...block,
                    items: [...block.items, { label: flowPageColumnLabel(texts[0]!.key), source: { action: FLOW_PAGE_ACTION_IDS.query, key: texts[0]!.key }, format: 'text' }],
                  })
                }
              >
                数字
              </Button>
            </Row>
          )}
        </>
      );
      break;
    case 'table': {
      const cols = columnsOf(block.source.key);
      body = (
        <>
          <Row label="データ" htmlFor="ob-table-src">
            <SourceSelect
              id="ob-table-src"
              value={block.source.key}
              sources={rows}
              onChange={(key) =>
                onChange({
                  ...block,
                  source: { ...block.source, key },
                  columns: columnsOf(key).slice(0, 4).map((c) => ({ key: c, label: flowPageColumnLabel(c) })),
                })
              }
            />
          </Row>
          <Row label="列">
            <ul className="divide-y divide-border">
              {cols.map((c) => {
                const col = block.columns.find((x) => x.key === c);
                return (
                  <li key={c} className="flex items-center gap-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`${c} を出す`}
                      checked={!!col}
                      disabled={!!col && block.columns.length === 1}
                      onChange={(e) =>
                        onChange({
                          ...block,
                          columns: e.target.checked
                            ? [...block.columns, { key: c, label: flowPageColumnLabel(c) }].slice(0, 8)
                            : block.columns.filter((x) => x.key !== c),
                        })
                      }
                    />
                    <span className="w-20 truncate text-xs text-secondary">{c}</span>
                    {col && (
                      <select
                        aria-label={`${c} の表示`}
                        value={col.format ?? 'text'}
                        onChange={(e) =>
                          onChange({
                            ...block,
                            columns: block.columns.map((x) => (x.key === c ? { ...x, format: e.target.value as (typeof CELL_FORMATS)[number]['value'] } : x)),
                          })
                        }
                        className={`${SELECT_CLASS} w-24`}
                      >
                        {CELL_FORMATS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          </Row>
        </>
      );
      break;
    }
    case 'list': {
      const cols = columnsOf(block.source.key).map((c) => ({ key: c, label: c }));
      const pick = (field: 'titleKey' | 'subKey' | 'metaKey', id: string, label: string, optional: boolean) => (
        <Row label={label} htmlFor={id}>
          <select
            id={id}
            value={block[field] ?? ''}
            onChange={(e) => {
              const next = { ...block, [field]: e.target.value } as typeof block;
              if (optional && e.target.value === '') delete next[field];
              onChange(next);
            }}
            className={SELECT_CLASS}
          >
            {optional && <option value="">—</option>}
            {cols.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Row>
      );
      body = (
        <>
          <Row label="データ" htmlFor="ob-list-src">
            <SourceSelect
              id="ob-list-src"
              value={block.source.key}
              sources={rows}
              onChange={(key) => onChange({ type: 'list', source: { ...block.source, key }, titleKey: columnsOf(key)[0] ?? 'date', empty: block.empty })}
            />
          </Row>
          {pick('titleKey', 'ob-list-title', '題', false)}
          {pick('subKey', 'ob-list-sub', '補足', true)}
          {pick('metaKey', 'ob-list-meta', '右', true)}
        </>
      );
      break;
    }
    case 'form':
      body = (
        <>
          <Row label="ボタン" htmlFor="ob-form-submit">
            <input id="ob-form-submit" maxLength={6} value={block.submit} onChange={(e) => onChange({ ...block, submit: e.target.value })} className={FIELD_CLASS} />
          </Row>
          <Row label="項目">
            <p className="text-sm text-secondary">きっかけと同じ</p>
          </Row>
        </>
      );
      break;
    case 'buttons':
      body = (
        <Row label="ボタン" htmlFor="ob-button">
          <input
            id="ob-button"
            maxLength={6}
            value={block.items[0]?.label ?? ''}
            onChange={(e) => onChange({ ...block, items: [{ label: e.target.value, action: FLOW_PAGE_ACTION_IDS.submit, style: 'primary' }] })}
            className={FIELD_CLASS}
          />
        </Row>
      );
      break;
    default:
      break;
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <h2 className="text-sm font-extrabold text-primary">{BLOCK_LABEL[block.type]}</h2>
        <div className="ml-auto flex gap-1">
          <button type="button" aria-label="上へ" disabled={!canUp} onClick={() => onMove(-1)} className="rounded-sm p-1.5 text-secondary hover:text-primary disabled:text-text-muted">
            <ArrowUp size={14} aria-hidden="true" />
          </button>
          <button type="button" aria-label="下へ" disabled={!canDown} onClick={() => onMove(1)} className="rounded-sm p-1.5 text-secondary hover:text-primary disabled:text-text-muted">
            <ArrowDown size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {issues.map((m) => (
        <p key={m} className="px-5 pt-3 text-sm text-danger">
          {m}
        </p>
      ))}
      {body}
      <div className="border-t border-border px-5 py-3">
        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={onDelete}>
          削除
        </Button>
      </div>
    </div>
  );
}
