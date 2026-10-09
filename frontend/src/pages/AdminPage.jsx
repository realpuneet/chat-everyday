import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, FileWarning, Gavel, Settings2, ScrollText, FileX, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import { get, post, put, del, adminOtp } from '../lib/api.js';
import { useAdminLive } from '../lib/wire.js';
import { Modal, Spinner, Empty, Toggle, ErrorText, Field } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

const TABS = [
  ['dash', 'Live', Activity],
  ['reports', 'Reports', FileWarning],
  ['bans', 'Bans', Gavel],
  ['takedowns', 'Takedowns', FileX],
  ['settings', 'Settings', Settings2],
  ['audit', 'Audit', ScrollText],
];

export default function AdminPage() {
  useDocumentTitle('Admin');
  const [tab, setTab] = useState('dash');
  const [otp, setOtp] = useState(adminOtp.code);
  const live = useAdminLive();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 overflow-x-auto border-b border-white/5 bg-bg-soft px-safe py-2 pt-safe" role="tablist" aria-label="Admin sections">
        {TABS.map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => (setTab(k), k === 'reports' && live.reset())} className={clsx('btn-sm btn shrink-0', tab === k ? 'bg-brand-600 text-white' : 'bg-white/5 text-slate-300')}>
            <Icon className="h-4 w-4" aria-hidden="true" /> {label}
            {k === 'reports' && live.reports > 0 && <span className="rounded-full bg-accent-500 px-1.5 text-[10px]">{live.reports}</span>}
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <KeyRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <input aria-label="Admin 2FA code" className="input !w-24 !py-1.5 text-center text-xs" placeholder="2FA code" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => ((adminOtp.code = e.target.value.replace(/\D/g, '')), setOtp(adminOtp.code))} />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-safe py-4">
        <div className="mx-auto max-w-5xl">
          {tab === 'dash' && <Dashboard />}
          {tab === 'reports' && <Reports />}
          {tab === 'bans' && <Bans />}
          {tab === 'takedowns' && <Takedowns />}
          {tab === 'settings' && <SettingsEditor />}
          {tab === 'audit' && <Audit />}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={clsx('mt-1 text-2xl font-bold tabular-nums', tone)}>{value ?? '…'}</p>
    </div>
  );
}

function Dashboard() {
  const { data, error } = useQuery({ queryKey: ['a-stats'], queryFn: () => get('/api/admin/stats'), refetchInterval: 5000 });
  return (
    <>
      <ErrorText>{error?.message}</ErrorText>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Online users" value={data?.online} tone="text-emerald-400" />
        <Stat label="Waiting in queue" value={data?.waiting} />
        <Stat label="Active 1:1 chats" value={data?.activeChats} />
        <Stat label="Active rooms" value={data && `${data.activeRooms} / ${data.roomsTotal}`} />
        <Stat label="Users in rooms" value={data?.usersInRooms} />
        <Stat label="Open reports" value={data?.openReports} tone={data?.openReports ? 'text-amber-400' : ''} />
        <Stat label="Critical reports" value={data?.criticalReports} tone={data?.criticalReports ? 'text-red-400' : ''} />
        <Stat label="Open takedowns" value={data?.openTakedowns} tone={data?.openTakedowns ? 'text-amber-400' : ''} />
        <Stat label="Active bans" value={data?.activeBans} />
        <Stat label="Images processing" value={data?.pendingImages} />
      </div>
      <p className="mt-3 text-xs text-slate-500">Refreshes every 5 seconds. {data && `Updated ${new Date(data.at).toLocaleTimeString()}`}</p>
    </>
  );
}

const PRI = { critical: 'bg-red-500/20 text-red-300', high: 'bg-amber-500/20 text-amber-300', normal: 'bg-white/10 text-slate-300' };

function Reports() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const { data, isLoading } = useQuery({ queryKey: ['a-reports', status], queryFn: () => get(`/api/admin/reports?status=${status}`), refetchInterval: 10_000 });
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const view = async (id) => {
    setNote('');
    setOpen((await get(`/api/admin/reports/${id}`)).report);
  };
  const act = async (action, durationHours) => {
    try {
      await post(`/api/admin/reports/${open.id}/resolve`, { action, note: note || undefined, ...(durationHours ? { durationHours } : {}) });
      toast(`Report ${action}`, 'success');
      setOpen(null);
      qc.invalidateQueries({ queryKey: ['a-reports'] });
    } catch (e) {
      toast(e.message, 'warn');
    }
  };
  return (
    <>
      <div className="mb-3 flex gap-2">
        {['open', 'actioned', 'dismissed'].map((s) => (
          <button key={s} onClick={() => setStatus(s)} className={clsx('btn-sm btn', status === s ? 'bg-brand-600' : 'bg-white/5')}>
            {s}
          </button>
        ))}
      </div>
      {isLoading && <Spinner />}
      {data?.reports.length === 0 && <Empty icon={FileWarning} title="Queue is empty" />}
      <ul className="space-y-2">
        {data?.reports.map((r) => (
          <li key={r.id}>
            <button onClick={() => view(r.id)} className="card flex w-full items-center gap-3 text-left hover:border-brand-500/40">
              <span className={clsx('rounded px-2 py-0.5 text-xs font-semibold uppercase', PRI[r.priority])}>{r.priority}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.category} · {r.context?.kind}</span>
                <span className="block truncate text-xs text-slate-400">{r.reporterId === 'system' ? 'Auto-detected' : 'User report'} · {new Date(r.createdAt).toLocaleString()} · {r.evidence.messages} msgs / {r.evidence.images} img{r.action ? ` · ${r.action}` : ''}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Modal open={!!open} onClose={() => setOpen(null)} wide title={open ? `${open.category} (${open.priority})` : ''}
        footer={open?.status === 'open' && (
          <>
            <button className="btn-ghost" onClick={() => act('dismiss')}>Dismiss</button>
            <button className="btn-ghost" onClick={() => act('warn')}>Warn</button>
            <button className="btn-ghost" onClick={() => act('hide_content')}>Hide content</button>
            <button className="btn-danger" onClick={() => act('ban_temp', 24)}>Ban 24h</button>
            <button className="btn-danger" onClick={() => act('ban_perm')}>Ban permanently</button>
          </>
        )}
      >
        {open && (
          <>
            <p className="text-sm text-slate-400">Reporter: {open.reporterId} · Reported: <code>{open.reportedId}</code> {open.reported && `(${open.reported.nickname}, ${open.reported.kind}, bans ${open.reported.banCount}, strikes ${open.reported.strikes})`} · prior reports: {open.priorReports}</p>
            {open.details && <p className="mt-2 rounded bg-white/5 p-2 text-sm">“{open.details}”</p>}
            <h3 className="mt-3 text-sm font-semibold">Evidence (last messages)</h3>
            <ol className="mt-1 max-h-60 space-y-1 overflow-y-auto rounded-xl bg-bg-soft p-2 text-sm">
              {open.evidence.messages.map((m, i) => (
                <li key={i} className={clsx(m.senderRef === 'reported' && 'text-red-300', m.senderRef === 'reporter' && 'text-sky-300')}>
                  <span className="text-xs uppercase opacity-60">{m.senderRef}{m.senderAlias ? ` (${m.senderAlias})` : ''}: </span>
                  {m.kind === 'image' ? <em>[image {m.imageId}]</em> : m.text}
                </li>
              ))}
              {!open.evidence.messages.length && <li className="text-slate-500">No messages captured.</li>}
            </ol>
            {open.evidence.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {open.evidence.images.map((img) => (
                  <button key={img.imageId} className="btn-ghost btn-sm" onClick={async () => window.open((await get(`/api/admin/evidence/${open.id}/${img.imageId}`)).url, '_blank', 'noopener')}>
                    View evidence image {img.imageId.slice(0, 6)}
                  </button>
                ))}
              </div>
            )}
            <Field label="Note" htmlFor="rn">
              <input id="rn" className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
            {['minor', 'csam', 'underage_signal'].includes(open.category) && <p className="rounded bg-red-500/10 p-2 text-xs text-red-300">Critical category: follow the escalation steps in docs/legal.md (preserve hashes/metadata, do not forward the material).</p>}
          </>
        )}
      </Modal>
    </>
  );
}

function Bans() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['a-bans'], queryFn: () => get('/api/admin/bans') });
  const [f, setF] = useState({ userId: '', reason: '', hours: 24, permanent: false });
  const [err, setErr] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['a-bans'] });
  return (
    <>
      <form className="card mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_90px_auto_auto]" onSubmit={async (e) => {
        e.preventDefault();
        setErr('');
        try {
          await post('/api/admin/bans', { userId: f.userId.trim(), reason: f.reason, permanent: f.permanent, ...(f.permanent ? {} : { hours: Number(f.hours) }) });
          toast('User banned', 'success');
          refresh();
        } catch (ex) {
          setErr(ex.message);
        }
      }}>
        <input className="input" placeholder="User ID" aria-label="User ID" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} required />
        <input className="input" placeholder="Reason" aria-label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} />
        <input className="input" type="number" min={1} aria-label="Hours" disabled={f.permanent} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><Toggle checked={f.permanent} onChange={(permanent) => setF({ ...f, permanent })} label="Permanent" /> Permanent</label>
        <button className="btn-danger">Ban</button>
        <div className="sm:col-span-5"><ErrorText>{err}</ErrorText></div>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="p-2">Type</th><th className="p-2">User</th><th className="p-2">Reason</th><th className="p-2">Until</th><th /></tr></thead>
          <tbody>
            {data?.bans.map((b) => (
              <tr key={b.id} className="border-t border-white/5">
                <td className="p-2">{b.type}</td>
                <td className="p-2 font-mono text-xs">{b.userId}</td>
                <td className="p-2">{b.reason} <span className="text-slate-500">({b.category})</span></td>
                <td className="p-2">{b.expiresAt ? new Date(b.expiresAt).toLocaleString() : 'permanent'}</td>
                <td className="p-2 text-right">{b.type === 'account' && <button className="btn-ghost btn-sm" onClick={async () => { await del(`/api/admin/bans/${b.id}`); toast('Unbanned', 'success'); refresh(); }}>Unban</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.bans.length === 0 && <Empty icon={Gavel} title="No active bans" />}
      </div>
    </>
  );
}

function Takedowns() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['a-takedowns'], queryFn: () => get('/api/admin/takedowns'), refetchInterval: 15_000 });
  const resolve = async (id, action) => {
    await post(`/api/admin/takedowns/${id}/resolve`, { action });
    toast(`Takedown ${action}`, 'success');
    qc.invalidateQueries({ queryKey: ['a-takedowns'] });
  };
  return (
    <>
      {data?.takedowns.length === 0 && <Empty icon={FileX} title="No open takedown requests" />}
      <ul className="space-y-2">
        {data?.takedowns.map((t) => (
          <li key={t.id} className="card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{t.category}</span>
              <span className={clsx('rounded px-2 py-0.5 text-xs', t.overdue ? 'bg-red-500/20 text-red-300' : 'bg-white/10')}>{t.overdue ? 'OVERDUE · ' : 'due '}{new Date(t.dueAt).toLocaleString()}</span>
              <span className="ml-auto flex gap-2"><button className="btn-primary btn-sm" onClick={() => resolve(t.id, 'actioned')}>Remove content</button><button className="btn-ghost btn-sm" onClick={() => resolve(t.id, 'rejected')}>Reject</button></span>
            </div>
            <p className="mt-2 text-sm text-slate-300">{t.description}</p>
            <p className="mt-1 text-xs text-slate-500">Ref: {t.reference || '-'} · Contact: {t.requesterContact} {t.requesterName && `(${t.requesterName})`}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

const SELECTS = { defaultViewMode: ['once', 'timer'], adultMinAgeLevel: ['declared', 'phone', 'google', 'strict'] };

function SettingsEditor() {
  const { data, refetch } = useQuery({ queryKey: ['a-settings'], queryFn: () => get('/api/admin/settings') });
  const [group, setGroup] = useState('limits');
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState('');
  if (!data) return <Spinner />;
  const cur = { ...data.current[group], ...draft[group] };
  const set = (k, v) => setDraft((d) => ({ ...d, [group]: { ...d[group], [k]: v } }));
  const save = async () => {
    setErr('');
    try {
      await put('/api/admin/settings', { [group]: draft[group] || {} });
      toast('Settings saved (audited)', 'success');
      setDraft((d) => ({ ...d, [group]: {} }));
      refetch();
    } catch (e) {
      setErr(e.details?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || e.message);
    }
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {Object.keys(data.current).map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={clsx('btn-sm btn', group === g ? 'bg-brand-600' : 'bg-white/5')}>{g}</button>
        ))}
      </div>
      <div className="card space-y-3">
        {Object.entries(cur).map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <label htmlFor={`s-${k}`} className="font-mono text-xs text-slate-400">{k}</label>
            {typeof v === 'boolean' ? <Toggle id={`s-${k}`} checked={v} onChange={(x) => set(k, x)} label={k} />
              : SELECTS[k] ? <select id={`s-${k}`} className="input sm:!w-56" value={v} onChange={(e) => set(k, e.target.value)}>{SELECTS[k].map((o) => <option key={o}>{o}</option>)}</select>
              : Array.isArray(v) ? <textarea id={`s-${k}`} className="input min-h-[60px] sm:!w-80" value={v.join(', ')} onChange={(e) => set(k, e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (typeof v[0] === 'number' ? Number(x) : x)))} />
              : <input id={`s-${k}`} type="number" step="any" className="input sm:!w-56" value={v} onChange={(e) => set(k, Number(e.target.value))} />}
          </div>
        ))}
        <ErrorText>{err}</ErrorText>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDraft((d) => ({ ...d, [group]: {} }))}>Reset edits</button>
          <button className="btn-primary" onClick={save} disabled={!Object.keys(draft[group] || {}).length}>Save {group}</button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">Hard content-policy blocks (CSAM, minors, non-consensual intimate content, sextortion, doxxing, trafficking, threats) and the 18+ age floor are not settings and cannot be changed here.</p>
    </>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data } = useQuery({ queryKey: ['a-audit', action], queryFn: () => get(`/api/admin/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ''}`) });
  return (
    <>
      <input className="input mb-3 sm:!w-72" placeholder="Filter by action (e.g. ban.create)" aria-label="Filter audit by action" value={action} onChange={(e) => setAction(e.target.value)} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="uppercase text-slate-500"><tr><th className="p-2">Time</th><th className="p-2">Actor</th><th className="p-2">Action</th><th className="p-2">Target</th><th className="p-2">Meta</th></tr></thead>
          <tbody>
            {data?.logs.map((l) => (
              <tr key={l.id} className={clsx('border-t border-white/5', l.severity === 'critical' && 'bg-red-500/5')}>
                <td className="whitespace-nowrap p-2">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="p-2">{l.actorType}{l.actorId && l.actorId !== 'system' ? ` ${String(l.actorId).slice(-6)}` : ''}</td>
                <td className="p-2 font-medium">{l.action}</td>
                <td className="p-2 font-mono">{l.targetType} {l.targetId && String(l.targetId).slice(-8)}</td>
                <td className="max-w-xs truncate p-2 font-mono text-slate-500" title={JSON.stringify(l.meta)}>{l.meta ? JSON.stringify(l.meta) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
