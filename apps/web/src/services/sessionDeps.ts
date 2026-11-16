// services/session.ts の本番用の依存（api / ストア / react-query / 画面遷移）。
import type { SessionDeps } from './session';
import { api } from './api';
import { queryClient } from './queryClient';
import { useAuthStore } from '../store/authStore';

export const sessionDeps: SessionDeps = {
  post: (url, body) => api.post(url, body),
  get: (url) => api.get(url),
  setSession: (token, user, memberships) => useAuthStore.getState().setSession(token, user, memberships),
  clearQueries: () => queryClient.clear(),
  navigate: (path) => window.location.assign(path),
};
