import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// スマホの画面の高さ・セーフエリア・入力欄の文字サイズ（docs/plan/saas-readiness-plan.md チャンク 6）。

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css)$/.test(name)) yield p;
  }
}

describe('100dvh', () => {
  it('web のソースに h-screen（100vh）が残らない', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes('__tests__')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bh-screen\b/.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('dvh を知らないブラウザには 100vh の代替がある', () => {
    expect(read('index.css')).toMatch(/@supports not \(height: 100dvh\)[\s\S]*\.h-dvh[\s\S]*\.min-h-dvh/);
  });

  it('AppShell は h-dvh で、本文の下余白と下部ナビにホームバーの分を足す', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(shell).toMatch(/\bh-dvh\b/);
    expect(shell).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(read('components/shell/MobileNav.tsx')).toContain('pb-[env(safe-area-inset-bottom)]');
  });
});

describe('認証の 4 画面', () => {
  const pages = ['Register', 'Login', 'NoOrg', 'Invite'].map((n) => [n, read(`pages/${n}Page.tsx`)] as const);

  it.each(pages)('%sPage は動的ビューポートの高さで 1 列', (_n, src) => {
    expect(src).toMatch(/\bmin-h-dvh\b/);
    expect(src).not.toMatch(/\b(?:sm|md):grid-cols-|\bgrid-cols-[2-9]/);
  });

  it('入力欄はスマホで 16px（iOS の自動拡大を避ける）', () => {
    const input = read('components/ui/Input.tsx');
    for (const size of ['sm', 'md']) {
      expect(input).toMatch(new RegExp(`${size}: '[^']*max-lg:text-base`));
    }
  });

  it('メール欄は email キーボード・自動入力・自動大文字なし', () => {
    for (const name of ['Login', 'Register']) {
      const src = read(`pages/${name}Page.tsx`);
      expect(src).toMatch(/inputMode(=|: )["']email["']/);
      expect(src).toMatch(/autoComplete(=|: )["']email["']/);
      expect(src).toMatch(/autoCapitalize/);
    }
    expect(read('pages/RegisterPage.tsx')).toMatch(/autoComplete: 'new-password'/);
    expect(read('pages/LoginPage.tsx')).toMatch(/autoComplete="current-password"/);
    expect(read('pages/InvitePage.tsx')).toMatch(/autoComplete="name"/);
    expect(read('pages/InvitePage.tsx')).toMatch(/autoComplete="new-password"/);
  });
});
