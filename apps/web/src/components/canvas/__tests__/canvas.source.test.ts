// ホームキャンバス（docs/design/canvas-home.md §3.6・§10 T13・K20）の決まりをソースで固定する。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const canvasDir = join(here, '..');
const srcDir = join(here, '..', '..', '..');
const read = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CANVAS_FILES = readdirSync(canvasDir)
  .filter((n) => /\.tsx?$/.test(n) && statSync(join(canvasDir, n)).isFile())
  .map((n) => join(canvasDir, n));
const HOME = join(srcDir, 'pages', 'CanvasHomePage.tsx');
const FLOW_PAGE = join(srcDir, 'pages', 'FlowPage.tsx');
const ALL = [...CANVAS_FILES, HOME, FLOW_PAGE];

/** スマホの経路（ホームの縦リスト・フロー画面）。ここから @xyflow/react を読まない */
const MOBILE_PATH = [
  HOME,
  FLOW_PAGE,
  ...['BusinessList.tsx', 'canvasToList.ts', 'canvasApi.ts', 'canvasEdit.ts', 'PageIconGlyph.tsx'].map((n) => join(canvasDir, n)),
];

describe('ホームキャンバスのソース', () => {
  it('対象のファイルがある', () => {
    expect(CANVAS_FILES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(ALL.map((f) => [f.slice(srcDir.length + 1), f]))('%s: HTML を差し込まない（T13）', (_n, file) => {
    const src = read(file);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\beval\(|new Function\(/);
  });

  it.each(ALL.map((f) => [f.slice(srcDir.length + 1), f]))('%s: カードで包まない・左アクセントバーを付けない', (_n, file) => {
    const src = read(file);
    expect(src).not.toMatch(/\bCard\b/);
    expect(src).not.toMatch(/border-l-\d|border-l\b/);
    expect(src).not.toMatch(/bg-gradient|from-\w+-\d/);
  });

  it.each(MOBILE_PATH.map((f) => [f.slice(srcDir.length + 1), f]))('%s: @xyflow/react を import しない（スマホで読まない）', (_n, file) => {
    expect(code(file)).not.toMatch(/@xyflow\/react/);
  });

  it.each(MOBILE_PATH.map((f) => [f.slice(srcDir.length + 1), f]))('%s: zod の値を import しない（初回ロード・K29）', (_n, file) => {
    const src = code(file);
    expect(src).not.toMatch(/from 'zod'/);
    expect(src).not.toMatch(/canvasLayoutSchema|flowDefinitionSchema|buildFlowDefinitionSchema|pageDefinitionSchema/);
  });

  it('ホームはキャンバスを lazy で読み、静的には import しない', () => {
    const src = code(HOME);
    expect(src).toMatch(/lazy\(\(\) => import\('\.\.\/components\/canvas\/CanvasBoard'\)\)/);
    expect(src).not.toMatch(/^import .*CanvasBoard/m);
    // CanvasBoard を静的に読むファイルが他に無い
    for (const f of ALL.filter((x) => !x.endsWith('CanvasBoard.tsx'))) {
      expect(code(f), f).not.toMatch(/from '\.\/CanvasBoard'|from '\.\.\/components\/canvas\/CanvasBoard'/);
    }
  });

  it('キャンバス上のノードは影なし（浮くのは追加メニューだけ）', () => {
    expect(read(join(canvasDir, 'HomeNode.tsx'))).not.toMatch(/shadow-/);
    expect(read(join(canvasDir, 'BusinessList.tsx'))).not.toMatch(/shadow-/);
  });

  it('リンク先はノードの行き先（gateway の許可リストを通った値）か固定の文字列だけ', () => {
    const api = code(join(canvasDir, 'canvasApi.ts'));
    expect(api).toContain('navigate(`/flows/${encodeURIComponent(');
    expect(api).toContain('navigate(t.to)');
    expect(api).not.toMatch(/window\.location|window\.open/);
  });

  it('App.tsx はホームをキャンバスに差し替え、フロー画面を lazy で読む', () => {
    const app = read(join(srcDir, 'App.tsx'));
    expect(app).toMatch(/<Route index element=\{<CanvasHomePage \/>\} \/>/);
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/FlowPage'\)\)/);
    expect(app).not.toMatch(/TopPage/);
  });
});
