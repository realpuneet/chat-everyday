import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { X, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { useToasts } from '../lib/toast.js';

export function Spinner({ className }) {
  return <Loader2 className={clsx('h-4 w-4 animate-spin', className)} aria-hidden="true" />;
}

export function Avatar({ avatar, name, size = 40, className }) {
  const emoji = avatar?.emoji || (name ? name[0].toUpperCase() : '?');
  return (
    <span
      className={clsx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-slate-900', className)}
      style={{ width: size, height: size, background: avatar?.color || '#64748b', fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}

/** Accessible modal: focus moves in, Escape closes, focus returns to the opener. */
export function Modal({ open, onClose, title, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const el = ref.current;
    el?.querySelector('[data-autofocus], input, textarea, select, button')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const [first, last] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={clsx('max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-white/10 bg-bg-card p-5 pb-safe shadow-2xl sm:rounded-3xl', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close dialog">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <div className="mb-3">
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-white/15')}
    >
      <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

export function ErrorText({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-red-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

const ICONS = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: AlertTriangle };
export function ToastHost() {
  const { items, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3 pt-safe" aria-live="polite">
      {items.map((t) => {
        const Icon = ICONS[t.kind] || Info;
        return (
          <div key={t.id} className={clsx('pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm shadow-xl', t.kind === 'warn' || t.kind === 'error' ? 'border-amber-500/30 bg-amber-950/90 text-amber-100' : 'border-white/10 bg-bg-raised text-slate-100')}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t.text}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="ml-1 opacity-60 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-slate-400">
      {Icon && <Icon className="h-10 w-10 text-slate-600" aria-hidden="true" />}
      <p className="font-medium text-slate-300">{title}</p>
      {children && <p className="max-w-sm text-sm">{children}</p>}
    </div>
  );
}
