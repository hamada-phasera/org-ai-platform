import { describe, expect, it } from 'vitest';
import { reorderSlots } from '../PagesSection';

// 設定 > 業務ページ の並び替えで割り当てる番号（レビュー L4）。見えている行の番号の集合だけを使う。

describe('reorderSlots', () => {
  it('番号がばらばらなら、その集合を小さい順に使う（見えないページの番号 1・3 には触れない）', () => {
    // オーナー限定のページが 1 と 3 にあり、管理者に見えているのは 0・2・4
    expect(reorderSlots([2, 0, 4])).toEqual([0, 2, 4]);
  });

  it('同じ番号が並ぶ（既定の 0 のまま）ところだけ +1 ずつ押し出す', () => {
    expect(reorderSlots([0, 0, 0])).toEqual([0, 1, 2]);
    expect(reorderSlots([5, 5, 2])).toEqual([2, 5, 6]);
  });

  it('空・1 行はそのまま', () => {
    expect(reorderSlots([])).toEqual([]);
    expect(reorderSlots([7])).toEqual([7]);
  });
});
