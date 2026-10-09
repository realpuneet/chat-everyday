import { create } from 'zustand';

/** Auth state lives in memory only (access token is never written to localStorage). */
export const useAuth = create((set) => ({
  status: 'booting', // booting | anon | authed
  token: null,
  user: null,
  setSession: ({ accessToken, user }) => set({ status: 'authed', token: accessToken, user }),
  patchUser: (patch) => set((s) => ({ user: s.user ? { ...s.user, ...patch } : s.user })),
  clear: () => set({ status: 'anon', token: null, user: null }),
}));

export const isRegistered = (u) => u?.kind === 'registered';
export const isAdmin = (u) => u?.role === 'admin';
