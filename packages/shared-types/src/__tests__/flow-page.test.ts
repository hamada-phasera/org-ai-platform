/* eslint-disable @typescript-eslint/no-explicit-any -- 不正な定義をわざと組み立てるテスト */
import { describe, it, expect } from 'vitest';
import {
  FLOW_PAGE_ACTION_IDS,
  FLOW_PAGE_DATA_KEY_PATTERN,
  FLOW_PARTS,
  FLOW_TEMPLATE_KEYS,
  PAGE_DATA_KEY_PATTERN,
  alignFlowPageDefinition,
  checkFlowPageDefinition,
  cloneFlowTemplate,
  defaultFlowPageDefinition,
  flowDefinitionSchema,
  flowPageSources,
  flowQueryRaw,
  jstDateTime,
  pageDefinitionSchema,
  pageRegisterDefinitionSchema,
  projectQueryResult,
  type FlowDefinition,
  type PageDefinition,
} from '../index';

/** きっかけ（フォーム）→ データ（一覧）→ 出力（ページ・値と表） */
const withPage: FlowDefinition = {
  nodes: [
    { id: 'form', type: 'trigger', label: 'フォーム', config: { mode: 'form', fields: [{ key: 'customer', label: '顧客', type: 'text', required: true }] } },
    { id: 'deals', type: 'data', label: '商談', config: { resource: 'deal', op: 'list', limit: 10 } },
    {
      id: 'out',
      type: 'output',
      label: '出力',
      config: { kind: 'page', values: { total: '{{deals.count}}', who: '{{form.customer}}' }, rows: '{{deals.rows}}' },
    },
  ],
  edges: [
    { from: 'form', to: 'deals' },
    { from: 'deals', to: 'out' },
  ],
} as any;

const manual: FlowDefinition = {
  nodes: [
    { id: 'start', type: 'trigger', label: '手動', config: { mode: 'manual' } },
    { id: 'out', type: 'output', label: '出力', config: { kind: 'page', values: {} } },
  ],
  edges: [{ from: 'start', to: 'out' }],
} as any;

describe('前提', () => {
  it('組み立てたフローはスキーマを通る', () => {
    expect(flowDefinitionSchema.safeParse(withPage).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(manual).success).toBe(true);
  });
  it('key の形は pages.ts と同じ', () => {
    expect(FLOW_PAGE_DATA_KEY_PATTERN.source).toBe(PAGE_DATA_KEY_PATTERN.source);
  });
});

describe('flowPageSources（§6.3）', () => {
  it('出力ノードの値（文字）・表（参照先の列）・履歴（日時・状態・値）', () => {
    const s = flowPageSources(withPage, FLOW_PARTS);
    expect(s.map((x) => [x.key, x.type])).toEqual([
      ['total', 'text'],
      ['who', 'text'],
      ['rows', 'rows'],
      ['runs', 'rows'],
    ]);
    expect(s.find((x) => x.key === 'rows')?.columns).toContain('title');
    expect(s.find((x) => x.key === 'runs')?.columns).toEqual(['date', 'status', 'total', 'who']);
  });
  it('出力ノードが無いフロー（テンプレート）でも履歴だけは選べる', () => {
    const def = cloneFlowTemplate('proposal').definition;
    expect(flowPageSources(def).map((x) => x.key)).toEqual(['runs']);
  });
});

describe('defaultFlowPageDefinition（最初の案）', () => {
  it.each(FLOW_TEMPLATE_KEYS)('テンプレート %s の案は読む側のスキーマを通り、検査で問題が無い', (key) => {
    const t = cloneFlowTemplate(key);
    const page = defaultFlowPageDefinition(t.definition, t.name);
    expect(pageDefinitionSchema.safeParse(page).success).toBe(true);
    expect(checkFlowPageDefinition(page, t.definition)).toEqual([]);
    // n8n の登録経路は flow_* を拒否する（登録トークンでページをフローに結べない）
    expect(pageRegisterDefinitionSchema.safeParse(page).success).toBe(false);
  });
  it('フォームのきっかけならフォーム、手動ならボタン。毎回同じ', () => {
    const a = defaultFlowPageDefinition(withPage, '商談');
    expect(a.blocks.map((b) => b.type)).toEqual(['heading', 'form', 'kpi', 'table', 'table']);
    expect(defaultFlowPageDefinition(withPage, '商談')).toEqual(a);
    const b = defaultFlowPageDefinition(manual, '手動');
    expect(b.blocks.map((x) => x.type)).toContain('buttons');
    expect(b.actions).toEqual({ result: { kind: 'flow_query' }, run: { kind: 'flow_submit' } });
  });
});

describe('alignFlowPageDefinition（フォーム＝きっかけの項目）', () => {
  it('フォームの項目はきっかけの項目で上書きされる（二重に定義しない）', () => {
    const page: PageDefinition = {
      blocks: [{ type: 'form', fields: [{ key: 'evil', label: '別', type: 'text' }], action: 'run', submit: '送る' }],
      actions: { run: { kind: 'flow_submit' }, other: { kind: 'flow_query' } },
    } as any;
    const aligned = alignFlowPageDefinition(page, withPage);
    expect(aligned.blocks[0]).toMatchObject({ type: 'form', submit: '送る', fields: [{ key: 'customer' }] });
    expect(Object.keys(aligned.actions).sort()).toEqual([FLOW_PAGE_ACTION_IDS.query, FLOW_PAGE_ACTION_IDS.submit].sort());
  });
  it('きっかけがフォームでなくなればボタンに、フォームになればフォームに', () => {
    const form = defaultFlowPageDefinition(withPage, 'x');
    const toButtons = alignFlowPageDefinition(form, manual);
    expect(toButtons.blocks[1]).toEqual({ type: 'buttons', items: [{ label: '実行', action: 'run', style: 'primary' }] });
    const back = alignFlowPageDefinition(toButtons, withPage);
    expect(back.blocks[1]).toMatchObject({ type: 'form', action: 'run', submit: '実行' });
    expect(alignFlowPageDefinition(back, withPage)).toEqual(back);
  });
});

describe('checkFlowPageDefinition（保存時の検査）', () => {
  const base = defaultFlowPageDefinition(withPage, '商談');
  it('出力に無いキー・型違い・無い列・行の操作・余計なアクションを落とす', () => {
    const bad: PageDefinition = {
      blocks: [
        { type: 'kpi', items: [{ label: '無い', source: { action: 'result', key: 'nope' } }] },
        { type: 'kpi', items: [{ label: '表', source: { action: 'result', key: 'runs' } }] },
        { type: 'table', source: { action: 'result', key: 'total' }, columns: [{ key: 'a', label: 'a' }] },
        { type: 'table', source: { action: 'result', key: 'runs' }, columns: [{ key: 'secret', label: 's' }] },
        { type: 'list', source: { action: 'result', key: 'rows' }, titleKey: 'nope' },
        { type: 'table', source: { action: 'result', key: 'runs' }, columns: [{ key: 'date', label: '日' }], rowKey: 'date', rowAction: { label: '消す', action: 'run' } },
      ],
      actions: { ...base.actions, extra: { kind: 'query', hook: 'x' } },
    } as any;
    const msgs = checkFlowPageDefinition(bad, withPage).map((i) => i.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'アクションは結果の取得と実行の 2 つだけです',
        'データ「nope」はこのフローの出力にありません',
        '「runs」は表なので数字には使えません',
        '「total」は表ではありません',
        '列「secret」はありません',
        '列「nope」はありません',
        '行の操作は使えません',
      ]),
    );
  });
  it('正しい定義は問題なし', () => {
    expect(checkFlowPageDefinition(base, withPage)).toEqual([]);
  });
});

describe('flowQueryRaw（flow_query の値）', () => {
  it('直近の値・表・履歴を返し、projectQueryResult で宣言した列だけに切り詰められる', () => {
    const page = defaultFlowPageDefinition(withPage, '商談');
    const raw = flowQueryRaw(
      withPage,
      { total: '3', who: '<script>x</script>', rows: [{ title: 'A社', secret: 'pw' }], extra: 'drop' },
      [
        { createdAt: new Date('2026-11-18T15:30:00Z'), status: 'SUCCEEDED', output: { total: '3', who: 'B', nested: { a: 1 } } },
        { createdAt: '2026-11-17T00:00:00Z', status: 'FAILED', output: null },
      ],
    );
    expect(raw.extra).toBeUndefined();
    expect((raw.runs as any[])[0]).toEqual({ date: '2026-11-19 00:30', status: '完了', total: '3', who: 'B' });
    expect((raw.runs as any[])[1]).toMatchObject({ status: '失敗', total: null });
    const projected = projectQueryResult(page, 'result', raw);
    const kpi = projected.blocks.find((b) => b.type === 'kpi') as any;
    expect(kpi.values).toEqual({ 0: '3', 1: '<script>x</script>' });
    const rowsTable = projected.blocks.find((b) => b.type === 'table' && 'rows' in b && b.rows[0]?.cells.title !== undefined) as any;
    expect(rowsTable.rows[0].cells).not.toHaveProperty('secret');
  });
  it('実行が無ければ値は null・履歴は空', () => {
    const raw = flowQueryRaw(withPage, null, []);
    expect(raw).toEqual({ total: null, who: null, rows: [], runs: [] });
  });
  it('日本時間で表示する', () => {
    expect(jstDateTime(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01 00:00');
  });
});
