// @vitest-environment jsdom
//
// フロー画面（スマホ。docs/design/canvas-home.md §4.3）を実際に描画して確かめる。
// 幅はスマホ（matchMedia が無い＝一致しない）。編集画面（@xyflow/react・zod）は読み込まない（K20）。
// API は本物の axios インスタンスで、通信だけ adapter で差し替える（外部には出ない）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { cloneFlowTemplate, type UserRole } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import FlowPage from '../../../pages/FlowPage';

const { editorLoaded } = vi.hoisted(() => ({ editorLoaded: vi.fn() }));
vi.mock('../FlowEditor', () => {
  editorLoaded();
  return { default: () => <p>flow-editor</p> };
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
  useAuthStore.setState({
    token: 't',
    user: { id: 'u1', orgId: 'org-1', role, email: 'a@example.com', name: '山田' } as never,
    memberships: [],
  });
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
    version: 3, definition: t.definition, layout: t.layout, valid: true, canEdit: false, usage, connection: { n8n: 'not_configured' },
    ...over,
  };
}

function renderFlow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/flows/flow-1']}>
        <Routes>
          <Route path="/flows/:id" element={<FlowPage />} />
          <Route path="/inbox" element={<p>inbox-page</p>} />
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
    'GET /flows/parts': () => ({ status: 200, data: { success: true, data: { parts: [] } } }),
    'GET /flows/flow-1/runs': () => ({ status: 200, data: { success: true, data: { runs: [], nextCursor: null } } }),
  };
  signIn('MEMBER');
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
});

describe('フロー画面（スマホ）', () => {
  it('ステップが 1 列に番号付きで並び、行は 56px 以上。編集画面（@xyflow/react）は読み込まない', async () => {
    renderFlow();
    const list = await screen.findByRole('list', { name: '手順' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['1 フォーム', '2 下書き', '3 確認', '4 文書']);
    for (const b of buttons) expect(b.className).toMatch(/min-h-14/);
    expect(screen.queryByText('flow-editor')).toBeNull();
    expect(editorLoaded).not.toHaveBeenCalled();
  });

  it('ラベルの <script> は文字のまま（T13）', async () => {
    const t = cloneFlowTemplate('proposal');
    t.definition.nodes[1].label = '<script>';
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ definition: t.definition }) } });
    const { container } = renderFlow();
    expect(await screen.findByText('<script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });

  it('MEMBER のシートは閲覧だけ（保存の項目が無い）', async () => {
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '2 下書き' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: '保存' })).toBeNull();
    expect(within(sheet).getByText('指示')).toBeTruthy();
  });

  it('ADMIN は文字の項目を変えて保存できる（PATCH の node と版）', async () => {
    signIn('ADMIN');
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ canEdit: true }) } });
    routes['PATCH /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: { version: 4 } } });
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '3 確認' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('文言'), { target: { value: '中身を見てください' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /flows/flow-1')).toBe(true));
    expect(calls.find((c) => c.key === 'PATCH /flows/flow-1')?.body).toEqual({ node: { id: 'check', config: { message: '中身を見てください' } }, baseVersion: 3 });
  });

  it('実行: フォームの入力 → requestId 付きで POST → 承認待ちは受信への導線。ステップに状態が出る', async () => {
    routes['POST /flows/flow-1/runs'] = () => ({
      status: 200,
      data: {
        success: true,
        data: {
          runId: 'run-1',
          run: {
            id: 'run-1', flowId: 'flow-1', status: 'WAITING_APPROVAL', durationMs: 4200, error: null, trigger: 'form', actorId: 'u1',
            steps: { form: { status: 'SUCCEEDED', attempts: 1 }, draft: { status: 'SUCCEEDED', attempts: 1, durationMs: 4100, output: { text: '下書き' } }, check: { status: 'WAITING_APPROVAL', attempts: 1 } },
          },
        },
      },
    });
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '実行' }));
    const dialog = screen.getByRole('dialog');
    // 必須の空は送らない
    fireEvent.click(within(dialog).getByRole('button', { name: '実行' }));
    expect(calls.some((c) => c.key === 'POST /flows/flow-1/runs')).toBe(false);
    for (const input of within(dialog).getAllByRole('textbox')) fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '実行' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const body = calls.find((c) => c.key === 'POST /flows/flow-1/runs')?.body as { requestId: string; input: Record<string, unknown> };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body.input)).toContain('customerName');
    expect(screen.getAllByRole('link', { name: '受信で承認' })[0].getAttribute('href')).toBe('/inbox?tab=approvals');
    expect(screen.getByRole('button', { name: '3 確認 承認待ち' })).toBeTruthy();
  });

  it('上限の 429 は 1 行で出す（実行は作られない）', async () => {
    routes['POST /flows/flow-1/runs'] = () => ({ status: 429, data: { success: false, error: { code: 'FLOW_RUN_LIMIT', message: '今月の実行数の上限です。' } } });
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: '実行' }));
    const dialog = screen.getByRole('dialog');
    for (const input of within(dialog).getAllByRole('textbox')) fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '実行' }));
    expect(await within(dialog).findByText('今月の実行数の上限です。')).toBeTruthy();
  });

  it('無効なフローは実行できない', async () => {
    routes['GET /flows/flow-1'] = () => ({ status: 200, data: { success: true, data: flowData({ enabled: false }) } });
    renderFlow();
    const run = await screen.findByRole('button', { name: '実行' });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('無効になっています')).toBeTruthy();
  });

  it('履歴: 日時・誰が・状態・所要時間。押すとその回のステップ結果を重ねる', async () => {
    routes['GET /flows/flow-1/runs'] = () => ({
      status: 200,
      data: {
        success: true,
        data: {
          runs: [
            { id: 'run-9', flowId: 'flow-1', flowVersion: 3, trigger: 'schedule', actorId: null, actorName: null, status: 'FAILED', error: null, taskId: null, startedAt: null, finishedAt: null, durationMs: 1200, createdAt: '2026-11-18T01:00:00Z' },
          ],
          nextCursor: null,
        },
      },
    });
    routes['GET /flows/runs/run-9'] = () => ({
      status: 200,
      data: { success: true, data: { id: 'run-9', flowId: 'flow-1', status: 'FAILED', durationMs: 1200, error: { message: 'AI に届きませんでした' }, trigger: 'schedule', steps: { form: { status: 'SUCCEEDED', attempts: 1 }, draft: { status: 'FAILED', attempts: 2 } } } },
    });
    renderFlow();
    fireEvent.click(await screen.findByRole('tab', { name: '履歴' }).catch(() => screen.findByRole('button', { name: '履歴' })));
    const history = await screen.findByRole('list', { name: '履歴' });
    const row = within(history).getByRole('button');
    expect(row.textContent).toContain('定期');
    expect(row.textContent).toContain('失敗');
    expect(row.textContent).toContain('1.2 秒');
    fireEvent.click(row);
    expect(await screen.findByRole('button', { name: '2 下書き 失敗' })).toBeTruthy();
    expect(screen.getByText('AI に届きませんでした')).toBeTruthy();
  });
});
