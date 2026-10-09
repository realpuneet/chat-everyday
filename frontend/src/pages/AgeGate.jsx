import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { isAdult } from '../lib/age.js';
import { storeDob, clearDob } from '../lib/device.js';
import { ErrorText } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';

const LOCK_KEY = 'ce_underage_until';
const lockedUntil = () => {
  try {
    return Number(localStorage.getItem(LOCK_KEY)) || 0;
  } catch {
    return 0;
  }
};

export default function AgeGate() {
  useDocumentTitle('Age check');
  const nav = useNavigate();
  const loc = useLocation();
  const [dob, setDob] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(lockedUntil() > Date.now());

  const submit = (e) => {
    e.preventDefault();
    setErr('');
    if (!ok) return setErr('Please confirm that you are 18 or older.');
    if (!dob) return setErr('Enter your date of birth.');
    if (!isAdult(dob)) {
      // Mirrors the server-side 24h device lock; the DOB itself is never stored.
      try {
        localStorage.setItem(LOCK_KEY, String(Date.now() + 24 * 3600 * 1000));
      } catch {
        /* ignore */
      }
      clearDob();
      setBlocked(true);
      return undefined;
    }
    storeDob(dob);
    nav(loc.state?.from || '/', { replace: true });
    return undefined;
  };

  if (blocked) {
    return (
      <div className="app-vh flex flex-col items-center justify-center gap-3 px-6 text-center">
        <ShieldCheck className="h-12 w-12 text-red-400" aria-hidden="true" />
        <h1 className="h-page">Sorry, you can't use Chat Everyday</h1>
        <p className="max-w-sm text-slate-400">This service is only for people who are 18 or older.</p>
      </div>
    );
  }

  return (
    <div className="app-vh flex items-center justify-center px-4 pt-safe pb-safe">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4" aria-labelledby="age-title">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-accent-500">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 id="age-title" className="text-xl font-bold">
              18+ only
            </h1>
            <p className="text-sm text-slate-400">Chat Everyday is for adults.</p>
          </div>
        </div>
        <div>
          <label htmlFor="dob" className="label">
            Date of birth
          </label>
          <input id="dob" type="date" className="input" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} required data-autofocus autoComplete="bday" />
          <p className="mt-1 text-xs text-slate-500">Used only to check your age. It stays on your device and is not saved on our servers.</p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-white/5 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>
            I confirm that I am <strong>18 years or older</strong> and I agree to the{' '}
            <Link className="link" to="/terms" target="_blank">
              Terms
            </Link>{' '}
            and{' '}
            <Link className="link" to="/privacy" target="_blank">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        <ErrorText>{err}</ErrorText>
        <button className="btn-primary w-full">Continue</button>
        <p className="text-center text-xs text-slate-500">Strangers online can be anyone. Never share personal details, money or private photos.</p>
      </form>
    </div>
  );
}
