/* eslint-disable @typescript-eslint/no-explicit-any -- 送った本文を読むテスト */
// @vitest-environment jsdom
//
// 出力ビルダー（docs/design/canvas-home.md §3.5・チャンク 9）を実際に描画して確かめる。@xyflow/react をそのまま使い、
// jsdom に無い ResizeObserver・matchMedia だけ足す。API は adapter で差し替える（外部には出ない）。

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { cloneFlowTemplate, defaultFlowPageDefinition, type UserRole } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import FlowPage from '../../../pages/FlowPage';

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1024px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

type Handler = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
let routes: Record<string, Handler> = {};
const calls: { key: string; body: unknown }[] = [];
const originalAdapter = api.defaults.adapter;

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push({ key, body: config.data ? JSON.parse(config.data as string) : undefined });
  const route = routes[key] ?? (() => ({ status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: 'x' } } }));
  const { status, data } = route(config);
  const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response);
  return response;
};

function signIn(role: UserRole): void {
  useAuthStore.setState({ token: 't', user: { id: 'u1', orgId: 'org-1', role, email: 'a@example.com', name: '山田' } as never, memberships: [] });
}

const usage = {
  flows: { count: 1, limit: 3 },
  runs: { used: 0, limit: 300, state: 'ok', blocked: false },
  partCalls: { used: 0, limit: 100, state: 'ok', blocked: false },
};


function flowData(over: Record<string, unknown> = {}) {
  const t = cloneFlowTemplate('proposal');
  return {
    id: 'flow-1', slug: 'proposal', name: '提案書', icon: 'file-text', enabled: true, minRole: 'MEMBER', templateKey: 'proposal',
    version: 3, definition: t.definition, layout: t.layout, valid: true, canEdit: true, usage, connection: { n8n: 'not_configured' },
    ...over,
  };
}

const PARTS = [
  { key: 'pdf_make', title: 'PDF', icon: 'file-text', via: 'n8n', input: [{ key: 'title', label: '題名', type: 'text', required: true }, { key: 'body', label: '本文', type: 'textarea', required: true }], output: [{ key: 'url', type: 'text' }], sideEffect: 'none', minPlan: 'PRO', allowed: true, connection: 'not_configured' },
];

let lastQc: QueryClient | null = null;

function renderFlow(path = '/flows/flow-1?view=output') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQc = qc;
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/flows/:id" element={<FlowPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}


beforeEach(() => {
  api.defaults.adapter = adapter;
  calls.length = 0;
  routes = {
    'GET /flows/flow-1': () => ({ status: 200, data: { success: true, data: flowData() } }),
    'GET /flows/parts': () => ({ status: 200, data: { success: true, data: { parts: PARTS } } }),
    'GET /flows/flow-1/runs': () => ({ status: 200, data: { success: true, data: { runs: [], nextCursor: null } } }),
    'PUT /flows/flow-1': () => ({ status: 200, data: { success: true, data: { version: 4, changed: true } } }),
    'GET /flows/flow-1/page': () => ({ status: 200, data: { success: true, data: pageInfo() } }),
    'PUT /flows/flow-1/page': () => ({ status: 201, data: { success: true, data: { slug: 'proposal', version: 1, status: 'PUBLISHED', created: true, changed: true } } }),
  };
  signIn('ADMIN');
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
});


function pageInfo(over: Record<string, unknown> = {}) {
  const t = cloneFlowTemplate('proposal');
  return {
    page: null,
    draft: defaultFlowPageDefinition(t.definition, '提案書'),
    sources: [{ key: 'runs', label: '履歴', type: 'rows', columns: ['date', 'status'] }],
    preview: { raw: { runs: [{ date: '2026-11-19 10:00', status: '<script>alert(1)</script>' }] }, hasRun: true },
    ...over,
  };
}

describe('出力ビルダー（PC・ADMIN 以上）', () => {
  it('?view=output で開き、最初の案（見出し・フォーム・履歴）をプレビュー。フォームはきっかけの項目', async () => {
    renderFlow();
    const preview = await screen.findByLabelText('プレビュー');
    await waitFor(() => expect(within(preview).getByText('顧客名')).toBeTruthy());
    // プレビューは押しても実行しない（fieldset disabled）
    expect(preview.querySelector('fieldset[disabled]')).toBeTruthy();
    // 値は文字として出る（XSS にならない）
    expect(within(preview).getAllByText('<script>alert(1)</script>').length).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();
  });

  it('部品を足して保存すると、結果の取得と実行のアクションつきで PUT する', async () => {
    renderFlow();
    const palette = await screen.findByRole('navigation', { name: '部品' });
    fireEvent.click(within(palette).getByRole('button', { name: '文章' }));
    // 足したブロックが選ばれて右パネルに出る
    const panel = screen.getByLabelText('ブロックの設定');
    fireEvent.change(within(panel).getByLabelText('文字'), { target: { value: 'お客さまごとの提案書' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /flows/flow-1/page')).toBe(true));
    const body = calls.find((c) => c.key === 'PUT /flows/flow-1/page')!.body as any;
    expect(body.definition.actions).toEqual({ result: { kind: 'flow_query' }, run: { kind: 'flow_submit' } });
    expect(body.definition.blocks.at(-1)).toEqual({ type: 'text', text: 'お客さまごとの提案書' });
    expect(body.baseVersion).toBeUndefined();
  });

  it('保存の検査エラーは該当ブロックに出る', async () => {
    routes['PUT /flows/flow-1/page'] = () => ({
      status: 400,
      data: { success: false, error: { code: 'FLOW_PAGE_INVALID', message: 'x', issues: [{ path: ['blocks', 0, 'text'], message: '見出しが長すぎます' }] } },
    });
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getAllByText('見出しが長すぎます').length).toBeGreaterThan(0));
  });

  it('並べ替え: 右パネルの「下へ」でブロックの順が変わる', async () => {
    renderFlow();
    const preview = await screen.findByLabelText('プレビュー');
    fireEvent.click(within(preview).getByRole('button', { name: '見出し' }));
    fireEvent.click(within(screen.getByLabelText('ブロックの設定')).getByRole('button', { name: '下へ' }));
    const labels = [...preview.querySelectorAll('li[data-output-block] button[aria-pressed]')].map((b) => b.textContent);
    expect(labels.slice(0, 2)).toEqual(['フォーム', '見出し']);
  });

  it('MEMBER（編集できない）には「出力」タブが無く、?view=output でも手順を出す', async () => {
    signIn('MEMBER');
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ canEdit: false }) } });
    renderFlow();
    await screen.findByRole('tab', { name: '手順' });
    expect(screen.queryByRole('tab', { name: '出力' })).toBeNull();
    expect(calls.some((c) => c.key === 'GET /flows/flow-1/page')).toBe(false);
  });
});

describe('出力ビルダー: 編集中の取り直し（レビュー #4）', () => {
  const existing = (version: number, title: string) => {
    const t = cloneFlowTemplate('proposal');
    return pageInfo({
      page: { slug: 'proposal', title, status: 'PUBLISHED', minRole: 'MEMBER', version, definition: defaultFlowPageDefinition(t.definition, '提案書') },
      draft: null,
    });
  };

  it('編集中に版が上がっても足したブロックを消さず 1 行出す。保存は編集を始めた版で送る', async () => {
    routes['GET /flows/flow-1/page'] = () => ({ status: 200, data: { success: true, data: existing(2, '提案書') } });
    renderFlow();
    const palette = await screen.findByRole('navigation', { name: '部品' });
    fireEvent.click(within(palette).getByRole('button', { name: '文章' }));
    fireEvent.change(within(screen.getByLabelText('ブロックの設定')).getByLabelText('文字'), { target: { value: '残す' } });

    routes['GET /flows/flow-1/page'] = () => ({ status: 200, data: { success: true, data: existing(3, '別の人の題名') } });
    await lastQc!.invalidateQueries({ queryKey: ['flow-page', 'flow-1'] });
    expect(await screen.findByText('他の人が更新しました')).toBeTruthy();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('提案書');

    routes['PUT /flows/flow-1/page'] = () => ({ status: 409, data: { success: false, error: { code: 'PAGE_CONFLICT', message: '別の人が先に保存しました。' } } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('別の人が先に保存しました。')).toBeTruthy();
    const body = calls.find((c) => c.key === 'PUT /flows/flow-1/page')!.body as any;
    expect(body.baseVersion).toBe(2);
    expect(body.definition.blocks.at(-1)).toEqual({ type: 'text', text: '残す' });
  });

  it('編集していなければ取り直した版に合わせる', async () => {
    routes['GET /flows/flow-1/page'] = () => ({ status: 200, data: { success: true, data: existing(2, '提案書') } });
    renderFlow();
    await screen.findByRole('navigation', { name: '部品' });
    routes['GET /flows/flow-1/page'] = () => ({ status: 200, data: { success: true, data: existing(3, '新しい題名') } });
    await lastQc!.invalidateQueries({ queryKey: ['flow-page', 'flow-1'] });
    await waitFor(() => expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('新しい題名'));
    expect(screen.queryByText('他の人が更新しました')).toBeNull();
  });
});
