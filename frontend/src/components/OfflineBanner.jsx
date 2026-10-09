import { WifiOff, RefreshCw } from 'lucide-react';
import { useNet } from '../lib/socket.js';
import { useAuth } from '../lib/auth.js';
import { useOnline } from '../hooks/hooks.js';

/** Shows when the browser is offline or the socket is reconnecting. Messages are queued and retried automatically. */
export default function OfflineBanner() {
  const { status, everConnected, shuttingDown } = useNet();
  const authed = useAuth((s) => s.status === 'authed');
  const browserOnline = useOnline();
  if (!authed) return null;
  if (browserOnline && status === 'online' && !shuttingDown) return null;
  if (status === 'connecting' && !everConnected && browserOnline) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200 pt-safe">
      {browserOnline ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />}
      {!browserOnline ? 'You are offline. Messages will send when you reconnect.' : shuttingDown ? 'Server is restarting, reconnecting…' : 'Reconnecting…'}
    </div>
  );
}
