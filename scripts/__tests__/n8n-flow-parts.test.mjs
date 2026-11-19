// 業務フローの部品（apps/n8n-workflows/parts/part-*.json）の検査（node --test）。docs/flow-parts-n8n.md・canvas-home.md §11「n8n 部品」。
// - JSON として読め、名前が part-<key>、Webhook のパスが parts/<key>（gateway が組み立てる形。K6）、POST・headerAuth・responseNode
// - Webhook の直後で本文（orgId・part・idempotencyKey）を確かめ、違えば 400
// - カタログ（shared-types の flow-parts.ts）の n8n 経由の部品と 1 対 1（TS は読めないので key を正規表現で拾う）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PART_FILE_PATTERN, listPartFiles, selectPartFiles } from '../n8n-import-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = join(ROOT, 'apps', 'n8n-workflows');
const PARTS_DIR = join(WF_DIR, 'parts');
const files = readdirSync(PARTS_DIR).filter((f) => f.endsWith('.json'));

/** カタログで via: { kind: 'n8n' } の部品の key */
function catalogN8nKeys() {
  const src = readFileSync(join(ROOT, 'packages', 'shared-types', 'src', 'flow-parts.ts'), 'utf8');
  const keys = [];
  // 部品は配列の要素（4 字下げの key: と via:）。入力項目の key（6 字下げ以上）は拾わない
  for (const entry of src.split(/\n  \{\n/).slice(1)) {
    const key = /^ {4}key: '([a-z][a-z0-9_]{1,39})'/m.exec(entry)?.[1];
    const via = /^ {4}via: \{ kind: '(n8n|capability)'/m.exec(entry)?.[1];
    if (key && via === 'n8n') keys.push(key);
  }
  return keys.sort();
}

test('parts/ のファイルはすべて part-<key>.json で、カタログの n8n 経由の部品と 1 対 1', () => {
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f, PART_FILE_PATTERN);
  const keys = files.map((f) => PART_FILE_PATTERN.exec(f)[1]).sort();
  assert.deepEqual(keys, catalogN8nKeys());
});

for (const f of files) {
  const key = PART_FILE_PATTERN.exec(f)?.[1];
  const wf = JSON.parse(readFileSync(join(PARTS_DIR, f), 'utf8'));
  const byType = (type) => wf.nodes.filter((n) => n.type === type);

  test(`${f}: 名前は part-<key>、Webhook は parts/<key>・POST・headerAuth・responseNode`, () => {
    assert.equal(wf.name, `part-${key}`);
    const hooks = byType('n8n-nodes-base.webhook');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].parameters.path, `parts/${key}`);
    assert.equal(hooks[0].parameters.httpMethod, 'POST');
    assert.equal(hooks[0].parameters.authentication, 'headerAuth');
    assert.equal(hooks[0].parameters.responseMode, 'responseNode');
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, conn] of Object.entries(wf.connections)) {
      assert.ok(names.has(from));
      for (const branch of conn.main) for (const c of branch) assert.ok(names.has(c.node));
    }
  });

  test(`${f}: Webhook の直後で orgId・part・idempotencyKey を確かめ、違えば 400`, () => {
    const hook = byType('n8n-nodes-base.webhook')[0];
    const gate = wf.nodes.find((n) => n.name === wf.connections[hook.name].main[0][0].node);
    assert.equal(gate.type, 'n8n-nodes-base.if');
    const lefts = gate.parameters.conditions.conditions.map((c) => c.leftValue).join(' ');
    for (const k of ['body.orgId', 'body.part', 'body.idempotencyKey']) assert.ok(lefts.includes(k), k);
    const bad = wf.nodes.find((n) => n.name === wf.connections[gate.name].main[1][0].node);
    assert.equal(bad.type, 'n8n-nodes-base.respondToWebhook');
    assert.equal(bad.parameters.options.responseCode, 400);
  });
}

test('n8n:import は parts/part-*.json を拾い、形の違うファイル名は拾わない', () => {
  assert.deepEqual(listPartFiles(WF_DIR), files.map((f) => `parts/${f}`).sort());
  assert.deepEqual(selectPartFiles(['part-ok_1.json', 'part-Bad.json', 'part-x.json', 'other.json', 'part-ok.txt']), ['parts/part-ok_1.json']);
  assert.deepEqual(listPartFiles(join(ROOT, 'no-such-dir')), []);
});
