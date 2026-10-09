import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Users, Info, Flame, Gauge, Shield, LogOut, VolumeX, UserMinus, Flag, UserX, Crown } from 'lucide-react';
import { useRooms } from '../lib/roomStore.js';
import { useNet, emitAck } from '../lib/socket.js';
import { Avatar, Modal, Spinner, Field, ErrorText } from '../components/ui.jsx';
import MessageList from '../components/MessageList.jsx';
import Composer from '../components/Composer.jsx';
import Bubble from '../components/Bubble.jsx';
import ImageAttach from '../components/ImageAttach.jsx';
import ReportDialog from '../components/ReportDialog.jsx';
import { useDocumentTitle, useInterval } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

export default function RoomPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const online = useNet((s) => s.status === 'online');
  const r = useRooms((s) => s.joined[id]);
  const { join, leave, send, typing, mod, block, report } = useRooms();
  const [membersOpen, setMembersOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [reporting, setReporting] = useState(null);
  const [modOpen, setModOpen] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  useDocumentTitle(r?.room?.name || 'Room');
  useInterval(() => tick((n) => n + 1), 1000);

  useEffect(() => {
    if (!r && online) join({ roomId: id }).catch((e) => setErr(e.message));
  }, [id, online]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = useMemo(() => new Set(r?.blocked || []), [r?.blocked]);
  const items = useMemo(() => (r ? r.messages.filter((m) => !blocked.has(m.memberId)) : []), [r, blocked]);

  if (!r) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        {err ? (
          <>
            <ErrorText>{err}</ErrorText>
            <button className="btn-ghost" onClick={() => nav('/rooms')}>
              Back to rooms
            </button>
          </>
        ) : (
          <Spinner className="h-6 w-6" />
        )}
      </div>
    );
  }

  const isMod = r.me.role === 'owner' || r.me.role === 'moderator';
  const slowLeft = Math.max(0, Math.ceil((r.slowUntil - Date.now()) / 1000));
  const mutedLeft = r.muted ? Math.max(0, Math.ceil((r.muted - Date.now()) / 60000)) : 0;
  const typingNames = Object.entries(r.typing)
    .filter(([m, t]) => Date.now() - t < 5000 && m !== r.me.memberId && !blocked.has(m))
    .map(([m]) => r.members.find((x) => x.memberId === m)?.alias)
    .filter(Boolean);
  const canSend = !r.closed && !mutedLeft && online && !(r.room.slowModeSec > 0 && !isMod && slowLeft > 0);

  const doMod = async (body) => {
    try {
      await mod(id, body);
      toast('Done');
      setTarget(null);
    } catch (e) {
      toast(e.message, 'warn');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-white/5 bg-bg-soft px-safe py-2.5 pt-safe">
        <button className="btn-ghost btn-sm !px-2" onClick={() => nav('/rooms')} aria-label="Back to rooms">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate font-semibold">
            {r.room.name}
            {r.room.adult && <Flame className="h-4 w-4 text-accent-400" aria-label="Adult 18+ room" />}
          </h1>
          <p className="truncate text-xs text-slate-400">
            You are <strong className="text-slate-200">{r.me.alias}</strong> · {r.count} here
            {r.room.slowModeSec > 0 && <span className="ml-1 inline-flex items-center gap-0.5 text-amber-300"><Gauge className="h-3 w-3" /> slow {r.room.slowModeSec}s</span>}
          </p>
        </div>
        <button className="btn-ghost btn-sm !px-2.5" onClick={() => setRulesOpen(true)} aria-label="Room rules and info">
          <Info className="h-4 w-4" />
        </button>
        {isMod && (
          <button className="btn-ghost btn-sm !px-2.5" onClick={() => setModOpen(true)} aria-label="Moderator tools">
            <Shield className="h-4 w-4 text-brand-400" />
          </button>
        )}
        <button className="btn-ghost btn-sm !px-2.5" onClick={() => setMembersOpen(true)} aria-label="Members">
          <Users className="h-4 w-4" />
        </button>
        <button className="btn-ghost btn-sm !px-2.5" onClick={async () => (await leave(id), nav('/rooms'))} aria-label="Leave room">
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {r.closed && <p className="bg-red-500/10 px-safe py-2 text-center text-sm text-red-300" role="alert">This room is no longer available.</p>}
      {mutedLeft > 0 && <p className="bg-amber-500/10 px-safe py-1.5 text-center text-xs text-amber-200">You are muted for about {mutedLeft} more minute(s).</p>}

      <MessageList
        items={items}
        label={`${r.room.name} messages`}
        emptyState={<p className="py-10 text-center text-sm text-slate-500">No messages yet. Say hello!</p>}
        renderItem={(m, i) => (
          <Bubble m={m} mine={!!m.mine} showAuthor={!m.mine && items[i - 1]?.memberId !== m.memberId} onAuthorClick={(x) => setTarget(x)} onRetry={(x) => send(id, x.text, { retryKey: x.key })} />
        )}
        footer={typingNames.length ? <p className="px-2 pb-1 text-xs text-slate-500">{typingNames.slice(0, 2).join(', ')}{typingNames.length > 2 ? ' and others' : ''} typing…</p> : null}
      />

      <Composer
        onSend={(t) => send(id, t)}
        onTyping={(on) => typing(id, on)}
        disabled={!canSend}
        placeholder={mutedLeft ? 'You are muted' : slowLeft > 0 && !isMod ? `Slow mode: wait ${slowLeft}s` : `Message ${r.room.name}`}
        leading={<ImageAttach scope="room" scopeId={id} disabled={!canSend} onUploaded={async (imageId) => {
          const clientMsgId = crypto.randomUUID().replace(/-/g, '');
          await emitAck('room:send', { roomId: id, clientMsgId, kind: 'image', imageId });
          toast('Photo sent');
        }} />}
      />

      {/* Rules / info */}
      <Modal open={rulesOpen} onClose={() => setRulesOpen(false)} title={r.room.name}>
        <p className="text-sm text-slate-300">{r.room.description || 'No description.'}</p>
        <h3 className="mt-3 text-sm font-semibold">Rules</h3>
        <p className="whitespace-pre-wrap text-sm text-slate-400">{r.room.rules || 'Be respectful. Keep it legal. No harassment.'}</p>
        <ul className="mt-3 space-y-1 text-xs text-slate-500">
          <li>Everyone here is shown by a random alias that is different in every room.</li>
          {r.room.type === 'identity' && <li>Identity rooms use self-declared profile information. It is not verified.</li>}
          {r.room.adult && <li>18+ room: consenting adults only. Photos are blurred until tapped.</li>}
          <li>Content involving minors, non-consensual images, threats, doxxing or blackmail is never allowed and is reported.</li>
        </ul>
      </Modal>

      {/* Members */}
      <Modal open={membersOpen} onClose={() => setMembersOpen(false)} title={`Members (${r.count})`}>
        <ul className="max-h-[50dvh] space-y-1 overflow-y-auto">
          {[...r.members].sort((a, b) => (b.role === 'owner') - (a.role === 'owner') || a.alias.localeCompare(b.alias)).map((m) => (
            <li key={m.memberId}>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5" onClick={() => m.memberId !== r.me.memberId && (setMembersOpen(false), setTarget(m))}>
                <Avatar avatar={m.avatar} name={m.alias} size={30} />
                <span className="flex-1 truncate text-sm">{m.alias}{m.memberId === r.me.memberId && ' (you)'}</span>
                {m.role === 'owner' && <Crown className="h-4 w-4 text-amber-400" aria-label="Owner" />}
                {m.role === 'moderator' && <Shield className="h-4 w-4 text-brand-400" aria-label="Moderator" />}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      {/* Person actions */}
      <Modal open={!!target} onClose={() => setTarget(null)} title={target?.alias || 'Member'}>
        <div className="grid gap-2">
          <button className="btn-ghost justify-start" onClick={() => (setReporting(target), setTarget(null))}>
            <Flag className="h-4 w-4" /> Report
          </button>
          <button className="btn-ghost justify-start" onClick={async () => { await block(id, target.memberId).catch((e) => toast(e.message, 'warn')); toast('Blocked. Their messages are hidden.'); setTarget(null); }}>
            <UserX className="h-4 w-4" /> Block (hide their messages)
          </button>
          {isMod && (
            <>
              <button className="btn-ghost justify-start" onClick={() => doMod({ action: 'mute', memberId: target.memberId, minutes: 10 })}>
                <VolumeX className="h-4 w-4" /> Mute 10 min
              </button>
              <button className="btn-ghost justify-start" onClick={() => doMod({ action: 'unmute', memberId: target.memberId })}>
                Unmute
              </button>
              <button className="btn-danger justify-start" onClick={() => doMod({ action: 'kick', memberId: target.memberId })}>
                <UserMinus className="h-4 w-4" /> Remove from room
              </button>
              {r.me.role === 'owner' && (
                <button className="btn-ghost justify-start" onClick={() => doMod({ action: target.role === 'moderator' ? 'demote' : 'promote', memberId: target.memberId })}>
                  <Shield className="h-4 w-4" /> {target?.role === 'moderator' ? 'Remove moderator' : 'Make moderator'}
                </button>
              )}
            </>
          )}
        </div>
      </Modal>
      <ReportDialog open={!!reporting} onClose={() => setReporting(null)} title={`Report ${reporting?.alias || ''}`} onSubmit={({ category, details }) => report(id, reporting.memberId, category, details)} />
      <ModTools open={modOpen} onClose={() => setModOpen(false)} room={r.room} onApply={doMod} />
    </div>
  );
}

function ModTools({ open, onClose, room, onApply }) {
  const [slow, setSlow] = useState(room.slowModeSec || 0);
  const [rules, setRules] = useState(room.rules || '');
  return (
    <Modal open={open} onClose={onClose} title="Moderator tools">
      <Field label="Slow mode (seconds between messages, 0 = off)" htmlFor="slow">
        <div className="flex gap-2">
          <input id="slow" type="number" min={0} max={300} className="input" value={slow} onChange={(e) => setSlow(Number(e.target.value))} />
          <button className="btn-primary shrink-0" onClick={() => onApply({ action: 'slow', seconds: Math.max(0, Math.min(300, slow)) })}>
            Apply
          </button>
        </div>
      </Field>
      <Field label="Room rules" htmlFor="mrules">
        <textarea id="mrules" className="input min-h-[80px]" maxLength={600} value={rules} onChange={(e) => setRules(e.target.value)} />
        <button className="btn-primary mt-2" onClick={() => onApply({ action: 'rules', rules })}>
          Update rules
        </button>
      </Field>
      <p className="text-xs text-slate-500">To mute, remove or promote someone, tap their name in the member list or on a message.</p>
    </Modal>
  );
}
