// @vitest-environment jsdom
//
// 帯（PlanNotice）と 402 の導線を、実際に描画して確かめる（saas-review #5b）。
// ソースの正規表現（PlanNotice.source.test.ts）では見えない「何が画面に出るか」を見る。
// API は本物の axios インスタンス（services/api.ts の interceptor を含む）で、通信だけ adapter で差し替える。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { BillingOverview, OrganizationUsage, UserRole } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import { usePlanNoticeStore } from '../../../store/planNoticeStore';
import { PlanNotice } from '../PlanNotice';

const DAY = 86_400_000;

function overview(over: Partial<BillingOverview> = {}): BillingOverview {
  return {
    configured: true,
    plan: 'STARTER',
    subscriptionStatus: null,
    billingInterval: null,
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    trialAvailable: false,
    trialDays: 30,
    appTrial: { active: false, endsAt: null, daysLeft: 0 },
    checkoutTrialEndsAt: null,
    hasCustomer: false,
    prices: [],
    storageAddon: { available: false, purchasable: false, units: 0, unitAmount: null },
    ...over,
  } as BillingOverview;
}

const USAGE = { aiCallsThisMonth: 0, planLimit: 1000, storageUsedBytes: 0, storageQuotaBytes: 1024 } as OrganizationUsage;

/** URL ごとの応答。402 などは status で返し、axios と同じく AxiosError で reject する */
type Route = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
let routes: Record<string, Route> = {};
const originalAdapter = api.defaults.adapter;

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  const route = routes[key];
  if (!route) throw new Error(`想定外の要求: ${key}`);
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

function renderNotice(extra?: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PlanNotice />
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.defaults.adapter = adapter;
  usePlanNoticeStore.getState().reset();
  routes = {
    'GET /billing': () => ({ status: 200, data: { success: true, data: overview() } }),
    'GET /organizations/me/usage': () => ({ status: 200, data: { success: true, data: USAGE } }),
  };
});

afterEach(() => {
  cleanup();
  api.defaults.adapter = originalAdapter;
  useAuthStore.setState({ token: null, user: null, memberships: [] });
});

describe('PlanNotice（描画）', () => {
  it('問題が無ければ何も出さない', async () => {
    signIn('OWNER');
    const { container } = renderNotice();
    // 取得が終わるのを待ってから空であることを見る
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('オーナー: 閲覧のみの文言と「プラン」リンク（契約画面へ）', async () => {
    signIn('OWNER');
    routes['GET /billing'] = () => ({ status: 200, data: { success: true, data: overview({ subscriptionStatus: 'canceled' }) } });
    renderNotice();

    const band = await screen.findByRole('status');
    expect(band.getAttribute('data-notice')).toBe('expired');
    expect(band.textContent).toContain('閲覧のみです（ご契約で保存と実行を再開できます）。');
    const link = screen.getByRole('link', { name: 'プラン' });
    expect(link.getAttribute('href')).toBe('/settings?tab=billing');
  });

  it('メンバー: リンクを出さず「オーナーにご連絡ください」（1 文）', async () => {
    signIn('MEMBER');
    routes['GET /billing'] = () => ({ status: 200, data: { success: true, data: overview({ subscriptionStatus: 'canceled' }) } });
    renderNotice();

    const band = await screen.findByRole('status');
    expect(band.textContent).toBe('閲覧のみです（再開はオーナーにご連絡ください）。');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('無料期間の残り 7 日以下は残り日数を出す', async () => {
    signIn('ADMIN');
    routes['GET /billing'] = () => ({
      status: 200,
      data: { success: true, data: overview({ trialEndsAt: new Date(Date.now() + 3 * DAY - 1000).toISOString() }) },
    });
    renderNotice();

    const band = await screen.findByRole('status');
    expect(band.getAttribute('data-notice')).toBe('trial');
    expect(band.textContent).toContain('無料期間は残り3日です。');
    expect(screen.getByRole('link', { name: 'プラン' })).toBeTruthy();
  });

  it('402 を受けたら、帯が閲覧のみに変わり契約画面への導線が出る（ログアウトしない）', async () => {
    signIn('OWNER');
    // 期限切れ前に開いた画面（帯なし）。保存の時点でサーバが閲覧のみと判定した、という流れ
    let expired = false;
    routes['GET /billing'] = () => ({
      status: 200,
      data: {
        success: true,
        data: overview({ trialEndsAt: new Date(Date.now() + (expired ? -DAY : 30 * DAY)).toISOString() }),
      },
    });
    routes['POST /tasks'] = () => {
      expired = true;
      return {
        status: 402,
        data: { success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: '無料期間が終了したため…' } },
      };
    };
    const { container } = renderNotice();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      await api.post('/tasks', { title: 'x' }).catch((e: AxiosError) => {
        // 呼び出し元には失敗として返る（画面ごとのエラー表示はそのまま）
        expect(e.response?.status).toBe(402);
      });
    });

    const band = await screen.findByRole('status');
    await waitFor(() => expect(band.getAttribute('data-notice')).toBe('expired'));
    expect(screen.getByRole('link', { name: 'プラン' }).getAttribute('href')).toBe('/settings?tab=billing');
    // 402 ではログアウトしない
    expect(useAuthStore.getState().token).toBe('t');
  });
});
