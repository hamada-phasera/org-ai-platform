import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_MENU,
  MOBILE_MENU,
  MOBILE_TABS,
  NAV_ROUTES,
  CUSTOM_PAGES_ENTRY,
  isMobileRoute,
  showInMobileMenu,
} from '../navConfig';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** App.tsx のシェル配下の全ルートと、スマホで開けるか（D6）。ルートを足したらここにも足す */
const EXPECTED: Record<string, boolean> = {
  '/': true,
  '/dashboard': false,
  '/chat': true,
  '/chat/:id': true,
  '/inbox': true,
  '/agents': true,
  '/agents/:id': false,
  '/governance': false,
  '/tasks': false,
  '/deliverables': true,
  '/sales': false,
  '/analytics': false,
  '/sns': false,
  '/accounting': true,
  '/p': true,
  '/p/:slug': true,
  '/settings': true,
};

/** シェルの外（ログイン前の画面と catch-all） */
const LEGAL_ROUTES = ['/legal/terms', '/legal/privacy', '/legal/tokushoho'];
const OUTSIDE_SHELL = new Set(['/login', '/register', '/invite/:token', '/no-org', ...LEGAL_ROUTES, '*']);

function shellRoutes(): string[] {
  const src = read('../../../App.tsx');
  const paths = [...src.matchAll(/\bpath="([^"]+)"/g)].map((m) => m[1]);
  const routes = paths
    .filter((p) => !OUTSIDE_SHELL.has(p))
    .map((p) => (p.startsWith('/') ? p : `/${p}`));
  if (/<Route\s+index\b/.test(src)) routes.unshift('/');
  return routes;
}

const sample = (pattern: string) => pattern.replace(/:[^/]+/g, 'abc');

describe('isMobileRoute', () => {
  it('App.tsx のルートがすべて表にある（漏れも余りも無い）', () => {
    expect(shellRoutes().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s → %s', (pattern, mobile) => {
    expect(isMobileRoute(sample(pattern))).toBe(mobile);
  });

  it('受け入れ条件の個別の値', () => {
    for (const p of ['/settings', '/accounting', '/agents']) expect(isMobileRoute(p)).toBe(true);
    for (const p of ['/agents/abc', '/governance', '/tasks', '/sales', '/analytics', '/sns']) {
      expect(isMobileRoute(p)).toBe(false);
    }
  });

  it('前方一致は区切り単位（/chatroom は /chat 扱いにしない）', () => {
    expect(isMobileRoute('/chatroom')).toBe(false);
    expect(isMobileRoute('/settingsx')).toBe(false);
  });

  it('末尾のスラッシュとクエリは無視する', () => {
    expect(isMobileRoute('/settings/')).toBe(true);
    expect(isMobileRoute('/settings?tab=billing')).toBe(true);
    expect(isMobileRoute('/agents/')).toBe(true);
  });

  it('知らないパスはパソコン向け', () => {
    expect(isMobileRoute('/unknown')).toBe(false);
  });
});

describe('法務の頁（チャンク 12）', () => {
  const src = read('../../../App.tsx');

  it.each(LEGAL_ROUTES)('%s が App.tsx にある', (path) => {
    expect(src).toContain(`path="${path}"`);
  });

  it('認証の外（RequireAuth / RequireToken より前の、要素を包まない Route）にある', () => {
    for (const path of LEGAL_ROUTES) {
      const line = src.split('\n').find((l) => l.includes(`path="${path}"`)) ?? '';
      expect(line).toMatch(/element=\{<\w+Page \/>\}/);
      expect(src.indexOf(`path="${path}"`)).toBeLessThan(src.indexOf('<RequireToken>'));
    }
  });

  it('シェルの外なのでナビの表には載せない（スマホでも DesktopOnly にならない）', () => {
    for (const path of LEGAL_ROUTES) expect(NAV_ROUTES.some((e) => e.to === path)).toBe(false);
  });
});

describe('ナビの表', () => {
  it('ナビの行き先はすべて App.tsx のルート', () => {
    const routes = new Set(shellRoutes());
    for (const e of NAV_ROUTES) expect(routes.has(e.to)).toBe(true);
  });

  it('下部タブは 4 つで、すべてスマホで開ける', () => {
    expect(MOBILE_TABS.map((t) => t.to)).toEqual(['/', '/chat', '/inbox', '/deliverables']);
    for (const t of MOBILE_TABS) expect(isMobileRoute(t.to)).toBe(true);
  });

  it('メニューの「スマホで使える」「パソコン向け」は同じ表を二分したもの', () => {
    const all = NAV_ROUTES.map((e) => e.to).sort();
    expect([...MOBILE_MENU, ...DESKTOP_MENU].map((e) => e.to).sort()).toEqual(all);
    for (const e of MOBILE_MENU) expect(isMobileRoute(e.to)).toBe(true);
    for (const e of DESKTOP_MENU) expect(isMobileRoute(e.to)).toBe(false);
  });
});

describe('業務ページ（/p）', () => {
  it('スマホで開ける（一覧と各ページ）', () => {
    expect(isMobileRoute('/p')).toBe(true);
    expect(isMobileRoute('/p/inquiries')).toBe(true);
    expect(isMobileRoute('/pages')).toBe(false);
  });

  it('下部タブは増やさない（K14）。メニューの「スマホで使える」に「業務」1 行', () => {
    expect(MOBILE_TABS).toHaveLength(4);
    expect(MOBILE_MENU.filter((e) => e.to === '/p')).toEqual([CUSTOM_PAGES_ENTRY]);
    expect(CUSTOM_PAGES_ENTRY.label).toBe('業務');
  });

  it('ページが 0 件の組織にはメニューの「業務」を出さない', () => {
    expect(showInMobileMenu(CUSTOM_PAGES_ENTRY, false)).toBe(false);
    expect(showInMobileMenu(CUSTOM_PAGES_ENTRY, true)).toBe(true);
    for (const e of MOBILE_MENU.filter((x) => x !== CUSTOM_PAGES_ENTRY)) expect(showInMobileMenu(e, false)).toBe(true);
  });

  it('MobileNav はメニューを showInMobileMenu で絞る', () => {
    expect(read('../MobileNav.tsx')).toContain('showInMobileMenu(item, hasCustomPages)');
  });
});

describe('MobileNav のソース', () => {
  const src = read('../MobileNav.tsx');

  it('ルートの配列定義を持たない（navConfig の表だけを使う）', () => {
    expect(src).not.toMatch(/\bTABS\s*[:=]/);
    expect(src).not.toMatch(/MOBILE_OK/);
    expect(src).not.toMatch(/to:\s*'\//);
    expect(src).not.toMatch(/new Set<string>\(\[/);
  });

  it('メニューは MOBILE_MENU / DESKTOP_MENU から出す', () => {
    expect(src).toContain('MOBILE_MENU.map');
    expect(src).toContain('DESKTOP_MENU.map');
    expect(src).toContain('MOBILE_TABS.map');
  });
});

describe('BillingSection のソース', () => {
  it('押せる要素に 28px（h-7 / w-7）が残らない', () => {
    const src = read('../../Settings/BillingSection.tsx');
    expect(src).not.toMatch(/\bh-7\b/);
    expect(src).not.toMatch(/\bw-7\b/);
  });
});
