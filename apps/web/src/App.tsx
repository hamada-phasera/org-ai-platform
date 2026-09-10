import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import InvitePage from './pages/InvitePage';
import InboxPage from './pages/InboxPage';
import ChatPage from './pages/ChatPage';
import HomePage from './pages/HomePage';
import AgentsPage from './pages/AgentsPage';
/* エージェント詳細だけがキャンバス（@xyflow/react ≒ 60KB gzip）を使う。
   静的に import すると全ユーザーが初回ロードで落とすので、ここだけ遅延にする。 */
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage'));
import GovernancePage from './pages/GovernancePage';
import TaskManagerPage from './pages/TaskManagerPage';
import DeliverablesPage from './pages/DeliverablesPage';
import SettingsPage from './pages/SettingsPage';
import SalesPage from './pages/SalesPage';
import AnalyticsPage from './pages/AnalyticsPage';
import SnsPage from './pages/SnsPage';
import AccountingPage from './pages/AccountingPage';
import TopPage from './pages/TopPage';
import { AppShell } from './components/shell/AppShell';
import { Spinner } from './components/ui';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* 招待の受諾。ログイン前に踏むので RequireAuth の外に置く */}
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {/* TOP は最小。数字は /dashboard 側に置く。 */}
        <Route index element={<TopPage />} />
        <Route path="dashboard" element={<HomePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:id" element={<ChatPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route
          path="agents/:id"
          element={
            <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}>
              <AgentDetailPage />
            </Suspense>
          }
        />
        <Route path="governance" element={<GovernancePage />} />
        <Route path="tasks" element={<TaskManagerPage />} />
        <Route path="deliverables" element={<DeliverablesPage />} />
        <Route path="sales" element={<SalesPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="sns" element={<SnsPage />} />
        <Route path="accounting" element={<AccountingPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
