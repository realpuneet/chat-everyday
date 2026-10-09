import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dices, LogOut, Smartphone, ShieldCheck, UserPlus, Ban } from 'lucide-react';
import { useAuth, isRegistered } from '../lib/auth.js';
import { get, patch, post, del } from '../lib/api.js';
import { logout } from '../lib/session.js';
import { useChat } from '../lib/chatStore.js';
import { Avatar, Field, Spinner, Toggle, ErrorText } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

const LANGS = [['', 'Not set'], ['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['es', 'Spanish']];

export default function SettingsPage() {
  useDocumentTitle('Settings');
  const nav = useNavigate();
  const user = useAuth((s) => s.user);
  const patchUser = useAuth((s) => s.patchUser);
  const [nick, setNick] = useState(user.nickname);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const registered = isRegistered(user);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => get('/api/auth/devices'), enabled: true });
  const blocks = useQuery({ queryKey: ['blocks'], queryFn: () => get('/api/blocks') });

  const save = async (body, okMsg = 'Saved') => {
    setBusy(true);
    setErr('');
    try {
      const { user: u } = await patch('/api/auth/me', body);
      patchUser(u);
      setNick(u.nickname);
      toast(okMsg, 'success');
    } catch (e) {
      setErr(e.details?.issues?.[0]?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    useChat.getState().reset();
    await logout();
    nav('/', { replace: true });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-safe pb-8 pt-safe">
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="h-page pt-4">Settings</h1>

        <section className="card" aria-labelledby="s-profile">
          <h2 id="s-profile" className="mb-3 font-semibold">
            Your identity
          </h2>
          <div className="mb-3 flex items-center gap-3">
            <Avatar avatar={user.avatar} name={user.nickname} size={52} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{user.nickname}</p>
              <p className="text-xs text-slate-400">{registered ? 'Account' : 'Guest session'}</p>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => save({ regenerateIdentity: true }, 'New random identity')} disabled={busy}>
              <Dices className="h-4 w-4" aria-hidden="true" /> Randomise
            </button>
          </div>
          <Field label="Nickname" htmlFor="nick">
            <div className="flex gap-2">
              <input id="nick" className="input" maxLength={24} value={nick} onChange={(e) => setNick(e.target.value)} />
              <button className="btn-primary shrink-0" disabled={busy || nick.trim().length < 2 || nick === user.nickname} onClick={() => save({ nickname: nick.trim() })}>
                {busy ? <Spinner /> : 'Save'}
              </button>
            </div>
          </Field>
          <ErrorText>{err}</ErrorText>
        </section>

        <section className="card" aria-labelledby="s-about">
          <h2 id="s-about" className="mb-1 font-semibold">
            About you (self-declared)
          </h2>
          <p className="mb-3 text-xs text-slate-500">Used only for gender-preference matching and to open identity rooms. We do not verify this and other people never see it.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender" htmlFor="gender">
              <select id="gender" className="input" value={user.gender} onChange={(e) => save({ gender: e.target.value })}>
                <option value="undisclosed">Prefer not to say</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="nonbinary">Non-binary</option>
              </select>
            </Field>
            <Field label="Language" htmlFor="slang">
              <select id="slang" className="input" value={user.lang || ''} onChange={(e) => save({ lang: e.target.value })}>
                {LANGS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2.5">
            <span className="text-sm">I identify as LGBTQ+ (opens the LGBTQ+ room)</span>
            <Toggle checked={!!user.lgbtq} onChange={(v) => save({ lgbtq: v })} label="Identify as LGBTQ+" />
          </div>
        </section>

        <section className="card" aria-labelledby="s-account">
          <h2 id="s-account" className="mb-2 font-semibold">
            Account
          </h2>
          {!registered ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-300">You are chatting as a guest. Create an account to keep your identity, save chats (with consent), create rooms and send more photos. Your current session carries over.</p>
              <Link to="/signup" className="btn-primary w-full">
                <UserPlus className="h-4 w-4" aria-hidden="true" /> Upgrade to an account
              </Link>
            </div>
          ) : (
            <ul className="space-y-1 text-sm text-slate-300">
              <li>Email: {user.hasEmail ? 'linked' : 'not linked'}</li>
              <li>Phone: {user.hasPhone ? 'verified' : 'not linked'}</li>
              <li>Google: {user.hasGoogle ? 'linked' : 'not linked'}</li>
              <li>Age verification level: <strong>{user.ageLevel}</strong></li>
            </ul>
          )}
          {registered && user.ageLevel !== 'strict' && <StrictAge />}
        </section>

        <section className="card" aria-labelledby="s-dev">
          <h2 id="s-dev" className="mb-2 flex items-center gap-2 font-semibold">
            <Smartphone className="h-4 w-4" aria-hidden="true" /> Connected devices
          </h2>
          {devices.isLoading ? <Spinner /> : (
            <ul className="space-y-1 text-sm text-slate-300">
              {(devices.data?.devices || []).map((d) => (
                <li key={d.socketId}>Device {d.deviceId || 'unknown'} · connected {d.since ? new Date(d.since).toLocaleTimeString() : ''}</li>
              ))}
              {!devices.data?.devices?.length && <li className="text-slate-500">No active connections.</li>}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">You can be online on several devices and tabs at once; closing one does not log you out of the others.</p>
        </section>

        <section className="card" aria-labelledby="s-safe">
          <h2 id="s-safe" className="mb-2 flex items-center gap-2 font-semibold">
            <Ban className="h-4 w-4" aria-hidden="true" /> Safety
          </h2>
          <p className="text-sm text-slate-300">People you blocked: <strong>{blocks.data?.count ?? '…'}</strong></p>
          {blocks.data?.count > 0 && (
            <button className="btn-ghost btn-sm mt-2" onClick={async () => { await del('/api/blocks'); blocks.refetch(); toast('Unblocked everyone'); }}>
              Unblock everyone
            </button>
          )}
        </section>

        <section className="card space-y-2">
          <button className="btn-ghost w-full" onClick={doLogout}>
            <LogOut className="h-4 w-4" aria-hidden="true" /> {registered ? 'Log out' : 'End guest session'}
          </button>
          {registered && (
            <button className="btn-ghost w-full text-red-300" onClick={async () => { await post('/api/auth/logout-all', {}); await doLogout(); }}>
              Log out of all devices
            </button>
          )}
          <p className="pt-2 text-center text-xs text-slate-500">
            <Link className="link" to="/terms">Terms</Link> · <Link className="link" to="/privacy">Privacy</Link> · <Link className="link" to="/grievance">Grievance</Link> · <Link className="link" to="/takedown">Takedown</Link>
          </p>
        </section>
      </div>
    </div>
  );
}

function StrictAge() {
  const [busy, setBusy] = useState(false);
  const patchUser = useAuth((s) => s.patchUser);
  const run = async () => {
    setBusy(true);
    try {
      const s = await post('/api/age/start', {});
      if (s.mode === 'redirect' && s.url) window.location.href = s.url;
      else if (s.mode === 'dryrun') {
        const r = await post('/api/age/dryrun-complete', {});
        patchUser({ ageLevel: r.ageLevel });
        toast('Dry-run verification complete', 'success');
      }
    } catch (e) {
      toast(e.message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn-ghost mt-3 w-full" onClick={run} disabled={busy}>
      {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />} Verify my age (some adult rooms may require it)
    </button>
  );
}
