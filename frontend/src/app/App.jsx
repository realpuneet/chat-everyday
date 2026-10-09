import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, isAdmin } from '../lib/auth.js';
import { bootSession } from '../lib/session.js';
import { getStoredDob } from '../lib/device.js';
import { useNet } from '../lib/socket.js';
import Layout from '../components/Layout.jsx';
import { ToastHost, Spinner } from '../components/ui.jsx';
import AgeGate from '../pages/AgeGate.jsx';
import Landing from '../pages/Landing.jsx';
import AuthPage from '../pages/AuthPage.jsx';
import ChatPage from '../pages/ChatPage.jsx';
import RoomsPage from '../pages/RoomsPage.jsx';
import RoomPage from '../pages/RoomPage.jsx';
import SettingsPage from '../pages/SettingsPage.jsx';
import SavedChats from '../pages/SavedChats.jsx';
import AdminPage from '../pages/AdminPage.jsx';
import { Terms, Privacy, Grievance, Takedown } from '../pages/Legal.jsx';
import BannedScreen from '../pages/BannedScreen.jsx';

function RequireAge({ children }) {
  const loc = useLocation();
  if (!getStoredDob()) return <Navigate to="/age" replace state={{ from: loc.pathname }} />;
  return children;
}

function RequireAuth({ children, admin }) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  if (status === 'booting') return <Splash />;
  if (status !== 'authed') return <Navigate to="/" replace />;
  if (admin && !isAdmin(user)) return <Navigate to="/chat" replace />;
  return children;
}

function Splash() {
  return (
    <div className="app-vh flex items-center justify-center" role="status" aria-label="Loading">
      <Spinner className="h-6 w-6 text-brand-400" />
    </div>
  );
}

export default function App() {
  const status = useAuth((s) => s.status);
  const terminated = useNet((s) => s.terminated);

  useEffect(() => {
    bootSession();
  }, []);

  if (terminated) return <BannedScreen info={terminated} />;
  return (
    <>
      <Routes>
        <Route path="/age" element={<AgeGate />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/grievance" element={<Grievance />} />
        <Route path="/takedown" element={<Takedown />} />
        <Route path="/" element={status === 'booting' ? <Splash /> : status === 'authed' ? <Navigate to="/chat" replace /> : <RequireAge><Landing /></RequireAge>} />
        <Route path="/login" element={<RequireAge><AuthPage mode="login" /></RequireAge>} />
        <Route path="/signup" element={<RequireAge><AuthPage mode="signup" /></RequireAge>} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/:id" element={<RoomPage />} />
          <Route path="/saved" element={<SavedChats />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </>
  );
}
