import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakePrisma } from '../helpers/fake-prisma';

// 業務ページの 3 表（CustomPage / PageToken / PageActionLog）がテナントクライアントで絞られること（設計書 §3.4・T1）と、
// 偽 Prisma が一意制約（P2002）を再現すること（ルートの 409 / 同名ページのテストの土台）。
// 実 Postgres での一意制約・Cascade は tests/integration/custom-pages.int.test.ts。

vi.mock('../../src/utils/prisma', () => ({ prisma: {} }));
const { tenantDbFrom, TenantViolationError } = await import('../../src/tenancy');
const { AUDIT_ACTIONS } = await import('../../src/services/audit');

const DEF = { blocks: [{ type: 'heading', text: '問い合わせ' }], actions: {} };

function seed(): FakePrisma {
  return new FakePrisma({
    organization: [{ id: 'org-A' }, { id: 'org-B' }],
    customPage: [
      { id: 'page-B', orgId: 'org-B', slug: 'inquiries', title: 'B の問い合わせ', status: 'PUBLISHED', minRole: 'MEMBER',
        source: 'N8N', version: 3, definition: DEF, definitionHash: 'h-b', sortOrder: 0 },
    ],
    pageToken: [
      { id: 'tok-B', orgId: 'org-B', label: 'n8n', tokenHash: 'hash-B', prefix: 'flowpg_bbb', createdBy: 'u-b', revokedAt: null },
    ],
    pageActionLog: [
      { id: 'log-B', orgId: 'org-B', pageId: 'page-B', slug: 'inquiries', actionId: 'create', pageVersion: 3, actorId: 'u-b',
        requestId: 'req-1', status: 'OK', inputKeys: ['name'], createdAt: new Date() },
    ],
  });
}

let fake: FakePrisma;
beforeEach(() => {
  fake = seed();
});

describe('業務ページの表とテナントクライアント', () => {
  it('組織 A のクライアントからは B のページ・トークン・記録が見えない', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    expect(await db.customPage.findMany()).toEqual([]);
    expect(await db.customPage.findFirst({ where: { slug: 'inquiries' } })).toBeNull();
    expect(await db.pageToken.findMany()).toEqual([]);
    expect(await db.pageActionLog.count()).toBe(0);
  });

  it('同じ slug を orgId_slug で引いても A の範囲でしか探さない', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    expect(await db.customPage.findUnique({ where: { orgId_slug: { orgId: 'org-A', slug: 'inquiries' } } })).toBeNull();
  });

  it('複合キーで B を名指しすると DB に届く前に止まる', () => {
    const db = tenantDbFrom(fake, 'org-A');
    expect(() => db.customPage.findUnique({ where: { orgId_slug: { orgId: 'org-B', slug: 'inquiries' } } })).toThrow(
      TenantViolationError,
    );
  });

  it('B のページを更新・削除できない（P2025 / 0 件）', async () => {
    const before = fake.snapshot();
    const db = tenantDbFrom(fake, 'org-A');
    await expect(db.customPage.update({ where: { id: 'page-B' }, data: { status: 'DRAFT' } })).rejects.toMatchObject({
      code: 'P2025',
    });
    expect(await db.customPage.deleteMany({ where: { slug: 'inquiries' } })).toEqual({ count: 0 });
    expect(await db.pageToken.updateMany({ where: { id: 'tok-B' }, data: { revokedAt: new Date() } })).toEqual({ count: 0 });
    expect(fake.snapshot()).toBe(before);
  });

  it('作ると orgId が自動で付き、B の orgId を指定すると止まる', async () => {
    const db = tenantDbFrom(fake, 'org-A');
    const page = await db.customPage.create({
      data: { slug: 'inquiries', title: 'A の問い合わせ', source: 'N8N', definition: DEF, definitionHash: 'h-a' } as never,
    });
    expect(page).toMatchObject({ orgId: 'org-A', status: 'DRAFT', minRole: 'MEMBER', version: 1, icon: 'file-text' });
    expect(() =>
      db.customPage.create({
        data: { orgId: 'org-B', slug: 'x', title: 'x', source: 'N8N', definition: DEF, definitionHash: 'h' } as never,
      }),
    ).toThrow(TenantViolationError);
  });
});

describe('偽 Prisma の一意制約（P2002）', () => {
  it('同じ組織の同じ requestId は 2 回目が P2002、別の組織なら同じ値でも作れる', async () => {
    const a = tenantDbFrom(fake, 'org-A');
    const log = { pageId: 'p', slug: 's', actionId: 'create', pageVersion: 1, actorId: 'u-a', requestId: 'req-1', inputKeys: [] };
    await expect(a.pageActionLog.create({ data: log as never })).resolves.toMatchObject({ orgId: 'org-A', status: 'PENDING' });
    await expect(a.pageActionLog.create({ data: log as never })).rejects.toMatchObject({ code: 'P2002' });
    expect(fake.rows('pageActionLog')).toHaveLength(2);
  });

  it('同じ組織の同じ slug は P2002（upsert の作成側でも）', async () => {
    const b = tenantDbFrom(fake, 'org-B');
    await expect(
      b.customPage.create({ data: { slug: 'inquiries', title: 't', source: 'N8N', definition: DEF, definitionHash: 'h' } as never }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // 既存行は upsert の update 側に入る
    await b.customPage.upsert({
      where: { orgId_slug: { orgId: 'org-B', slug: 'inquiries' } },
      create: { slug: 'inquiries', title: 't', source: 'N8N', definition: DEF, definitionHash: 'h' } as never,
      update: { title: '更新' },
    });
    expect(fake.rows('customPage').filter((r) => r.orgId === 'org-B')).toHaveLength(1);
    expect(fake.rows('customPage')[0].title).toBe('更新');
  });

  it('トークンのハッシュは全体で一意', async () => {
    const a = tenantDbFrom(fake, 'org-A');
    await expect(
      a.pageToken.create({ data: { label: 'x', tokenHash: 'hash-B', prefix: 'flowpg_xxx', createdBy: 'u-a' } as never }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('監査のアクション', () => {
  it('業務ページの 6 つが AUDIT_ACTIONS にある（設計書 §3.3）', () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['page.upsert', 'page.delete', 'page.publish', 'page.unpublish', 'page_token.issue', 'page_token.revoke']),
    );
  });
});
