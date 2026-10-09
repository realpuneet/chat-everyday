import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Phone, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { signup, login, googleLogin, phoneRequest, phoneVerify } from '../lib/session.js';
import { useAuth } from '../lib/auth.js';
import { Field, ErrorText, Spinner } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';

const GOOGLE_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const DRYRUN = import.meta.env.VITE_DRYRUN === 'true' || import.meta.env.DEV;

const errText = (e) =>
  ({ BAD_CREDENTIALS: 'Incorrect email or password.', EMAIL_TAKEN: 'An account with this email already exists. Try logging in.', UNDERAGE: 'You must be 18+ to use this service.', AGE_BLOCKED: 'You must be 18+ to use this service.', OTP_INVALID: 'Incorrect code.', OTP_EXPIRED: 'That code expired. Request a new one.', COUNTRY_NOT_ALLOWED: 'Phone numbers from this country are not supported yet.', TOTP_REQUIRED: 'Enter your two-factor code.', BANNED: 'This account or device is restricted.' })[e.code] || e.message;

function GoogleButton({ onToken }) {
  const ref = useRef(null);
  const [dry, setDry] = useState('');
  useEffect(() => {
    if (!GOOGLE_ID) return undefined;
    let cancelled = false;
    const init = () => {
      if (cancelled || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({ client_id: GOOGLE_ID, callback: (r) => onToken(r.credential) });
      window.google.accounts.id.renderButton(ref.current, { theme: 'filled_black', size: 'large', width: 300, text: 'continue_with' });
    };
    if (window.google?.accounts?.id) init();
    else {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = init;
      document.head.appendChild(s);
    }
    return () => {
      cancelled = true;
    };
  }, [onToken]);

  if (GOOGLE_ID) return <div ref={ref} className="flex justify-center" />;
  if (!DRYRUN) return <p className="text-center text-sm text-slate-500">Google sign-in is not configured.</p>;
  return (
    <div className="rounded-xl border border-dashed border-white/15 p-3">
      <p className="mb-2 text-xs text-amber-300">Dry-run Google sign-in (no GOOGLE_CLIENT_ID configured)</p>
      <div className="flex gap-2">
        <input className="input" type="email" placeholder="you@example.com" value={dry} onChange={(e) => setDry(e.target.value)} aria-label="Dry-run Google email" />
        <button className="btn-ghost shrink-0" disabled={!dry} onClick={() => onToken(`dryrun:${dry}`)}>
          Continue
        </button>
      </div>
    </div>
  );
}

export default function AuthPage({ mode: initial }) {
  const [mode, setMode] = useState(initial);
  const [tab, setTab] = useState('email');
  useDocumentTitle(mode === 'login' ? 'Log in' : 'Sign up');
  const nav = useNavigate();
  const wasGuest = useAuth((s) => s.user?.kind === 'guest');
  const [f, setF] = useState({ email: '', password: '', nickname: '', totp: '' });
  const [need2fa, setNeed2fa] = useState(false);
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(null);
  const [cool, setCool] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    if (cool <= 0) return undefined;
    const t = setTimeout(() => setCool(cool - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);

  const run = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      nav('/chat', { replace: true });
    } catch (e) {
      if (e.code === 'TOTP_REQUIRED') setNeed2fa(true);
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = (e) => {
    e.preventDefault();
    run(() => (mode === 'signup' ? signup({ email: f.email, password: f.password, ...(f.nickname ? { nickname: f.nickname } : {}) }) : login({ email: f.email, password: f.password, ...(f.totp ? { totp: f.totp } : {}) })));
  };

  const sendCode = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await phoneRequest(phone.replace(/\s/g, ''));
      setSent(r);
      setCool(r.cooldownSec || 30);
    } catch (ex) {
      setErr(errText(ex));
      if (ex.details?.retryAfterSec) setCool(ex.details.retryAfterSec);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-vh overflow-y-auto px-4 pb-safe pt-safe">
      <div className="mx-auto w-full max-w-md py-8">
        <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Link>
        <div className="card">
          <h1 className="h-page mb-1">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          {wasGuest && mode === 'signup' && <p className="mb-2 text-sm text-emerald-400">Your current guest session will be upgraded.</p>}
          <p className="mb-4 text-sm text-slate-400">{mode === 'login' ? 'Log in to continue.' : 'Save chats, create rooms, send more photos.'}</p>

          <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-bg-soft p-1" role="tablist">
            {[
              ['email', 'Email', Mail],
              ['phone', 'Phone', Phone],
            ].map(([k, label, Icon]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => (setTab(k), setErr(''))} className={clsx('btn !py-2', tab === k ? 'bg-bg-raised text-white' : 'text-slate-400')}>
                <Icon className="h-4 w-4" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>

          {tab === 'email' && (
            <form onSubmit={submitEmail} noValidate>
              <Field label="Email" htmlFor="email">
                <input id="email" className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} data-autofocus />
              </Field>
              <Field label="Password" htmlFor="pw" hint={mode === 'signup' ? 'At least 10 characters' : undefined}>
                <input id="pw" className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 10 : 1} value={f.password} onChange={set('password')} />
              </Field>
              {mode === 'signup' && (
                <Field label="Nickname (optional)" htmlFor="nn">
                  <input id="nn" className="input" maxLength={24} value={f.nickname} onChange={set('nickname')} />
                </Field>
              )}
              {need2fa && (
                <Field label="Two-factor code" htmlFor="totp">
                  <input id="totp" className="input" inputMode="numeric" pattern="\d{6}" maxLength={6} value={f.totp} onChange={set('totp')} />
                </Field>
              )}
              <button className="btn-primary w-full" disabled={busy}>
                {busy ? <Spinner /> : mode === 'login' ? 'Log in' : 'Sign up'}
              </button>
            </form>
          )}

          {tab === 'phone' && (
            <div>
              <form onSubmit={sendCode}>
                <Field label="Phone number" htmlFor="ph" hint="International format, e.g. +919876543210. We store only a hash.">
                  <input id="ph" className="input" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
                <button className="btn-ghost w-full" disabled={busy || cool > 0}>
                  {busy && !sent ? <Spinner /> : cool > 0 ? `Resend in ${cool}s` : sent ? 'Resend code' : 'Send code'}
                </button>
              </form>
              {sent && (
                <form
                  className="mt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => phoneVerify(phone.replace(/\s/g, ''), code));
                  }}
                >
                  <Field label="6-digit code" htmlFor="otp" hint={sent.devCode && DRYRUN ? `Dry-run mode: your code is ${sent.devCode}` : undefined}>
                    <input id="otp" className="input tracking-[.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} data-autofocus />
                  </Field>
                  <button className="btn-primary w-full" disabled={busy || code.length !== 6}>
                    {busy ? <Spinner /> : 'Verify & continue'}
                  </button>
                </form>
              )}
            </div>
          )}

          <ErrorText>{err}</ErrorText>

          <div className="my-4 flex items-center gap-3 text-xs text-slate-500">
            <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
          </div>
          <GoogleButton onToken={(t) => run(() => googleLogin(t))} />

          <p className="mt-5 text-center text-sm text-slate-400">
            {mode === 'login' ? (
              <>
                New here?{' '}
                <button className="link" onClick={() => setMode('signup')}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button className="link" onClick={() => setMode('login')}>
                  Log in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
