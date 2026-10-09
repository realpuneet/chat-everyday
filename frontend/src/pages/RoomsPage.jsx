import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, Lock, Flame, Plus, KeyRound, Hash } from 'lucide-react';
import { get, post } from '../lib/api.js';
import { useRooms } from '../lib/roomStore.js';
import { useAuth, isRegistered } from '../lib/auth.js';
import { Modal, Field, ErrorText, Spinner, Empty, Toggle } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

const SECTIONS = [
  ['identity', 'Identity rooms', 'Based on what people declare in their profile. Not verified.'],
  ['interest', 'Interest rooms', null],
  ['custom', 'Community rooms', null],
];

const JOIN_HELP = {
  IDENTITY_MISMATCH: 'This room is for people who self-identify for it. Update your profile in Settings.',
  SIGNUP_REQUIRED: 'Log in or sign up to join this room.',
  AGE_LEVEL_TOO_LOW: 'Verify your phone number or sign in with Google (Settings) to join adult rooms.',
  ROOM_FULL: 'This room is full right now.',
  KICKED: 'You were removed from this room recently. Try again in a few minutes.',
};

export default function RoomsPage() {
  useDocumentTitle('Rooms');
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const join = useRooms((s) => s.join);
  const { data, isLoading, refetch } = useQuery({ queryKey: ['rooms'], queryFn: () => get('/api/rooms'), refetchInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const enter = async (arg, key) => {
    setBusy(key);
    setErr('');
    try {
      const res = await join(arg);
      nav(`/rooms/${res.room.id}`);
    } catch (e) {
      const msg = JOIN_HELP[e.code] || e.message;
      toast(msg, 'warn');
      setErr(msg);
    } finally {
      setBusy('');
    }
  };

  const rooms = data?.rooms || [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-safe pb-6 pt-safe">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between py-4">
          <h1 className="h-page">Rooms</h1>
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => setCodeOpen(true)}>
              <KeyRound className="h-4 w-4" aria-hidden="true" /> Invite code
            </button>
            <button className="btn-primary btn-sm" onClick={() => (isRegistered(user) ? setCreating(true) : toast('Sign up to create a room', 'warn'))}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Create
            </button>
          </div>
        </div>
        <ErrorText>{err}</ErrorText>
        {isLoading && (
          <div className="py-10 text-center">
            <Spinner className="mx-auto h-6 w-6" />
          </div>
        )}
        {!isLoading && !rooms.length && <Empty icon={Users} title="No rooms yet">Create the first one.</Empty>}
        {SECTIONS.map(([type, title, note]) => {
          const list = rooms.filter((r) => r.type === type);
          if (!list.length) return null;
          return (
            <section key={type} className="mb-6" aria-labelledby={`sec-${type}`}>
              <h2 id={`sec-${type}`} className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                {title}
              </h2>
              {note && <p className="mb-2 text-xs text-slate-500">{note}</p>}
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {list.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => enter({ roomId: r.id }, r.id)} disabled={!!busy} className="card flex w-full items-center gap-3 text-left transition hover:border-brand-500/40" aria-label={`Join ${r.name}${r.adult ? ' (adult 18+)' : ''}`}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/5">{r.type === 'interest' ? <Hash className="h-5 w-5 text-brand-400" aria-hidden="true" /> : <Users className="h-5 w-5 text-brand-400" aria-hidden="true" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-semibold">
                          {r.name}
                          {r.adult && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-accent-500/20 px-1.5 text-[10px] font-bold text-accent-400">
                              <Flame className="h-3 w-3" aria-hidden="true" />
                              18+
                            </span>
                          )}
                          {r.visibility === 'private' && <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />}
                        </span>
                        <span className="block truncate text-xs text-slate-400">{r.description}</span>
                      </span>
                      <span className="chip shrink-0">{busy === r.id ? <Spinner /> : <><Users className="h-3 w-3" aria-hidden="true" />{r.members}</>}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="pb-4 text-center text-xs text-slate-500">Your name in each room is a random alias. Identity rooms rely on self-declared profile info and are not verified.</p>
      </div>

      <Modal
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        title="Join with invite code"
        footer={
          <button
            className="btn-primary"
            disabled={code.trim().length < 4 || !!busy}
            onClick={() => {
              setCodeOpen(false);
              enter({ inviteCode: code.trim() }, 'code');
            }}
          >
            Join
          </button>
        }
      >
        <Field label="Invite code" htmlFor="ic">
          <input id="ic" className="input uppercase tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} maxLength={24} data-autofocus />
        </Field>
      </Modal>
      <CreateRoom open={creating} onClose={() => setCreating(false)} onCreated={(r) => (qc.invalidateQueries({ queryKey: ['rooms'] }), refetch(), enter(r.inviteCode ? { inviteCode: r.inviteCode } : { roomId: r.id }, 'new'))} />
    </div>
  );
}

function CreateRoom({ open, onClose, onCreated }) {
  const [f, setF] = useState({ name: '', description: '', visibility: 'public', adult: false, rules: '', blockLinks: true, badWords: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const { room } = await post('/api/rooms', {
        name: f.name,
        description: f.description || undefined,
        visibility: f.visibility,
        adult: f.adult,
        rules: f.rules || undefined,
        filters: { blockLinks: f.blockLinks, badWords: f.badWords.split(',').map((w) => w.trim()).filter((w) => w.length > 1) },
      });
      onClose();
      onCreated(room);
    } catch (e) {
      setErr(e.details?.issues?.[0]?.message || e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create a room" footer={<button className="btn-primary" onClick={submit} disabled={busy || f.name.trim().length < 3}>{busy ? <Spinner /> : 'Create'}</button>}>
      <Field label="Name" htmlFor="rn">
        <input id="rn" className="input" value={f.name} maxLength={48} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
      </Field>
      <Field label="Description" htmlFor="rd">
        <input id="rd" className="input" value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="Rules shown to members" htmlFor="rr">
        <textarea id="rr" className="input min-h-[64px]" value={f.rules} maxLength={600} onChange={(e) => setF({ ...f, rules: e.target.value })} />
      </Field>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="rv">
            Visibility
          </label>
          <select id="rv" className="input" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>
            <option value="public">Public</option>
            <option value="private">Private (invite code)</option>
          </select>
        </div>
        <div className="flex items-end justify-between rounded-xl bg-white/5 px-3 py-2">
          <span className="text-sm">Adult 18+ room</span>
          <Toggle checked={f.adult} onChange={(adult) => setF({ ...f, adult })} label="Adult room" />
        </div>
      </div>
      <div className="mb-3 flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
        <span className="text-sm">Block links</span>
        <Toggle checked={f.blockLinks} onChange={(blockLinks) => setF({ ...f, blockLinks })} label="Block links" />
      </div>
      <Field label="Blocked words (comma separated)" htmlFor="rb">
        <input id="rb" className="input" value={f.badWords} onChange={(e) => setF({ ...f, badWords: e.target.value })} />
      </Field>
      {f.adult && <p className="text-xs text-amber-300">Adult rooms allow consenting-adult conversation only. Content involving minors, non-consensual material, threats or doxxing is always banned and reported.</p>}
      <ErrorText>{err}</ErrorText>
    </Modal>
  );
}
