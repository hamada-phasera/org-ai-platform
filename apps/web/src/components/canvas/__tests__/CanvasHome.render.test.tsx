// @vitest-environment jsdom
//
// ホーム（docs/design/canvas-home.md §3.3・§4.2）を実際に描画して確かめる。
// 幅はスマホ（matchMedia が一致しない）。スマホでは @xyflow/react のキャンバスを読み込まない（K20）。
// API は本物の axios インスタンスで、通信だけ adapter で差し替える（外部には出ない）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { defaultCanvasLayout, type UserRole } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import CanvasHomePage from '../../../pages/CanvasHomePage';
import { BusinessList } from '../BusinessList';
import { canvasToList } from '../canvasToList';

/** キャンバス（@xyflow/react）のモジュールが読み込まれたか。vi.mock は import より先に評価される */
const { boardLoaded } = vi.hoisted(() => ({ boardLoaded: vi.fn() }));
vi.mock('../CanvasBoard', () => {
  boardLoaded();
  return { default: () => <p>canvas-board</p> };
});

type Route = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
let routes: Record<string, Route> = {};
const calls: string[] = [];
const originalAdapter = api.defaults.adapter;

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push(key);
  // 初回の案内などの取得は空で返す（ここで見るのはホームの業務だけ）
  const route = routes[key] ?? (() => ({ status: 200, data: { success: true, data: [] } }));
  const { status, data } = route(config);
  const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response);
  return response;
};

function signIn(role: UserRole): void {
  useAuthStore.setState({
    token: 't',
    user: { id: 'u1', orgId: 'org-1', role, email: 'a@example.com', name: '山田' } as never,
    memberships: [],
  });
}

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<CanvasHomePage />} />
          <Route path="/flows/:id" element={<p>flow-page</p>} />
          <Route path="/inbox" element={<p>inbox-page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const canvasResponse = (flows: unknown[] = []) => ({
  status: 200,
  data: { success: true, data: { layout: defaultCanvasLayout(), version: 0, isDefault: true, flows } },
});

beforeEach(() => {
  api.defaults.adapter = adapter;
  calls.length = 0;
  routes = {
    'GET /canvas': () => canvasResponse(),
    'GET /tasks': () => ({
      status: 200,
      data: { success: true, data: [{ id: 't1', status: 'PENDING_APPROVAL' }, { id: 't2', status: 'PENDING_APPROVAL' }, { id: 't3', status: 'DONE' }] },
    }),
  };
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
  useAuthStore.setState({ token: null, user: null, memberships: [] });
});

describe('ホーム（スマホ幅）', () => {
  it('業務の縦リスト（既定の配置）が 1 列で出る。キャンバスは読み込まない', async () => {
    signIn('ADMIN');
    renderHome();
    const list = await screen.findByRole('list', { name: '業務' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      '問い合わせを開く',
      '提案書を開く',
      '見積を開く',
      '承認を開く',
      '請求を開く',
      '原価を開く',
      'SNSを開く',
      '数字を開く',
    ]);
    // 行は 56px 以上（min-h-14）・全幅（横に並べない）
    for (const r of rows) expect(r.className).toMatch(/\bmin-h-14\b.*\bw-full\b|\bw-full\b.*\bmin-h-14\b/);
    expect(boardLoaded).not.toHaveBeenCalled();
    // 指示入力は残る
    expect(screen.getByLabelText('今日は何をしますか？')).toBeTruthy();
  });

  it('承認待ちの件数は承認の行だけに出る（数字はそれだけ）', async () => {
    signIn('MEMBER');
    renderHome();
    expect(await screen.findByLabelText('承認待ち 2件')).toBeTruthy();
    const approvals = screen.getByRole('button', { name: '承認を開く' });
    expect(within(approvals).getByText('2')).toBeTruthy();
  });

  it('ADMIN: 未作成を押すとテンプレートから作って開く（確認なし）', async () => {
    signIn('ADMIN');
    let body: unknown = null;
    routes['POST /flows/from-template'] = (config) => {
      body = JSON.parse(String(config.data));
      return { status: 201, data: { success: true, data: { flow: { id: 'flow_1' }, created: true, canvasUpdated: true } } };
    };
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: '提案書を開く' }));
    expect(await screen.findByText('flow-page')).toBeTruthy();
    expect(body).toEqual({ templateKey: 'proposal', canvasNodeId: 'proposal' });
  });

  it('MEMBER: 未作成は押せない（aria-disabled）。押しても作らず 1 行だけ', async () => {
    signIn('MEMBER');
    renderHome();
    const row = await screen.findByRole('button', { name: '見積を開く' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(await screen.findByText('まだ用意されていません')).toBeTruthy();
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('フロー数の上限: 作らずに 1 行。ADMIN 以上にはプランへの導線', async () => {
    signIn('ADMIN');
    routes['POST /flows/from-template'] = () => ({
      status: 403,
      data: { success: false, error: { code: 'FLOW_LIMIT_REACHED', message: 'フロー数が上限です' } },
    });
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: '請求を開く' }));
    expect(await screen.findByText('フロー数が上限です')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'プラン' });
    expect(link.getAttribute('href')).toBe('/settings?tab=billing');
    expect(screen.queryByText('flow-page')).toBeNull();
  });

  it('作成済みのフロー（テンプレートのノードのまま）はそのフローを開く', async () => {
    signIn('MEMBER');
    routes['GET /canvas'] = () =>
      canvasResponse([{ id: 'flow_9', slug: 'proposal', name: '提案書', icon: 'file-text', enabled: true, templateKey: 'proposal' }]);
    renderHome();
    await waitFor(() => expect(screen.getByRole('button', { name: '提案書を開く' }).getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '提案書を開く' }));
    expect(await screen.findByText('flow-page')).toBeTruthy();
  });

  it('画面のノードはその画面へ', async () => {
    signIn('MEMBER');
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: '問い合わせを開く' }));
    expect(await screen.findByText('inbox-page')).toBeTruthy();
  });

  it('読み込みに失敗しても既定の配置を出す', async () => {
    signIn('ADMIN');
    routes['GET /canvas'] = () => ({ status: 500, data: { success: false, error: { code: 'INTERNAL', message: 'x' } } });
    renderHome();
    expect(await screen.findByText('読み込めませんでした。既定の配置を表示しています。')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /を開く$/ })).toHaveLength(8);
  });
});

describe('BusinessList', () => {
  it('ラベルの <script> は文字として出る（HTML として解釈しない）', () => {
    const layout = defaultCanvasLayout();
    layout.nodes[0] = { ...layout.nodes[0], label: '<script>' };
    const { container } = render(
      <BusinessList rows={canvasToList(layout, [])} approvalsCount={0} canCreate onOpen={() => {}} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>')).toBeTruthy();
  });

  it('2 行目に「次: 〇〇」。線の無い行は 2 行目を出さない', () => {
    render(<BusinessList rows={canvasToList(defaultCanvasLayout(), [])} approvalsCount={0} canCreate onOpen={() => {}} />);
    expect(within(screen.getByRole('button', { name: '提案書を開く' })).getByText('次: 見積・承認')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: '数字を開く' })).queryByText(/^次:/)).toBeNull();
  });

  it('未作成の印はテンプレートのノードだけ', () => {
    render(<BusinessList rows={canvasToList(defaultCanvasLayout(), [])} approvalsCount={0} canCreate onOpen={() => {}} />);
    expect(screen.getAllByText('未作成')).toHaveLength(4);
  });

  it('消えたフローを指すノードは誰も押せない（onOpen を呼ばない）', () => {
    const onOpen = vi.fn();
    const layout = defaultCanvasLayout();
    layout.nodes[0] = { ...layout.nodes[0], target: { kind: 'flow', flowId: 'gone' } };
    render(<BusinessList rows={canvasToList(layout, [])} approvalsCount={0} canCreate onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: '問い合わせを開く' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ⚠️ モジュールの読み込みは 1 度きりなので、PC 幅は最後に見る
describe('ホーム（PC 幅）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PC だけがキャンバスを遅延で読む', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({ matches: query === '(min-width: 1024px)', media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    signIn('ADMIN');
    renderHome();
    expect(await screen.findByText('canvas-board')).toBeTruthy();
    expect(boardLoaded).toHaveBeenCalledTimes(1);
  });
});
