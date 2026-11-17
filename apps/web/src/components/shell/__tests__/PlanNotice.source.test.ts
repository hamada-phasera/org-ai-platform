import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 帯の見た目の決まり（DESIGN.md: 色付きの左アクセントバー禁止・カードの入れ子禁止）と、
// PC とスマホの両方に出ること（AppShell でブレークポイントの分岐の外に置く）を、ソースで固定する。

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

describe('PlanNotice', () => {
  const src = read('PlanNotice.tsx');

  it('左アクセントバーを使わない', () => {
    expect(src).not.toMatch(/\bborder-l(-\w+)?\b/);
    expect(src).not.toMatch(/\bborder-s(-\w+)?\b/);
  });

  it('カードを使わない（入れ子にしない）', () => {
    expect(src).not.toMatch(/\bCard\b/);
    expect(src).not.toMatch(/\brounded-/);
    expect(src).not.toMatch(/\bshadow-/);
  });

  it('リンクは 1 つ（契約画面）', () => {
    expect(src.match(/<Link\b/g)?.length).toBe(1);
    expect(src).toContain('BILLING_PATH');
  });

  it('PC だけ・スマホだけの出し分けをしない', () => {
    expect(src).not.toMatch(/(?:^|[\s"'`])(?:hidden|lg:hidden|lg:flex|lg:block)(?=[\s"'`])/);
  });
});

describe('AppShell', () => {
  const src = read('AppShell.tsx');

  it('帯は main の外・ブレークポイントの分岐の外にある', () => {
    const notice = src.indexOf('<PlanNotice />');
    const main = src.indexOf('<main');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(main);
    // 直前の閉じタグはヘッダー（lg:flex で PC だけのもの）で、帯はその中に入っていない
    expect(src.lastIndexOf('</header>', notice)).toBeGreaterThan(src.lastIndexOf('<header', notice));
  });
});
