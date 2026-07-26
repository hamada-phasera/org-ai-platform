#!/usr/bin/env node
// Supabase の初期セットアップと検証を 1 コマンドで行う。
//
//   node scripts/supabase-setup.mjs            # 検査のみ（既定・DB を変更しない）
//   node scripts/supabase-setup.mjs --apply    # 実際にセットアップする
//
// 必要な env（.env か シェルで）:
//   DATABASE_URL … Supabase の **Session pooler** 接続文字列
//                  postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
//
// やること（--apply 時）:
//   1. 接続文字列の検証（既知の罠を弾く）
//   2. n8n 用スキーマ作成
//   3. prisma migrate deploy（全テーブル + pgvector を作成）
//   4. public の全テーブルに RLS を有効化（Data API 経由の直読みを塞ぐ蓋）
//   5. 検証（テーブル / vector の配置 / RLS / ベクトル型が使えるか）
//
// 検査のみのときは 1 と 5 だけを行う。

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCHEMA_PATH = 'packages/db-schema/prisma/schema.prisma';

function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv(join(ROOT, '.env'));

const APPLY = process.argv.includes('--apply');
const URL_STR = process.env.DATABASE_URL ?? '';

const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// ── 1. 接続文字列の検証 ────────────────────────────────
// 実測で確認した罠を弾く（docs/supabase-migration.md 参照）。
function validateUrl(raw) {
  if (!raw) die('DATABASE_URL が未設定です（.env かシェルで設定してください）。');
  let u;
  try {
    u = new URL(raw);
  } catch {
    die('DATABASE_URL を URL として解釈できません。');
  }
  const host = u.hostname;
  const port = u.port || '5432';
  const isSupabase = host.endsWith('.supabase.co') || host.endsWith('.supabase.com');

  console.log(`\n=== 1. 接続文字列の検証 ===\n  host=${host}  port=${port}  user=${u.username}`);

  // 罠A: direct 接続は IPv4 を持たず Render から到達できない
  if (/^db\..*\.supabase\.co$/.test(host)) {
    die(
      'direct 接続 (db.<ref>.supabase.co) が指定されています。\n' +
        '  このホストは IPv6 のみで Render の外向き(IPv4)からは到達できず、P1001 になります。\n' +
        '  Supabase の Connect → "Session pooler" の文字列（pooler.supabase.com:5432）を使ってください。',
    );
  }
  // 罠B: transaction pooler では prisma migrate deploy が失敗する
  if (isSupabase && port === '6543') {
    die(
      'ポート 6543（transaction pooler）が指定されています。\n' +
        '  Prisma のマイグレーションはセッションスコープの advisory lock を取るため失敗します。\n' +
        '  同じ pooler ホストの **5432**（session モード）を使ってください。',
    );
  }
  if (isSupabase) {
    if (host.includes('pooler.supabase.com')) ok('Session pooler を指しています');
    if (!u.username.includes('.')) warn(`ユーザ名が "postgres.<project-ref>" 形式ではありません（現在: ${u.username}）`);
    if (!/sslmode=/.test(u.search)) warn('sslmode=require が付いていません（付けることを推奨）');
  } else {
    warn(`Supabase 以外のホストです（ローカル検証用と判断して続行します）`);
  }
  return u;
}

const dbUrl = validateUrl(URL_STR);

// ── Prisma Client を用意（生成済みでなければ generate する） ──
const require_ = createRequire(import.meta.url);
function getPrisma() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require_('@prisma/client'));
  } catch {
    console.log('  Prisma Client が未生成のため生成します…');
    execFileSync('npx', ['prisma', 'generate', `--schema=${SCHEMA_PATH}`], { cwd: ROOT, stdio: 'inherit' });
    ({ PrismaClient } = require_('@prisma/client'));
  }
  return new PrismaClient({ datasources: { db: { url: URL_STR } }, log: ['error'] });
}

const prisma = getPrisma();

async function main() {
  // ── 接続確認 ──────────────────────────────────────
  console.log('\n=== 2. 接続確認 ===');
  try {
    await prisma.$queryRawUnsafe('select 1');
    ok(`接続できました（${dbUrl.hostname}）`);
  } catch (e) {
    die(`DB に接続できません: ${String(e).slice(0, 200)}`);
  }

  if (APPLY) {
    // ── n8n スキーマ ───────────────────────────────
    console.log('\n=== 3. n8n 用スキーマ ===');
    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS n8n');
    ok('スキーマ n8n を用意しました（n8n の約40テーブルを public から隔離する）');

    // ── マイグレーション ────────────────────────────
    console.log('\n=== 4. prisma migrate deploy ===');
    try {
      execFileSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${SCHEMA_PATH}`], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: URL_STR },
      });
      ok('マイグレーション適用完了');
    } catch {
      die('migrate deploy に失敗しました（上のログを確認してください）。');
    }

    // ── RLS ───────────────────────────────────────
    console.log('\n=== 5. RLS を有効化（Data API 経由の直読みを塞ぐ） ===');
    await prisma.$executeRawUnsafe(`
      DO $$ DECLARE t record; BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename); END LOOP;
      END $$;`);
    ok('public の全テーブルで RLS を有効化しました（ポリシーは作らない＝原則拒否）');
  } else {
    console.log('\n=== 検査のみモード（DB は変更していません）===');
    console.log('  実際にセットアップするには --apply を付けて再実行してください。');
  }

  // ── 検証 ─────────────────────────────────────────
  console.log('\n=== 6. 検証 ===');
  let failures = 0;

  const tables = await prisma.$queryRawUnsafe(
    `select count(*)::int as n from information_schema.tables where table_schema='public'`,
  );
  const nTables = tables[0]?.n ?? 0;
  nTables > 0 ? ok(`public のテーブル数: ${nTables}`) : (bad('public にテーブルがありません'), failures++);

  // pgvector の配置（extensions にあると RAG だけが静かに壊れる）
  const ext = await prisma.$queryRawUnsafe(
    `select n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector'`,
  );
  if (!ext.length) {
    bad('vector 拡張がありません（RAG は動きません）');
    failures++;
  } else if (ext[0].schema !== 'public') {
    bad(`vector 拡張が "${ext[0].schema}" スキーマにあります → RAG が実行時に壊れます`);
    console.log('     Supabase の画面で事前に有効化するとこうなります。プロジェクトを作り直すのが確実です。');
    failures++;
  } else {
    ok('vector 拡張は public スキーマ（正しい配置）');
  }

  // 実際にベクトル型が使えるか（配置が正しくてもここで落ちれば RAG は動かない）。
  // vector 型のまま返すと Prisma が「Failed to deserialize column of type 'vector'」で落ちるため
  // ::text に落として受け取る。検証したいのはキャストが通ること自体なのでこれで十分。
  // （アプリ本体も vector 列は SELECT せず、距離計算の結果だけを返しているので同じ制約に当たらない）
  try {
    await prisma.$queryRawUnsafe(`select ('[1,2,3]'::vector)::text as v`);
    ok('ベクトル型のキャストが使えます');
  } catch (e) {
    bad(`ベクトル型が使えません: ${String(e).slice(0, 120)}`);
    failures++;
  }

  // RLS の網羅性
  const noRls = await prisma.$queryRawUnsafe(`
    SELECT t.tablename FROM pg_tables t
    WHERE t.schemaname='public'
      AND NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t.tablename)::regclass)`);
  if (noRls.length === 0) ok('public の全テーブルで RLS が有効');
  else {
    warn(`RLS 未有効のテーブル ${noRls.length} 件: ${noRls.map((r) => r.tablename).join(', ').slice(0, 120)}`);
    if (APPLY) failures++;
  }

  // n8n スキーマ
  const n8n = await prisma.$queryRawUnsafe(`select 1 from information_schema.schemata where schema_name='n8n'`);
  n8n.length ? ok('n8n スキーマが存在します') : warn('n8n スキーマがありません（n8n を使うなら --apply で作成）');

  console.log(
    failures === 0
      ? '\n✅ 問題は見つかりませんでした。\n'
      : `\n✖ ${failures} 件の問題があります。docs/supabase-migration.md を参照してください。\n`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  await prisma.$disconnect().catch(() => {});
  die(String(e).slice(0, 300));
});
