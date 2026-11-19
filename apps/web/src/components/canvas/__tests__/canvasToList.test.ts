import { describe, expect, it } from 'vitest';
import { DEFAULT_CANVAS_LAYOUT, type CanvasLayout, type CanvasNode } from '@org-ai/shared-types';
import {
  canOpenTarget,
  canvasToList,
  isApprovalsTarget,
  isUncreated,
  nextText,
  orderCanvasNodes,
  resolveTarget,
  type CanvasFlowSummary,
} from '../canvasToList';

const node = (id: string, x: number, y: number, target: CanvasNode['target'] = { kind: 'link', to: '/inbox' }): CanvasNode => ({
  id,
  label: id.toUpperCase(),
  icon: 'file-text',
  x,
  y,
  target,
});

const flow = (over: Partial<CanvasFlowSummary> = {}): CanvasFlowSummary => ({
  id: 'f1',
  slug: 'proposal',
  name: '提案書',
  icon: 'file-text',
  enabled: true,
  templateKey: 'proposal',
  ...over,
});

describe('orderCanvasNodes（§4.2 の並び）', () => {
  it('線をたどった順。線の無いノードは末尾', () => {
    const layout: CanvasLayout = {
      nodes: [node('c', 400, 0), node('lonely', 0, -100), node('a', 0, 0), node('b', 200, 0)],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    expect(orderCanvasNodes(layout).map((n) => n.id)).toEqual(['a', 'b', 'c', 'lonely']);
  });

  it('同順位は上 → 下、左 → 右', () => {
    const layout: CanvasLayout = {
      nodes: [node('root', 0, 0), node('right', 300, 100), node('low', 0, 200), node('left', 100, 100)],
      edges: [
        { from: 'root', to: 'right' },
        { from: 'root', to: 'low' },
        { from: 'root', to: 'left' },
      ],
    };
    expect(orderCanvasNodes(layout).map((n) => n.id)).toEqual(['root', 'left', 'right', 'low']);
  });

  it('循環があれば線のあるノードを配置順に（落ちない・欠けない）', () => {
    const layout: CanvasLayout = {
      nodes: [node('b', 200, 0), node('a', 0, 0), node('solo', 0, 300), node('c', 0, 100)],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    };
    expect(orderCanvasNodes(layout).map((n) => n.id)).toEqual(['a', 'b', 'c', 'solo']);
  });

  it('既定の配置: 問い合わせ → 提案書 → … の順で、線の無い原価・SNS・数字は末尾', () => {
    expect(orderCanvasNodes(DEFAULT_CANVAS_LAYOUT).map((n) => n.label)).toEqual([
      '問い合わせ',
      '提案書',
      '見積',
      '承認',
      '請求',
      '原価',
      'SNS',
      '数字',
    ]);
  });
});

describe('canvasToList', () => {
  it('「次: 〇〇」は出る線の先（最大 2 つ＋ほか）', () => {
    const layout: CanvasLayout = {
      nodes: [node('a', 0, 0), node('b', 200, 0), node('c', 200, 100), node('d', 200, 200)],
      edges: [
        { from: 'a', to: 'd' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    };
    const [a, b] = canvasToList(layout, []);
    expect(a.next).toEqual(['B', 'C']);
    expect(a.nextMore).toBe(true);
    expect(nextText(a)).toBe('B・C ほか');
    expect(nextText(b)).toBeNull();
  });

  it('既定の配置: 提案書の次は「見積・承認」', () => {
    const rows = canvasToList(DEFAULT_CANVAS_LAYOUT, []);
    expect(nextText(rows.find((r) => r.id === 'proposal')!)).toBe('見積・承認');
    expect(nextText(rows.find((r) => r.id === 'inquiry')!)).toBe('提案書');
  });

  it('入力の配置を書き換えない', () => {
    const before = JSON.stringify(DEFAULT_CANVAS_LAYOUT);
    canvasToList(DEFAULT_CANVAS_LAYOUT, [flow()]);
    expect(JSON.stringify(DEFAULT_CANVAS_LAYOUT)).toBe(before);
  });
});

describe('resolveTarget（§3.3）', () => {
  it('flow: 見られるフローならそれ、消えた・見えないフローは missing', () => {
    expect(resolveTarget({ target: { kind: 'flow', flowId: 'f1' } }, [flow()])).toEqual({ kind: 'flow', flowId: 'f1', enabled: true });
    expect(resolveTarget({ target: { kind: 'flow', flowId: 'gone' } }, [flow()])).toEqual({ kind: 'missing' });
  });

  it('template: 同じテンプレートのフローが既にあればそれを開く（キャンバスの書き換えを諦めた作成。K47）', () => {
    expect(resolveTarget({ target: { kind: 'template', templateKey: 'proposal' } }, [flow()])).toEqual({
      kind: 'flow',
      flowId: 'f1',
      enabled: true,
    });
    expect(resolveTarget({ target: { kind: 'template', templateKey: 'estimate' } }, [flow()])).toEqual({
      kind: 'template',
      templateKey: 'estimate',
    });
  });

  it('未作成の印と押せるか: テンプレートは作れる人だけ、消えたフローは誰も押せない', () => {
    const tpl = { kind: 'template', templateKey: 'estimate' } as const;
    expect(isUncreated(tpl)).toBe(true);
    expect(isUncreated({ kind: 'missing' })).toBe(true);
    expect(isUncreated({ kind: 'link', to: '/inbox' })).toBe(false);
    expect(canOpenTarget(tpl, true)).toBe(true);
    expect(canOpenTarget(tpl, false)).toBe(false);
    expect(canOpenTarget({ kind: 'missing' }, true)).toBe(false);
    expect(canOpenTarget({ kind: 'link', to: '/inbox' }, false)).toBe(true);
  });

  it('承認件数の印は受信の承認タブのノードだけ', () => {
    expect(isApprovalsTarget({ kind: 'link', to: '/inbox?tab=approvals' })).toBe(true);
    expect(isApprovalsTarget({ kind: 'link', to: '/inbox' })).toBe(false);
  });
});
