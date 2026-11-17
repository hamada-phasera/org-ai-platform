#!/usr/bin/env node
/**
 * PWA の資産の検査（計画書チャンク 6 受け入れ条件 1・2）。依存ゼロ。
 *
 *  - manifest.webmanifest が JSON として読め、必須の項目がある
 *  - manifest の icons が全部存在し、PNG の実寸が sizes と一致する（192・512・maskable）
 *  - apple-touch-icon（180）がある
 *  - index.html が manifest と apple-touch-icon を参照し、参照先が存在する
 *
 * 使い方:
 *   node scripts/check-pwa.mjs          … public/ と index.html（ソース）
 *   node scripts/check-pwa.mjs dist     … ビルド成果物（build の後に自動で回る）
 * ルートの `npm test`（scripts/__tests__/pwa-assets.test.mjs）からも呼ぶ。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** PNG の幅と高さ（IHDR）。PNG でなければ null。 */
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** `/icons/a.png` → `<root>/icons/a.png`（先頭の / は root 起点） */
const local = (root, href) => join(root, href.replace(/^\//, '').split(/[?#]/)[0]);

/**
 * @param {{ assetsDir: string, indexHtml: string }} opts
 *   assetsDir: manifest とアイコンがある場所（public か dist）
 *   indexHtml: 検査する index.html
 * @returns {string[]} 問題の一覧（空なら合格）
 */
export function checkPwa({ assetsDir, indexHtml }) {
  const errors = [];
  const manifestPath = join(assetsDir, 'manifest.webmanifest');
  if (!existsSync(manifestPath)) return [`manifest がありません: ${manifestPath}`];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return [`manifest が JSON として読めません: ${e instanceof Error ? e.message : String(e)}`];
  }

  for (const key of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) {
    if (typeof manifest[key] !== 'string' || manifest[key] === '') errors.push(`manifest.${key} がありません`);
  }
  if (manifest.display !== 'standalone') errors.push('manifest.display は standalone にする');
  if (manifest.start_url !== '/') errors.push('manifest.start_url は / にする');

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const need = [
    { size: '192x192', purpose: 'any' },
    { size: '512x512', purpose: 'any' },
    { size: '512x512', purpose: 'maskable' },
  ];
  for (const n of need) {
    const hit = icons.some(
      (i) => i.sizes === n.size && String(i.purpose ?? 'any').split(/\s+/).includes(n.purpose),
    );
    if (!hit) errors.push(`manifest.icons に ${n.size} (${n.purpose}) がありません`);
  }
  for (const icon of icons) {
    const p = local(assetsDir, String(icon.src ?? ''));
    if (!existsSync(p)) {
      errors.push(`アイコンがありません: ${icon.src}`);
      continue;
    }
    const size = pngSize(readFileSync(p));
    if (!size) errors.push(`PNG ではありません: ${icon.src}`);
    else if (`${size.width}x${size.height}` !== icon.sizes) {
      errors.push(`寸法が manifest と違います: ${icon.src} は ${size.width}x${size.height}、manifest は ${icon.sizes}`);
    }
  }

  if (!existsSync(indexHtml)) return [...errors, `index.html がありません: ${indexHtml}`];
  const html = readFileSync(indexHtml, 'utf8');
  const hrefOf = (rel) => {
    const tag = html.match(new RegExp(`<link[^>]*rel=["']${rel}["'][^>]*>`, 'i'))?.[0];
    return tag?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
  };
  const manifestHref = hrefOf('manifest');
  if (!manifestHref) errors.push('index.html に <link rel="manifest"> がありません');
  else if (!existsSync(local(assetsDir, manifestHref))) errors.push(`index.html の manifest の参照先がありません: ${manifestHref}`);

  const appleHref = hrefOf('apple-touch-icon');
  if (!appleHref) errors.push('index.html に <link rel="apple-touch-icon"> がありません');
  else if (!existsSync(local(assetsDir, appleHref))) errors.push(`apple-touch-icon の参照先がありません: ${appleHref}`);
  else {
    const size = pngSize(readFileSync(local(assetsDir, appleHref)));
    if (!size || size.width !== 180 || size.height !== 180) errors.push('apple-touch-icon は 180x180 の PNG にする');
  }

  if (!/<meta[^>]*name=["']viewport["'][^>]*viewport-fit=cover/i.test(html)) {
    errors.push('viewport に viewport-fit=cover がありません');
  }
  return errors;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = process.argv[2];
  const opts = target
    ? { assetsDir: resolve(WEB_ROOT, target), indexHtml: resolve(WEB_ROOT, target, 'index.html') }
    : { assetsDir: join(WEB_ROOT, 'public'), indexHtml: join(WEB_ROOT, 'index.html') };
  const errors = checkPwa(opts);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`✗ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`PWA の資産 OK (${opts.assetsDir})\n`);
}
