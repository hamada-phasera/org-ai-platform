import axios from 'axios';
import { useAuthStore } from '../store/authStore';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let recovering = false;

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status = err.response?.status;
    const code = err.response?.data?.error?.code as string | undefined;
    if (status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    } else if (status === 403 && code === 'TENANT_ACCESS_REVOKED' && !recovering) {
      /* この組織から外された。ログアウトはさせず、残っている組織へ（無ければ「所属組織なし」）。
         同時に何本も 403 が返るので、復帰は1回だけ走らせる */
      recovering = true;
      window.alert('この組織へのアクセス権がなくなりました。');
      const [{ recoverFromRevoked }, { sessionDeps }] = await Promise.all([import('./session'), import('./sessionDeps')]);
      await recoverFromRevoked(sessionDeps, useAuthStore.getState().user?.orgId ?? null).catch(() => {
        window.location.href = '/no-org';
      });
    } else if (status === 403 && code === 'TENANT_REQUIRED' && window.location.pathname !== '/no-org') {
      window.location.href = '/no-org';
    }
    return Promise.reject(err);
  },
);
