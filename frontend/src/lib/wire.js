import { onSocketCreated, emitAck, useNet } from './socket.js';
import { useChat } from './chatStore.js';
import { useRooms } from './roomStore.js';
import { resolveImageStatus } from './images.js';
import { toast } from './toast.js';
import { create } from 'zustand';

/** Admin pushes (queue badge) */
export const useAdminLive = create((set) => ({ reports: 0, takedowns: 0, bump: (k) => set((s) => ({ [k]: s[k] + 1 })), reset: () => set({ reports: 0, takedowns: 0 }) }));

/** Video-call signalling events are consumed by the VideoPanel component through this tiny bus. */
export const rtcBus = new EventTarget();

let first = true;

onSocketCreated((socket) => {
  const chat = () => useChat.getState();
  const rooms = () => useRooms.getState();

  // `session:ready` (not `connect`) is the signal that the server finished registering this socket.
  socket.on('session:ready', async () => {
    const c = chat();
    // A fresh page load has no chatId: ask the server whether this user is already in a chat (reload, 2nd device).
    try {
      const r = await emitAck('chat:resume', { ...(c.chatId ? { chatId: c.chatId } : {}), lastSeq: c.chatId ? c.lastSeq : 0 });
      if (r.state === 'chatting' || c.phase === 'chatting' || c.phase === 'searching') c.onResumed(r);
    } catch {
      /* will retry on the next connect */
    }
    rooms().resumeAll();
    if (!first) toast('Back online', 'success');
    first = false;
  });
  socket.on('room:rejoined', () => rooms().resumeAll());

  socket.on('match:queued', () => chat().onQueued());
  socket.on('match:fallback', () => chat().onFallback());
  socket.on('match:timeout', () => chat().onTimeout());
  socket.on('match:cancelled', () => chat().onCancelled());
  socket.on('match:found', (p) => chat().onFound(p));
  socket.on('chat:msg', (m) => chat().onMsg(m));
  socket.on('chat:typing', (p) => chat().onTyping(p));
  socket.on('chat:partner_status', (p) => chat().onPartnerStatus(p));
  socket.on('chat:ended', (p) => chat().onEnded(p));
  socket.on('save:prompt', (p) => chat().onSavePrompt(p));
  socket.on('save:state', (p) => chat().onSaveState(p));

  socket.on('room:msgs', (p) => rooms().onMsgs(p));
  socket.on('room:presence', (p) => rooms().onPresence(p));
  socket.on('room:typing', (p) => rooms().onTyping(p));
  socket.on('room:rules', (p) => rooms().onRules(p));
  socket.on('room:role', (p) => rooms().onRole(p));
  socket.on('room:kicked', (p) => rooms().onKicked(p));
  socket.on('room:muted', (p) => {
    rooms().onMuted(p);
    toast(`You were muted for ${p.minutes} min`, 'warn');
  });
  socket.on('room:unmuted', (p) => rooms().onUnmuted(p));
  socket.on('room:closed', (p) => rooms().onClosed(p));

  socket.on('image:status', resolveImageStatus);
  socket.on('image:hidden', (p) => rooms().onImageHidden(p));
  socket.on('image:viewed', () => toast('Your image was opened', 'info'));
  socket.on('moderation:warning', (p) => toast(p.message, 'warn', 9000));

  for (const ev of ['rtc:incoming', 'rtc:accepted', 'rtc:declined', 'rtc:signal', 'rtc:ended']) {
    socket.on(ev, (p) => rtcBus.dispatchEvent(new CustomEvent(ev, { detail: p })));
  }

  socket.on('admin:report', () => useAdminLive.getState().bump('reports'));
  socket.on('admin:takedown', () => useAdminLive.getState().bump('takedowns'));

  const ping = setInterval(() => socket.connected && socket.emit('presence:ping', {}, () => {}), 25_000);
  socket.on('disconnect', () => {
    if (useNet.getState().status === 'offline') clearInterval(ping);
  });
});
