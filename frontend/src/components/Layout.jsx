import { NavLink, Outlet } from 'react-router-dom';
import { MessageCircle, Users, Bookmark, Settings, Shield, Radio } from 'lucide-react';
import clsx from 'clsx';
import { useAuth, isAdmin, isRegistered } from '../lib/auth.js';
import { useNet } from '../lib/socket.js';
import { useAdminLive } from '../lib/wire.js';
import OfflineBanner from './OfflineBanner.jsx';

/** App shell: bottom tab bar on phones, left rail on larger screens. Uses dynamic viewport height. */
export default function Layout() {
  const user = useAuth((s) => s.user);
  const online = useNet((s) => s.online);
  const pending = useAdminLive((s) => s.reports + s.takedowns);
  const items = [
    { to: '/chat', icon: MessageCircle, label: 'Chat' },
    { to: '/rooms', icon: Users, label: 'Rooms' },
    ...(isRegistered(user) ? [{ to: '/saved', icon: Bookmark, label: 'Saved' }] : []),
    { to: '/settings', icon: Settings, label: 'Me' },
    ...(isAdmin(user) ? [{ to: '/admin', icon: Shield, label: 'Admin', badge: pending }] : []),
  ];
  return (
    <div className="app-vh flex flex-col md:flex-row">
      <nav aria-label="Main" className="order-2 flex shrink-0 justify-around border-t border-white/5 bg-bg-soft pb-safe md:order-1 md:w-20 md:flex-col md:justify-start md:gap-2 md:border-r md:border-t-0 md:pt-6">
        <div className="hidden items-center justify-center pb-3 md:flex" title={`${online} online`}>
          <Radio className="h-5 w-5 text-emerald-400" aria-hidden="true" />
        </div>
        {items.map(({ to, icon: Icon, label, badge }) => (
          <NavLink key={to} to={to} className={({ isActive }) => clsx('relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium md:flex-none md:py-3', isActive ? 'text-brand-400' : 'text-slate-400 hover:text-slate-200')}>
            <Icon className="h-5 w-5" aria-hidden="true" />
            {label}
            {badge > 0 && <span className="absolute right-[28%] top-1.5 rounded-full bg-accent-500 px-1.5 text-[10px] text-white">{badge}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
        <OfflineBanner />
        <main className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
