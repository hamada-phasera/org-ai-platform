import { describe, it, expect, vi } from 'vitest';
import { switchOrg, createOrg, recoverFromRevoked, type SessionDeps } from '../session';
import { orgIdInAuthSnapshot } from '../tabSync';

// 組織の切り替え（docs/design/multi-tenancy.md §10.2 / §11.8）

const SESSION = {
  token: 'tok-B',
  user: { id: 'u', email: 'u@example.com', name: 'U', role: 'MEMBER' as const, orgId: 'org-B' },
  memberships: [{ orgId: 'org-B', orgName: 'B', plan: 'PRO', role: 'MEMBER' as const }],
};

function deps(over: Partial<SessionDeps> = {}) {
  const calls: string[] = [];
  const d: SessionDeps = {
    post: vi.fn(async () => ({ data: { success: true, data: SESSION } })) as SessionDeps['post'],
    get: vi.fn(async () => ({ data: { success: true, data: [] } })) as SessionDeps['get'],
    setSession: vi.fn(() => void calls.push('setSession')),
    clearQueries: vi.fn(() => void calls.push('clear')),
    navigate: vi.fn((p: string) => void calls.push(`navigate:${p}`)),
    ...over,
  };
  return { d, calls };
}

describe('switchOrg', () => {
  it('トークンを差し替え → キャッシュを捨てる → / を読み直す（この順）', async () => {
    const { d, calls } = deps();
    await switchOrg(d, 'org-B');
    expect(d.post).toHaveBeenCalledWith('/auth/switch-org', { orgId: 'org-B' });
    expect(d.setSession).toHaveBeenCalledWith('tok-B', SESSION.user, SESSION.memberships);
    expect(calls).toEqual(['setSession', 'clear', 'navigate:/']);
  });

  it('サーバが拒否したら（所属していない組織）何も差し替えない', async () => {
    const { d } = deps({ post: vi.fn(async () => Promise.reject(new Error('403'))) as SessionDeps['post'] });
    await expect(switchOrg(d, 'org-Z')).rejects.toThrow();
    expect(d.setSession).not.toHaveBeenCalled();
    expect(d.clearQueries).not.toHaveBeenCalled();
  });
});

describe('createOrg', () => {
  it('作った組織のセッションに切り替える', async () => {
    const { d } = deps();
    await createOrg(d, '新会社');
    expect(d.post).toHaveBeenCalledWith('/organizations', { name: '新会社' });
    expect(d.setSession).toHaveBeenCalled();
    expect(d.clearQueries).toHaveBeenCalled();
  });
});

describe('recoverFromRevoked（403 TENANT_ACCESS_REVOKED）', () => {
  it('残っている組織があれば、いまの組織以外の先頭へ切り替える', async () => {
    const { d } = deps({
      get: vi.fn(async () => ({
        data: { success: true, data: [{ orgId: 'org-A' }, { orgId: 'org-B' }] },
      })) as SessionDeps['get'],
    });
    expect(await recoverFromRevoked(d, 'org-A')).toBe('switched');
    expect(d.post).toHaveBeenCalledWith('/auth/switch-org', { orgId: 'org-B' });
  });

  it('無ければ「所属組織なし」画面へ（ログアウトはしない）', async () => {
    const { d } = deps();
    expect(await recoverFromRevoked(d, 'org-A')).toBe('no-org');
    expect(d.navigate).toHaveBeenCalledWith('/no-org');
    expect(d.setSession).not.toHaveBeenCalled();
  });
});

describe('別タブの検知', () => {
  it('persist の中身からアクティブ組織を読む', () => {
    expect(orgIdInAuthSnapshot(JSON.stringify({ state: { user: { orgId: 'org-B' } } }))).toBe('org-B');
    expect(orgIdInAuthSnapshot(null)).toBeNull();
    expect(orgIdInAuthSnapshot('{壊れた')).toBeNull();
  });
});
