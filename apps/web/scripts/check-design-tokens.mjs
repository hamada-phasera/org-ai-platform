#!/usr/bin/env node
/**
 * デザイントークン退行ガード（v3）。
 * src/**​/*.{ts,tsx} を走査して exit 1:
 *  1. hex 直書き（#RRGGBB / #RGB）— 色はトークン経由で
 *  2. v2 の残骸 — dark: バリアント / tab-glass・liquid-* / backdrop-filter系
 *     （v3 でダークモードとリキッドガラスは全廃。復活は退行）
 *
 * 実行: npm run check:tokens
 *
 * 除外:
 *  - src/taskmanager/** … v1のまま凍結中のサブアプリ
 *  - constants/departments.ts / brand.ts … データの色の正本
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

const EXCLUDE = [
  /^taskmanager\//,
  /^constants\/(departments|brand)\.ts$/,
];

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/* v2残骸の禁止パターン（マッチした行ごと報告） */
const BANNED = [
  [/(?:^|[\s"'`{])dark:/, 'dark: バリアント（ダークモードは廃止）'],
  [/\btab-glass\b|\bliquid-(?:glass|primary|smoke|lens|trough|thumb|pill|bar|icon|unified)/, 'リキッドガラスのクラス（v3で全廃）'],
  [/backdrop-(?:filter|blur)/, 'backdrop-filter（v3では不使用）'],
];

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
    if (hits) {
      bad += hits.length;
      console.log(`${rel}:${i + 1}  ${hits.join(' ')}  |  ${line.trim().slice(0, 90)}`);
    }
    for (const [re, label] of BANNED) {
      if (re.test(line)) {
        bad += 1;
        console.log(`${rel}:${i + 1}  [${label}]  |  ${line.trim().slice(0, 90)}`);
      }
    }
  });
}

if (bad > 0) {
  console.error(`\n✗ 違反 ${bad} 件。トークン経由に置き換えるか、v2残骸を撤去してください。`);
  process.exit(1);
}
console.log('✓ 違反なし（hex直書き・dark:・ガラス残骸ゼロ / taskmanager, departments, brand を除く）');
