import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { UserRole } from '@org-ai/shared-types';
import { api } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import CustomPage from '../../../pages/CustomPage';

export type Route_ = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };
export const calls: Array<{ key: string; body: unknown }> = [];
export let routes: Record<string, Route_> = {};
export function setRoutes(r: Record<string, Route_>): void {
  routes = r;
}

const originalAdapter = api.defaults.adapter;

const adapter: AxiosAdapter = async (config) => {
  const key = `${(config.method ?? 'get').toUpperCase()} ${config.url}`;
  calls.push({ key, body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data });
  const route = routes[key];
  if (!route) throw new Error(`想定外の要求: ${key}`);
  const { status, data } = route(config);
  const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response);
  return response;
};

export function install(): void {
  api.defaults.adapter = adapter;
  calls.length = 0;
}

export function uninstall(): void {
  api.defaults.adapter = originalAdapter;
  useAuthStore.setState({ token: null, user: null, memberships: [] });
}

export function signIn(role: UserRole): void {
  useAuthStore.setState({
    token: 't',
    user: { id: 'u1', orgId: 'org-1', role, email: 'a@example.com', name: '山田' } as never,
    memberships: [],
  });
}

export const ok = (data: unknown) => () => ({ status: 200, data: { success: true, data } });
export const fail = (status: number, code: string, message = 'x') => () => ({
  status,
  data: { success: false, error: { code, message } },
});

export function renderPage(path = '/p/inquiries', extra?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:slug" element={<CustomPage />} />
        </Routes>
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
