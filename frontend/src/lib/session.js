import { api, post, setRefresher } from './api.js';
import { useAuth } from './auth.js';
import { jwtPayload } from './jwt.js';
import { getStoredDob, setGuestToken, getGuestToken } from './device.js';
import { reauthSocket, disconnectSocket, connectSocket } from './socket.js';

let timer;
let inflight = null;

function schedule(token) {
  clearTimeout(timer);
  const exp = jwtPayload(token)?.exp;
  if (!exp) return;
  const ms = Math.max(15_000, exp * 1000 - Date.now() - 60_000);
  timer = setTimeout(() => refreshSession().catch(() => {}), Math.min(ms, 2 ** 31 - 1));
}

export function applySession(s) {
  useAuth.getState().setSession(s);
  if (s.user.kind === 'guest') setGuestToken(s.accessToken);
  else setGuestToken(null);
  schedule(s.accessToken);
  reauthSocket(s.accessToken);
}

/** Single-flight: concurrent callers share one refresh (rotating tokens must never be replayed). */
export function refreshSession() {
  inflight ||= (async () => {
    try {
      const { user } = useAuth.getState();
      const guestToken = getGuestToken();
      let s;
      if (user?.kind === 'guest') {
        s = await api('/api/auth/guest/refresh', { method: 'POST', retry: false });
      } else {
        try {
          s = await api('/api/auth/refresh', { method: 'POST', auth: false, retry: false });
        } catch (e) {
          if (!guestToken || e.status === 0) throw e;
          s = await api('/api/auth/guest/refresh', { method: 'POST', auth: false, retry: false, token: guestToken });
        }
      }
      applySession(s);
      return true;
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        useAuth.getState().clear();
        disconnectSocket();
      }
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
setRefresher(refreshSession);

export async function bootSession() {
  const ok = await refreshSession();
  if (!ok) useAuth.getState().clear();
  else connectSocket();
  return ok;
}

const ageBody = () => ({ dob: getStoredDob(), ageConfirmed: true });

export async function startGuest({ nickname, gender } = {}) {
  const s = await post('/api/auth/guest', { ...ageBody(), ...(nickname ? { nickname } : {}), ...(gender && gender !== 'undisclosed' ? { gender } : {}) }, { auth: false });
  applySession(s);
  connectSocket();
  return s;
}

async function authenticate(path, body) {
  // Sending the current (guest) bearer upgrades the guest account in place instead of creating a new one.
  const s = await post(path, body, { auth: true });
  applySession(s);
  connectSocket();
  return s;
}

export const signup = (b) => authenticate('/api/auth/signup', { ...ageBody(), ...b });
export const login = (b) => authenticate('/api/auth/login', b);
export const googleLogin = (idToken) => authenticate('/api/auth/google', { ...ageBody(), idToken });
export const phoneRequest = (phone) => post('/api/auth/phone/request', { ...ageBody(), phone }, { auth: false });
export const phoneVerify = (phone, code) => authenticate('/api/auth/phone/verify', { ...ageBody(), phone, code });

export async function logout() {
  try {
    await post('/api/auth/logout', {}, { auth: false });
  } catch {
    /* best effort */
  }
  clearTimeout(timer);
  setGuestToken(null);
  disconnectSocket();
  useAuth.getState().clear();
}
