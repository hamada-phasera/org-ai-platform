#!/usr/bin/env node
/**
 * デザイントークン退行ガード。
 * src/**​/*.{ts,tsx} の hex 直書き（#RRGGBB / #RGB）を検出して一覧し、
 * 検出があれば exit 1。色は index.css のトークン（CSS変数）か
 * tailwind.config.js のキー経由で使うこと。
 *
 * 実行: node scripts/check-design-tokens.mjs
 *
 * 除外:
 *  - src/taskmanager/** … v1のまま凍結中のサブアプリ（ダーク非対応も既知）
 *  - constants/departments.ts … 部署色＝データの色の正本（トークンの供給元）
 *  - orb-runtime.gen.* … 生成物
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

const EXCLUDE = [
  /^taskmanager\//,
  /^constants\/(departments|brand)\.ts$/,
  /orb-runtime\.gen\./,
];

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

let bad = 0;
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (EXCLUDE.some((re) => re.test(rel))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const hits = line.match(HEX);
    if (!hits) return;
    bad += hits.length;
    console.log(`${rel}:${i + 1}  ${hits.join(' ')}  |  ${line.trim().slice(0, 90)}`);
  });
}

if (bad > 0) {
  console.error(`\n✗ hex直書き ${bad} 件。index.css のトークンか tailwind キーに置き換えてください。`);
  process.exit(1);
}
console.log('✓ hex直書きなし（taskmanager/departments を除く）');
