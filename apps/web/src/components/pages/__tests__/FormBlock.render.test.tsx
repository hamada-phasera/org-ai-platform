// @vitest-environment jsdom
//
// フォーム・ボタン・行の操作の送信（必須・送信中・requestId・confirm・上限）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { calls, fail, install, ok, renderPage, setRoutes, signIn, uninstall } from './harness';
import { sampleData, sampleDetail } from './fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  install();
  signIn('MEMBER');
  setRoutes({
    'GET /pages/inquiries': ok(sampleDetail()),
    'GET /pages/inquiries/data/list': ok(sampleData()),
    'POST /pages/inquiries/actions/create': ok({ ok: true, message: '登録しました', sample: false }),
    'POST /pages/inquiries/actions/remind': ok({ ok: true, message: '通知しました', sample: false }),
    'POST /pages/inquiries/actions/done': ok({ ok: true, sample: false }),
  });
});

afterEach(() => {
  cleanup();
  uninstall();
});

const posts = () => calls.filter((c) => c.key.startsWith('POST '));

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('フォーム', () => {
  it('必須が空なら送らずに「必須です」を項目の下に出す', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '登録' }));
    expect(await screen.findAllByText('必須です')).toHaveLength(2);
    expect(screen.getByLabelText('名前').getAttribute('aria-invalid')).toBe('true');
    expect(posts()).toHaveLength(0);
  });

  it('型違い（電話）も送る前に止める', async () => {
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    fill('名前', '田中');
    fill('件名', '見積');
    fill('電話', 'abc');
    fireEvent.click(screen.getByRole('button', { name: '登録' }));
    expect(await screen.findByText('電話番号の形ではありません')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('送信: 定義の項目だけ・origin 付き・requestId は毎回新しい。成功で 1 行と取り直し', async () => {
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    const before = calls.filter((c) => c.key.endsWith('/data/list')).length;

    for (const name of ['田中', '鈴木']) {
      fill('名前', name);
      fill('件名', '見積');
      fireEvent.click(screen.getByRole('button', { name: '登録' }));
      expect(await screen.findByText('登録しました')).toBeTruthy();
      // 成功したら空に戻る
      await waitFor(() => expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe(''));
    }

    const sent = posts().map((c) => c.body as { input: Record<string, unknown>; requestId: string; origin: unknown });
    expect(sent).toHaveLength(2);
    expect(sent[0].input).toEqual({ name: '田中', tel: '', subject: '見積', body: '' });
    expect(sent[0].origin).toEqual({ blockIndex: 2 });
    expect(sent[0].requestId).toMatch(UUID);
    expect(sent[1].requestId).toMatch(UUID);
    expect(sent[0].requestId).not.toBe(sent[1].requestId);
    await waitFor(() => expect(calls.filter((c) => c.key.endsWith('/data/list')).length).toBeGreaterThan(before));
  });

  it('送信中はボタンを止める（連打しても 1 回）', async () => {
    let release: () => void = () => {};
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok(sampleData()),
      'POST /pages/inquiries/actions/create': () => ({ status: 200, data: { success: true, data: { ok: true, sample: false } } }),
    });
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    fill('名前', '田中');
    fill('件名', '見積');
    // adapter を遅らせる代わりに、送信直後の disabled を見る
    const gate = new Promise<void>((r) => (release = r));
    const { api } = await import('../../../services/api');
    const id = api.interceptors.request.use(async (c) => {
      if (c.method === 'post') await gate;
      return c;
    });
    const button = screen.getByRole('button', { name: '登録' }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    await act(async () => release());
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(posts()).toHaveLength(1);
    api.interceptors.request.eject(id);
  });

  it('n8n の { ok:false } は文言を赤で出す', async () => {
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok(sampleData()),
      'POST /pages/inquiries/actions/create': ok({ ok: false, message: '重複しています', sample: false }),
    });
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    fill('名前', '田中');
    fill('件名', '見積');
    fireEvent.click(screen.getByRole('button', { name: '登録' }));
    const line = await screen.findByText('重複しています');
    expect(line.className).toContain('text-danger');
    expect(line.getAttribute('aria-live')).toBe('polite');
  });

  it('上限（429 PAGE_ACTION_LIMIT）: メンバーには契約リンクを出さない', async () => {
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok(sampleData()),
      'POST /pages/inquiries/actions/create': fail(429, 'PAGE_ACTION_LIMIT', '今月の実行回数の上限に達しました'),
    });
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    fill('名前', '田中');
    fill('件名', '見積');
    fireEvent.click(screen.getByRole('button', { name: '登録' }));
    expect(await screen.findByText(/上限に達しました/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'プラン' })).toBeNull();
  });

  it('上限: 管理者には /settings?tab=billing へのリンク', async () => {
    signIn('ADMIN');
    setRoutes({
      'GET /pages/inquiries': ok(sampleDetail()),
      'GET /pages/inquiries/data/list': ok(sampleData()),
      'POST /pages/inquiries/actions/create': fail(429, 'PAGE_ACTION_LIMIT', '今月の実行回数の上限に達しました'),
    });
    renderPage();
    await screen.findByRole('button', { name: '登録' });
    fill('名前', '田中');
    fill('件名', '見積');
    fireEvent.click(screen.getByRole('button', { name: '登録' }));
    const link = await screen.findByRole('link', { name: 'プラン' });
    expect(link.getAttribute('href')).toBe('/settings?tab=billing');
  });
});

describe('ボタンと行の操作（confirm）', () => {
  it('confirm があれば確認してから送る。やめると送らない。Escape でも閉じる', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '通知' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('担当へ通知しますか')).toBeTruthy();
    // 初期フォーカスは「やめる」
    expect(document.activeElement?.textContent).toBe('やめる');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '通知' }));
    fireEvent.click(await screen.findByRole('button', { name: '実行' }));
    expect(await screen.findByText('通知しました')).toBeTruthy();
    const body = posts()[0].body as { input: unknown; origin: unknown };
    expect(body.input).toEqual({});
    expect(body.origin).toEqual({ blockIndex: 3, itemIndex: 0 });
  });

  it('行の操作は rowId を送る', async () => {
    const { container } = renderPage();
    await screen.findByText('見積の依頼', { selector: 'td' });
    const button = container.querySelector('table button') as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: '実行' }));
    await screen.findByText('送信しました');
    const body = posts()[0].body as { input: unknown; origin: unknown };
    expect(body.input).toEqual({ rowId: 'r1' });
    expect(body.origin).toEqual({ blockIndex: 1 });
  });
});
