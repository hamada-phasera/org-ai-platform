import { create } from 'zustand';

/**
 * サーバから 402（閲覧のみ）を受けた組織。帯を expired にするためだけに使う。
 *
 * 組織 id で持つのは、組織を切り替えたあとに前の組織の状態が残らないようにするため。
 * 保存はしない（再読み込みで消え、そのときは GET /api/billing の判定に戻る。
 * Checkout から戻るのは全画面の読み込みなので、契約後に古い帯が残らない）。
 */
interface PlanNoticeState {
  readOnlyOrgId: string | null;
  /** 402 を受けた時刻。これより後に取り直した GET /api/billing があれば、そちらを正とする */
  markedAt: number;
  markReadOnly: (orgId: string | null) => void;
  reset: () => void;
}

export const usePlanNoticeStore = create<PlanNoticeState>((set) => ({
  readOnlyOrgId: null,
  markedAt: 0,
  markReadOnly: (orgId) => set({ readOnlyOrgId: orgId, markedAt: Date.now() }),
  reset: () => set({ readOnlyOrgId: null, markedAt: 0 }),
}));
