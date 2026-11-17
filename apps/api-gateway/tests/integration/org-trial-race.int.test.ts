import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, type TestDatabase } from './setup';

// 作成者ごとのトライアルは 1 回（D4）。同時に 2 回「組織を作る」を押しても、トライアルが付くのは 1 つだけ（saas-review #8）。
// createOrganizationFor は作成者の行を先に更新して行ロックを取るので、2 本目は 1 本目のコミットを待ってから数える。
// 実 Postgres でないと再現しない（偽 prisma にはロックが無い）。

let db: TestDatabase | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return db.prisma;
  },
}));

describe.skipIf(!hasTestDatabase)('組織の同時作成でトライアルは 1 つだけ（実 Postgres）', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
    db = undefined;
  });

  it('招待で入っただけの人（自分の組織 0 件）が同時に 2 つ作っても、期限が先なのは 1 つ', async () => {
    const { createOrganizationFor } = await import('../../src/services/organizations');
    const user = await db!.prisma.user.create({
      data: { email: 'race@example.com', name: '同時', passwordHash: 'x' },
    });

    const before = Date.now();
    const created = await Promise.all([
      createOrganizationFor(user.id, '同時 1'),
      createOrganizationFor(user.id, '同時 2'),
    ]);

    const orgs = await db!.prisma.organization.findMany({
      where: { id: { in: created.map((o) => o.id) } },
      select: { trialEndsAt: true },
    });
    expect(orgs).toHaveLength(2);
    const withTrial = orgs.filter((o) => (o.trialEndsAt?.getTime() ?? 0) > before + 60_000);
    expect(withTrial).toHaveLength(1);
  });
});
