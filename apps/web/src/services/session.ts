// 組織の切り替え・作成・締め出されたときの復帰（docs/design/multi-tenancy.md §10.2）。
//
// 切り替えの手順:
//   1. サーバで新しいトークンを発行してもらう（所属していない組織なら 403 TENANT_NOT_MEMBER）
//   2. トークン・本人・所属一覧を差し替える
//   3. react-query のキャッシュを全部捨てる（queryKey に組織が入っていないため。E10）
//   4. `/` を読み直す。開いていた URL に前の組織の id（/agents/:id など）が入っていることがあり、
//      メモリ上のストアにも前の組織のデータが残っているので、ページごと作り直すのが一番確実
//      （組織別の persist もこのとき切り替え先の key から読まれる）

import type { MembershipSummary, SessionPayload } from '@org-ai/shared-types';

export interface SessionDeps {
  post: <T>(url: string, body: unknown) => Promise<{ data: { success: boolean; data: T } }>;
  get: <T>(url: string) => Promise<{ data: { success: boolean; data: T } }>;
  setSession: (token: string, user: SessionPayload['user'], memberships: MembershipSummary[]) => void;
  clearQueries: () => void;
  /** ページを読み直す（既定は window.location.assign） */
  navigate: (path: string) => void;
}

export async function applySession(deps: SessionDeps, session: SessionPayload, to = '/'): Promise<void> {
  deps.setSession(session.token, session.user, session.memberships);
  deps.clearQueries();
  deps.navigate(to);
}

export async function switchOrg(deps: SessionDeps, orgId: string): Promise<void> {
  const res = await deps.post<SessionPayload>('/auth/switch-org', { orgId });
  await applySession(deps, res.data.data);
}

export async function createOrg(deps: SessionDeps, name: string): Promise<void> {
  const res = await deps.post<SessionPayload>('/organizations', { name });
  await applySession(deps, res.data.data);
}

/**
 * いまの組織から外された（403 TENANT_ACCESS_REVOKED）ときの復帰。
 * ログアウトはさせない。残っている組織があれば先頭に切り替え、無ければ「所属組織なし」画面へ。
 */
export async function recoverFromRevoked(deps: SessionDeps, currentOrgId: string | null): Promise<'switched' | 'no-org'> {
  const res = await deps.get<MembershipSummary[]>('/auth/memberships');
  const next = res.data.data.find((m) => m.orgId !== currentOrgId);
  if (next) {
    await switchOrg(deps, next.orgId);
    return 'switched';
  }
  deps.clearQueries();
  deps.navigate('/no-org');
  return 'no-org';
}
