import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { applyRlsPhase2a, createTestDatabase, hasTestDatabase, setEnv, truncateAll, type TestDatabase } from './setup';

// RLS Phase 2a（計画書チャンク 11）。実 Postgres + pgvector で packages/db-schema/rls/phase2a.sql を当て、
// flow_app（NOBYPASSRLS・所有者ではない）ロールで 4 表 AILog / RiskEvent / FileChunk / MessageEmbedding が
// app.org_id の組織だけに絞られること、テナントクライアント（RLS_MODE=on）がそれを正しく設定することを確かめる。

let db: TestDatabase | undefined;
let appPrisma: PrismaClient | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!appPrisma) throw new Error('統合テストの DB が未作成です');
    return appPrisma;
  },
}));

const DIM = 1024;
const vec = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;

describe.skipIf(!hasTestDatabase)('RLS Phase 2a（flow_app・実 Postgres）', () => {
  let restoreEnv: () => void;
  let appUrl: string;
  let tenantDbFrom: typeof import('../../src/tenancy/tenant-db').tenantDbFrom;
  const A = 'org-a';
  const B = 'org-b';

  beforeAll(async () => {
    restoreEnv = setEnv({ RLS_MODE: 'on' });
    db = await createTestDatabase();
    const rls = await applyRlsPhase2a(db);
    appPrisma = rls.app;
    appUrl = rls.appUrl;
    ({ tenantDbFrom } = await import('../../src/tenancy/tenant-db'));
  });

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await db?.drop();
    restoreEnv?.();
  });

  /** 所有者（RLS を素通り）で A・B それぞれに 4 表の行を作る */
  async function seed(): Promise<Record<string, { fileId: string; messageId: string }>> {
    const owner = db!.prisma;
    const out: Record<string, { fileId: string; messageId: string }> = {};
    for (const orgId of [A, B]) {
      await owner.organization.create({ data: { id: orgId, name: orgId } });
      const user = await owner.user.create({ data: { email: `${orgId}@example.jp`, passwordHash: 'x', name: orgId, orgId } });
      const file = await owner.uploadedFile.create({
        data: { orgId, uploadedBy: user.id, originalName: 'f.txt', storagePath: `/x/${orgId}`, mimeType: 'text/plain', sizeBytes: 1 },
      });
      const session = await owner.chatSession.create({ data: { orgId, title: 't' } });
      const msg = await owner.message.create({ data: { sessionId: session.id, role: 'user', content: 'c' } });
      const log = await owner.aILog.create({ data: { orgId, department: 'GENERAL', provider: 'anthropic', model: 'm', inputText: 'i' } });
      await owner.riskEvent.create({ data: { orgId, aiLogId: log.id, type: 'PII_DETECTED', description: 'd', severity: 'MEDIUM' } });
      await owner.$executeRaw`INSERT INTO "FileChunk" ("id", "orgId", "fileId", "chunkIndex", "content", "embedding")
        VALUES (${randomUUID()}, ${orgId}, ${file.id}, 0, 'chunk', ${vec}::vector)`;
      await owner.$executeRaw`INSERT INTO "MessageEmbedding" ("id", "orgId", "messageId", "sessionId", "role", "content", "embedding")
        VALUES (${randomUUID()}, ${orgId}, ${msg.id}, ${session.id}, 'user', 'c', ${vec}::vector)`;
      out[orgId] = { fileId: file.id, messageId: msg.id };
    }
    return out;
  }

  const TABLES = ['AILog', 'RiskEvent', 'FileChunk', 'MessageEmbedding'] as const;
  /** 4 表の行数（組織ごと）を同じトランザクションの中で数える */
  const countsIn = (c: Prisma.TransactionClient) =>
    Promise.all(
      TABLES.map(async (t) => {
        const rows = await c.$queryRawUnsafe<Array<{ orgId: string; n: bigint }>>(
          `SELECT "orgId", count(*) AS n FROM "${t}" GROUP BY "orgId" ORDER BY "orgId"`,
        );
        return [t, rows.map((r) => `${r.orgId}:${Number(r.n)}`).join(',')] as const;
      }),
    ).then((e) => Object.fromEntries(e));

  let seeded: Record<string, { fileId: string; messageId: string }>;
  beforeEach(async () => {
    await truncateAll(db!.prisma);
    seeded = await seed();
  });

  it('前提: flow_app は BYPASSRLS でも所有者でもない', async () => {
    const rows = await appPrisma!.$queryRaw<Array<{ rolbypassrls: boolean; rolsuper: boolean; current_user: string }>>`
      SELECT rolbypassrls, rolsuper, current_user FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false, current_user: 'flow_app' });
  });

  it('(1) app.org_id が未設定なら 4 表とも 0 行（fail-closed）', async () => {
    const counts = await appPrisma!.$transaction((tx) => countsIn(tx));
    expect(counts).toEqual({ AILog: '', RiskEvent: '', FileChunk: '', MessageEmbedding: '' });
    // 所有者からは両社とも見えている（データはある）
    expect(await db!.prisma.$transaction((tx) => countsIn(tx))).toEqual({
      AILog: 'org-a:1,org-b:1',
      RiskEvent: 'org-a:1,org-b:1',
      FileChunk: 'org-a:1,org-b:1',
      MessageEmbedding: 'org-a:1,org-b:1',
    });
  });

  it('(2) A を設定すると A の行だけ見え、B の orgId での INSERT は拒否される', async () => {
    const counts = await appPrisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.org_id', ${A}, true)`;
      return countsIn(tx);
    });
    expect(counts).toEqual({ AILog: 'org-a:1', RiskEvent: 'org-a:1', FileChunk: 'org-a:1', MessageEmbedding: 'org-a:1' });

    // 4 表それぞれで、B の行を A として書こうとすると WITH CHECK で落ちる
    const asA = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      appPrisma!.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.org_id', ${A}, true)`;
        return fn(tx);
      });
    const denied = /row-level security/;
    await expect(
      asA((tx) => tx.aILog.create({ data: { orgId: B, department: 'GENERAL', provider: 'p', model: 'm', inputText: 'i' } })),
    ).rejects.toThrow(denied);
    await expect(
      asA((tx) => tx.$executeRaw`INSERT INTO "RiskEvent" ("id", "orgId", "type", "description", "severity")
        VALUES (${randomUUID()}, ${B}, 'PII_DETECTED', 'd', 'LOW')`),
    ).rejects.toThrow(denied);
    await expect(
      asA((tx) => tx.$executeRaw`INSERT INTO "FileChunk" ("id", "orgId", "fileId", "chunkIndex", "content")
        VALUES (${randomUUID()}, ${B}, ${seeded[B].fileId}, 1, 'x')`),
    ).rejects.toThrow(denied);
    await expect(
      asA((tx) => tx.$executeRaw`INSERT INTO "MessageEmbedding" ("id", "orgId", "messageId", "sessionId", "role", "content")
        VALUES (${randomUUID()}, ${B}, ${'m-' + randomUUID()}, 's', 'user', 'x')`),
    ).rejects.toThrow(denied);
    // B の行を UPDATE / DELETE しても 0 件（見えない行は触れない）
    expect(await asA((tx) => tx.aILog.updateMany({ where: { orgId: B }, data: { model: 'x' } }))).toEqual({ count: 0 });
    expect(await asA((tx) => tx.$executeRaw`DELETE FROM "FileChunk" WHERE "orgId" = ${B}`)).toBe(0);
    expect(await db!.prisma.fileChunk.count({ where: { orgId: B } })).toBe(1);
  });

  it('set_config は is_local=true: コミット後の同じプールの接続に値が残らない', async () => {
    const one = new PrismaClient({ datasources: { db: { url: `${appUrl}${appUrl.includes('?') ? '&' : '?'}connection_limit=1` } } });
    try {
      await one.$transaction([one.$queryRaw`SELECT set_config('app.org_id', ${A}, true)`, one.aILog.count()]);
      const after = await one.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.org_id', true) AS v`;
      expect(after[0].v ?? '').toBe('');
      expect(await one.aILog.count()).toBe(0);
    } finally {
      await one.$disconnect();
    }
  });

  it('テナントクライアント（RLS_MODE=on）が組織を設定する: 読み・raw SQL・interactive transaction', async () => {
    const a = tenantDbFrom(appPrisma, A);
    expect(await a.aILog.count()).toBe(1);
    expect(await a.riskEvent.count()).toBe(1);
    const chunks = await a.$queryRaw<Array<{ orgId: string }>>`SELECT "orgId" FROM "FileChunk" WHERE "orgId" = ${A}`;
    expect(chunks).toEqual([{ orgId: A }]);
    // 条件を書き忘れた raw SQL でも B の行は返らない（DB 側の柵）
    const all = await a.$queryRaw<Array<{ orgId: string }>>`SELECT "orgId" FROM "MessageEmbedding"`;
    expect(all).toEqual([{ orgId: A }]);
    // raw の INSERT は A の行として入り、B の orgId は拒否される
    await a.$executeRaw`INSERT INTO "FileChunk" ("id", "orgId", "fileId", "chunkIndex", "content")
      VALUES (${randomUUID()}, ${A}, ${seeded[A].fileId}, 1, 'x')`;
    expect(await db!.prisma.fileChunk.count({ where: { orgId: A } })).toBe(2);
    await expect(
      a.$executeRaw`INSERT INTO "FileChunk" ("id", "orgId", "fileId", "chunkIndex", "content")
        VALUES (${randomUUID()}, ${B}, ${seeded[B].fileId}, 1, 'x')`,
    ).rejects.toThrow(/row-level security/);
    // interactive transaction の中（開始直後に 1 回だけ設定）
    const n = await a.$transaction(async (tx) => {
      await tx.aILog.create({ data: { department: 'GENERAL', provider: 'p', model: 'm', inputText: 'i' } as never });
      return tx.aILog.count();
    });
    expect(n).toBe(2);
    // 外から渡した tx（tenantDbFrom(tx, orgId)）
    const viaTx = await appPrisma!.$transaction(async (tx) => tenantDbFrom(tx, B).aILog.count());
    expect(viaTx).toBe(1);
  });

  it('RLS_MODE=off のまま flow_app に替えると 4 表が見えない（on にしてから接続を替える理由）', async () => {
    const restore = setEnv({ RLS_MODE: 'off' });
    try {
      expect(await tenantDbFrom(appPrisma, A).aILog.count()).toBe(0);
    } finally {
      restore();
    }
  });

  it('4 表以外は flow_app に素通し（Supabase の全表 ENABLE の下でもアプリが動く）。親の削除は子の 4 表に連鎖する', async () => {
    const a = tenantDbFrom(appPrisma, A);
    expect(await a.uploadedFile.count()).toBe(1);
    expect(await a.organization.findUnique({ where: { id: A } })).toMatchObject({ id: A });
    await a.uploadedFile.delete({ where: { id: seeded[A].fileId } });
    expect(await db!.prisma.fileChunk.count({ where: { orgId: A } })).toBe(0);
    expect(await db!.prisma.fileChunk.count({ where: { orgId: B } })).toBe(1);
  });

  it('phase2a.sql は何度流しても同じ（ポリシーは表ごとに 1 つ）', async () => {
    await applyRlsPhase2a(db!).then((r) => r.app.$disconnect());
    const policies = await db!.prisma.$queryRaw<Array<{ tablename: string; policyname: string }>>`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('AILog', 'RiskEvent', 'FileChunk', 'MessageEmbedding')
      ORDER BY tablename, policyname`;
    expect(policies).toEqual([
      { tablename: 'AILog', policyname: 'tenant_isolation' },
      { tablename: 'FileChunk', policyname: 'tenant_isolation' },
      { tablename: 'MessageEmbedding', policyname: 'tenant_isolation' },
      { tablename: 'RiskEvent', policyname: 'tenant_isolation' },
    ]);
  });

  it('(5) 往復の増加を計測する（off: 1 文 / on: BEGIN・set_config・本体・COMMIT の 4 文）', async () => {
    const counted = new PrismaClient({
      datasources: { db: { url: appUrl } },
      log: [{ emit: 'event', level: 'query' }],
    });
    const stmts: string[] = [];
    counted.$on('query', (e) => stmts.push(e.query));
    const N = 200;
    const time = async (fn: () => Promise<unknown>) => {
      await fn(); // 接続を温める
      stmts.length = 0;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await fn();
      return { ms: (performance.now() - t0) / N, stmts: stmts.length / N };
    };
    try {
      // off の比較は所有者相当でなく同じ flow_app・同じ文。組織は手で設定せず、件数ではなく往復だけを見る
      const offClient = tenantDbFrom(counted, A);
      const restore = setEnv({ RLS_MODE: 'off' });
      const off = await time(() => offClient.aILog.count());
      restore();
      const on = await time(() => tenantDbFrom(counted, A).aILog.count());
      expect(off.stmts).toBe(1);
      expect(on.stmts).toBe(4);
      // 数字は docs/design/multi-tenancy.md §RLS Phase 2a に書き写す（手元の値。CI では揺れる）
      process.stdout.write(
        `[rls] aILog.count ×${N}: off ${off.ms.toFixed(3)}ms/${off.stmts} 文, on ${on.ms.toFixed(3)}ms/${on.stmts} 文\n`,
      );
    } finally {
      await counted.$disconnect();
    }
  });
});
