// 組織ごとに分ける localStorage（docs/design/multi-tenancy.md §10.2 / E10）。
//
// zustand の persist に渡すと、保存先の key が `${name}:${orgId}` になる。組織を切り替えた後に
// 前の組織のフォルダ構成などが見えたり、混ざって保存されたりしない。
// 以前の（組織の入っていない）key は、最初に開いた組織へ1回だけ引き継ぐ（その後は消す）。

import type { StateStorage } from 'zustand/middleware';

export function orgScopedKey(name: string, orgId: string | null): string {
  return `${name}:${orgId ?? 'no-org'}`;
}

export function createOrgScopedStorage(
  getOrgId: () => string | null,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = globalThis.localStorage,
): StateStorage {
  return {
    getItem(name) {
      const key = orgScopedKey(name, getOrgId());
      const scoped = storage.getItem(key);
      if (scoped !== null) return scoped;
      // 移行: 組織の入っていない古い key があれば、今の組織に1回だけ移す
      const legacy = storage.getItem(name);
      if (legacy !== null && getOrgId()) {
        storage.setItem(key, legacy);
        storage.removeItem(name);
        return legacy;
      }
      return null;
    },
    setItem(name, value) {
      storage.setItem(orgScopedKey(name, getOrgId()), value);
    },
    removeItem(name) {
      storage.removeItem(orgScopedKey(name, getOrgId()));
    },
  };
}
