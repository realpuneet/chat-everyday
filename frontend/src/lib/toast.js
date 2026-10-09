import { create } from 'zustand';

let n = 0;
export const useToasts = create((set) => ({
  items: [],
  push(text, kind = 'info', ms = 4500) {
    const id = ++n;
    set((s) => ({ items: [...s.items.slice(-3), { id, text, kind }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), ms);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = (text, kind) => useToasts.getState().push(text, kind);
