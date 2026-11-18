// `npm run n8n:import` が取り込むワークフローの選び方（scripts/n8n-import-workflows.mjs から使う）。
//
// 取り込むのは apps/n8n-workflows 直下の `dept-*.json` と `cap-*.json` だけ。
// ⚠️ `pages/`（業務ページのサンプル）は**取り込まない**。`__ORG_ID__` を組織ごとに置き換えてから手で入れるもので、
//    そのまま入れると全組織共通の Webhook パスができてしまう（docs/design/custom-pages.md §9）。
//    下位のディレクトリは読まない（readdir は直下だけ）ので、pages/ の中のファイル名がどうであっても拾わない。

import { readdirSync } from 'node:fs';

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
