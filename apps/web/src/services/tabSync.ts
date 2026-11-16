// 別のタブでの組織の切り替え・ログアウトに追従する（docs/design/multi-tenancy.md ADR-3）。
// トークンは localStorage（key 'auth'）で全タブ共有なので、別のタブで切り替えると
// このタブの次のリクエストは新しい組織になる。画面に前の組織が残ったまま操作させないよう読み直す。

import { AUTH_STORAGE_KEY, useAuthStore } from '../store/authStore';

export function orgIdInAuthSnapshot(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { state?: { user?: { orgId?: string | null } } }).state?.user?.orgId ?? null;
  } catch {
    return null;
  }
}

export function watchOtherTabs(): void {
  window.addEventListener('storage', (e) => {
    if (e.key !== AUTH_STORAGE_KEY) return;
    const before = useAuthStore.getState().user?.orgId ?? null;
    const after = orgIdInAuthSnapshot(e.newValue);
    if (before === after) return;
    window.alert(after ? '別のタブで組織が切り替わりました。画面を読み直します。' : '別のタブでログアウトしました。');
    window.location.assign(after ? '/' : '/login');
  });
}
