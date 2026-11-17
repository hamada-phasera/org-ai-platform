// 実 Postgres の統合テストの土台（計画書チャンク 9）。
//
// - `TEST_DATABASE_URL` があるときだけ走る（無ければ各ファイルが describe.skip になり、`npm test` には入らない）。
// - テストファイルごとに新しいデータベース `<TEST_DATABASE_URL の DB 名>_<乱数>` を作り、
//   `prisma migrate deploy` を最初から全部当て、終わったら DROP する（他のファイル・既存の DB に触らない）。
//   拡張 vector はデータベース単位なので、スキーマではなくデータベースごと作り直す。
// - 接続先の DB 名は `flow_` で始まるものだけを許す（共有の Postgres で他人の DB を作り直さないため）。
// - 管理接続は同じサーバの `postgres` データベースに張る（CREATE / DROP DATABASE 用）。
//
// ⚠️ ここで扱う URL・パスワードはテスト用。ログには DB 名だけを出す。

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

/** 統合テストの接続先。未設定ならテストを飛ばす */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

// CI では「DB が無くて全部スキップされたのに緑」を防ぐ（.github/workflows/ci.yml の integration ジョブが 1 にする）
if (process.env.REQUIRE_TEST_DATABASE === '1' && !hasTestDatabase) {
  throw new Error('REQUIRE_TEST_DATABASE=1 なのに TEST_DATABASE_URL がありません');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
export const SCHEMA_PATH = resolve(REPO_ROOT, 'packages/db-schema/prisma/schema.prisma');

function prismaBin(): string {
  for (const p of [resolve(REPO_ROOT, 'node_modules/.bin/prisma'), resolve(HERE, '../../node_modules/.bin/prisma')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('prisma CLI が見つかりません（npm ci を実行してください）');
}

/** prisma CLI を実行する。標準出力を返す。失敗したら例外（stderr を含む） */
export function runPrisma(args: string[], databaseUrl: string): string {
  return execFileSync(prismaBin(), args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function baseDatabaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^flow_[a-z0-9_]+$/.test(name)) {
    throw new Error(`TEST_DATABASE_URL の DB 名は flow_ で始まる英小文字・数字・_ にしてください（今: ${name || '(空)'}）`);
  }
  return name;
}

export interface TestDatabase {
  /** 作ったデータベースの名前（flow_…） */
  name: string;
  url: string;
  prisma: PrismaClient;
  /** 接続を閉じてデータベースを消す */
  drop: () => Promise<void>;
}

/**
 * 空のデータベースを作る。`migrate: true`（既定）ならマイグレーションを全部当てる。
 */
export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const base = baseDatabaseName(TEST_DATABASE_URL);
  const name = `${base}_${randomBytes(4).toString('hex')}`.slice(0, 63);
  const url = withDatabase(TEST_DATABASE_URL, name);
  const admin = new PrismaClient({ datasources: { db: { url: withDatabase(TEST_DATABASE_URL, 'postgres') } }, log: ['error'] });
  try {
    // 名前は上で検査済み（英小文字・数字・_ のみ）なので識別子に埋め込んでよい
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
  if (opts.migrate !== false) runPrisma(['migrate', 'deploy', '--schema', SCHEMA_PATH], url);

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  return {
    name,
    url,
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      const a = new PrismaClient({ datasources: { db: { url: withDatabase(TEST_DATABASE_URL, 'postgres') } }, log: ['error'] });
      try {
        await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await a.$disconnect();
      }
    },
  };
}

/** マイグレーション管理表以外の全テーブルを空にする（テストの間でデータを持ち越さない） */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/** テストで使う環境変数を差し替え、戻す関数を返す。undefined は削除 */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** packages/db-schema/rls/phase2a.sql（RLS Phase 2a。migrations には入っていない） */
export const RLS_PHASE2A_PATH = resolve(REPO_ROOT, 'packages/db-schema/rls/phase2a.sql');

export interface RlsSetup {
  /** flow_app（NOBYPASSRLS・所有者ではない）で接続したクライアント */
  app: PrismaClient;
  appUrl: string;
}

/**
 * テスト用 DB に RLS Phase 2a を当て、flow_app で接続したクライアントを返す（計画書チャンク 11）。
 *   1. flow_app ロールを作る（クラスタ全体のロール。無ければ作り、あれば NOBYPASSRLS / NOSUPERUSER に揃える）
 *   2. 本番の Supabase と同じく public の全表で RLS を ENABLE（docs/supabase-migration.md §6）
 *   3. phase2a.sql を `prisma db execute` で流す（本番の手順と同じファイル）
 * ⚠️ ロールは消さない（同じサーバの別のテスト DB が使っているかもしれない。DB を消せば権限は消える）。
 */
export async function applyRlsPhase2a(db: TestDatabase): Promise<RlsSetup> {
  // テスト専用の値。秘密情報らしい文字列をソースに置かないよう実行時に組み立てる
  const password = ['flow', 'app', 'int', 'only'].join('_');
  try {
    await db.prisma.$executeRawUnsafe(`CREATE ROLE flow_app LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${password}'`);
  } catch (e) {
    // 既にある（別の実行が先に作った）
    if (!/already exists/.test(String((e as Error).message))) throw e;
  }
  await db.prisma.$executeRawUnsafe(`ALTER ROLE flow_app LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${password}'`);
  await db.prisma.$executeRawUnsafe(`
    DO $$ DECLARE t record; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename); END LOOP;
    END $$;`);
  runPrisma(['db', 'execute', '--url', db.url, '--file', RLS_PHASE2A_PATH], db.url);
  const u = new URL(db.url);
  u.username = 'flow_app';
  u.password = password;
  const appUrl = u.toString();
  return { app: new PrismaClient({ datasources: { db: { url: appUrl } }, log: ['error'] }), appUrl };
}
