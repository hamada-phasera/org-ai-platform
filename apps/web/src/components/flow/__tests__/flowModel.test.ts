// フロー画面の純粋関数（docs/design/canvas-home.md §3.4・§4.3・§6.4）。
import { describe, expect, it } from 'vitest';
import { FLOW_PARTS, cloneFlowTemplate, flowDefinitionSchema, type FlowDefinition, type FlowNodeType } from '@org-ai/shared-types';
import {
  addFlowNode,
  addableTypes,
  connectFlowNodes,
  defaultNode,
  describeRef,
  flowChanged,
  formatDuration,
  insertCandidates,
  issuesByNode,
  mobileTextFields,
  normalizeDefinition,
  removeFlowNodes,
  stepOutputHead,
  stepRows,
} from '../flowModel';
import { pollDelayMs, runBlockReason, runSettled } from '../flowApi';
import { validateDefinition } from '../FlowEditor';

const proposal = () => cloneFlowTemplate('proposal');

const BRANCH: FlowDefinition = {
  nodes: [
    { id: 'form', type: 'trigger', label: 'フォーム', config: { mode: 'form', fields: [{ key: 'amount', label: '金額', type: 'number', required: true }] } },
    { id: 'big', type: 'branch', label: '大口', config: { left: '{{form.amount}}', op: 'gt', right: 100 } },
    { id: 'yes', type: 'output', label: '大', config: { kind: 'page', values: { size: '{{form.amount}}' } } },
    { id: 'deals', type: 'data', label: '商談', config: { resource: 'deal', op: 'list', limit: 5 } },
  ],
  edges: [
    { from: 'form', to: 'big' },
    { from: 'big', to: 'yes', when: 'yes' },
    { from: 'big', to: 'deals', when: 'no' },
  ],
};

describe('stepRows（スマホの番号。§4.3）', () => {
  it('直線は 1〜4', () => {
    expect(stepRows(proposal().definition).map((r) => r.number)).toEqual(['1', '2', '3', '4']);
  });
  it('分岐は 3a / 3b と字下げ 1 段', () => {
    const rows = stepRows(BRANCH);
    expect(rows.map((r) => [r.node.id, r.number, r.depth])).toEqual([
      ['form', '1', 0],
      ['big', '2', 0],
      ['yes', '3a', 1],
      ['deals', '3b', 1],
    ]);
  });
  it('循環（保存前の壊れた形）は定義の並び順', () => {
    const def = { ...BRANCH, edges: [...BRANCH.edges, { from: 'yes', to: 'big' }] } as FlowDefinition;
    expect(stepRows(def).map((r) => r.number)).toEqual(['1', '2', '3', '4']);
  });
  it('古い形の行（nodes が無い）でも落ちない', () => {
    expect(stepRows(normalizeDefinition({ foo: 1 }))).toEqual([]);
  });
});

describe('insertCandidates（値の差し込み。§3.4・§6.4）', () => {
  it('上流のノードの出力だけ。フォームの項目は利用者の名前で出す。組み込みは文字のときだけ', () => {
    const c = insertCandidates(proposal().definition, 'check', FLOW_PARTS);
    expect(c.map((g) => g.node)).toEqual(['form', 'draft', 'run', 'org']);
    expect(c[0].keys.map((k) => k.title)).toContain('顧客名');
    expect(c[1].keys).toEqual([{ key: 'text', type: 'text', ref: '{{draft.text}}', title: '文章' }]);
    // 下流（doc）は出ない
    expect(c.some((g) => g.node === 'doc')).toBe(false);
    expect(insertCandidates(proposal().definition, 'check', FLOW_PARTS, 'any').map((g) => g.node)).toEqual(['form', 'draft']);
  });
  it('表を受ける項目には表だけ', () => {
    const c = insertCandidates(BRANCH, 'yes', FLOW_PARTS, 'rows');
    expect(c).toEqual([]);
    const def: FlowDefinition = {
      nodes: [...BRANCH.nodes.slice(0, 1), BRANCH.nodes[3], { id: 'out', type: 'output', label: '出', config: { kind: 'page', values: {} } }],
      edges: [
        { from: 'form', to: 'deals' },
        { from: 'deals', to: 'out' },
      ],
    };
    expect(insertCandidates(def, 'out', FLOW_PARTS, 'rows')[0].keys.map((k) => k.ref)).toEqual(['{{deals.rows}}']);
  });
  it('参照の見出し', () => {
    expect(describeRef(BRANCH, '{{form.amount}}')).toBe('フォーム › 金額');
    expect(describeRef(BRANCH, '{{run.date}}')).toBe('実行 › 実行日');
    expect(describeRef(BRANCH, 'x')).toBe('');
  });
});

describe('issuesByNode（保存の検証エラーをノードへ）', () => {
  it('nodes[i] はそのノード、edges[i] は線の元、それ以外は全体', () => {
    const m = issuesByNode(BRANCH, [
      { path: ['nodes', 1, 'config', 'right'], message: '比べる値が要ります' },
      { path: ['edges', 2], message: '線の端' },
      { path: ['nodes'], message: 'きっかけはちょうど 1 つ必要です' },
      { path: [], message: 'x', nodeId: 'deals' },
      { path: ['nodes', 1], message: '比べる値が要ります' },
    ]);
    expect(m.nodes.big).toEqual(['比べる値が要ります', '線の端']);
    expect(m.nodes.deals).toEqual(['x']);
    expect(m.general).toEqual(['きっかけはちょうど 1 つ必要です']);
  });
  it('画面の検証（gateway と同じスキーマ）で空の指示はそのノードに出る', () => {
    const def = proposal().definition;
    const draft = def.nodes[1];
    if (draft.type !== 'ai') throw new Error('ai');
    draft.config.instruction = '';
    const m = issuesByNode(def, validateDefinition(def));
    expect(Object.keys(m.nodes)).toEqual(['draft']);
  });
});

describe('編集（§3.4）', () => {
  it('既定値のまま後ろに足すと保存できる形になる（分岐は比べる値、部品は必須の入力を埋めるまで印が付く）', () => {
    for (const t of ['ai', 'approval', 'data', 'output'] as FlowNodeType[]) {
      const t0 = proposal();
      const res = addFlowNode(t0.definition, t0.layout, defaultNode(t0.definition, t, FLOW_PARTS), { after: 'doc' });
      expect(res, t).not.toBeNull();
      expect(validateDefinition(res!.def), t).toEqual([]);
      expect(res!.layout[res!.id]).toEqual({ x: 0, y: t0.layout.doc.y + 140 });
    }
    const t0 = proposal();
    for (const t of ['branch', 'part'] as FlowNodeType[]) {
      const res = addFlowNode(t0.definition, t0.layout, defaultNode(t0.definition, t, FLOW_PARTS), { after: 'doc' })!;
      const m = issuesByNode(res.def, validateDefinition(res.def));
      expect(Object.keys(m.nodes), t).toEqual([res.id]);
    }
  });
  it('線の途中に挟むと前後をつなぎ、下は 1 段ずれる。分岐の yes / no は引き継ぐ', () => {
    const t0 = proposal();
    const res = addFlowNode(t0.definition, t0.layout, defaultNode(t0.definition, 'ai', FLOW_PARTS), { onEdge: { from: 'draft', to: 'check' } })!;
    expect(res.def.edges).toContainEqual({ from: 'draft', to: 'ai1' });
    expect(res.def.edges).toContainEqual({ from: 'ai1', to: 'check' });
    expect(res.def.edges).not.toContainEqual({ from: 'draft', to: 'check' });
    expect(res.layout.doc.y).toBe(t0.layout.doc.y + 140);
    const b = addFlowNode(BRANCH, {}, defaultNode(BRANCH, 'approval', FLOW_PARTS), { onEdge: { from: 'big', to: 'yes', when: 'yes' } })!;
    expect(b.def.edges).toContainEqual({ from: 'big', to: 'approval1', when: 'yes' });
  });
  it('きっかけは 1 つだけ・上限で null・追加メニューから消える', () => {
    const t0 = proposal();
    expect(addFlowNode(t0.definition, t0.layout, defaultNode(t0.definition, 'trigger', FLOW_PARTS))).toBeNull();
    expect(addableTypes(t0.definition)).not.toContain('trigger');
    const full = { nodes: Array.from({ length: 30 }, (_, i) => ({ ...t0.definition.nodes[1], id: `n${i}` })), edges: [] } as unknown as FlowDefinition;
    expect(addableTypes(full)).toEqual([]);
  });
  it('分岐からの線は はい → いいえ の順、3 本目は引けない。きっかけに入る線・自己ループ・重複は引けない', () => {
    const base: FlowDefinition = { nodes: BRANCH.nodes, edges: [{ from: 'form', to: 'big' }] };
    const one = connectFlowNodes(base, 'big', 'yes');
    expect(one.edges.at(-1)).toEqual({ from: 'big', to: 'yes', when: 'yes' });
    const two = connectFlowNodes(one, 'big', 'deals');
    expect(two.edges.at(-1)).toEqual({ from: 'big', to: 'deals', when: 'no' });
    expect(connectFlowNodes(connectFlowNodes(two, 'yes', 'deals'), 'big', 'form')).toEqual(connectFlowNodes(two, 'yes', 'deals'));
    expect(connectFlowNodes(two, 'deals', 'deals')).toBe(two);
    expect(connectFlowNodes(two, 'form', 'big')).toBe(two);
  });
  it('消すと前後をつなぎ直す。きっかけは消せない', () => {
    const t0 = proposal();
    const r = removeFlowNodes(t0.definition, t0.layout, ['check', 'form']);
    expect(r.def.nodes.map((n) => n.id)).toEqual(['form', 'draft', 'doc']);
    expect(r.def.edges).toContainEqual({ from: 'draft', to: 'doc' });
    expect(r.layout.check).toBeUndefined();
  });
  it('変更の判定', () => {
    const t0 = proposal();
    const a = { def: t0.definition, layout: t0.layout, name: '提案書' };
    expect(flowChanged(a, { ...a })).toBe(false);
    expect(flowChanged(a, { ...a, name: '別' })).toBe(true);
    expect(flowChanged(a, { ...a, layout: { ...t0.layout, form: { x: 1, y: 0 } } })).toBe(true);
  });
  it('テンプレートの定義はそのままスキーマを通る（画面の検証と gateway が同じ）', () => {
    expect(flowDefinitionSchema.safeParse(proposal().definition).success).toBe(true);
  });
});

describe('スマホ・表示の小物', () => {
  it('スマホで変えられる文字は 指示・確認の文言・文書の題名と本文だけ（K46）', () => {
    const def = proposal().definition;
    expect(def.nodes.map((n) => mobileTextFields(n).map((f) => f.key))).toEqual([[], ['instruction'], ['message', 'preview'], ['title', 'body']]);
    expect(mobileTextFields(BRANCH.nodes[1])).toEqual([]);
  });
  it('結果の先頭と所要時間', () => {
    expect(stepOutputHead({ status: 'SUCCEEDED', attempts: 1, output: { text: 'あ'.repeat(300) } }, 10)).toBe(`${'あ'.repeat(10)}…`);
    expect(stepOutputHead({ status: 'SUCCEEDED', attempts: 1, output: { rows: [1, 2], count: 2 } })).toBe('表: 2 行\n件数: 2');
    expect(stepOutputHead({ status: 'SUCCEEDED', attempts: 1, output: { text: '<script>x</script>' } })).toBe('<script>x</script>');
    expect(formatDuration(4200)).toBe('4.2 秒');
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
    expect(formatDuration(null)).toBe('');
  });
  it('未保存では実行できない・無効・上限（§3.4・§7.6）', () => {
    const usage = { flows: { count: 1, limit: 3 }, runs: { used: 300, limit: 300, state: 'over' as const, blocked: true }, partCalls: { used: 0, limit: 100, state: 'ok' as const, blocked: false } };
    expect(runBlockReason({ dirty: true, enabled: true, valid: true })).toBe('保存してから実行してください');
    expect(runBlockReason({ dirty: false, enabled: false, valid: true })).toBe('無効になっています');
    expect(runBlockReason({ dirty: false, enabled: true, valid: true, usage })).toBe('今月の実行数の上限です');
    expect(runBlockReason({ dirty: false, enabled: true, valid: true })).toBeNull();
  });
  it('取りに行く間隔は 2 秒、30 秒過ぎたら 5 秒。承認待ちで止める', () => {
    expect(pollDelayMs(0)).toBe(2000);
    expect(pollDelayMs(31_000)).toBe(5000);
    expect(runSettled('WAITING_APPROVAL')).toBe(true);
    expect(runSettled('RUNNING')).toBe(false);
  });
});
