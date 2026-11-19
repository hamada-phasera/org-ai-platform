// @vitest-environment jsdom
//
// 受信ページ「エージェント承認」タブの業務フローの承認（docs/design/canvas-home.md §7.4・C5-4）。
// 中身は gateway が展開済みで、承認画面では編集させない（人が見たものをそのまま通す。K57）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import type { FlowStepApprovalData } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import InboxPage from '../../../pages/InboxPage';

const calls: { key: string; body: unknown }[] = [];
const originalAdapter = api.defaults.adapter;

const approval = (over: Partial<FlowStepApprovalData>): string =>
  JSON.stringify({ kind: 'flow_step', runId: 'run-1', nodeId: 'check', label: '確認', message: '提案書を確認してください', preview: '<script>alert(1)</script>本文', minRole: 'MEMBER', gate: false, ...over });

/** 個別の応答（status と本文。Promise なら返すのを待たせる） */
type Reply = { status: number; data: unknown };
let overrides: Record<string, () => Reply | Promise<Reply>> = {};

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push({ key, body: config.data ? JSON.parse(config.data as string) : undefined });
  const o = overrides[key];
  if (o) {
    const { status, data } = await o();
    const res: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
    if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, res);
    return res;
  }
  let data: unknown = { success: true, data: [] };
  if (key === 'GET /tasks?status=PENDING_APPROVAL&taskType=flow') {
    data = {
      success: true,
      data: [
        { id: 't-check', title: '提案書', status: 'PENDING_APPROVAL', approvalData: approval({}), createdAt: '2026-11-19T00:00:00Z' },
        { id: 't-gate', title: '通知', status: 'PENDING_APPROVAL', approvalData: approval({ nodeId: 'slack', label: 'Slack', message: '「Slack」を送ります', preview: '宛先: #general\nこんにちは', gate: true }), createdAt: '2026-11-19T00:00:00Z' },
        { id: 't-other', title: '別', status: 'PENDING_APPROVAL', approvalData: '{"kind":"agent_step"}', createdAt: '2026-11-19T00:00:00Z' },
      ],
    };
  }
  const response: AxiosResponse = { data, status: 200, statusText: 'OK', headers: {}, config };
  return response;
};

function renderInbox(path = '/inbox?tab=approvals') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/inbox" element={<InboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.defaults.adapter = adapter;
  calls.length = 0;
  overrides = {};
});
afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
});

describe('受信: 業務フローの承認', () => {
  it('?tab=approvals で承認タブが開き、確認と送信前の停止が並ぶ（中身は文字のまま・編集欄なし）', async () => {
    const { container } = renderInbox();
    const check = await screen.findByRole('group', { name: '実行プレビュー: 確認' });
    expect(within(check).getByText('提案書を確認してください')).toBeTruthy();
    expect(within(check).getByText('<script>alert(1)</script>本文')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    const gate = screen.getByRole('group', { name: '実行プレビュー: Slack' });
    expect(within(gate).getByText(/宛先: #general/)).toBeTruthy();
    expect(screen.getByText('送信前')).toBeTruthy();
    // agent_step 以外の形は流れに混ぜない・業務フローの承認に編集欄は無い
    expect(screen.queryByText('別')).toBeNull();
    expect(screen.queryByLabelText(/送信内容/)).toBeNull();
  });

  it('承認は本文なしで POST（人が見た中身をそのまま通す）、却下は reject', async () => {
    renderInbox();
    const check = await screen.findByRole('group', { name: '実行プレビュー: 確認' });
    fireEvent.click(within(check).getByRole('button', { name: '実行する' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /tasks/t-check/approve')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /tasks/t-check/approve')?.body).toEqual({});
    fireEvent.click(within(screen.getByRole('group', { name: '実行プレビュー: Slack' })).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /tasks/t-gate/reject')).toBe(true));
  });

  it('タブの件数に業務フローの承認も数える', async () => {
    renderInbox('/inbox');
    const tab = await screen.findByRole('tab', { name: /エージェント承認/ });
    await waitFor(() => expect(tab.textContent).toContain('2'));
  });
});

describe('受信: 業務フローの承認の表示（レビュー #13・#14）', () => {
  it('カードの中のプレビューは枠なし（カードを入れ子にしない）', async () => {
    renderInbox();
    const check = await screen.findByRole('group', { name: '実行プレビュー: 確認' });
    expect(check.className).not.toMatch(/shadow|rounded/);
  });

  it('失敗は gateway の文言をそのカードに 1 行（402 閲覧のみ・却下の失敗も）', async () => {
    overrides['POST /tasks/t-check/approve'] = () => ({ status: 402, data: { success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: '閲覧のみです。契約すると再開できます' } } });
    overrides['POST /tasks/t-gate/reject'] = () => ({ status: 409, data: { success: false, error: { code: 'CONFLICT', message: 'すでに処理されています' } } });
    renderInbox();
    const check = await screen.findByRole('group', { name: '実行プレビュー: 確認' });
    fireEvent.click(within(check).getByRole('button', { name: '実行する' }));
    expect(await screen.findByText('閲覧のみです。契約すると再開できます')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: '実行プレビュー: Slack' })).getByRole('button', { name: 'やめる' }));
    expect(await screen.findByText('すでに処理されています')).toBeTruthy();
    // 1 つ目の失敗はそのまま残る（別のカードを押しても消えない）
    expect(screen.getByText('閲覧のみです。契約すると再開できます')).toBeTruthy();
  });

  it('処理中の印はカードごと（別のカードを押しても外れない）。却下も処理中は押せない', async () => {
    let release: (r: Reply) => void = () => {};
    overrides['POST /tasks/t-check/approve'] = () => new Promise<Reply>((res) => (release = res));
    overrides['POST /tasks/t-gate/reject'] = () => new Promise<Reply>(() => {});
    renderInbox();
    const check = await screen.findByRole('group', { name: '実行プレビュー: 確認' });
    fireEvent.click(within(check).getByRole('button', { name: '実行する' }));
    const gate = screen.getByRole('group', { name: '実行プレビュー: Slack' });
    fireEvent.click(within(gate).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect((within(gate).getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(check).getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true);
    // 二重押ししても 1 回だけ
    fireEvent.click(within(gate).getByRole('button', { name: 'やめる' }));
    expect(calls.filter((c) => c.key === 'POST /tasks/t-gate/reject')).toHaveLength(1);
    release({ status: 200, data: { success: true, data: {} } });
    await waitFor(() => expect((within(check).getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(gate).getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('フローの承認の取得に失敗したら「承認待ちはありません」ではなくエラーを出す', async () => {
    overrides['GET /tasks?status=PENDING_APPROVAL&taskType=flow'] = () => ({ status: 500, data: { success: false, error: { code: 'INTERNAL', message: 'x' } } });
    renderInbox();
    await waitFor(() => expect(calls.some((c) => c.key === 'GET /tasks?status=PENDING_APPROVAL&taskType=flow')).toBe(true));
    await waitFor(() => expect(screen.queryByText('承認待ちはありません')).toBeNull());
    expect(await screen.findByRole('button', { name: /再試行|もう一度/ })).toBeTruthy();
  });
});
