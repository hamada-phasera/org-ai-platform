import { describe, expect, it } from 'vitest';
import { FLOW_PAGE_ACTION_IDS, checkFlowPageDefinition, cloneFlowTemplate, pageDefinitionSchema, type FlowPageSource } from '@org-ai/shared-types';
import { addableBlocks, dummyRaw, issuesByBlock, moveBlock, newBlock, removeAt } from '../outputModel';

const SOURCES: FlowPageSource[] = [
  { key: 'total', label: 'total', type: 'text' },
  { key: 'runs', label: '履歴', type: 'rows', columns: ['date', 'status', 'total'] },
];

describe('出力ビルダーの純粋関数（§3.5）', () => {
  it('部品の一覧: 実行はきっかけに合う方だけ。値が無ければ数字、表が無ければ表・一覧を出さない', () => {
    expect(addableBlocks(SOURCES, true)).toEqual(['heading', 'text', 'kpi', 'table', 'list', 'form']);
    expect(addableBlocks([SOURCES[1]!], false)).toEqual(['heading', 'text', 'table', 'list', 'buttons']);
    expect(addableBlocks([], false)).toEqual(['heading', 'text', 'buttons']);
  });

  it('足したブロックはデータを候補から選んでおり、読む側のスキーマと出力の検査を通る', () => {
    const def = cloneFlowTemplate('proposal').definition;
    const sources: FlowPageSource[] = [{ key: 'runs', label: '履歴', type: 'rows', columns: ['date', 'status'] }];
    for (const t of ['heading', 'text', 'table', 'list', 'form'] as const) {
      const page = {
        blocks: [newBlock(t, sources)],
        actions: { [FLOW_PAGE_ACTION_IDS.query]: { kind: 'flow_query' as const }, [FLOW_PAGE_ACTION_IDS.submit]: { kind: 'flow_submit' as const } },
      };
      expect(pageDefinitionSchema.safeParse(page).success).toBe(true);
      expect(checkFlowPageDefinition(page, def)).toEqual([]);
    }
  });

  it('並べ替え・削除・ダミー値・issues の振り分け', () => {
    expect(moveBlock(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveBlock(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(dummyRaw(SOURCES)).toEqual({ total: 'total', runs: [{ date: '日時', status: '状態', total: 'total' }] });
    expect(issuesByBlock([{ path: ['blocks', 2, 'text'], message: 'x' }, { path: ['actions'], message: 'y' }])).toEqual({
      blocks: { 2: ['x'] },
      general: ['y'],
    });
  });
});
