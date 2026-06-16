import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ChatPage from './pages/ChatPage';
import HomePage from './pages/HomePage';
import AgentsPage from './pages/AgentsPage';
import GovernancePage from './pages/GovernancePage';
import TaskManagerPage from './pages/TaskManagerPage';
import DeliverablesPage from './pages/DeliverablesPage';
import SettingsPage from './pages/SettingsPage';
import Layout from './components/Layout';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:id" element={<ChatPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="governance" element={<GovernancePage />} />
        <Route path="tasks" element={<TaskManagerPage />} />
        <Route path="deliverables" element={<DeliverablesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
