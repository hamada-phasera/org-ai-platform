import { describe, expect, it } from 'vitest';
import {
  CANVAS_LINK_PATHS,
  DEFAULT_CANVAS_LAYOUT,
  canvasLayoutSchema,
  defaultCanvasLayout,
  isCanvasLinkPath,
  type CanvasLayout,
} from '@org-ai/shared-types';
import {
  CANVAS_SCREENS,
  addMenuSections,
  addNode,
  boardInteraction,
  clampCoord,
  clampLabel,
  connectNodes,
  layoutChanged,
  moveNode,
  nextNodeId,
  removeEdge,
  removeNodes,
} from '../canvasEdit';
import type { CanvasFlowSummary } from '../canvasToList';

const valid = (layout: CanvasLayout) => canvasLayoutSchema.safeParse(layout).success;

describe('boardInteraction（閲覧モードではノードが動かない）', () => {
  it('閲覧モード: 動かない・繋がらない・選べない・消せない', () => {
    const v = boardInteraction(false);
    expect(v.nodesDraggable).toBe(false);
    expect(v.nodesConnectable).toBe(false);
    expect(v.elementsSelectable).toBe(false);
    expect(v.edgesFocusable).toBe(false);
    expect(v.deleteKeyCode).toBeNull();
  });

  it('編集モード: 移動・接続・選択・Delete で削除', () => {
    const e = boardInteraction(true);
    expect(e.nodesDraggable).toBe(true);
    expect(e.nodesConnectable).toBe(true);
    expect(e.elementsSelectable).toBe(true);
    expect(e.deleteKeyCode).toContain('Delete');
  });

  it('ノードの外枠にはフォーカスを置かない（中身の button だけ）', () => {
    expect(boardInteraction(false).nodesFocusable).toBe(false);
    expect(boardInteraction(true).nodesFocusable).toBe(false);
  });
});

describe('編集の操作', () => {
  it('移動は −5000〜5000 の整数に丸める', () => {
    const next = moveNode(defaultCanvasLayout(), 'inquiry', 12.6, 99999);
    const n = next.nodes.find((x) => x.id === 'inquiry')!;
    expect([n.x, n.y]).toEqual([13, 5000]);
    expect(clampCoord(-Infinity)).toBe(0);
    expect(valid(next)).toBe(true);
  });

  it('削除はつながる線ごと消す', () => {
    const next = removeNodes(defaultCanvasLayout(), ['proposal']);
    expect(next.nodes.some((n) => n.id === 'proposal')).toBe(false);
    expect(next.edges.some((e) => e.from === 'proposal' || e.to === 'proposal')).toBe(false);
    expect(next.edges).toEqual([{ from: 'estimate', to: 'invoice' }]);
    expect(valid(next)).toBe(true);
  });

  it('線: 自己ループ・重複・端の無い線は引かない', () => {
    const base = defaultCanvasLayout();
    expect(connectNodes(base, 'sns', 'sns')).toBe(base);
    expect(connectNodes(base, 'inquiry', 'proposal')).toBe(base);
    expect(connectNodes(base, 'inquiry', 'nope')).toBe(base);
    const next = connectNodes(base, 'cost', 'numbers');
    expect(next.edges).toContainEqual({ from: 'cost', to: 'numbers' });
    expect(valid(next)).toBe(true);
    expect(removeEdge(next, 'cost', 'numbers').edges).toEqual(base.edges);
  });

  it('循環する線も引ける（業務の地図は循環しうる。§6.6）', () => {
    const next = connectNodes(defaultCanvasLayout(), 'invoice', 'inquiry');
    expect(next.edges).toContainEqual({ from: 'invoice', to: 'inquiry' });
    expect(valid(next)).toBe(true);
  });

  it('追加: ID は n1, n2 …、いちばん下の段の下に置く。結果は配置スキーマを通る', () => {
    const base = defaultCanvasLayout();
    const res = addNode(base, { label: '日報', icon: 'clipboard-list', target: { kind: 'link', to: '/chat' } })!;
    expect(res.id).toBe('n1');
    const added = res.layout.nodes.find((n) => n.id === 'n1')!;
    expect(added.y).toBe(Math.max(...base.nodes.map((n) => n.y)) + 160);
    expect(valid(res.layout)).toBe(true);
    expect(nextNodeId(res.layout)).toBe('n2');
  });

  it('追加: 40 個で止める', () => {
    let layout: CanvasLayout = { nodes: [], edges: [] };
    for (let i = 0; i < 40; i++) {
      const res = addNode(layout, { label: `業務${i}`, icon: 'file-text', target: { kind: 'link', to: '/chat' } });
      layout = res!.layout;
    }
    expect(layout.nodes).toHaveLength(40);
    expect(addNode(layout, { label: 'x', icon: 'file-text', target: { kind: 'link', to: '/chat' } })).toBeNull();
    expect(valid(layout)).toBe(true);
  });

  it('ラベルは 8 文字まで（サロゲートを切らない）・空は既定', () => {
    expect(clampLabel('とても長い業務の名前です')).toBe('とても長い業務の');
    expect(clampLabel('😀😀😀😀😀')).toBe('😀😀😀😀');
    expect(clampLabel('   ')).toBe('業務');
  });

  it('変更の判定', () => {
    const base = defaultCanvasLayout();
    expect(layoutChanged(base, defaultCanvasLayout())).toBe(false);
    expect(layoutChanged(base, moveNode(base, 'sns', 0, 0))).toBe(true);
  });

  it('既定の配置の定数を書き換えない', () => {
    const before = JSON.stringify(DEFAULT_CANVAS_LAYOUT);
    removeNodes(DEFAULT_CANVAS_LAYOUT, ['inquiry']);
    moveNode(DEFAULT_CANVAS_LAYOUT, 'sns', 1, 1);
    expect(JSON.stringify(DEFAULT_CANVAS_LAYOUT)).toBe(before);
  });
});

describe('追加メニュー（テンプレート／フロー／画面）', () => {
  const flows: CanvasFlowSummary[] = [
    { id: 'f1', slug: 'proposal', name: '提案書', icon: 'file-text', enabled: true, templateKey: 'proposal' },
    { id: 'f2', slug: 'daily-report-long', name: 'とても長い日報のフロー', icon: 'not-an-icon', enabled: true, templateKey: null },
  ];

  it('画面の一覧は shared-types の許可リスト（固定のパス）と 1 対 1', () => {
    expect(Object.keys(CANVAS_SCREENS).sort()).toEqual([...CANVAS_LINK_PATHS].sort());
    for (const to of Object.keys(CANVAS_SCREENS)) expect(isCanvasLinkPath(to)).toBe(true);
  });

  it('作成済みのテンプレートはテンプレート側に出さず、フロー側に出す', () => {
    const s = addMenuSections(defaultCanvasLayout(), flows);
    expect(s.templates.map((t) => t.key)).toEqual(['template:estimate', 'template:invoice', 'template:sns_post']);
    expect(s.flows.map((f) => f.key)).toEqual(['flow:f1', 'flow:f2']);
  });

  it('既にキャンバスにある行き先は「配置済み」（テンプレートのノードが指すフローも）', () => {
    const s = addMenuSections(defaultCanvasLayout(), flows);
    expect(s.flows.find((f) => f.key === 'flow:f1')!.onCanvas).toBe(true);
    expect(s.flows.find((f) => f.key === 'flow:f2')!.onCanvas).toBe(false);
    expect(s.templates.find((t) => t.key === 'template:estimate')!.onCanvas).toBe(true);
    expect(s.screens.find((x) => x.key === 'link:/accounting')!.onCanvas).toBe(true);
    expect(s.screens.find((x) => x.key === 'link:/sales')!.onCanvas).toBe(false);
  });

  it('フローの名前は 8 文字に切り、知らないアイコンは既定にする。足した配置はスキーマを通る', () => {
    const s = addMenuSections(defaultCanvasLayout(), flows);
    const f2 = s.flows.find((f) => f.key === 'flow:f2')!;
    expect(f2.label).toBe('とても長い日報の');
    expect(f2.icon).toBe('file-text');
    let layout = defaultCanvasLayout();
    for (const e of [...s.templates, ...s.flows, ...s.screens].filter((x) => !x.onCanvas)) {
      layout = addNode(layout, e)!.layout;
    }
    expect(valid(layout)).toBe(true);
  });
});
