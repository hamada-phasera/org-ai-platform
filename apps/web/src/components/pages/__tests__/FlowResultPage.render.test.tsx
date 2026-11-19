// @vitest-environment jsdom
//
// 業務フローの結果ページ（docs/design/canvas-home.md §6.3）を /p/:slug で描く。flow_query で値と履歴を取り、
// フォームの送信は flow_submit（フローの実行）として POST する。API は adapter で差し替える（外部には出ない）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { cloneFlowTemplate, defaultFlowPageDefinition, flowQueryRaw, projectQueryResult, toPublicPageDefinition } from '@org-ai/shared-types';
import { calls, install, ok, renderPage, setRoutes, signIn, uninstall } from './harness';

const def = cloneFlowTemplate('proposal').definition;
const pageDef = defaultFlowPageDefinition(def, '提案書');
const raw = flowQueryRaw(def, null, [{ createdAt: '2026-11-19T01:00:00Z', status: 'WAITING_APPROVAL', output: null }]);

beforeEach(() => {
  install();
  signIn('MEMBER');
  setRoutes({
    'GET /pages/proposal': ok({
      slug: 'proposal', title: '提案書', icon: 'file-text', status: 'PUBLISHED', minRole: 'MEMBER', version: 1, updatedAt: '2026-11-19',
      definition: toPublicPageDefinition(pageDef), connection: 'ok', usage: { used: 1, limit: 300, state: 'ok', blocked: false },
    }),
    'GET /pages/proposal/data/result': ok({ ...projectQueryResult(pageDef, 'result', raw), sample: false }),
    'POST /pages/proposal/actions/run': ok({ ok: true, message: '承認待ちです。受信で承認すると続きます', sample: false, runId: 'r1', status: 'WAITING_APPROVAL' }),
  });
});
afterEach(() => {
  cleanup();
  uninstall();
});

describe('結果ページ（flow_query / flow_submit）', () => {
  it('履歴を flow_query で取り、フォームから実行する', async () => {
    renderPage('/p/proposal');
    await waitFor(() => expect(screen.getAllByText('承認待ち').length).toBeGreaterThan(0));
    expect(calls.some((c) => c.key === 'GET /pages/proposal/data/result')).toBe(true);

    fireEvent.change(screen.getByLabelText(/顧客名/), { target: { value: '〇〇建設' } });
    fireEvent.change(screen.getByLabelText(/要件/), { target: { value: '外壁' } });
    fireEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => expect(screen.getByText('承認待ちです。受信で承認すると続きます')).toBeTruthy());
    const post = calls.find((c) => c.key === 'POST /pages/proposal/actions/run')!.body as { input: Record<string, unknown>; origin: unknown };
    expect(post.input).toMatchObject({ customerName: '〇〇建設', requirements: '外壁' });
    expect(post.origin).toEqual({ blockIndex: 1 });
  });
});
