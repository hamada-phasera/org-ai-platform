import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, truncateAll, type TestDatabase } from './setup';

// 業務ページの 3 表（設計書 docs/design/custom-pages.md §3、チャンク 2 の受け入れ条件）を実 Postgres で確かめる。
//   - マイグレーションが当たり、3 表がある
//   - (orgId, slug) と (orgId, requestId) の一意制約が**同時実行でも**効く（偽 Prisma にはロックも制約も無い）
//   - 組織を消すと 3 表とも消える（Cascade）。ページを消しても送信の記録は残る（当月の件数をすり抜けさせない）
// アプリの配線を通す通し（登録 → 送信 → 月間件数）はチャンク 4 で足す。

const DEF = { blocks: [{ type: 'heading', text: '問い合わせ' }], actions: {} } as Prisma.InputJsonValue;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

describe.skipIf(!hasTestDatabase)('業務ページの表（実 Postgres）', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await truncateAll(db.prisma);
    await db.prisma.organization.createMany({ data: [{ id: 'org-A', name: 'A' }, { id: 'org-B', name: 'B' }] });
  });

  const page = (orgId: string, slug = 'inquiries', title = '問い合わせ') => ({
    orgId,
    slug,
    title,
    source: 'N8N',
    definition: DEF,
    definitionHash: `h-${orgId}-${slug}`,
  });
  const log = (orgId: string, requestId: string, pageId = 'p-1') => ({
    orgId,
    pageId,
    slug: 'inquiries',
    actionId: 'create',
    pageVersion: 1,
    actorId: 'u-1',
    requestId,
    inputKeys: ['name', 'tel'],
  });

  it('3 表と一意索引がマイグレーションで作られ、既定値が設計どおり', async () => {
    const idx = await db.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename IN ('CustomPage', 'PageToken', 'PageActionLog') ORDER BY indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'CustomPage_orgId_slug_key',
        'CustomPage_orgId_status_sortOrder_idx',
        'PageToken_tokenHash_key',
        'PageToken_orgId_createdAt_idx',
        'PageActionLog_orgId_requestId_key',
        'PageActionLog_orgId_createdAt_idx',
      ]),
    );

    const p = await db.prisma.customPage.create({ data: page('org-A') });
    expect(p).toMatchObject({ status: 'DRAFT', minRole: 'MEMBER', icon: 'file-text', version: 1, schemaVersion: 1, sortOrder: 0 });
    expect(p.sampleData).toBeNull();
    const l = await db.prisma.pageActionLog.create({ data: log('org-A', 'r-1') });
    expect(l).toMatchObject({ status: 'PENDING', durationMs: null, inputKeys: ['name', 'tel'] });
  });

  it('同じ組織・同じ slug の同時作成は 1 行だけ（片方は P2002）。別の組織なら同じ slug を持てる', async () => {
    const results = await Promise.allSettled([
      db.prisma.customPage.create({ data: page('org-A') }),
      db.prisma.customPage.create({ data: page('org-A') }),
      db.prisma.customPage.create({ data: page('org-A') }),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected.every((r) => isUniqueViolation(r.reason))).toBe(true);

    await db.prisma.customPage.create({ data: page('org-B') });
    expect(await db.prisma.customPage.count({ where: { slug: 'inquiries' } })).toBe(2);
  });

  it('同じ slug の同時 upsert でも 1 行（負けた側は P2002 か更新になる）', async () => {
    const upsert = (title: string) =>
      db.prisma.customPage.upsert({
        where: { orgId_slug: { orgId: 'org-A', slug: 'inquiries' } },
        create: page('org-A', 'inquiries', title),
        update: { title, version: { increment: 1 } },
      });
    const results = await Promise.allSettled([upsert('一'), upsert('二'), upsert('三')]);
    for (const r of results) if (r.status === 'rejected') expect(isUniqueViolation(r.reason)).toBe(true);
    expect(await db.prisma.customPage.count({ where: { orgId: 'org-A' } })).toBe(1);
  });

  it('同じ組織・同じ requestId の同時送信は記録が 1 行だけ（二重送信を DB で止める）', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => db.prisma.pageActionLog.create({ data: log('org-A', 'req-x') })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(isUniqueViolation(r.reason)).toBe(true);

    // 別の組織の同じ requestId は別物
    await db.prisma.pageActionLog.create({ data: log('org-B', 'req-x') });
    expect(await db.prisma.pageActionLog.count({ where: { requestId: 'req-x' } })).toBe(2);
  });

  it('トークンのハッシュは全体で一意', async () => {
    const t = { label: 'n8n', tokenHash: 'same-hash', prefix: 'flowpg_abc', createdBy: 'u-1' };
    await db.prisma.pageToken.create({ data: { ...t, orgId: 'org-A' } });
    await expect(db.prisma.pageToken.create({ data: { ...t, orgId: 'org-B' } })).rejects.toSatisfy(isUniqueViolation);
  });

  it('ページを消しても送信の記録は残る（pageId は FK ではない）', async () => {
    const p = await db.prisma.customPage.create({ data: page('org-A') });
    await db.prisma.pageActionLog.create({ data: log('org-A', 'r-1', p.id) });
    await db.prisma.customPage.delete({ where: { id: p.id } });
    expect(await db.prisma.pageActionLog.count({ where: { orgId: 'org-A' } })).toBe(1);
  });

  it('組織を消すと 3 表とも消え、他の組織の行は残る（Cascade）', async () => {
    for (const orgId of ['org-A', 'org-B']) {
      await db.prisma.customPage.create({ data: page(orgId) });
      await db.prisma.pageToken.create({
        data: { orgId, label: 'n8n', tokenHash: `hash-${orgId}`, prefix: 'flowpg_abc', createdBy: 'u-1' },
      });
      await db.prisma.pageActionLog.create({ data: log(orgId, 'r-1') });
    }
    await db.prisma.organization.delete({ where: { id: 'org-A' } });

    for (const where of [{ orgId: 'org-A' }, { orgId: 'org-B' }]) {
      const n = await Promise.all([
        db.prisma.customPage.count({ where }),
        db.prisma.pageToken.count({ where }),
        db.prisma.pageActionLog.count({ where }),
      ]);
      expect(n).toEqual(where.orgId === 'org-A' ? [0, 0, 0] : [1, 1, 1]);
    }
  });
});
