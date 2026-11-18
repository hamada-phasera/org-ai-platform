// @vitest-environment jsdom
//
// 業務ページの描画（docs/design/custom-pages.md §7・§11 web）。API は本物の axios インスタンスで、通信だけ adapter で差し替える。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fail, install, ok, renderPage, setRoutes, signIn, uninstall } from './harness';
import { defaultRows, sampleData, sampleDetail } from './fixtures';

beforeEach(() => {
  install();
  signIn('MEMBER');
  setRoutes({
    'GET /pages/inquiries': ok(sampleDetail()),
    'GET /pages/inquiries/data/list': ok(sampleData()),
  });
});

afterEach(() => {
  cleanup();
  uninstall();
});

describe('業務ページ（描画）', () => {
  it('サンプルの問い合わせが KPI・表・フォーム・ボタンまで出る（D1）', async () => {
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { name: '問い合わせ', level: 1 })).toBeTruthy();
    expect(screen.getByText('サンプル')).toBeTruthy();

    // KPI
    await waitFor(() => expect(screen.getByText('未対応', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3'));
    expect(screen.getByText('今月', { selector: 'dt' }).nextElementSibling?.textContent).toBe('12');

    // 表（PC の表とスマホの行の両方が DOM にある）
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    expect(within(table as HTMLElement).getByText('見積の依頼')).toBeTruthy();
    expect(within(table as HTMLElement).getByText('2026/11/17')).toBeTruthy();
    expect(within(table as HTMLElement).getAllByRole('button', { name: '完了' })).toHaveLength(2);

    // フォーム（ラベルが htmlFor で紐づく）
    expect(screen.getByLabelText('電話')).toBeTruthy();
    expect(screen.getByLabelText('内容').tagName).toBe('TEXTAREA');
    expect(screen.getByRole('button', { name: '登録' })).toBeTruthy();

    // ボタン
    expect(screen.getByRole('button', { name: '通知' })).toBeTruthy();
  });

  it('<script> 入りの文字列は文字のまま出て、script 要素は作られない（T4）', async () => {
    const { container } = renderPage();
    await screen.findAllByText('<script>alert("x")</script>');
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });

  it('知らない type のブロックは何も描かない（区切りも出さない）', async () => {
    const { container } = renderPage();
    await screen.findByRole('button', { name: '登録' });
    // 既知の 6 ブロック（kpi・table・form・buttons・text・list）だけ。chart は section ごと出さない
    expect(container.querySelectorAll('section')).toHaveLength(6);
    expect(container.textContent).not.toContain('chart');
  });

  it('同じ action を参照するブロックは 1 回の取得を共有する', async () => {
    const { calls } = await import('./harness');
    renderPage();
    await screen.findByText('見積の依頼', { selector: 'td' });
    expect(calls.filter((c) => c.key === 'GET /pages/inquiries/data/list')).toHaveLength(1);
  });

  it('空の表は定義の empty か「まだありません」', async () => {
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok(sampleData([])),
    });
    renderPage();
    expect(await screen.findByText('まだありません')).toBeTruthy();
    expect(screen.getByText('空です')).toBeTruthy();
  });

  it('未接続（not_configured）: 見出しとフォームは出し、データ部だけ「未接続」。取得しに行かない', async () => {
    const { calls } = await import('./harness');
    setRoutes({ 'GET /pages/inquiries': ok(sampleDetail({ connection: 'not_configured' })) });
    renderPage();
    expect(await screen.findByRole('heading', { name: '問い合わせ', level: 1 })).toBeTruthy();
    expect(screen.getAllByText('未接続').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('button', { name: '登録' })).toBeTruthy();
    expect(calls.some((c) => c.key.includes('/data/'))).toBe(false);
    // メンバーには設定への導線を出さない
    expect(screen.queryByRole('link', { name: '設定' })).toBeNull();
  });

  it('503 PAGE_NOT_CONNECTED は「未接続」、管理者には設定への導線', async () => {
    signIn('ADMIN');
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail({ connection: 'ok' })),
      'GET /pages/inquiries/data/list': fail(503, 'PAGE_NOT_CONNECTED'),
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/未接続/).length).toBeGreaterThan(0));
    const links = screen.getAllByRole('link', { name: '設定' });
    expect(links[0].getAttribute('href')).toBe('/settings?tab=pages');
  });

  it('502 は「取得できませんでした」と「再試行」。再試行で取り直す', async () => {
    let n = 0;
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail({ connection: 'ok' })),
      'GET /pages/inquiries/data/list': () => {
        n += 1;
        return n === 1
          ? { status: 502, data: { success: false, error: { code: 'PAGE_UPSTREAM_FAILED', message: 'x' } } }
          : { status: 200, data: { success: true, data: sampleData() } };
      },
    });
    renderPage();
    const retry = await screen.findAllByRole('button', { name: '再試行' });
    expect(screen.getAllByText(/取得できませんでした/).length).toBeGreaterThan(0);
    retry[0].click();
    expect(await screen.findByText('見積の依頼', { selector: 'td' })).toBeTruthy();
  });

  it('ブロック単位の INVALID_RESPONSE はそのブロックだけ。メンバーには「表示できません」', async () => {
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok({
        action: 'list',
        sample: false,
        blocks: [
          { index: 0, type: 'kpi', values: { 0: 3, 1: 12 } },
          { index: 1, type: 'table', error: 'INVALID_RESPONSE' },
          { index: 5, type: 'list', rows: defaultRows(), truncated: true },
        ],
      }),
    });
    const { container } = renderPage();
    expect(await screen.findByText('表示できません')).toBeTruthy();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText('佐藤')).toBeTruthy();
    expect(screen.getByText('先頭 2 件を表示')).toBeTruthy();
  });

  it('管理者には形違いの理由を出す', async () => {
    signIn('OWNER');
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok({ action: 'list', sample: false, blocks: [{ index: 0, type: 'kpi', error: 'INVALID_RESPONSE' }] }),
    });
    renderPage();
    expect((await screen.findAllByText('ワークフローの応答が定義と合いません')).length).toBeGreaterThan(0);
  });

  it('見えないページ（404）は「見つかりません」', async () => {
    setRoutes({ 'GET /pages/secret': fail(404, 'NOT_FOUND') });
    renderPage('/p/secret');
    expect(await screen.findByText('ページが見つかりません')).toBeTruthy();
  });

  it('実行数 8 割: 管理者にだけ 1 行（プランへの導線）', async () => {
    const usage = { used: 250, limit: 300, state: 'warn' as const, blocked: false };
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail({ usage })),
      'GET /pages/inquiries/data/list': ok(sampleData()),
    });
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    expect(screen.queryByText(/今月の実行/)).toBeNull();
    cleanup();

    signIn('ADMIN');
    renderPage();
    expect(await screen.findByText(/今月の実行/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'プラン' }).getAttribute('href')).toBe('/settings?tab=billing');
  });
});
