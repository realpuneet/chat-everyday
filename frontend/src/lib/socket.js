import { io } from 'socket.io-client';
import { create } from 'zustand';
import { useAuth } from './auth.js';
import { getDeviceId, getFingerprint } from './device.js';

const URL = import.meta.env.VITE_SOCKET_URL || undefined;

/** Connection / presence state shown in the UI (offline banner, live online count). */
export const useNet = create((set) => ({
  status: 'offline', // offline | connecting | online
  online: 0,
  everConnected: false,
  terminated: null, // { reason, permanent, until }
  shuttingDown: false,
  set: (p) => set(p),
}));

let socket = null;
const wiring = [];
/** wire.js registers a function that attaches all event handlers on a fresh socket. */
export const onSocketCreated = (fn) => wiring.push(fn);
export const getSocket = () => socket;

export function connectSocket() {
  if (socket) {
    if (!socket.connected && !socket.active) socket.connect();
    return socket;
  }
  useNet.getState().set({ status: 'connecting', terminated: null });
  socket = io(URL, {
    path: '/socket.io',
    transports: ['websocket'],
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
    randomizationFactor: 0.5,
    auth: (cb) => {
      getFingerprint().then((fp) => cb({ token: useAuth.getState().token, deviceId: getDeviceId(), fp }));
    },
  });
  socket.on('connect', () => useNet.getState().set({ status: 'online', everConnected: true }));
  socket.on('disconnect', (reason) => {
    useNet.getState().set({ status: reason === 'io client disconnect' ? 'offline' : 'connecting' });
  });
  socket.on('connect_error', async (err) => {
    useNet.getState().set({ status: 'connecting' });
    const code = err?.data?.code;
    if (code === 'BANNED') {
      useNet.getState().set({ terminated: { reason: 'banned', ...(err.data.details || {}) } });
      socket.disconnect();
    } else if (code === 'UNAUTHORIZED') {
      // Token expired while offline: refresh through session.js (lazy import avoids a cycle) and retry.
      const { refreshSession } = await import('./session.js');
      if (await refreshSession()) socket.connect();
    }
  });
  socket.on('presence:online', ({ count }) => useNet.getState().set({ online: count }));
  socket.on('session:ready', ({ online }) => useNet.getState().set({ online }));
  socket.on('server:shutdown', () => useNet.getState().set({ shuttingDown: true }));
  socket.on('session:terminated', (p) => {
    if (p.reason === 'banned') {
      useNet.getState().set({ terminated: p });
      socket.disconnect();
    } else if (p.reason === 'token_expired') {
      import('./session.js').then((m) => m.refreshSession().then((ok) => ok && socket.connect()));
    }
  });
  wiring.forEach((fn) => fn(socket));
  socket.connect();
  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  useNet.getState().set({ status: 'offline' });
}

/** Swap the token on a live connection (no reconnect): used after refresh and guest -> account upgrade. */
export function reauthSocket(token) {
  if (socket?.connected) socket.emit('auth:refresh', { token }, () => {});
}

/** Emit with ack + timeout. Rejects with {code} so callers can show typed errors. */
export function emitAck(event, data = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(Object.assign(new Error('You are offline'), { code: 'OFFLINE' }));
    const t = setTimeout(() => reject(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' })), timeoutMs);
    socket.emit(event, data, (res) => {
      clearTimeout(t);
      if (res?.ok) resolve(res);
      else reject(Object.assign(new Error(res?.error?.message || 'Request failed'), { code: res?.error?.code || 'ERROR', details: res?.error?.details }));
    });
  });
}
