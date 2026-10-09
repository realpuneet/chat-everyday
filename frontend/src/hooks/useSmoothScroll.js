import { useEffect } from 'react';
import Lenis from 'lenis';
import { useReducedMotion } from './hooks.js';

/** Lenis smooth scrolling for long public pages only (never inside the chat shell). Skipped for reduced-motion users. */
export function useSmoothScroll() {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return undefined;
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    let raf;
    const loop = (t) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [reduce]);
}
