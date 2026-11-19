// @vitest-environment jsdom
//
// ホームキャンバス（PC。docs/design/canvas-home.md §3.2・§5.2）を実際に描画して確かめる。@xyflow/react をそのまま使い、
// jsdom に無い ResizeObserver だけ足す。API は adapter で差し替える（外部には出ない）。

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { defaultCanvasLayout, type CanvasLayout } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import { usePlanNoticeStore } from '../../../store/planNoticeStore';
import CanvasBoard from '../CanvasBoard';
import type { CanvasData } from '../canvasApi';

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
});

type Handler = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
let routes: Record<string, Handler> = {};
const calls: { key: string; body: unknown }[] = [];
const originalAdapter = api.defaults.adapter;

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push({ key, body: config.data ? JSON.parse(config.data as string) : undefined });
  const route = routes[key] ?? (() => ({ status: 200, data: { success: true, data: {} } }));
  const { status, data } = route(config);
  const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response);
  return response;
};

const EMPTY: CanvasLayout = { nodes: [], edges: [] } as unknown as CanvasLayout;
const canvas = (version: number): CanvasData => ({ layout: EMPTY, version, isDefault: false, flows: [] });

function renderBoard(data: CanvasData) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (d: CanvasData) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CanvasBoard data={d} approvalsCount={0} canEdit canCreate onOpen={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(ui(data));
  return { rerender: (d: CanvasData) => r.rerender(ui(d)) };
}

beforeEach(() => {
  api.defaults.adapter = adapter;
  calls.length = 0;
  routes = {};
  useAuthStore.setState({ token: 't', user: { id: 'u1', orgId: 'org-1', role: 'ADMIN', email: 'a@example.com', name: '山田' } as never, memberships: [] });
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
  usePlanNoticeStore.getState().reset();
});

/** 編集を始めてノードを 1 つ足す（保存が押せる状態） */
function editAndAdd() {
  fireEvent.click(screen.getByRole('button', { name: '編集' }));
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  const menu = screen.getByRole('dialog', { name: '追加' });
  const entry = within(menu).getAllByRole('button').find((b) => !(b as HTMLButtonElement).disabled);
  fireEvent.click(entry!);
}

describe('ホームキャンバス（PC）の保存（レビュー #3）', () => {
  it('編集中に取り直しで版だけ上がっても、保存は編集を始めた版で送り、409 を 1 行出す', async () => {
    routes['PUT /canvas'] = () => ({ status: 409, data: { success: false, error: { code: 'CANVAS_CONFLICT', message: '別の人が先に保存しました。' } } });
    const { rerender } = renderBoard(canvas(5));
    editAndAdd();
    // 取り直し（フォーカス・staleTime 切れ）で他の人の保存が入った
    rerender(canvas(6));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('別の人が先に保存しました。')).toBeTruthy();
    const put = calls.find((c) => c.key === 'PUT /canvas')?.body as { baseVersion: number };
    expect(put.baseVersion).toBe(5);
  });

  it('保存できたら閲覧に戻る', async () => {
    routes['PUT /canvas'] = () => ({ status: 200, data: { success: true, data: { version: 6 } } });
    renderBoard(canvas(5));
    editAndAdd();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '編集' })).toBeTruthy());
    expect((calls.find((c) => c.key === 'PUT /canvas')?.body as { baseVersion: number }).baseVersion).toBe(5);
  });
});

describe('ホームキャンバス（PC）: 閲覧のみ（レビュー #15）', () => {
  it('402 を受けた組織では「編集」を押せず、理由を添える', async () => {
    usePlanNoticeStore.getState().markReadOnly('org-1');
    routes['GET /billing'] = () => ({ status: 200, data: { success: true, data: { configured: true, subscriptionStatus: 'canceled', trialEndsAt: null } } });
    renderBoard(canvas(5));
    // 取り直した契約状態も閲覧のみなら、そのまま止める
    await waitFor(() => expect(calls.some((c) => c.key === 'GET /billing')).toBe(true));
    const edit = screen.getByRole('button', { name: '編集' }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe('閲覧のみです');
  });
});

describe('ホームキャンバス（PC）のノードの読み上げ（レビュー #16）', () => {
  it('名前は「〇〇を開く」のまま、未作成は説明として読まれる', () => {
    renderBoard({ layout: defaultCanvasLayout(), version: 1, isDefault: false, flows: [] });
    const proposal = document.querySelector<HTMLElement>('[data-canvas-node="proposal"]')!;
    expect(proposal.getAttribute('aria-label')).toBe('提案書を開く');
    const ids = (proposal.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['未作成']);
  });
});
