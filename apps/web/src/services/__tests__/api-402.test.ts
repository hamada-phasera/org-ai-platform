import { describe, it, expect, beforeEach } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../api';
import { useAuthStore } from '../../store/authStore';
import { usePlanNoticeStore } from '../../store/planNoticeStore';

// 402（閲覧のみ）の受け方（docs/plan/saas-readiness-plan.md チャンク 2）

const USER = { id: 'u1', email: 'u@example.com', name: 'U', role: 'OWNER' as const, orgId: 'org-A' };

function respondWith(status: number, data: unknown): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig) => {
    const response = { data, status, statusText: '', headers: {}, config };
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
  };
}

const SUBSCRIPTION_REQUIRED = {
  success: false,
  error: { code: 'SUBSCRIPTION_REQUIRED', message: '無料期間が終了しました。' },
};

describe('api interceptor: 402', () => {
  beforeEach(() => {
    useAuthStore.getState().login('tok-A', USER);
    usePlanNoticeStore.getState().reset();
  });

  it('例外を投げ直す（呼び出し元はエラー文言を出せる）', async () => {
    const err = await api
      .post('/agents', {}, { adapter: respondWith(402, SUBSCRIPTION_REQUIRED) })
      .catch((e: unknown) => e as AxiosError<typeof SUBSCRIPTION_REQUIRED>);
    expect(err).toBeInstanceOf(AxiosError);
    expect((err as AxiosError).response?.status).toBe(402);
    expect((err as AxiosError<typeof SUBSCRIPTION_REQUIRED>).response?.data.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('ログアウトしない（トークンも本人も残る）', async () => {
    await api.post('/agents', {}, { adapter: respondWith(402, SUBSCRIPTION_REQUIRED) }).catch(() => null);
    expect(useAuthStore.getState().token).toBe('tok-A');
    expect(useAuthStore.getState().user?.orgId).toBe('org-A');
  });

  it('いまの組織を閲覧のみとして印を付ける（帯が expired になる）', async () => {
    const before = Date.now();
    await api.post('/agents', {}, { adapter: respondWith(402, SUBSCRIPTION_REQUIRED) }).catch(() => null);
    const s = usePlanNoticeStore.getState();
    expect(s.readOnlyOrgId).toBe('org-A');
    expect(s.markedAt).toBeGreaterThanOrEqual(before);
  });

  it('402 以外（400 など）では印を付けない', async () => {
    await api
      .post('/files/upload', {}, { adapter: respondWith(413, { success: false, error: { code: 'QUOTA_EXCEEDED', message: 'x' } }) })
      .catch(() => null);
    expect(usePlanNoticeStore.getState().readOnlyOrgId).toBeNull();
    expect(useAuthStore.getState().token).toBe('tok-A');
  });
});
