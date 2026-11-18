// 業務ページの n8n サンプル（apps/n8n-workflows/pages/page-inquiries.json）の検査（node --test）。
// docs/design/custom-pages.md §9・§11「n8n サンプル」・チャンク 7。
// 埋め込んだ定義が pageUpsertSchema を通り seed と一致することは gateway 側
// （apps/api-gateway/src/services/pages/__tests__/seed-sample.test.ts）が確かめる（zod のスキーマが TS のため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listImportFiles, selectImportFiles } from '../n8n-import-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = join(ROOT, 'apps', 'n8n-workflows');
const SAMPLE = join(WF_DIR, 'pages', 'page-inquiries.json');
const wf = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const byType = (type) => wf.nodes.filter((n) => n.type === type);

test('JSON として読め、名前とノードと接続がある', () => {
  assert.equal(typeof wf.name, 'string');
  assert.ok(wf.name.includes('__ORG_ID__'), '取り込んだ組織がワークフロー名で分かる');
  assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0);
  const names = new Set(wf.nodes.map((n) => n.name));
  assert.equal(names.size, wf.nodes.length, 'ノード名が重複しない');
  for (const [from, conn] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), `接続元 ${from} が存在する`);
    for (const branch of conn.main) for (const c of branch) assert.ok(names.has(c.node), `接続先 ${c.node} が存在する`);
  }
});

test('Webhook は 2 本とも pages/__ORG_ID__/<hook>・POST・headerAuth・responseNode', () => {
  const hooks = byType('n8n-nodes-base.webhook');
  assert.deepEqual(hooks.map((h) => h.parameters.path).sort(), ['pages/__ORG_ID__/inquiries-list', 'pages/__ORG_ID__/inquiries-submit']);
  for (const h of hooks) {
    assert.match(h.parameters.path, /^pages\/__ORG_ID__\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
    assert.equal(h.parameters.httpMethod, 'POST');
    assert.equal(h.parameters.authentication, 'headerAuth');
    assert.equal(h.parameters.responseMode, 'responseNode');
    assert.ok(h.webhookId.includes('__ORG_ID__'), 'webhookId も組織ごとに変わる');
  }
});

test('各 Webhook の直後で body.orgId を __ORG_ID__ と照合し、違えば 403 を返す', () => {
  for (const h of byType('n8n-nodes-base.webhook')) {
    const next = wf.connections[h.name].main[0].map((c) => wf.nodes.find((n) => n.name === c.node));
    assert.equal(next.length, 1);
    const gate = next[0];
    assert.equal(gate.type, 'n8n-nodes-base.if');
    const cond = gate.parameters.conditions.conditions[0];
    assert.ok(cond.leftValue.includes('body.orgId'));
    assert.equal(cond.rightValue, '__ORG_ID__');
    const falseBranch = wf.connections[gate.name].main[1].map((c) => wf.nodes.find((n) => n.name === c.node));
    assert.equal(falseBranch[0].type, 'n8n-nodes-base.respondToWebhook');
    assert.equal(falseBranch[0].parameters.options.responseCode, 403);
  }
});

test('登録は手動トリガ → PUT /api/webhooks/n8n/pages/inquiries（x-page-token の credential。共有トークンは使わない）', () => {
  assert.equal(byType('n8n-nodes-base.manualTrigger').length, 1);
  const [put] = byType('n8n-nodes-base.httpRequest');
  assert.equal(put.parameters.method, 'PUT');
  assert.match(put.parameters.url, /\/api\/webhooks\/n8n\/pages\/inquiries$/);
  assert.equal(put.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(put.credentials.httpHeaderAuth.name, 'FLOW page token');
  const body = JSON.parse(put.parameters.jsonBody);
  // 新規は gateway の既定で下書き（K9）。status を書くと再実行のたびに管理者の公開を戻すので書かない（§5.3・K51・レビュー M2）
  for (const k of ['status', 'sortOrder', 'minRole']) {
    assert.ok(!(k in body), `${k} は書かない（再実行で管理者が画面で変えた値を戻さない）`);
  }
  assert.ok(!('orgId' in body) && !('sampleData' in body), '組織はトークンが決める。sampleData は seed だけ');
});

test('秘密を埋め込まない（トークン・既定の共有トークン・本物の URL が無い）', () => {
  const raw = readFileSync(SAMPLE, 'utf8');
  assert.doesNotMatch(raw, /flowpg_[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(raw, /org-ai-n8n-secret-token/);
  assert.doesNotMatch(raw, /https?:\/\//);
});

test('外へ送る可能性のある submit（remind）には confirm がある（K10）', () => {
  const [put] = byType('n8n-nodes-base.httpRequest');
  const { actions } = JSON.parse(put.parameters.jsonBody).definition;
  assert.equal(typeof actions.remind.confirm, 'string');
});

test('n8n:import は pages/ を拾わない（直下の dept-* / cap-* だけ）', () => {
  const files = listImportFiles(WF_DIR);
  assert.ok(files.includes('dept-general.json'));
  assert.ok(files.some((f) => f.startsWith('cap-')));
  assert.ok(files.every((f) => /^(dept|cap)-[^/\\]+\.json$/.test(f)));
  assert.ok(!files.some((f) => f.includes('page')));
});

test('選び方: サブディレクトリ・別の接頭辞・JSON 以外は対象外', () => {
  assert.deepEqual(
    selectImportFiles(['pages', 'pages/cap-x.json', 'cap-b.json', 'dept-a.json', 'page-inquiries.json', 'cap-c.txt', 'chat-response.json']),
    ['cap-b.json', 'dept-a.json'],
  );
  // ディレクトリの名前が cap-*.json でも拾わない
  const dir = mkdtempSync(join(tmpdir(), 'flow-n8n-import-'));
  try {
    mkdirSync(join(dir, 'cap-dir.json'));
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'cap-in-pages.json'), '{}');
    writeFileSync(join(dir, 'dept-x.json'), '{}');
    assert.deepEqual(listImportFiles(dir), ['dept-x.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
