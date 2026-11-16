import { describe, it, expect } from 'vitest';
import { createOrgScopedStorage, orgScopedKey } from '../orgScopedStorage';

// 組織ごとの persist（docs/design/multi-tenancy.md §10.2 / E10）

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('createOrgScopedStorage', () => {
  it('key に組織が入り、組織を切り替えると別の値を読む', () => {
    const mem = memoryStorage();
    let org: string | null = 'org-A';
    const s = createOrgScopedStorage(() => org, mem);
    s.setItem('flow-deliverables-v1', 'A のフォルダ');
    expect(mem.m.get('flow-deliverables-v1:org-A')).toBe('A のフォルダ');

    org = 'org-B';
    expect(s.getItem('flow-deliverables-v1')).toBeNull(); // A の内容は見えない
    s.setItem('flow-deliverables-v1', 'B のフォルダ');
    org = 'org-A';
    expect(s.getItem('flow-deliverables-v1')).toBe('A のフォルダ');
  });

  it('組織の入っていない古い key は、最初に開いた組織へ1回だけ移す', () => {
    const mem = memoryStorage();
    mem.setItem('flow-deliverables-v1', '移行前');
    let org = 'org-A';
    const s = createOrgScopedStorage(() => org, mem);
    expect(s.getItem('flow-deliverables-v1')).toBe('移行前');
    expect(mem.m.has('flow-deliverables-v1')).toBe(false);
    expect(mem.m.get('flow-deliverables-v1:org-A')).toBe('移行前');
    // 別の組織には引き継がない
    org = 'org-B';
    expect(s.getItem('flow-deliverables-v1')).toBeNull();
  });

  it('組織が無い間は移行しない', () => {
    const mem = memoryStorage();
    mem.setItem('x', 'old');
    const s = createOrgScopedStorage(() => null, mem);
    expect(s.getItem('x')).toBeNull();
    expect(mem.m.get('x')).toBe('old');
    expect(orgScopedKey('x', null)).toBe('x:no-org');
  });
});
