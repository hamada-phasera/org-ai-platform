// 業務ページの描画の決まり（設計書 §7.2・T4）をソースで固定する。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pagesDir = join(here, '..');
const srcDir = join(here, '..', '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : walk(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

const FILES = [
  ...walk(pagesDir),
  join(srcDir, 'pages', 'CustomPage.tsx'),
  join(srcDir, 'pages', 'CustomPagesIndex.tsx'),
  // 設定 > 業務ページ（チャンク 6）も同じ決まり（区切り線と表だけ・カードで包まない）
  join(srcDir, 'components', 'Settings', 'PagesSection.tsx'),
];
const read = (p: string) => readFileSync(p, 'utf8');

describe('業務ページのソース', () => {
  it('対象のファイルがある', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FILES.map((f) => [f.slice(srcDir.length + 1), f]))('%s: HTML を差し込まない・任意のスクリプトを動かさない', (_name, file) => {
    const src = read(file);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\beval\(|new Function\(/);
    expect(src).not.toMatch(/<iframe|<img|<a\s/);
  });

  it.each(FILES.map((f) => [f.slice(srcDir.length + 1), f]))('%s: Card で包まない（カードの入れ子・影の面を作らない）', (_name, file) => {
    const src = read(file);
    expect(src).not.toMatch(/\bCard\b/);
    expect(src).not.toMatch(/border-l-\d|border-l\b/);
  });

  it('定義からスタイル・URL を受け取らない（style= は書かない。リンク先は固定の文字列だけ）', () => {
    for (const file of FILES) {
      const src = read(file);
      expect(src, file).not.toMatch(/\bstyle=\{/);
      for (const m of src.matchAll(/\bto=\{(`[^`]*`|[^`}]*)\}/g)) {
        // 行き先は自前の /p/<slug> だけ（slug は gateway の正規表現を通った値）
        expect(m[1], file).toMatch(/^`\/p\/\$\{encodeURIComponent\(p\.slug\)\}`$/);
      }
    }
  });

  it('初回ロードに載るファイル（ナビ・API・アイコン）は zod の値を import しない（K20）', () => {
    for (const name of ['pagesApi.ts', 'icons.ts', 'CustomPagesNav.tsx']) {
      const src = read(join(pagesDir, name));
      // コメントでの言及は数えない
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/from 'zod'/);
      expect(code).not.toMatch(/buildInputSchema|pageDefinitionSchema|projectQueryResult|pageUpsertSchema|pageSubmitResponseSchema/);
    }
  });

  it('App.tsx は業務ページを lazy で読む', () => {
    const app = read(join(srcDir, 'App.tsx'));
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/CustomPage'\)\)/);
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/CustomPagesIndex'\)\)/);
    expect(app).not.toMatch(/^import CustomPage/m);
  });
});
