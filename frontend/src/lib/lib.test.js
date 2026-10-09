import { describe, it, expect, beforeEach } from 'vitest';
import { ageFromDob, isAdult } from './age.js';
import { jwtPayload } from './jwt.js';
import { useChat, mergeMessage } from './chatStore.js';

describe('age helpers', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  it('computes age around the birthday and rejects invalid input', () => {
    expect(ageFromDob('2008-06-15', now)).toBe(18);
    expect(ageFromDob('2008-06-16', now)).toBe(17);
    expect(ageFromDob('2030-01-01', now)).toBe(null);
    expect(ageFromDob('2001-02-30', now)).toBe(null);
    expect(isAdult('2008-06-15', now)).toBe(true);
    expect(isAdult('2008-06-16', now)).toBe(false);
  });
});

describe('jwtPayload', () => {
  it('decodes the payload without verifying and tolerates garbage', () => {
    const body = btoa(JSON.stringify({ sub: 'u1', exp: 123 })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(jwtPayload(`x.${body}.y`)).toMatchObject({ sub: 'u1', exp: 123 });
    expect(jwtPayload('nonsense')).toBe(null);
  });
});

describe('message merging', () => {
  it('replaces an optimistic message by clientMsgId and dedupes by seq', () => {
    let list = [{ key: 'c1', clientMsgId: 'c1', from: 'me', text: 'hi', status: 'sending' }];
    list = mergeMessage(list, { clientMsgId: 'c1', seq: 4, from: 'me', text: 'hi' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ seq: 4, status: 'sent' });
    list = mergeMessage(list, { seq: 5, from: 'them', text: 'yo' });
    list = mergeMessage(list, { seq: 5, from: 'them', text: 'yo' });
    expect(list).toHaveLength(2);
  });
});

describe('chat store', () => {
  beforeEach(() => useChat.getState().reset());

  it('actions stay callable after state resets (regression: `typing` state vs action name clash)', () => {
    const s = useChat.getState();
    s.onFound({ chatId: 'c1', partner: { nickname: 'X' }, sharedTags: [] });
    expect(typeof useChat.getState().sendTyping).toBe('function');
    expect(useChat.getState().phase).toBe('chatting');
    useChat.getState().onEnded({ chatId: 'c1', reason: 'partner_left' });
    expect(typeof useChat.getState().sendTyping).toBe('function');
    expect(useChat.getState().phase).toBe('ended');
  });

  it('ignores duplicate / foreign-chat messages and tracks lastSeq', () => {
    const s = useChat.getState();
    s.onFound({ chatId: 'c1', partner: { nickname: 'X' } });
    s.onMsg({ chatId: 'c1', seq: 1, from: 'them', text: 'a' });
    s.onMsg({ chatId: 'c1', seq: 1, from: 'them', text: 'a' });
    s.onMsg({ chatId: 'other', seq: 2, from: 'them', text: 'b' });
    s.onMsg({ chatId: 'c1', seq: 3, from: 'them', text: 'c' });
    const st = useChat.getState();
    expect(st.messages.map((m) => m.text)).toEqual(['a', 'c']);
    expect(st.lastSeq).toBe(3);
  });

  it('resume replays missed events once and flags a vanished chat', () => {
    const s = useChat.getState();
    s.onFound({ chatId: 'c1', partner: { nickname: 'X' } });
    s.onMsg({ chatId: 'c1', seq: 1, from: 'them', text: 'a' });
    useChat.getState().onResumed({ state: 'chatting', chatId: 'c1', partner: { nickname: 'X' }, events: [{ chatId: 'c1', seq: 1, from: 'them', text: 'a' }, { chatId: 'c1', seq: 2, from: 'them', text: 'b' }] });
    expect(useChat.getState().messages.map((m) => m.text)).toEqual(['a', 'b']);
    useChat.getState().onResumed({ state: 'idle', chatEnded: true });
    expect(useChat.getState().phase).toBe('ended');
  });

  it('search phases: fallback hint, timeout returns to idle with a notice', () => {
    useChat.setState({ phase: 'searching' });
    useChat.getState().onFallback();
    expect(useChat.getState().fallback).toBe(true);
    useChat.getState().onTimeout();
    expect(useChat.getState().phase).toBe('idle');
    expect(useChat.getState().notice).toMatch(/No one is around/);
  });
});
