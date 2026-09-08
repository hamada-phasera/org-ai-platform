import { create } from 'zustand';

/**
 * トップバー常設の部署トグル（v3）。null = すべて。
 *
 * 現時点で実データに連動しているのはチャット（送信時の department 指定）のみ。
 * 他ページへの連動は受信箱スプリントで広げる — ここが唯一の選択状態の置き場。
 */
interface DeptFilterState {
  dept: string | null;
  setDept: (dept: string | null) => void;
}

export const useDeptFilterStore = create<DeptFilterState>((set) => ({
  dept: null,
  setDept: (dept) => set({ dept }),
}));
