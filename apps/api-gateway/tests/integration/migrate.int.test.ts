import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestDatabase, hasTestDatabase, runPrisma, SCHEMA_PATH, type TestDatabase } from './setup';

// 空のデータベースに `prisma migrate deploy` が全部通ること（計画書チャンク 9 の受け入れ条件 1）。
// あわせて、マイグレーションの結果と schema.prisma がずれていないことを確かめる
// （ずれていると次に `migrate dev` した人の手元で DROP が生成される）。

/**
 * schema.prisma では書けないので、ずれとして出るのを許すもの。
 * pgvector の HNSW 索引（vector 列は Unsupported なので Prisma は索引を表現できない）。
 */
const ALLOWED_DRIFT = [/^DROP INDEX "FileChunk_embedding_idx";$/, /^DROP INDEX "MessageEmbedding_embedding_idx";$/];

describe.skipIf(!hasTestDatabase)('マイグレーション（実 Postgres）', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('空の DB に migrate deploy が全部通り、もう一度流しても何もしない', async () => {
    const out = runPrisma(['migrate', 'deploy', '--schema', SCHEMA_PATH], db.url);
    expect(out).toMatch(/successfully applied|No pending migrations/);

    const applied = await db.prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`;
    expect(applied.length).toBeGreaterThan(10);
    expect(applied.every((m) => m.finished_at !== null && m.rolled_back_at === null)).toBe(true);

    expect(runPrisma(['migrate', 'deploy', '--schema', SCHEMA_PATH], db.url)).toMatch(/No pending migrations/);
  });

  it('pgvector が入り、schema.prisma の全モデルに表がある', async () => {
    const ext = await db.prisma.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(ext).toHaveLength(1);

    const tables = new Set(
      (await db.prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).map(
        (t) => t.tablename,
      ),
    );
    const models = Prisma.dmmf.datamodel.models.map((m) => m.dbName ?? m.name);
    expect(models.length).toBeGreaterThan(20);
    expect(models.filter((m) => !tables.has(m))).toEqual([]);
  });

  it('マイグレーションの結果と schema.prisma がずれていない（HNSW 索引を除く）', () => {
    const script = runPrisma(
      ['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', SCHEMA_PATH, '--script'],
      db.url,
    );
    const statements = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'));
    expect(statements.filter((s) => !ALLOWED_DRIFT.some((re) => re.test(s)))).toEqual([]);
  });
});
