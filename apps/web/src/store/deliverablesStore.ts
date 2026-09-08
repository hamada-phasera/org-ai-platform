import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Folder {
  id: string;
  name: string;
  color?: string;
  itemIds: string[]; // ordered task IDs within this folder
}

export type Importance = 'high' | 'mid' | 'low';

interface DeliverablesState {
  folders: Folder[];
  activeFolderId: string;
  deptFilter: string | null;
  typeFilter: string | null;

  // 重要度: AI 推定値 (importance) と手動上書き (importanceOverride)。実効値は override ?? importance ?? 'mid'。
  importance: Record<string, Importance>;
  importanceOverride: Record<string, Importance>;
  setImportanceBatch: (map: Record<string, Importance>) => void;
  cycleImportance: (id: string) => void; // high -> mid -> low -> (AI値に戻す)

  setActiveFolder: (id: string) => void;
  setDeptFilter: (dept: string | null) => void;
  setTypeFilter: (type: string | null) => void;

  reorderInFolder: (folderId: string, activeId: string, overId: string) => void;
  moveToFolder: (itemId: string, targetFolderId: string) => void;
  addItemIfMissing: (itemId: string) => void; // ensure new tasks land in "all"
  removeItem: (itemId: string) => void;

  createFolder: (name: string, color?: string) => string;
  deleteFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;
}

const DEFAULT_FOLDERS: Folder[] = [
  { id: 'all', name: 'すべて', itemIds: [] },
  { id: 'sales', name: '営業部', color: 'var(--dept-sales)', itemIds: [] },
  { id: 'marketing', name: 'マーケ部', color: 'var(--dept-marketing)', itemIds: [] },
  { id: 'accounting', name: '経理部', color: 'var(--dept-accounting)', itemIds: [] },
  { id: 'analytics', name: 'データ分析', color: 'var(--dept-analytics)', itemIds: [] },
  { id: 'general', name: '総合', color: 'var(--dept-general)', itemIds: [] },
];

export const useDeliverablesStore = create<DeliverablesState>()(
  persist(
    (set) => ({
      folders: DEFAULT_FOLDERS,
      activeFolderId: 'all',
      deptFilter: null,
      typeFilter: null,
      importance: {},
      importanceOverride: {},

      setImportanceBatch: (map) =>
        set((state) => ({ importance: { ...state.importance, ...map } })),

      cycleImportance: (id) =>
        set((state) => {
          const order: Importance[] = ['high', 'mid', 'low'];
          const current = state.importanceOverride[id] ?? state.importance[id] ?? 'mid';
          const next = order[(order.indexOf(current) + 1) % order.length];
          const override = { ...state.importanceOverride };
          // 一周して AI 推定値に戻ったら override を解除
          if (state.importance[id] && next === state.importance[id]) delete override[id];
          else override[id] = next;
          return { importanceOverride: override };
        }),

      setActiveFolder: (id) => set({ activeFolderId: id }),
      setDeptFilter: (dept) => set({ deptFilter: dept }),
      setTypeFilter: (type) => set({ typeFilter: type }),

      reorderInFolder: (folderId, activeId, overId) =>
        set((state) => {
          const folders = state.folders.map((f) => {
            if (f.id !== folderId) return f;
            const activeIdx = f.itemIds.indexOf(activeId);
            const overIdx = f.itemIds.indexOf(overId);
            if (activeIdx === -1 || overIdx === -1) return f;
            const next = [...f.itemIds];
            next.splice(activeIdx, 1);
            next.splice(overIdx, 0, activeId);
            return { ...f, itemIds: next };
          });
          return { folders };
        }),

      moveToFolder: (itemId, targetFolderId) =>
        set((state) => {
          if (targetFolderId === 'all') return state; // "all" is virtual
          const folders = state.folders.map((f) => ({
            ...f,
            itemIds:
              f.id === targetFolderId
                ? f.itemIds.includes(itemId)
                  ? f.itemIds
                  : [itemId, ...f.itemIds]
                : f.itemIds.filter((id) => id !== itemId),
          }));
          return { folders };
        }),

      addItemIfMissing: (itemId) =>
        set((state) => {
          const allFolder = state.folders.find((f) => f.id === 'all');
          if (allFolder?.itemIds.includes(itemId)) return state;
          const folders = state.folders.map((f) =>
            f.id === 'all' ? { ...f, itemIds: [itemId, ...f.itemIds] } : f,
          );
          return { folders };
        }),

      removeItem: (itemId) =>
        set((state) => ({
          folders: state.folders.map((f) => ({
            ...f,
            itemIds: f.itemIds.filter((id) => id !== itemId),
          })),
        })),

      createFolder: (name, color) => {
        const id = `folder-${Date.now()}`;
        set((state) => ({
          folders: [...state.folders, { id, name, color, itemIds: [] }],
        }));
        return id;
      },

      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          activeFolderId: state.activeFolderId === id ? 'all' : state.activeFolderId,
        })),

      renameFolder: (id, name) =>
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
        })),
    }),
    {
      name: 'flow-deliverables-v1',
    },
  ),
);
