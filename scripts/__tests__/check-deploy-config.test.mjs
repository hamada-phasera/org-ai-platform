// デプロイ設定の突き合わせ（計画書チャンク 8 受け入れ条件 1・3・4）。
// 本物のリポジトリで 0 件になること、写しを 1 か所ずつ壊すと必ず落ちることを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, checkDeployConfig, envSchemaKeys, publicJwtSecrets } from '../check-deploy-config.mjs';

const FILES = [
  'apps/api-gateway/src/config/env.ts',
  'apps/api-gateway/src/config/startup-checks.ts',
  'apps/ai-engine/app/config.py',
  'apps/api-gateway/Dockerfile',
  'apps/web/Dockerfile',
  'apps/ai-engine/Dockerfile',
  'apps/web/package.json',
  '.env.example',
  '.node-version',
  'package.json',
  'render.yaml',
  'docker-compose.yml',
  'vercel.json',
  '.github/workflows/ci.yml',
  'docs/DEPLOY.md',
  'DEPLOYMENT_RUNBOOK.md',
];

/** 突き合わせに使うファイルだけを一時ディレクトリに写し、edit で 1 か所変えてから検査する */
function checkWith(rel, edit) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-deploy-check-'));
  try {
    for (const f of FILES) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(REPO_ROOT, f), join(dir, f));
    }
    if (rel) {
      const before = readFileSync(join(dir, rel), 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, `${rel} の書き換えが効いていない`);
      writeFileSync(join(dir, rel), after);
    }
    return checkDeployConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('リポジトリの設定は食い違いが 0 件（CLI も exit 0）', () => {
  assert.deepEqual(checkDeployConfig(), []);
  assert.deepEqual(checkWith(null), []);
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/check-deploy-config.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('envSchema のキーを .env.example から 1 つ消すと落ちる', () => {
  const errors = checkWith('.env.example', (s) => s.replace(/^# OAUTH_STATE_SECRET=.*\n/m, ''));
  assert.ok(errors.some((e) => e.includes('OAUTH_STATE_SECRET')), errors.join('\n'));
});

test('CLI はキーが欠けると exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-deploy-cli-'));
  try {
    for (const f of FILES) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(REPO_ROOT, f), join(dir, f));
    }
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(REPO_ROOT, 'scripts/check-deploy-config.mjs'), join(dir, 'scripts/check-deploy-config.mjs'));
    // yaml はリポジトリの node_modules から解決させる
    cpSync(join(REPO_ROOT, 'node_modules/yaml'), join(dir, 'node_modules/yaml'), { recursive: true });
    const p = join(dir, '.env.example');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^# N8N_CALLBACK_ORG_REQUIRED=.*\n/m, ''));
    const r = spawnSync(process.execPath, [join(dir, 'scripts/check-deploy-config.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /N8N_CALLBACK_ORG_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render.yaml の gateway に読まれないキー・必要なキーの欠落・古い Node は落ちる', () => {
  const unknown = checkWith('render.yaml', (s) =>
    s.replace('      - key: JWT_SECRET\n', '      - key: NOT_READ_ANYWHERE\n        sync: false\n      - key: JWT_SECRET\n'),
  );
  assert.ok(unknown.some((e) => e.includes('NOT_READ_ANYWHERE')), unknown.join('\n'));

  const missing = checkWith('render.yaml', (s) => s.replace(/      - key: ALLOWED_ORIGIN_HOSTS\n        value: .*\n/, ''));
  assert.ok(missing.some((e) => e.includes('ALLOWED_ORIGIN_HOSTS')), missing.join('\n'));

  // 決済設定済みの 3 つのうち webhook の署名鍵（saas-review #2）
  const whMissing = checkWith('render.yaml', (s) => s.replace(/      - key: STRIPE_WEBHOOK_SECRET\n        sync: false\n/, ''));
  assert.ok(whMissing.some((e) => e.includes('STRIPE_WEBHOOK_SECRET')), whMissing.join('\n'));

  const aiMissing = checkWith('render.yaml', (s) => s.replace(/      - key: ORG_HEADER_MODE\n        value: .*\n/, ''));
  assert.ok(aiMissing.some((e) => e.includes('ORG_HEADER_MODE')), aiMissing.join('\n'));

  const oldNode = checkWith('render.yaml', (s) => s.replace(/key: NODE_VERSION\n(\s+)value: "22"/, 'key: NODE_VERSION\n$1value: "20"'));
  assert.ok(oldNode.some((e) => e.includes('NODE_VERSION')), oldNode.join('\n'));
});

test('compose: pgvector でない・.env 必須・開発用 JWT の既定値なし・profile 無しの n8n は落ちる', () => {
  const plain = checkWith('docker-compose.yml', (s) => s.replace('image: pgvector/pgvector:pg16\n    restart: unless-stopped', 'image: postgres:16-alpine\n    restart: unless-stopped'));
  assert.ok(plain.some((e) => e.includes('pgvector')), plain.join('\n'));

  const envRequired = checkWith('docker-compose.yml', (s) => s.replace(/env_file:\n\s+- path: \.env\n\s+required: false/, 'env_file: .env'));
  assert.ok(envRequired.some((e) => e.includes('env_file')), envRequired.join('\n'));

  const noJwtDefault = checkWith('docker-compose.yml', (s) => s.replace(/\$\{JWT_SECRET:-[^}]*\}/, '${JWT_SECRET}'));
  assert.ok(noJwtDefault.some((e) => e.includes('JWT_SECRET')), noJwtDefault.join('\n'));

  const n8nDefault = checkWith('docker-compose.yml', (s) => s.replace('    profiles: [n8n]\n', ''));
  assert.ok(n8nDefault.some((e) => e.includes('n8n')), n8nDefault.join('\n'));

  const notYaml = checkWith('docker-compose.yml', (s) => `${s}\n  broken: [unclosed\n`);
  assert.ok(notYaml.some((e) => e.includes('YAML')), notYaml.join('\n'));
});

test('compose の JWT 既定値・.env.example の見本は本番の起動拒否の表に入っている', () => {
  const published = publicJwtSecrets(readFileSync(join(REPO_ROOT, 'apps/api-gateway/src/config/startup-checks.ts'), 'utf8'));
  const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  assert.ok(published.includes(compose.match(/\$\{JWT_SECRET:-([^}]*)\}/)[1]));
  assert.ok(published.includes(example.match(/^JWT_SECRET=(.*)$/m)[1].trim()));

  const dropped = checkWith('apps/api-gateway/src/config/startup-checks.ts', (s) =>
    s.replace("  'compose-dev-only-jwt-secret-not-for-production-0000',\n", ''),
  );
  assert.ok(dropped.some((e) => e.includes('PUBLIC_JWT_SECRETS')), dropped.join('\n'));
});

test('Dockerfile に node:20 を戻すと落ちる。AI_ENGINE_URL_COMPOSE を戻しても落ちる', () => {
  const docker = checkWith('apps/web/Dockerfile', (s) => s.replace('FROM node:22-alpine', 'FROM node:20-alpine'));
  assert.ok(docker.some((e) => e.includes('apps/web/Dockerfile')), docker.join('\n'));

  const compose = checkWith('apps/api-gateway/src/config/env.ts', (s) =>
    s.replace("  AI_ENGINE_URL: 'http://localhost:8000',\n", "  AI_ENGINE_URL: 'http://localhost:8000',\n  AI_ENGINE_URL_COMPOSE: 'http://ai-engine:8000',\n"),
  );
  assert.ok(compose.some((e) => e.includes('AI_ENGINE_URL_COMPOSE')), compose.join('\n'));
});

test('リポジトリに node:20 の記述が無い（受け入れ条件 4）', () => {
  const r = spawnSync('git', ['grep', '-n', 'node:20', '--', '.', ':!docs/plan/**', ':!scripts/__tests__/check-deploy-config.test.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // git grep は一致なしで 1
  assert.equal(r.status, 1, r.stdout);
});

test('デプロイ手順は docs/DEPLOY.md の 1 本（チャンク 12 受け入れ条件 3）', () => {
  // render.yaml の sync: false を手順から消すと落ちる
  const missingKey = checkWith('docs/DEPLOY.md', (s) => s.replaceAll('STRIPE_TAX_RATE_ID', 'STRIPE_TAX_RATE'));
  assert.ok(missingKey.some((e) => e.includes('STRIPE_TAX_RATE_ID')), missingKey.join('\n'));
  const aiKey = checkWith('docs/DEPLOY.md', (s) => s.replaceAll('ADMIN_EMAILS', 'ADMINS'));
  assert.ok(aiKey.some((e) => e.includes('org-ai-ai-engine') && e.includes('ADMIN_EMAILS')), aiKey.join('\n'));

  // 移行済みの DB の記述が戻ると落ちる
  const stale = checkWith('docs/DEPLOY.md', (s) => `${s}\n接続先は Neon の ep-xxx\n`);
  assert.ok(stale.some((e) => e.includes('移行済み')), stale.join('\n'));

  // RUNBOOK に手順が戻る・案内が消えると落ちる
  const forked = checkWith('DEPLOYMENT_RUNBOOK.md', (s) => `${s}\n\`\`\`bash\nvercel --prod\n\`\`\`\n`);
  assert.ok(forked.some((e) => e.includes('コードブロック')), forked.join('\n'));
  const noLink = checkWith('DEPLOYMENT_RUNBOOK.md', (s) => s.replaceAll('docs/DEPLOY.md', 'docs/X.md'));
  assert.ok(noLink.some((e) => e.includes('案内が無い')), noLink.join('\n'));
});

test('envSchemaKeys は env.ts の全キーを拾う', () => {
  const keys = envSchemaKeys(readFileSync(join(REPO_ROOT, 'apps/api-gateway/src/config/env.ts'), 'utf8'));
  assert.ok(keys.includes('NODE_ENV'));
  assert.ok(keys.includes('APP_BASE_URL'));
  assert.ok(keys.length >= 50, String(keys.length));
});
