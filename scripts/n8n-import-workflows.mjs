#!/usr/bin/env node
// apps/n8n-workflows/{dept,cap}-*.json と parts/part-*.json を n8n Public API でインポート (or 上書き) し、
// アクティブ化する。
//
// 使い方:
//   N8N_URL=https://org-ai-n8n-web.onrender.com \
//   N8N_API_KEY=eyJ... \
//   N8N_WEBHOOK_AUTH_TOKEN=org-ai-n8n-secret-token \
//   node scripts/n8n-import-workflows.mjs
//
// .env を自動で読み込みます（dotenv-flow 不要、簡易パーサ）。

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listImportFiles, listPartFiles } from './n8n-import-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WF_DIR = join(ROOT, 'apps', 'n8n-workflows');

// ----- 簡易 .env ローダー -----
function loadEnv(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv(join(ROOT, '.env'));

const N8N_URL = (process.env.N8N_CLOUD_URL ?? process.env.N8N_URL ?? '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const TOKEN = process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'org-ai-n8n-secret-token';

if (!N8N_URL) {
  console.error('N8N_URL もしくは N8N_CLOUD_URL を設定してください。');
  process.exit(1);
}
if (!N8N_API_KEY) {
  console.error('N8N_API_KEY を設定してください (n8n → Settings → API → Create)。');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'X-N8N-API-KEY': N8N_API_KEY,
};

const CREDENTIAL_NAME = 'org-ai webhook token';
const CREDENTIAL_HEADER_NAME = 'x-org-ai-token';

async function listExistingWorkflows() {
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, { headers });
  if (!res.ok) throw new Error(`workflows list failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.data ?? [];
}

// Header Auth credential を作成または既存を返す。
// 注: n8n Public API の GET /credentials は credential 一覧を返すバージョンと
// 404 を返すバージョンがあるため、既存検出は best-effort。
async function ensureHeaderAuthCredential() {
  let existing = [];
  try {
    const res = await fetch(`${N8N_URL}/api/v1/credentials`, { headers });
    if (res.ok) {
      const j = await res.json();
      existing = j.data ?? [];
    }
  } catch {
    // ignore — 一覧が取れなくても作成は試みる
  }
  const hit = existing.find((c) => c.name === CREDENTIAL_NAME && c.type === 'httpHeaderAuth');
  if (hit) {
    console.log(`[creds] 既存 credential を利用: ${hit.id}`);
    return { id: hit.id, name: hit.name };
  }
  const res = await fetch(`${N8N_URL}/api/v1/credentials`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: CREDENTIAL_NAME,
      type: 'httpHeaderAuth',
      data: { name: CREDENTIAL_HEADER_NAME, value: TOKEN },
    }),
  });
  if (!res.ok) {
    throw new Error(`credential create failed: ${res.status} ${await res.text()}`);
  }
  const j = await res.json();
  const id = j.data?.id ?? j.id;
  console.log(`[creds] credential 新規作成: ${id}`);
  return { id, name: CREDENTIAL_NAME };
}

// Webhook ノードに httpHeaderAuth credential を注入する。
function attachCredentialToWebhookNodes(wf, credential) {
  let attached = 0;
  for (const node of wf.nodes ?? []) {
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters?.authentication === 'headerAuth') {
      node.credentials = node.credentials ?? {};
      node.credentials.httpHeaderAuth = { id: credential.id, name: credential.name };
      attached += 1;
    }
  }
  return attached;
}

async function n8nApiCreate(wf) {
  // 一部フィールドは create 時に渡せない
  const body = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? { executionOrder: 'v1' },
  };
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function updateWorkflow(id, wf) {
  const body = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? { executionOrder: 'v1' },
  };
  const res = await fetch(`${N8N_URL}/api/v1/workflows/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function activateWorkflow(id) {
  const res = await fetch(`${N8N_URL}/api/v1/workflows/${id}/activate`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`  [warn] activate ${id} failed: ${res.status} ${body}`);
    return false;
  }
  return true;
}

console.log(`n8n URL: ${N8N_URL}`);
console.log('既存ワークフローを取得中…');
let existing;
try {
  existing = await listExistingWorkflows();
} catch (e) {
  const msg = e.message ?? '';
  console.error(`\n× Public API 接続に失敗しました: ${msg.slice(0, 200)}`);
  if (msg.includes('Database is not ready')) {
    console.error('  → n8n の DB (Postgres) が未接続。Render ダッシュボードで:');
    console.error('     1. org-ai-n8n サービスの環境変数 DB_POSTGRESDB_* を確認');
    console.error('     2. 紐づく Postgres インスタンスが Active か確認 (Free は 90日で削除)');
    console.error('     3. n8n サービスを Restart');
  } else if (msg.includes('unauthorized') || msg.includes('401')) {
    console.error('  → API キーが無効。n8n UI で発行してください:');
    console.error(`     ${N8N_URL}/settings/api → "Create an API key"`);
    console.error('     取得したキーを .env の N8N_API_KEY に設定して再実行。');
  } else if (msg.includes('404')) {
    console.error('  → Public API パスが見つからない。n8n のバージョンが古いか、Public API が無効。');
    console.error('     N8N_PUBLIC_API_DISABLED=false を Render env に設定して Restart。');
  }
  process.exit(1);
}
console.log(`既存: ${existing.length} 件`);

console.log('Header Auth credential を準備中…');
let credential;
try {
  credential = await ensureHeaderAuthCredential();
} catch (e) {
  console.error(`× credential 準備失敗: ${e.message}`);
  console.error('  → n8n UI で手動作成してください (docs/n8n-setup.md §4)');
  credential = null;
}

// dept-* / cap-* と、業務フローの部品 parts/part-*.json（全組織共通。docs/flow-parts-n8n.md）。
// 業務ページのサンプル（pages/）は組織ごとに手で入れるので拾わない
const files = [...listImportFiles(WF_DIR), ...listPartFiles(WF_DIR)];

for (const f of files) {
  const wf = JSON.parse(await readFile(join(WF_DIR, f), 'utf8'));
  const found = existing.find((w) => w.name === wf.name);
  let attached = 0;
  if (credential) attached = attachCredentialToWebhookNodes(wf, credential);
  try {
    let id;
    if (found) {
      console.log(`[update] ${wf.name} (id=${found.id}, creds attached=${attached})`);
      await updateWorkflow(found.id, wf);
      id = found.id;
    } else {
      console.log(`[create] ${wf.name} (creds attached=${attached})`);
      const created = await n8nApiCreate(wf);
      id = created.data?.id ?? created.id;
    }
    const ok = await activateWorkflow(id);
    console.log(`  active=${ok}`);
  } catch (e) {
    console.error(`  [error] ${wf.name}: ${e.message}`);
  }
}

console.log('\n=== 残りの手動作業 ===');
if (!credential) {
  console.log('1. Credentials → New → "Header Auth"');
  console.log(`     Name : ${CREDENTIAL_HEADER_NAME}`);
  console.log(`     Value: ${TOKEN}`);
  console.log('   保存し、各 Webhook ノードの "Credential" にこのエントリを紐付け');
}
console.log('A. provider OAuth 接続 (Gmail / Slack / X / Google Sheets 等)');
console.log(`   → ${N8N_URL}/home/credentials で各 provider の "New" を実行`);
console.log('\n動作確認:');
console.log(`  curl -X POST ${N8N_URL}/webhook/dept-general \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -H "x-org-ai-token: ${TOKEN}" \\`);
console.log(`    -d '{"taskId":"smoke-test","orgId":"x","title":"t","input":"こんにちは","department":"GENERAL","plan":"STARTER","callbackUrl":"http://localhost:4000/api/webhooks/n8n/task-complete","logUrl":"http://localhost:4000/api/webhooks/n8n/task-log","aiEngineUrl":"http://localhost:8000"}'`);
