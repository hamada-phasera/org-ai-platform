import { describe, it, expect, vi } from 'vitest';

// 登録トークンの形とハッシュ（docs/design/custom-pages.md §5.4）。DB を引く前に弾く形の検査も見る。
const findUnique = vi.fn();
vi.mock('../../../utils/prisma', () => ({ prisma: { pageToken: { findUnique } } }));
const { generatePageToken, hashPageToken, resolvePageToken } = await import('../page-token');

describe('generatePageToken', () => {
  it('flowpg_ + 256 bit（base64url 43 文字）。prefix は先頭 10 文字、ハッシュは sha256', () => {
    const t = generatePageToken();
    expect(t.raw).toMatch(/^flowpg_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.raw.slice(0, 10));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).toBe(hashPageToken(t.raw));
    expect(generatePageToken().raw).not.toBe(t.raw);
  });
});

describe('resolvePageToken', () => {
  it.each([undefined, '', 'flowpg_short', 'Bearer flowpg_' + 'a'.repeat(43), ['flowpg_' + 'a'.repeat(43)], 'flowpg_' + 'a'.repeat(43) + '/../'])(
    '形が違うもの（%s）は DB を引かずに null',
    async (raw) => {
      findUnique.mockClear();
      expect(await resolvePageToken(raw)).toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('ハッシュで引き、失効済みは null、有効なら組織を返す', async () => {
    const raw = 'flowpg_' + 'a'.repeat(43);
    findUnique.mockResolvedValueOnce({ id: 't1', orgId: 'org-A', revokedAt: null });
    expect(await resolvePageToken(raw)).toEqual({ tokenId: 't1', orgId: 'org-A' });
    expect(findUnique.mock.calls.at(-1)?.[0].where).toEqual({ tokenHash: hashPageToken(raw) });
    findUnique.mockResolvedValueOnce({ id: 't1', orgId: 'org-A', revokedAt: new Date() });
    expect(await resolvePageToken(raw)).toBeNull();
    findUnique.mockResolvedValueOnce(null);
    expect(await resolvePageToken(raw)).toBeNull();
  });
});
