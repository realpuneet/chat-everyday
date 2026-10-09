import { useEffect, useRef, useState, useCallback } from 'react';
import { Eye, EyeOff, Lock, Timer, ShieldAlert, ImageOff, X } from 'lucide-react';
import clsx from 'clsx';
import { fetchImageForView } from '../lib/images.js';
import { Spinner } from './ui.jsx';

/**
 * Deterrent-grade protected image viewer. It makes casual saving/screenshotting harder, but
 * screenshots CANNOT be reliably prevented in a web page (see Terms). Measures:
 *  - blurred / locked until the viewer taps; view-once or timer based expiry (server enforced)
 *  - pixels only live in a <canvas> (no <img>, no URL in DOM); bitmap released on close
 *  - right-click / long-press / drag disabled, user-select:none, no download control, hidden when printing
 *  - viewer-specific dynamic watermark (alias + code + time) tiled over the image
 *  - auto-blur when the tab is hidden or the window loses focus
 */
export default function SecureImage({ imageId, meta, own }) {
  const [state, setState] = useState('locked'); // locked | loading | viewing | expired | error | hidden
  const [err, setErr] = useState('');
  const [blurred, setBlurred] = useState(false);
  const [left, setLeft] = useState(0);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const canvasRef = useRef(null);
  const holder = useRef({ bitmap: null, timer: null, info: null });
  const status = meta?.status;

  const wipe = useCallback(() => {
    clearInterval(holder.current.timer);
    holder.current.bitmap?.close?.();
    holder.current.bitmap = null;
    const c = canvasRef.current;
    if (c) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      c.width = 0;
      c.height = 0;
    }
  }, []);

  useEffect(() => wipe, [wipe]);
  useEffect(() => {
    if (status === 'hidden' || status === 'removed' || status === 'rejected') {
      wipe();
      setState('hidden');
    }
  }, [status, wipe]);

  // Blur as soon as the page is hidden or loses focus (task switcher / screen-recorder overlays)
  useEffect(() => {
    if (state !== 'viewing') return undefined;
    const hide = () => setBlurred(true);
    const vis = () => document.visibilityState === 'hidden' && setBlurred(true);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
    };
  }, [state]);

  const draw = useCallback(() => {
    const { bitmap, info } = holder.current;
    const c = canvasRef.current;
    if (!bitmap || !c) return;
    const maxW = Math.min(320, c.parentElement?.clientWidth || 320);
    const ratio = bitmap.height / bitmap.width;
    const cssW = maxW;
    const cssH = Math.min(Math.round(maxW * ratio), 420);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = cssW * dpr;
    c.height = cssH * dpr;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    const s = Math.max(cssW / bitmap.width, cssH / bitmap.height);
    ctx.drawImage(bitmap, (cssW - bitmap.width * s) / 2, (cssH - bitmap.height * s) / 2, bitmap.width * s, bitmap.height * s);
    // Viewer-specific watermark, tiled and rotated
    const wm = info.watermark;
    const stamp = new Date(wm.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const label = `${wm.alias} · ${wm.code} · ${stamp}`;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.rotate(-Math.PI / 8);
    for (let y = -cssH; y < cssH * 2; y += 46) {
      for (let x = -cssW; x < cssW * 2; x += 190) {
        ctx.strokeText(label, x + ((y / 46) % 2) * 60, y);
        ctx.fillText(label, x + ((y / 46) % 2) * 60, y);
      }
    }
    ctx.restore();
  }, []);

  const open = useCallback(async () => {
    setState('loading');
    setErr('');
    try {
      const { info, bitmap } = await fetchImageForView(imageId);
      holder.current.bitmap = bitmap;
      holder.current.info = info;
      setBlurred(info.forceBlur && !own ? true : false);
      setNeedsConfirm(false);
      setState('viewing');
      requestAnimationFrame(draw);
      if (!own) {
        let remaining = info.timerSec || 10;
        setLeft(remaining);
        holder.current.timer = setInterval(() => {
          remaining -= 1;
          setLeft(remaining);
          if (remaining <= 0) {
            wipe();
            setState('expired');
          }
        }, 1000);
      }
    } catch (e) {
      wipe();
      if (e.status === 410) setState('expired');
      else {
        setErr(e.message || 'Could not open image');
        setState('error');
      }
    }
  }, [imageId, own, draw, wipe]);

  const close = () => {
    wipe();
    setState(meta?.viewMode === 'once' && !own ? 'expired' : 'locked');
  };

  const block = (e) => e.preventDefault();
  const mode = meta?.viewMode === 'once' ? 'View once' : `Timer ${meta?.timerSec || 10}s`;

  if (state === 'hidden') {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-bg-raised px-3.5 py-3 text-sm text-slate-400">
        <ImageOff className="h-4 w-4" aria-hidden="true" /> Image removed by moderation
      </div>
    );
  }

  if (state === 'viewing') {
    return (
      <div className="secure-surface relative overflow-hidden rounded-2xl bg-black" onContextMenu={block} onDragStart={block} onCopy={block} onCut={block}>
        <canvas ref={canvasRef} draggable={false} aria-label="Protected image" role="img" className={clsx('block transition-[filter]', blurred && 'blur-2xl')} />
        {blurred && (
          <button
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/30 text-sm font-medium text-white"
            onClick={() => (holder.current.info?.forceBlur && !own && !needsConfirm ? setNeedsConfirm(true) : setBlurred(false))}
          >
            <EyeOff className="h-6 w-6" aria-hidden="true" />
            {needsConfirm ? 'Tap again to confirm: this may contain adult content' : holder.current.info?.forceBlur ? 'Possible adult content · tap to reveal' : 'Hidden while you were away · tap to show'}
          </button>
        )}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent px-2 py-1 text-[11px] text-white">
          <span className="inline-flex items-center gap-1">
            <Timer className="h-3 w-3" aria-hidden="true" /> {own ? 'Your photo' : `${left}s left`}
          </span>
          <button onClick={close} aria-label="Close image" className="rounded-full bg-black/40 p-1">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const label =
    state === 'loading' ? (
      <>
        <Spinner /> Opening…
      </>
    ) : state === 'expired' ? (
      <>
        <Lock className="h-4 w-4" aria-hidden="true" /> {meta?.viewMode === 'once' ? 'Opened · view-once photo' : 'Photo expired'}
      </>
    ) : state === 'error' ? (
      <>
        <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" /> {err} · tap to retry
      </>
    ) : (
      <>
        <Eye className="h-4 w-4" aria-hidden="true" /> {own ? 'Your photo' : 'Tap to reveal'} · {mode}
      </>
    );

  return (
    <button
      onClick={open}
      disabled={state === 'loading' || state === 'expired'}
      className={clsx('secure-surface relative flex h-36 w-56 flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border border-white/10 text-sm text-slate-200 transition', state === 'expired' ? 'bg-bg-raised opacity-60' : 'bg-gradient-to-br from-brand-700/40 to-accent-500/30 hover:brightness-110')}
      aria-label={own ? 'Open your sent photo' : 'Reveal photo'}
    >
      <span className="absolute inset-0 backdrop-blur-xl" aria-hidden="true" />
      <span className="relative flex items-center gap-1.5 font-medium">{label}</span>
      {state !== 'expired' && <span className="relative px-3 text-center text-[10px] text-slate-400">Screenshots can't be reliably blocked on the web</span>}
    </button>
  );
}
