// フロー画面（docs/design/canvas-home.md §3.4・§3.6・§10 T13・K20）の決まりをソースで固定する。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const flowDir = join(here, '..');
const srcDir = join(here, '..', '..', '..');
const read = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FLOW_FILES = readdirSync(flowDir)
  .filter((n) => /\.tsx?$/.test(n) && statSync(join(flowDir, n)).isFile())
  .map((n) => join(flowDir, n));
const FLOW_PAGE = join(srcDir, 'pages', 'FlowPage.tsx');
const ALL = [...FLOW_FILES, FLOW_PAGE];

/** PC の編集画面だけが @xyflow/react と zod のスキーマを読む（FlowPage から lazy） */
const DESKTOP_ONLY = ['FlowEditor.tsx', 'FlowCanvasNode.tsx', 'NodePanel.tsx', 'TemplateField.tsx', 'NodeTypeMenu.tsx'];
const MOBILE_PATH = ALL.filter((f) => !DESKTOP_ONLY.some((n) => f.endsWith(`/flow/${n}`)));

describe('フロー画面のソース', () => {
  it('対象のファイルがある', () => {
    expect(FLOW_FILES.length).toBeGreaterThanOrEqual(12);
    expect(MOBILE_PATH.length).toBeGreaterThanOrEqual(8);
  });

  it.each(ALL.map((f) => [f.slice(srcDir.length + 1), f]))('%s: HTML を差し込まない・式を評価しない（T2・T13）', (_n, file) => {
    const src = read(file);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\beval\(|new Function\(/);
  });

  it.each(ALL.map((f) => [f.slice(srcDir.length + 1), f]))('%s: カードで包まない・左アクセントバー・グラデを付けない', (_n, file) => {
    const src = read(file);
    expect(src).not.toMatch(/\bCard\b/);
    expect(src).not.toMatch(/border-l-\d|border-l\b(?!\s*border-border)/);
    expect(src).not.toMatch(/bg-gradient|from-\w+-\d/);
  });

  it.each(MOBILE_PATH.map((f) => [f.slice(srcDir.length + 1), f]))('%s: @xyflow/react を import しない（スマホで読まない）', (_n, file) => {
    expect(code(file)).not.toMatch(/@xyflow\/react/);
  });

  it.each(MOBILE_PATH.map((f) => [f.slice(srcDir.length + 1), f]))('%s: zod の値を import しない（K29）', (_n, file) => {
    const src = code(file);
    expect(src).not.toMatch(/from 'zod'/);
    expect(src).not.toMatch(/flowDefinitionSchema|buildFlowDefinitionSchema|buildFlowRunInputSchema|buildPartInputSchema|pageDefinitionSchema/);
  });

  it('FlowPage は編集画面を lazy で読み、静的には import しない', () => {
    const src = code(FLOW_PAGE);
    expect(src).toMatch(/lazy\(\(\) => import\('\.\.\/components\/flow\/FlowEditor'\)\)/);
    for (const f of ALL.filter((x) => !x.endsWith('FlowEditor.tsx'))) {
      expect(code(f), f).not.toMatch(/from '\.\/FlowEditor'|from '\.\.\/components\/flow\/FlowEditor'/);
    }
  });

  it('キャンバス上のノードは影なし（浮くのは追加メニュー・差し込みメニュー・モーダルだけ）', () => {
    expect(read(join(flowDir, 'FlowCanvasNode.tsx'))).not.toMatch(/shadow-/);
    expect(read(join(flowDir, 'StepList.tsx'))).not.toMatch(/shadow-/);
  });

  it('外への URL は運営向けの editorUrl だけ（noopener）。window.open・location を使わない', () => {
    for (const f of ALL) {
      const src = code(f);
      expect(src, f).not.toMatch(/window\.open|window\.location/);
      const hrefs = src.match(/href=\{[^}]+\}/g) ?? [];
      for (const h of hrefs) expect(h, f).toBe('href={part.editorUrl}');
    }
    expect(read(join(flowDir, 'NodePanel.tsx'))).toMatch(/rel="noopener noreferrer"/);
  });

  it('お客さんの画面から n8n の public API を叩かない（D9）', () => {
    for (const f of ALL) expect(code(f), f).not.toMatch(/\/api\/v1\/|n8n-workflow-builder/);
  });
});
