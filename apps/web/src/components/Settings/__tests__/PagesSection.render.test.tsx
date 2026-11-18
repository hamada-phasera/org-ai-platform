// @vitest-environment jsdom
//
// 設定 > 業務ページ（docs/design/custom-pages.md §7.4・チャンク 6）。
// 公開・並び替え・削除（管理者）、トークンの発行と失効（オーナーのみ・生値は 1 回だけ）、利用状況、メンバーにはタブを出さない。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { calls, fail, install, ok, setRoutes, signIn, uninstall } from '../../pages/__tests__/harness';
import { PagesSection, type PagesAdminData, type PageTokenRow } from '../PagesSection';
import SettingsPage from '../../../pages/SettingsPage';

const RAW = `flowpg_${'A'.repeat(43)}`;

function adminData(over: Partial<PagesAdminData> = {}): PagesAdminData {
  return {
    pages: [
      { slug: 'inquiries', title: '問い合わせ', icon: 'inbox', status: 'PUBLISHED', minRole: 'MEMBER', sortOrder: 0, version: 3, source: 'N8N', updatedAt: '2026-11-17T00:00:00.000Z' },
      { slug: 'orders', title: '受注', icon: 'package', status: 'DRAFT', minRole: 'MEMBER', sortOrder: 0, version: 1, source: 'MANUAL', updatedAt: '2026-11-16T00:00:00.000Z' },
    ],
    pageCount: 2,
    plan: 'PRO',
    usage: { used: 120, limit: 3000, state: 'ok', blocked: false },
    orgId: 'org-1',
    connection: 'ok',
    ...over,
  };
}

const token = (over: Partial<PageTokenRow> = {}): PageTokenRow => ({
  id: 'tok-1',
  label: 'n8n 本番',
  prefix: 'flowpg_abc',
  lastUsedAt: null,
  revokedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PagesSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const patches = () => calls.filter((c) => c.key.startsWith('PATCH '));
const desktopRow = (slug: string) => screen.getByTestId(`page-row-${slug}`);

beforeEach(() => {
  install();
  setRoutes({
    'GET /pages/admin/list': ok(adminData()),
    'GET /pages/tokens': ok([token()]),
    'PATCH /pages/inquiries': ok({ changed: true }),
    'PATCH /pages/orders': ok({ changed: true }),
    'DELETE /pages/orders': ok({ deleted: true }),
  });
});

afterEach(() => {
  cleanup();
  uninstall();
});

describe('ページ一覧（管理者）', () => {
  beforeEach(() => signIn('ADMIN'));

  it('タイトル・状態・版・作成元が出る', async () => {
    renderSection();
    const row = await waitFor(() => desktopRow('inquiries'));
    expect(within(row).getByText('問い合わせ')).toBeTruthy();
    expect(within(row).getByText('公開')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(row).getByText('n8n')).toBeTruthy();
    expect(within(desktopRow('orders')).getByText('下書き')).toBeTruthy();
    expect(within(desktopRow('orders')).getByText('手動')).toBeTruthy();
  });

  it('公開・非公開を PATCH で切り替える（定義は送らない）', async () => {
    renderSection();
    fireEvent.click(within(await waitFor(() => desktopRow('orders'))).getByRole('button', { name: '公開' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ key: 'PATCH /pages/orders', body: { status: 'PUBLISHED' } });

    fireEvent.click(within(desktopRow('inquiries')).getByRole('button', { name: '非公開' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual({ key: 'PATCH /pages/inquiries', body: { status: 'DRAFT' } });
  });

  it('下へ: 並びを 0,1… に振り直し、ずれた行だけ送る', async () => {
    renderSection();
    const down = within(await waitFor(() => desktopRow('inquiries'))).getByRole('button', { name: '問い合わせ を下へ' });
    // 先頭の「上へ」と末尾の「下へ」は押せない
    expect(within(desktopRow('inquiries')).getByRole('button', { name: '問い合わせ を上へ' }).hasAttribute('disabled')).toBe(true);
    expect(within(desktopRow('orders')).getByRole('button', { name: '受注 を下へ' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(down);
    // orders(0)→0 は同じなので送らない、inquiries は 1 へ
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ key: 'PATCH /pages/inquiries', body: { sortOrder: 1 } });
  });

  it('削除は確認してから。やめれば送らない', async () => {
    renderSection();
    fireEvent.click(within(await waitFor(() => desktopRow('orders'))).getByRole('button', { name: '削除' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('「受注」を削除しますか')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.key.startsWith('DELETE '))).toBe(false);

    fireEvent.click(within(desktopRow('orders')).getByRole('button', { name: '削除' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '実行' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /pages/orders')).toBe(true));
  });

  it('失敗はサーバの文言を 1 行で出す', async () => {
    setRoutes({
      'GET /pages/admin/list': ok(adminData()),
      'PATCH /pages/orders': fail(403, 'FORBIDDEN', '自分より上の役割だけが見られるページにはできません'),
    });
    renderSection();
    fireEvent.click(within(await waitFor(() => desktopRow('orders'))).getByRole('button', { name: '公開' }));
    expect((await screen.findByRole('alert')).textContent).toContain('自分より上の役割');
  });

  it('0 件なら「まだありません」', async () => {
    setRoutes({ 'GET /pages/admin/list': ok(adminData({ pages: [], pageCount: 0 })) });
    renderSection();
    expect(await screen.findByText('まだありません')).toBeTruthy();
  });

  it('管理者にはトークンの節を出さず、トークン一覧も取りに行かない', async () => {
    renderSection();
    await waitFor(() => desktopRow('inquiries'));
    expect(screen.queryByText('トークン')).toBeNull();
    expect(calls.some((c) => c.key === 'GET /pages/tokens')).toBe(false);
  });
});

describe('利用状況・接続', () => {
  beforeEach(() => signIn('ADMIN'));

  it('ページ数と今月の実行数をプランの上限と並べる', async () => {
    renderSection();
    expect((await screen.findByTestId('pages-count')).textContent).toBe('2 / 5');
    expect(screen.getByTestId('pages-usage').textContent).toBe('120 / 3,000');
    expect(screen.queryByRole('link', { name: 'プラン' })).toBeNull();
  });

  it('ページが上限・実行が上限ならプランへの導線を出す', async () => {
    setRoutes({
      'GET /pages/admin/list': ok(
        adminData({ plan: 'STARTER', pageCount: 1, usage: { used: 300, limit: 300, state: 'over', blocked: true } }),
      ),
    });
    renderSection();
    expect((await screen.findByTestId('pages-count')).textContent).toBe('1 / 1');
    expect(screen.getByText(/送信は来月 1 日まで止まります/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'プラン' }).getAttribute('href')).toBe('/settings?tab=billing');
  });

  it('n8n が未設定なら「未接続」。組織 ID を出す', async () => {
    setRoutes({ 'GET /pages/admin/list': ok(adminData({ connection: 'not_configured' })) });
    renderSection();
    expect(await screen.findByText('未接続')).toBeTruthy();
    expect(screen.getByText('org-1')).toBeTruthy();
  });
});

describe('登録トークン（オーナー）', () => {
  beforeEach(() => signIn('OWNER'));

  const issuedRoute = ok({
    ...token({ id: 'tok-2', label: '予備', prefix: RAW.slice(0, 10) }),
    token: RAW,
    registerUrlBase: 'https://api.example.test/api/webhooks/n8n/pages',
  });

  it('一覧は名前・先頭 10 文字・状態だけ（ハッシュは扱わない）', async () => {
    renderSection();
    expect(await screen.findByText('n8n 本番')).toBeTruthy();
    expect(screen.getByText('flowpg_abc…')).toBeTruthy();
    expect(screen.getByText('有効')).toBeTruthy();
  });

  it('発行すると生値と登録先が 1 回だけ出て、閉じたら二度と出ない', async () => {
    setRoutes({
      'GET /pages/admin/list': ok(adminData()),
      'GET /pages/tokens': ok([token()]),
      'POST /pages/tokens': issuedRoute,
    });
    renderSection();
    const input = await screen.findByLabelText('名前');
    fireEvent.change(input, { target: { value: '予備' } });
    fireEvent.click(screen.getByRole('button', { name: '発行' }));

    expect((await screen.findByTestId('issued-token')).textContent).toBe(RAW);
    expect(screen.getByText('https://api.example.test/api/webhooks/n8n/pages/<slug>')).toBeTruthy();
    expect(calls.find((c) => c.key === 'POST /pages/tokens')?.body).toEqual({ label: '予備' });

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByTestId('issued-token')).toBeNull();
    expect(document.body.textContent).not.toContain(RAW);
  });

  it('有効なトークンが 2 本あれば発行できない', async () => {
    setRoutes({
      'GET /pages/admin/list': ok(adminData()),
      'GET /pages/tokens': ok([token(), token({ id: 'tok-2', label: '予備' })]),
    });
    renderSection();
    await screen.findByText('予備');
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '三本目' } });
    expect(screen.getByRole('button', { name: '発行' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('有効なトークンは 2 本までです')).toBeTruthy();
  });

  it('失効は確認してから DELETE', async () => {
    setRoutes({
      'GET /pages/admin/list': ok(adminData()),
      'GET /pages/tokens': ok([token()]),
      'DELETE /pages/tokens/tok-1': ok({ revoked: true }),
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '失効' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '実行' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /pages/tokens/tok-1')).toBe(true));
  });

  it('発行と一覧はパソコンだけ（スマホは 1 行の案内）', async () => {
    renderSection();
    await screen.findByText('n8n 本番');
    expect(screen.getByTestId('token-desktop').className).toMatch(/\bhidden\b.*\blg:block\b/);
    expect(screen.getByText('パソコンで開いてください').className).toContain('lg:hidden');
  });
});

describe('設定のタブ', () => {
  function renderSettings(path = '/settings') {
    window.history.replaceState(null, '', path);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <SettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    setRoutes({
      'GET /auth/me': fail(500, 'X'),
      'GET /organizations/me': fail(500, 'X'),
      'GET /organizations/me/setup': ok([]),
      'GET /files': ok([]),
      'GET /pages/admin/list': ok(adminData()),
      'GET /pages/tokens': ok([]),
    });
  });

  afterEach(() => window.history.replaceState(null, '', '/'));

  it('メンバーにはタブを出さず、?tab=pages でも開かない（一覧も取りに行かない）', async () => {
    signIn('MEMBER');
    renderSettings('/settings?tab=pages');
    expect(await screen.findByRole('tab', { name: '基本' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '業務' })).toBeNull();
    expect(calls.some((c) => c.key === 'GET /pages/admin/list')).toBe(false);
  });

  it('管理者には「業務」タブがあり、?tab=pages で開く', async () => {
    signIn('ADMIN');
    renderSettings('/settings?tab=pages');
    expect(await screen.findByRole('tab', { name: '業務' })).toBeTruthy();
    expect(await screen.findByTestId('page-row-inquiries')).toBeTruthy();
  });
});
