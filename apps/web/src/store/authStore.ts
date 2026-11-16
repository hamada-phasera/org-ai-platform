import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MembershipSummary, User } from '@org-ai/shared-types';

/**
 * ログイン状態。トークンは**1つの組織用**（JWT の orgId = アクティブ組織。docs/design/multi-tenancy.md ADR-3）。
 * 組織を切り替えるとトークンごと差し替わる（services/session.ts の switchOrg）。
 */
interface AuthState {
  user: User | null;
  token: string | null;
  /** 所属している組織の一覧（スイッチャー用。サーバが正本で、ここは表示用の写し） */
  memberships: MembershipSummary[];
  login: (token: string, user: User, memberships?: MembershipSummary[]) => void;
  /** 組織の切り替え・作成・招待の受諾で、トークンと本人とアクティブ組織をまとめて差し替える */
  setSession: (token: string, user: User, memberships: MembershipSummary[]) => void;
  setMemberships: (memberships: MembershipSummary[]) => void;
  logout: () => void;
}

export const AUTH_STORAGE_KEY = 'auth';

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      memberships: [],
      login: (token, user, memberships) => set({ token, user, memberships: memberships ?? [] }),
      setSession: (token, user, memberships) => set({ token, user, memberships }),
      setMemberships: (memberships) => set({ memberships }),
      logout: () => set({ token: null, user: null, memberships: [] }),
    }),
    { name: AUTH_STORAGE_KEY },
  ),
);

/** いまのアクティブ組織（無ければ null）。 */
export function activeOrgId(): string | null {
  return useAuthStore.getState().user?.orgId ?? null;
}
