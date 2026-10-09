import { create } from 'zustand';
import { emitAck } from './socket.js';
import { mergeMessage } from './chatStore.js';

const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`);
const PERMANENT = new Set(['VALIDATION', 'LINK_BLOCKED', 'PII_BLOCKED', 'BAD_WORD', 'TOO_LONG', 'EMPTY', 'SPAM_PATTERN', 'CONTENT_POLICY', 'MUTED', 'NOT_IN_ROOM', 'FORBIDDEN', 'RATE_LIMITED']);

const seen = new Map(); // roomId -> Set(seq)
const seenFor = (id) => seen.get(id) || seen.set(id, new Set()).get(id);

/** State for every room the user is currently in (a user can sit in several rooms at once). */
export const useRooms = create((set, get) => ({
  joined: {},
  notice: null,

  patch(roomId, fn) {
    set((s) => (s.joined[roomId] ? { joined: { ...s.joined, [roomId]: { ...s.joined[roomId], ...fn(s.joined[roomId]) } } } : s));
  },

  async join({ roomId, inviteCode }) {
    const res = await emitAck('room:join', { ...(roomId ? { roomId } : {}), ...(inviteCode ? { inviteCode } : {}) });
    const id = res.room.id;
    seen.set(id, new Set((res.recent || []).map((m) => m.seq)));
    set((s) => ({
      joined: {
        ...s.joined,
        [id]: {
          room: res.room,
          me: res.me,
          members: res.members,
          messages: (res.recent || []).map((m) => ({ key: `s${m.seq}`, status: 'sent', ...m })),
          lastSeq: res.seq || 0,
          typing: {},
          blocked: res.blockedMemberIds || [],
          count: res.room.members,
          slowUntil: res.slowRemainingSec ? Date.now() + res.slowRemainingSec * 1000 : 0,
          muted: false,
          closed: null,
        },
      },
    }));
    return res;
  },

  async leave(roomId) {
    await emitAck('room:leave', { roomId }).catch(() => {});
    seen.delete(roomId);
    set((s) => {
      const { [roomId]: _gone, ...rest } = s.joined;
      return { joined: rest };
    });
  },

  async send(roomId, text, { retryKey } = {}) {
    const clientMsgId = retryKey || newId();
    const me = get().joined[roomId]?.me;
    if (!retryKey) {
      get().patch(roomId, (r) => ({ messages: [...r.messages, { key: clientMsgId, clientMsgId, memberId: me?.memberId, alias: me?.alias, avatar: me?.avatar, role: me?.role, mine: true, kind: 'text', text, status: 'sending', ts: Date.now() }] }));
    } else {
      get().patch(roomId, (r) => ({ messages: r.messages.map((m) => (m.key === retryKey ? { ...m, status: 'sending', error: null } : m)) }));
    }
    try {
      const ack = await emitAck('room:send', { roomId, clientMsgId, kind: 'text', text });
      if (ack.seq) seenFor(roomId).add(ack.seq);
      get().patch(roomId, (r) => ({
        messages: r.messages.map((m) => (m.key === clientMsgId ? { ...m, status: 'sent', seq: ack.seq, ts: ack.ts, text: ack.text ?? m.text } : m)),
        lastSeq: Math.max(r.lastSeq, ack.seq || 0),
      }));
    } catch (e) {
      if (e.code === 'RATE_LIMITED' && e.details?.retryAfterSec) get().patch(roomId, () => ({ slowUntil: Date.now() + e.details.retryAfterSec * 1000 }));
      get().patch(roomId, (r) => ({ messages: r.messages.map((m) => (m.key === clientMsgId ? { ...m, status: PERMANENT.has(e.code) ? 'rejected' : 'failed', error: e.message } : m)) }));
    }
  },

  retryPending() {
    for (const [roomId, r] of Object.entries(get().joined)) {
      r.messages.filter((m) => m.mine && ['failed', 'sending'].includes(m.status) && m.kind === 'text').forEach((m) => get().send(roomId, m.text, { retryKey: m.key }));
    }
  },

  typing(roomId, on) {
    emitAck('room:typing', { roomId, on }).catch(() => {});
  },
  async mod(roomId, body) {
    return emitAck('room:mod', { roomId, ...body });
  },
  async report(roomId, memberId, category, details = '') {
    return emitAck('report:create', { context: 'room', roomId, memberId, category, details });
  },
  async block(roomId, memberId) {
    await emitAck('block:add', { roomId, memberId });
    get().patch(roomId, (r) => ({ blocked: [...new Set([...r.blocked, memberId])] }));
  },

  // ----- server events -----
  onMsgs({ roomId, msgs }) {
    const known = seenFor(roomId);
    get().patch(roomId, (r) => {
      let list = r.messages;
      let last = r.lastSeq;
      for (const m of msgs) {
        if (m.seq && known.has(m.seq)) continue;
        if (m.seq) known.add(m.seq);
        list = mergeMessage(list, { ...m, mine: m.memberId === r.me?.memberId });
        last = Math.max(last, m.seq || 0);
      }
      return { messages: list.length > 400 ? list.slice(-400) : list, lastSeq: last };
    });
  },
  onPresence({ roomId, joined = [], left = [], count }) {
    get().patch(roomId, (r) => {
      const byId = new Map(r.members.map((m) => [m.memberId, m]));
      joined.forEach((m) => byId.set(m.memberId, m));
      left.forEach((id) => byId.delete(id));
      return { members: [...byId.values()], count: count ?? byId.size };
    });
  },
  onTyping({ roomId, memberId, on }) {
    get().patch(roomId, (r) => {
      const typing = { ...r.typing };
      if (on) typing[memberId] = Date.now();
      else delete typing[memberId];
      return { typing };
    });
  },
  onRules: ({ roomId, rules }) => get().patch(roomId, (r) => ({ room: { ...r.room, rules } })),
  onRole: ({ roomId, memberId, role }) =>
    get().patch(roomId, (r) => ({ members: r.members.map((m) => (m.memberId === memberId ? { ...m, role } : m)), me: r.me.memberId === memberId ? { ...r.me, role } : r.me })),
  onKicked: ({ roomId }) => {
    seen.delete(roomId);
    set((s) => {
      const { [roomId]: _g, ...rest } = s.joined;
      return { joined: rest, notice: 'You were removed from the room by a moderator.' };
    });
  },
  onMuted: ({ roomId, minutes }) => get().patch(roomId, () => ({ muted: Date.now() + minutes * 60_000 })),
  onUnmuted: ({ roomId }) => get().patch(roomId, () => ({ muted: false })),
  onClosed: ({ roomId, reason }) => get().patch(roomId, () => ({ closed: reason || 'closed' })),
  onImageHidden: ({ imageId }) =>
    set((s) => ({
      joined: Object.fromEntries(Object.entries(s.joined).map(([id, r]) => [id, { ...r, messages: r.messages.map((m) => (m.imageId === imageId ? { ...m, image: { ...m.image, status: 'hidden' } } : m)) }])),
    })),

  /** After reconnect: sockets re-attach server-side; we only need to replay what we missed. */
  async resumeAll() {
    for (const [roomId, r] of Object.entries(get().joined)) {
      try {
        const res = await emitAck('room:resume', { roomId, lastSeq: r.lastSeq });
        if (res.state === 'not_member') {
          await get().join({ roomId }).catch(() => get().patch(roomId, () => ({ closed: 'left' })));
        } else {
          get().onMsgs({ roomId, msgs: res.events || [] });
          get().patch(roomId, () => ({ count: res.count }));
        }
      } catch {
        /* next reconnect will retry */
      }
    }
    get().retryPending();
  },
}));
