// @vitest-environment jsdom
//
// フロー画面（PC。docs/design/canvas-home.md §3.4）を実際に描画して確かめる。@xyflow/react をそのまま使い、
// jsdom に無い ResizeObserver・matchMedia だけ足す。API は adapter で差し替える（外部には出ない）。

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { cloneFlowTemplate, type UserRole } from '@org-ai/shared-types';
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

const PART_DEF = (() => {
  const t = cloneFlowTemplate('proposal');
  t.definition.nodes.push({ id: 'pdf', type: 'part', label: 'PDF', config: { part: 'pdf_make', input: { title: 'a', body: 'b' } } });
  t.definition.edges.push({ from: 'doc', to: 'pdf' });
  return t;
})();

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

function renderFlow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/flows/flow-1']}>
        <Routes>
          <Route path="/flows/:id" element={<FlowPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** キャンバスのノード（jsdom では大きさを測れないので @xyflow/react が visibility: hidden のまま置く。aria-label で探す） */
const node = (name: RegExp) =>
  waitFor(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[data-flow-node]')].find((b) => name.test(b.getAttribute('aria-label') ?? ''));
    if (!el) throw new Error(`node ${String(name)} not found`);
    return el;
  });

beforeEach(() => {
  api.defaults.adapter = adapter;
  calls.length = 0;
  routes = {
    'GET /flows/flow-1': () => ({ status: 200, data: { success: true, data: flowData() } }),
    'GET /flows/parts': () => ({ status: 200, data: { success: true, data: { parts: PARTS } } }),
    'GET /flows/flow-1/runs': () => ({ status: 200, data: { success: true, data: { runs: [], nextCursor: null } } }),
    'PUT /flows/flow-1': () => ({ status: 200, data: { success: true, data: { version: 4, changed: true } } }),
  };
  signIn('ADMIN');
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
});

describe('フロー画面（PC）', () => {
  it('キャンバスにノードが出て、押すと右パネルにその型の設定', async () => {
    renderFlow();
    fireEvent.click(await node(/^下書き/));
    const panel = screen.getByRole('complementary', { name: '設定' });
    expect(within(panel).getByText('AI')).toBeTruthy();
    expect(within(panel).getByLabelText('指示')).toBeTruthy();
    expect(within(panel).getAllByRole('button', { name: '値を差し込む' }).length).toBeGreaterThan(0);
  });

  it('値の差し込み: 上流の出力を選ぶと {{node.key}} が入る（手で式を書かせない）', async () => {
    renderFlow();
    fireEvent.click(await node(/^確認/));
    const panel = screen.getByRole('complementary', { name: '設定' });
    const message = within(panel).getByLabelText('文言') as HTMLInputElement;
    fireEvent.change(message, { target: { value: '' } });
    fireEvent.click(within(panel).getAllByRole('button', { name: '値を差し込む' })[0]);
    const menu = screen.getByRole('menu', { name: '差し込む値' });
    // 下流（文書）は候補に無い
    expect(within(menu).queryByText('文書')).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '顧客名' }));
    expect(message.value).toBe('{{form.customerName}}');
  });

  it('変更すると保存が主ボタンになり、未保存のまま実行できない', async () => {
    renderFlow();
    fireEvent.click(await node(/^下書き/));
    const run = screen.getByRole('button', { name: '実行' }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('指示'), { target: { value: '短く' } });
    expect(run.disabled).toBe(true);
    expect(screen.getByText('保存してから実行してください')).toBeTruthy();
  });

  it('保存の検証エラーはノードに印＋右パネルに 1 行。PUT は送らない', async () => {
    renderFlow();
    fireEvent.click(await node(/^下書き/));
    fireEvent.change(screen.getByLabelText('指示'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/直すところがあります/)).toBeTruthy();
    expect((await node(/^下書き（エラー/)).className).toMatch(/border-danger|border-accent/);
    expect(within(screen.getByRole('complementary', { name: '設定' })).getByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.key === 'PUT /flows/flow-1')).toBe(false);
  });

  it('gateway の 400（issues）も該当ノードに出る。409 は 1 行', async () => {
    routes['PUT /flows/flow-1'] = () => ({
      status: 400,
      data: { success: false, error: { code: 'FLOW_INVALID_DEFINITION', message: '定義に誤りがあります', issues: [{ path: ['nodes', 3, 'config', 'body'], message: '本文が長すぎます' }] } },
    });
    renderFlow();
    fireEvent.click(await node(/^下書き/));
    fireEvent.change(screen.getByLabelText('指示'), { target: { value: '短く' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await node(/^文書（エラー: 本文が長すぎます/)).toBeTruthy();
    const put = calls.find((c) => c.key === 'PUT /flows/flow-1')?.body as { baseVersion: number; definition: unknown };
    expect(put.baseVersion).toBe(3);

    routes['PUT /flows/flow-1'] = () => ({ status: 409, data: { success: false, error: { code: 'FLOW_CONFLICT', message: '別の人が先に保存しました。' } } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('別の人が先に保存しました。')).toBeTruthy();
  });

  it('ノードを追加して保存すると、定義と位置が PUT される', async () => {
    renderFlow();
    fireEvent.click(await node(/^文書/));
    fireEvent.click(screen.getByRole('button', { name: 'ノードを追加' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'ノードを追加' })).getByRole('menuitem', { name: '確認' }));
    expect(await node(/^確認/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /flows/flow-1')).toBe(true));
    const put = calls.find((c) => c.key === 'PUT /flows/flow-1')?.body as { definition: { nodes: { id: string }[]; edges: unknown[] }; layout: Record<string, unknown> };
    expect(put.definition.nodes.map((n) => n.id)).toContain('approval1');
    expect(put.definition.edges).toContainEqual({ from: 'doc', to: 'approval1' });
    expect(put.layout.approval1).toBeTruthy();
  });

  it('部品の未接続はノードと右パネルに出る（運営でなければ n8n のリンクは無い）', async () => {
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ definition: PART_DEF.definition, layout: PART_DEF.layout }) } });
    renderFlow();
    const pdf = await node(/^PDF（未接続）/);
    fireEvent.click(pdf);
    const panel = screen.getByRole('complementary', { name: '設定' });
    expect(within(panel).getByText('未接続')).toBeTruthy();
    expect(within(panel).queryByText('n8n で開く')).toBeNull();
  });

  it('MEMBER（canEdit なし）は保存ボタンも追加も無く、設定は触れない', async () => {
    signIn('MEMBER');
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ canEdit: false }) } });
    renderFlow();
    fireEvent.click(await node(/^下書き/));
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ノードを追加' })).toBeNull();
    expect(screen.getByLabelText('指示').matches(':disabled')).toBe(true);
  });

  it('実行するとノードに状態の点が重なる（承認待ち）', async () => {
    routes['POST /flows/flow-1/runs'] = () => ({
      status: 200,
      data: { success: true, data: { runId: 'r1', run: { id: 'r1', flowId: 'flow-1', status: 'WAITING_APPROVAL', durationMs: 10, error: null, trigger: 'form', steps: { form: { status: 'SUCCEEDED', attempts: 1 }, draft: { status: 'SUCCEEDED', attempts: 1 }, check: { status: 'WAITING_APPROVAL', attempts: 1 } } } } },
    });
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '実行' }));
    const dialog = screen.getByRole('dialog');
    for (const input of within(dialog).getAllByRole('textbox')) fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '実行' }));
    expect(await node(/^確認（承認待ち/)).toBeTruthy();
    expect(await node(/^下書き（完了/)).toBeTruthy();
  });
});
