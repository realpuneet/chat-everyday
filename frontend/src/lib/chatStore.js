import { create } from 'zustand';
import { emitAck } from './socket.js';

const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`);

/** Errors that mean "the server understood and refused": retrying the same text will not help. */
const PERMANENT = new Set(['VALIDATION', 'LINK_BLOCKED', 'PII_BLOCKED', 'BAD_WORD', 'TOO_LONG', 'EMPTY', 'SPAM_PATTERN', 'CONTENT_POLICY', 'NOT_IN_CHAT', 'FORBIDDEN', 'IMAGE_REJECTED', 'IMAGE_ALREADY_SENT']);

const initial = {
  phase: 'idle', // idle | searching | chatting | ended
  chatId: null,
  partner: null,
  sharedTags: [],
  messages: [],
  lastSeq: 0,
  typing: false,
  partnerStatus: 'online',
  fallback: false,
  endedReason: null,
  notice: null,
  save: 'off', // off | requested | prompt | active | declined
  rtc: 'idle', // idle | incoming | requested | active
  startedAt: null,
};

let seenSeq = new Set();
let typingTimer;

/** Merge a server message into the list, de-duplicating by seq and clientMsgId. */
export function mergeMessage(list, m) {
  const i = list.findIndex((x) => (m.clientMsgId && x.clientMsgId === m.clientMsgId) || (m.seq && x.seq === m.seq));
  if (i >= 0) {
    const next = list.slice();
    next[i] = { ...list[i], ...m, status: 'sent' };
    return next;
  }
  return [...list, { key: m.clientMsgId || `s${m.seq}`, status: 'sent', ...m }];
}

export const useChat = create((set, get) => ({
  ...initial,
  prefs: { tags: [], lang: '', genderPref: 'any' },
  error: null,

  setPrefs: (p) => set((s) => ({ prefs: { ...s.prefs, ...p } })),
  dismissNotice: () => set({ notice: null }),

  reset() {
    seenSeq = new Set();
    set({ ...initial, error: null });
  },

  async start() {
    seenSeq = new Set();
    set({ ...initial, phase: 'searching', error: null });
    try {
      await emitAck('match:start', get().prefs);
    } catch (e) {
      set({ phase: 'idle', error: e.message });
    }
  },

  async next() {
    seenSeq = new Set();
    set({ ...initial, phase: 'searching', error: null });
    try {
      await emitAck('match:next', get().prefs);
    } catch (e) {
      set({ phase: 'idle', error: e.message });
    }
  },

  async leave() {
    try {
      await emitAck('match:leave');
    } catch {
      /* already gone */
    }
    seenSeq = new Set();
    set({ ...initial, phase: 'idle' });
  },

  async send(text, { retryKey } = {}) {
    const { chatId } = get();
    if (!chatId) return;
    const clientMsgId = retryKey || newId();
    if (!retryKey) {
      set((s) => ({ messages: [...s.messages, { key: clientMsgId, clientMsgId, from: 'me', kind: 'text', text, status: 'sending', ts: Date.now() }] }));
    } else {
      set((s) => ({ messages: s.messages.map((m) => (m.key === retryKey ? { ...m, status: 'sending', error: null } : m)) }));
    }
    try {
      const ack = await emitAck('chat:send', { chatId, clientMsgId, kind: 'text', text });
      set((s) => ({ messages: s.messages.map((m) => (m.key === clientMsgId ? { ...m, status: 'sent', seq: ack.seq, ts: ack.ts, text: ack.text ?? m.text } : m)) }));
      if (ack.seq) seenSeq.add(ack.seq);
    } catch (e) {
      const permanent = PERMANENT.has(e.code);
      set((s) => ({ messages: s.messages.map((m) => (m.key === clientMsgId ? { ...m, status: permanent ? 'rejected' : 'failed', error: e.message } : m)) }));
    }
  },

  /** After a reconnect, re-send everything that never got an ack (server de-duplicates by clientMsgId). */
  retryPending() {
    get()
      .messages.filter((m) => m.from === 'me' && (m.status === 'failed' || m.status === 'sending') && m.kind === 'text')
      .forEach((m) => get().send(m.text, { retryKey: m.key }));
  },

  async sendImage(imageId) {
    const { chatId } = get();
    const clientMsgId = newId();
    try {
      const ack = await emitAck('chat:send', { chatId, clientMsgId, kind: 'image', imageId });
      return ack;
    } catch (e) {
      set({ notice: e.message });
      throw e;
    }
  },

  sendTyping(on) {
    const { chatId, phase } = get();
    if (phase !== 'chatting') return;
    emitAck('chat:typing', { chatId, on }).catch(() => {});
    clearTimeout(typingTimer);
    if (on) typingTimer = setTimeout(() => emitAck('chat:typing', { chatId, on: false }).catch(() => {}), 4000);
  },

  async report({ category, details, imageId }) {
    return emitAck('report:create', { context: 'random', chatId: get().chatId, category, details: details || '', ...(imageId ? { imageId } : {}) });
  },
  async block() {
    await emitAck('block:add', { chatId: get().chatId });
  },
  async saveRequest() {
    set({ save: 'requested' });
    try {
      await emitAck('save:request', { chatId: get().chatId });
    } catch (e) {
      set({ save: 'off', notice: e.message });
    }
  },
  async saveRespond(accept) {
    set({ savePrompt: false, save: accept ? 'active' : 'off' });
    await emitAck('save:respond', { chatId: get().chatId, accept }).catch((e) => set({ notice: e.message }));
  },
  async saveStop() {
    await emitAck('save:stop', { chatId: get().chatId }).catch(() => {});
  },

  // ----- server events -----
  onQueued: () => set((s) => (s.phase === 'idle' ? s : { phase: 'searching' })),
  onFallback: () => set({ fallback: true }),
  onTimeout: () => set({ ...initial, phase: 'idle', notice: 'No one is around right now. Try again in a moment or remove some tags.' }),
  onCancelled: () => set((s) => (s.phase === 'searching' ? { ...initial, phase: 'idle' } : s)),
  onFound(p) {
    seenSeq = new Set();
    set({ ...initial, phase: 'chatting', chatId: p.chatId, partner: p.partner, sharedTags: p.sharedTags || [], startedAt: p.startedAt, lastSeq: 0, messages: get().chatId === p.chatId ? get().messages : [] });
  },
  onMsg(m) {
    if (m.seq && seenSeq.has(m.seq)) return;
    if (m.seq) seenSeq.add(m.seq);
    set((s) => (s.chatId === m.chatId ? { messages: mergeMessage(s.messages, m), lastSeq: Math.max(s.lastSeq, m.seq || 0), typing: m.from === 'them' ? false : s.typing } : s));
  },
  onTyping: (p) => set((s) => (s.chatId === p.chatId ? { typing: p.on } : s)),
  onPartnerStatus: (p) => set((s) => (s.chatId === p.chatId ? { partnerStatus: p.status } : s)),
  onEnded: (p) => set((s) => (s.chatId === p.chatId ? { phase: p.reason === 'left' ? 'idle' : 'ended', endedReason: p.reason, typing: false, save: 'off', rtc: 'idle' } : s)),
  onSaveState: (p) => set((s) => (s.chatId === p.chatId ? { save: p.state === 'declined' ? 'declined' : p.state, savePrompt: false } : s)),
  onSavePrompt: (p) => set((s) => (s.chatId === p.chatId ? { save: 'prompt' } : s)),
  onResumed(r) {
    if (r.state === 'chatting') {
      set((s) => ({ phase: 'chatting', chatId: r.chatId, partner: r.partner || s.partner, partnerStatus: 'online' }));
      (r.events || []).forEach((e) => get().onMsg(e));
      get().retryPending();
    } else if (r.state === 'queued') {
      set({ phase: 'searching' });
    } else if (get().phase === 'chatting') {
      set({ phase: 'ended', endedReason: 'partner_disconnected' });
    } else if (get().phase === 'searching') {
      set({ phase: 'idle' });
    }
  },
  setRtc: (rtc) => set({ rtc }),
}));
