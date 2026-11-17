#!/usr/bin/env node
// デプロイ設定の突き合わせ（計画書チャンク 8）。ファイルを読むだけで、外部にも Docker にも触らない。
//
//   node scripts/check-deploy-config.mjs      … 食い違いがあれば一覧を出して exit 1
//
// ■ 見ているもの
//   - gateway の envSchema（config/env.ts）のキーが .env.example に載っている（`KEY=` か `# KEY=`）
//   - render.yaml の gateway / ai-engine のキーが、それぞれの読み口（env.ts / app/config.py）にある
//   - docker-compose.yml が YAML として読め、Postgres が pgvector、.env が無くても起動できる
//     （env_file は required: false、JWT_SECRET などに開発用の既定値）、gateway に渡すキーが envSchema にある
//   - リポジトリに書いた公開の JWT_SECRET（.env.example・compose の既定値）が、本番の起動拒否の表にある
//   - Node は 22 以上: Dockerfile・.node-version・package.json の engines・render.yaml・CI
//   - vercel.json の出力先が web のビルド先と同じ
//   - デプロイ手順は docs/DEPLOY.md の 1 本（render.yaml の sync: false を全部載せる。古い DB の記述が無い。
//     DEPLOYMENT_RUNBOOK.md は案内だけで手順＝コードブロックを持たない）
// ■ 足したいキーが「読み口に無い」で落ちたら: 先に env.ts / config.py に足す（CLAUDE.md の開発ルール）。
//   Render の基盤が読むだけのキーは PLATFORM_KEYS に理由付きで足す。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Render の基盤が読むだけで、アプリは読まないキー */
const PLATFORM_KEYS = new Set([
  'NODE_VERSION', // Render の Node のバージョン指定
]);

const MIN_NODE_MAJOR = 22;

const GATEWAY_RENDER_NAME = 'org-ai-api-gateway';
const AI_ENGINE_RENDER_NAME = 'org-ai-ai-engine';

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

const DEPLOY_DOC = 'docs/DEPLOY.md';
const RUNBOOK = 'DEPLOYMENT_RUNBOOK.md';
/** 移行済みの旧 DB（2026-08 に Supabase へ移った）。手順書に出てきたら古い手順が混ざっている */
const STALE_DEPLOY_WORDS = [/neon/i];

/** env.ts の `export const envSchema = z.object({ ... });` からキーを抜く */
export function envSchemaKeys(envTs) {
  const m = envTs.match(/export const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
  if (!m) return null;
  return [...m[1].matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((x) => x[1]);
}

/** app/config.py の `_env("KEY"` からキーを抜く */
export function aiEngineKeys(configPy) {
  return [...new Set([...configPy.matchAll(/_env\("([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]))];
}

/** .env.example に `KEY=` か `# KEY=` で載っているキー */
export function envExampleKeys(text) {
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((x) => x[1]));
}

/** startup-checks.ts の PUBLIC_JWT_SECRETS の中身 */
export function publicJwtSecrets(startupChecksTs) {
  const m = startupChecksTs.match(/PUBLIC_JWT_SECRETS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** `${NAME:-default}` の既定値。無ければ null */
function composeDefault(value, name) {
  if (typeof value !== 'string') return null;
  const m = value.match(new RegExp(`\\$\\{${name}:-([^}]*)\\}`));
  return m ? m[1] : null;
}

/** compose の environment（配列でも連想でも）をキー → 値に */
function composeEnv(service) {
  const env = service?.environment;
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map((line) => {
        const i = String(line).indexOf('=');
        return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
      }),
    );
  }
  return env;
}

function nodeMajor(spec) {
  const m = String(spec ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : NaN;
}

/** 食い違いの一覧を返す（空なら OK） */
export function checkDeployConfig(root = REPO_ROOT) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // ── gateway の読み口 ──
  const envTs = read(root, 'apps/api-gateway/src/config/env.ts');
  const schemaKeys = envSchemaKeys(envTs);
  if (!schemaKeys || schemaKeys.length === 0) {
    fail('env.ts: envSchema が見つからない');
    return errors;
  }
  const schema = new Set(schemaKeys);
  if (/AI_ENGINE_URL_COMPOSE/.test(envTs)) fail('env.ts: AI_ENGINE_URL_COMPOSE が残っている（既定値は AI_ENGINE_URL の 1 つだけ）');

  // ── .env.example ──
  const example = read(root, '.env.example');
  const exampleKeys = envExampleKeys(example);
  for (const k of schemaKeys) {
    if (!exampleKeys.has(k)) fail(`.env.example: envSchema の ${k} が載っていない（\`# ${k}=\` でよい）`);
  }

  // ── ai-engine の読み口 ──
  const aiKeys = new Set(aiEngineKeys(read(root, 'apps/ai-engine/app/config.py')));
  for (const k of aiKeys) {
    if (!exampleKeys.has(k)) fail(`.env.example: ai-engine の ${k} が載っていない`);
  }

  // ── render.yaml ──
  let render;
  try {
    render = parseYaml(read(root, 'render.yaml'));
  } catch (e) {
    fail(`render.yaml: YAML として読めない (${e.message})`);
  }
  if (render) {
    const services = render.services ?? [];
    const byName = (n) => services.find((s) => s.name === n);
    const keysOf = (svc) => (svc?.envVars ?? []).map((v) => v.key);
    const gw = byName(GATEWAY_RENDER_NAME);
    const ai = byName(AI_ENGINE_RENDER_NAME);
    if (!gw) fail(`render.yaml: ${GATEWAY_RENDER_NAME} が無い`);
    if (!ai) fail(`render.yaml: ${AI_ENGINE_RENDER_NAME} が無い`);
    for (const k of keysOf(gw)) {
      if (!schema.has(k) && !PLATFORM_KEYS.has(k)) fail(`render.yaml: gateway の ${k} は envSchema に無い（読まれない）`);
    }
    for (const k of keysOf(ai)) {
      if (!aiKeys.has(k) && !PLATFORM_KEYS.has(k)) fail(`render.yaml: ai-engine の ${k} は app/config.py で読まれない`);
    }
    // 本番に要るのに宣言が漏れやすいもの（計画書 1.7）
    for (const k of ['ALLOWED_ORIGIN_HOSTS', 'N8N_CALLBACK_ORG_REQUIRED', 'N8N_WEBHOOK_AUTH_TOKEN', 'JWT_SECRET', 'INTERNAL_API_TOKEN']) {
      if (gw && !keysOf(gw).includes(k)) fail(`render.yaml: gateway に ${k} が無い`);
    }
    for (const k of ['ORG_HEADER_MODE', 'INTERNAL_API_TOKEN', 'DATABASE_URL']) {
      if (ai && !keysOf(ai).includes(k)) fail(`render.yaml: ai-engine に ${k} が無い`);
    }
    // ── デプロイ手順書: ダッシュボードで入れるキー（sync: false）はすべて手順に載っている ──
    if (existsSync(join(root, DEPLOY_DOC))) {
      const doc = read(root, DEPLOY_DOC);
      for (const svc of [gw, ai]) {
        for (const v of svc?.envVars ?? []) {
          if (v.sync === false && !doc.includes(v.key)) fail(`${DEPLOY_DOC}: ${svc.name} の ${v.key}（sync: false）が手順に無い`);
        }
      }
    }
    const nodeVersion = (gw?.envVars ?? []).find((v) => v.key === 'NODE_VERSION')?.value;
    if (!(nodeMajor(nodeVersion) >= MIN_NODE_MAJOR)) fail(`render.yaml: gateway の NODE_VERSION が ${MIN_NODE_MAJOR} 以上でない`);
  }

  // ── 公開されている JWT_SECRET ──
  const published = publicJwtSecrets(read(root, 'apps/api-gateway/src/config/startup-checks.ts'));
  if (!published) fail('startup-checks.ts: PUBLIC_JWT_SECRETS が見つからない');
  const exampleJwt = example.match(/^JWT_SECRET=(.*)$/m)?.[1]?.trim();
  if (exampleJwt && published && !published.includes(exampleJwt)) {
    fail('.env.example の JWT_SECRET が PUBLIC_JWT_SECRETS に無い（本番で見本の値のまま起動できてしまう）');
  }

  // ── docker-compose.yml ──
  let compose;
  try {
    compose = parseYaml(read(root, 'docker-compose.yml'));
  } catch (e) {
    fail(`docker-compose.yml: YAML として読めない (${e.message})`);
  }
  if (compose) {
    const svcs = compose.services ?? {};
    for (const name of ['postgres', 'ai-engine', 'api-gateway', 'web']) {
      if (!svcs[name]) fail(`docker-compose.yml: ${name} が無い`);
      else if (svcs[name].profiles) fail(`docker-compose.yml: ${name} が profile 付き（既定の起動に入らない）`);
    }
    if (!String(svcs.postgres?.image ?? '').startsWith('pgvector/pgvector:')) {
      fail('docker-compose.yml: postgres が pgvector のイメージでない（マイグレーションの CREATE EXTENSION vector が落ちる）');
    }
    if (svcs.n8n && !(svcs.n8n.profiles ?? []).includes('n8n')) fail('docker-compose.yml: n8n は profiles: [n8n]（既定で起動しない）');
    if (svcs.n8n && /:latest$|^[^:]+$/.test(String(svcs.n8n.image ?? ''))) fail('docker-compose.yml: n8n のタグを固定する');
    for (const [name, svc] of Object.entries(svcs)) {
      const files = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
      for (const f of files) {
        if (typeof f === 'string' || f.required !== false) fail(`docker-compose.yml: ${name} の env_file が必須（.env が無いと起動しない）。required: false にする`);
      }
    }
    const gwEnv = composeEnv(svcs['api-gateway']);
    for (const k of Object.keys(gwEnv)) {
      if (!schema.has(k)) fail(`docker-compose.yml: api-gateway の ${k} は envSchema に無い`);
    }
    if (gwEnv.AI_ENGINE_URL !== 'http://ai-engine:8000') fail('docker-compose.yml: api-gateway の AI_ENGINE_URL は http://ai-engine:8000');
    const jwtDefault = composeDefault(gwEnv.JWT_SECRET, 'JWT_SECRET');
    if (jwtDefault === null) fail('docker-compose.yml: api-gateway の JWT_SECRET に開発用の既定値（${JWT_SECRET:-...}）が無い');
    else {
      if (jwtDefault.length < 32) fail('docker-compose.yml: JWT_SECRET の既定値が 32 文字未満（gateway が起動しない）');
      if (published && !published.includes(jwtDefault)) fail('docker-compose.yml: JWT_SECRET の既定値が PUBLIC_JWT_SECRETS に無い');
    }
    for (const k of ['DATABASE_URL', 'INTERNAL_API_TOKEN']) {
      const a = composeEnv(svcs['api-gateway'])[k];
      const b = composeEnv(svcs['ai-engine'])[k];
      if (!a || a !== b) fail(`docker-compose.yml: ${k} が api-gateway と ai-engine で同じでない`);
    }
    if (!gwEnv.DATABASE_URL?.includes('@postgres:')) fail('docker-compose.yml: api-gateway の DATABASE_URL が compose の postgres を指していない');
    const gwDeps = svcs['api-gateway']?.depends_on ?? {};
    if (gwDeps.postgres?.condition !== 'service_healthy') fail('docker-compose.yml: api-gateway は postgres の健康を待つ（depends_on: service_healthy）');
    if (svcs.web?.depends_on?.['api-gateway']?.condition !== 'service_healthy') fail('docker-compose.yml: web は api-gateway の健康を待つ');
    if (!svcs['api-gateway']?.healthcheck) fail('docker-compose.yml: api-gateway に healthcheck が無い');
    if (JSON.stringify(svcs['api-gateway']?.healthcheck?.test ?? '').includes('curl')) {
      fail('docker-compose.yml: api-gateway のイメージに curl は無い（node で確かめる）');
    }
  }

  // ── Node のバージョン ──
  for (const app of readdirSync(join(root, 'apps'))) {
    const rel = `apps/${app}/Dockerfile`;
    if (!existsSync(join(root, rel))) continue;
    for (const m of read(root, rel).matchAll(/^FROM\s+node:(\S+)/gim)) {
      if (!(nodeMajor(m[1]) >= MIN_NODE_MAJOR)) fail(`${rel}: node:${m[1]} は ${MIN_NODE_MAJOR} 未満`);
    }
  }
  if (!existsSync(join(root, '.node-version'))) fail('.node-version が無い');
  else if (!(nodeMajor(read(root, '.node-version')) >= MIN_NODE_MAJOR)) fail(`.node-version が ${MIN_NODE_MAJOR} 未満`);
  const pkg = JSON.parse(read(root, 'package.json'));
  if (!(nodeMajor(pkg.engines?.node) >= MIN_NODE_MAJOR)) fail(`package.json: engines.node が ${MIN_NODE_MAJOR} 以上でない`);
  const ciPath = '.github/workflows/ci.yml';
  if (existsSync(join(root, ciPath))) {
    for (const m of read(root, ciPath).matchAll(/node-version:\s*['"]?(\d+)/g)) {
      if (Number(m[1]) < MIN_NODE_MAJOR) fail(`${ciPath}: node-version ${m[1]} は ${MIN_NODE_MAJOR} 未満`);
    }
  }

  // ── Vercel（リポジトリ側が正。プロジェクト側は README の表に合わせる） ──
  const vercel = JSON.parse(read(root, 'vercel.json'));
  const webName = JSON.parse(read(root, 'apps/web/package.json')).name;
  if (vercel.outputDirectory !== 'apps/web/dist') fail('vercel.json: outputDirectory は apps/web/dist（リポジトリのルートから組む）');
  if (!String(vercel.buildCommand ?? '').includes(webName)) fail(`vercel.json: buildCommand が ${webName} を組んでいない`);

  // ── デプロイ手順は 1 本 ──
  if (!existsSync(join(root, DEPLOY_DOC))) fail(`${DEPLOY_DOC} が無い`);
  else {
    const doc = read(root, DEPLOY_DOC);
    for (const w of STALE_DEPLOY_WORDS) {
      if (w.test(doc)) fail(`${DEPLOY_DOC}: 移行済みの DB の記述（${w.source}）が残っている`);
    }
  }
  if (existsSync(join(root, RUNBOOK))) {
    const runbook = read(root, RUNBOOK);
    if (!runbook.includes(DEPLOY_DOC)) fail(`${RUNBOOK}: ${DEPLOY_DOC} への案内が無い`);
    if (runbook.includes('```')) fail(`${RUNBOOK}: 手順（コードブロック）を書かない。${DEPLOY_DOC} に書く`);
  }

  return errors;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const errors = checkDeployConfig();
  if (errors.length > 0) {
    console.error(`デプロイ設定の食い違い: ${errors.length} 件`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('デプロイ設定: OK');
}
