// PWA の資産の検査（node --test。計画書チャンク 6 受け入れ条件 1・2）。
// 実体は apps/web/scripts/check-pwa.mjs。web の build の後にも dist に対して同じ検査が回る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEB_ROOT, checkPwa, pngSize } from '../../apps/web/scripts/check-pwa.mjs';

const SOURCE = { assetsDir: join(WEB_ROOT, 'public'), indexHtml: join(WEB_ROOT, 'index.html') };

test('ソース（public/ と index.html）の manifest とアイコン 4 点が揃っている', () => {
  assert.deepEqual(checkPwa(SOURCE), []);
  for (const [name, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ]) {
    const dim = pngSize(readFileSync(join(WEB_ROOT, 'public', 'icons', name)));
    assert.deepEqual(dim, { width: size, height: size }, name);
  }
});

test('manifest は FLOW・standalone・start_url=/・theme_color は index.html と同じ値', () => {
  const m = JSON.parse(readFileSync(join(WEB_ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.short_name, 'FLOW');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  const html = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8');
  const theme = html.match(/name="theme-color" content="([^"]+)"/)?.[1];
  assert.equal(m.theme_color, theme);
});

test('ビルド成果物があればそれも検査する（無ければ build 時の検査に任せる）', (t) => {
  const dist = join(WEB_ROOT, 'dist');
  const built = join(dist, 'index.html');
  // manifest を足す前の古い dist は対象外（build の最後に check-pwa.mjs dist が必ず回る）
  if (!existsSync(built) || statSync(built).mtimeMs < statSync(join(WEB_ROOT, 'index.html')).mtimeMs) {
    t.skip('dist が無いか古い（npm run build の中で check-pwa.mjs dist が回る）');
    return;
  }
  assert.deepEqual(checkPwa({ assetsDir: dist, indexHtml: join(dist, 'index.html') }), []);
});

test('壊れた manifest・欠けたアイコン・寸法違い・リンク漏れを検出する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-pwa-'));
  try {
    cpSync(join(WEB_ROOT, 'public'), dir, { recursive: true });
    const html = join(dir, 'index.html');
    writeFileSync(html, readFileSync(SOURCE.indexHtml, 'utf8'));
    const assets = { assetsDir: dir, indexHtml: html };
    assert.deepEqual(checkPwa(assets), []);

    // JSON として読めない
    const mPath = join(dir, 'manifest.webmanifest');
    const original = readFileSync(mPath, 'utf8');
    writeFileSync(mPath, '{ not json');
    assert.match(checkPwa(assets).join('\n'), /JSON として読めません/);
    writeFileSync(mPath, original);

    // 参照先のアイコンが無い
    rmSync(join(dir, 'icons', 'icon-maskable-512.png'));
    assert.match(checkPwa(assets).join('\n'), /アイコンがありません: \/icons\/icon-maskable-512\.png/);

    // 寸法違い（192 の場所に 512 を置く）
    mkdirSync(join(dir, 'icons'), { recursive: true });
    cpSync(join(WEB_ROOT, 'public', 'icons', 'icon-512.png'), join(dir, 'icons', 'icon-maskable-512.png'));
    cpSync(join(WEB_ROOT, 'public', 'icons', 'icon-512.png'), join(dir, 'icons', 'icon-192.png'));
    assert.match(checkPwa(assets).join('\n'), /寸法が manifest と違います: \/icons\/icon-192\.png/);
    cpSync(join(WEB_ROOT, 'public', 'icons', 'icon-192.png'), join(dir, 'icons', 'icon-192.png'));

    // index.html のリンク漏れ
    writeFileSync(html, '<html><head><meta name="viewport" content="width=device-width"></head></html>');
    const errs = checkPwa(assets).join('\n');
    assert.match(errs, /rel="manifest"/);
    assert.match(errs, /rel="apple-touch-icon"/);
    assert.match(errs, /viewport-fit=cover/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
