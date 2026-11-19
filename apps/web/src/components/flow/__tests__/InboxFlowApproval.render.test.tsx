// @vitest-environment jsdom
//
// 受信ページ「エージェント承認」タブの業務フローの承認（docs/design/canvas-home.md §7.4・C5-4）。
// 中身は gateway が展開済みで、承認画面では編集させない（人が見たものをそのまま通す。K57）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosAdapter, AxiosResponse } from 'axios';
import type { FlowStepApprovalData } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import InboxPage from '../../../pages/InboxPage';

const calls: { key: string; body: unknown }[] = [];
const originalAdapter = api.defaults.adapter;

const approval = (over: Partial<FlowStepApprovalData>): string =>
  JSON.stringify({ kind: 'flow_step', runId: 'run-1', nodeId: 'check', label: '確認', message: '提案書を確認してください', preview: '<script>alert(1)</script>本文', minRole: 'MEMBER', gate: false, ...over });

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push({ key, body: config.data ? JSON.parse(config.data as string) : undefined });
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
