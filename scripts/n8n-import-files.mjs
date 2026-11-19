// `npm run n8n:import` が取り込むワークフローの選び方（scripts/n8n-import-workflows.mjs から使う）。
//
// 取り込むのは apps/n8n-workflows 直下の `dept-*.json` と `cap-*.json` だけ。
// ⚠️ `pages/`（業務ページのサンプル）は**取り込まない**。`__ORG_ID__` を組織ごとに置き換えてから手で入れるもので、
//    そのまま入れると全組織共通の Webhook パスができてしまう（docs/design/custom-pages.md §9）。
//    下位のディレクトリは読まない（readdir は直下だけ）ので、pages/ の中のファイル名がどうであっても拾わない。

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** ファイル名（直下のエントリ名）から取り込む対象を選ぶ */
export function selectImportFiles(entries) {
  return entries
    .filter((f) => !f.includes('/') && !f.includes('\\'))
    .filter((f) => (f.startsWith('dept-') || f.startsWith('cap-')) && f.endsWith('.json'))
    .sort();
}

/** ディレクトリ直下のファイルだけを見て選ぶ（サブディレクトリは対象外） */
export function listImportFiles(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return selectImportFiles(files);
}

/**
 * 業務フローの部品（docs/flow-parts-n8n.md）。`parts/part-<key>.json` を取り込む（全組織共通の運営のワークフロー）。
 * 返すのは WF_DIR からの相対パス（`parts/part-pdf_make.json`）。キーの形（英小文字始まり・英小文字・数字・_）以外は拾わない。
 * 部品のパスは gateway が `parts/<key>` に組み立てる（canvas-home.md K6）。
 */
export const PART_FILE_PATTERN = /^part-([a-z][a-z0-9_]{1,39})\.json$/;

export function selectPartFiles(entries) {
  return entries.filter((f) => PART_FILE_PATTERN.test(f)).sort().map((f) => `parts/${f}`);
}

export function listPartFiles(dir) {
  let entries;
  try {
    entries = readdirSync(join(dir, 'parts'), { withFileTypes: true });
  } catch {
    return [];
  }
  return selectPartFiles(entries.filter((e) => e.isFile()).map((e) => e.name));
}
