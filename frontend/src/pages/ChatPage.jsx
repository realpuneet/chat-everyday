import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SkipForward, LogOut, Flag, UserX, Bookmark, BookmarkCheck, Video, X, Search, Hash, MessageCircle } from 'lucide-react';
import { useChat } from '../lib/chatStore.js';
import { useAuth, isRegistered } from '../lib/auth.js';
import { useNet } from '../lib/socket.js';
import { Avatar, Spinner, Modal, ErrorText } from '../components/ui.jsx';
import MessageList from '../components/MessageList.jsx';
import Composer from '../components/Composer.jsx';
import Bubble from '../components/Bubble.jsx';
import ImageAttach from '../components/ImageAttach.jsx';
import ReportDialog from '../components/ReportDialog.jsx';
import VideoPanel, { useVideoCall } from '../components/VideoPanel.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

const LANGS = [['', 'Any language'], ['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['es', 'Spanish']];

function TagInput({ tags, onChange }) {
  const [v, setV] = useState('');
  const add = () => {
    const t = v.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_-]/g, '');
    if (t && !tags.includes(t) && tags.length < 5) onChange([...tags, t]);
    setV('');
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className="chip">
            <Hash className="h-3 w-3" aria-hidden="true" />
            {t}
            <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        className="input"
        placeholder={tags.length >= 5 ? 'Max 5 interests' : 'Add an interest and press Enter (e.g. cricket)'}
        value={v}
        disabled={tags.length >= 5}
        maxLength={24}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ',') && (e.preventDefault(), add())}
        onBlur={add}
        aria-label="Interests"
      />
    </div>
  );
}

function Idle() {
  const { prefs, setPrefs, start, error, notice, dismissNotice } = useChat();
  const connected = useNet((s) => s.status === 'online');
  const online = useNet((s) => s.online);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6">
      <div className="card w-full max-w-md space-y-4">
        <div className="text-center">
          <span className="mx-auto mb-2 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-accent-500">
            <MessageCircle className="h-7 w-7" aria-hidden="true" />
          </span>
          <h1 className="h-page">Meet someone new</h1>
          <p className="text-sm text-slate-400">{online} people online</p>
        </div>
        {notice && (
          <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200" role="status">
            {notice}{' '}
            <button className="underline" onClick={dismissNotice}>
              Dismiss
            </button>
          </p>
        )}
        <div>
          <span className="label">Interests (optional)</span>
          <TagInput tags={prefs.tags} onChange={(tags) => setPrefs({ tags })} />
          <p className="mt-1 text-xs text-slate-500">We try shared interests first, then widen the search after a few seconds.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="lang">
              Language
            </label>
            <select id="lang" className="input" value={prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value })}>
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="gp">
              Prefer to meet
            </label>
            <select id="gp" className="input" value={prefs.genderPref} onChange={(e) => setPrefs({ genderPref: e.target.value })}>
              <option value="any">Anyone</option>
              <option value="female">Women</option>
              <option value="male">Men</option>
              <option value="nonbinary">Non-binary</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">Gender preferences use what people choose to declare in their profile. It is not verified.</p>
        <button className="btn-primary w-full py-3 text-base" onClick={start} disabled={!connected}>
          {connected ? 'Start chatting' : <><Spinner /> Connecting…</>}
        </button>
        <ErrorText>{error}</ErrorText>
        <p className="text-center text-xs text-slate-500">
          Be kind. Never share money, passwords or private photos. By chatting you accept the <Link className="link" to="/terms">Terms</Link>.
        </p>
      </div>
    </div>
  );
}

function Searching() {
  const { fallback, prefs, leave } = useChat();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="relative grid h-28 w-28 place-items-center" aria-hidden="true">
        <span className="absolute inset-0 animate-pulseRing rounded-full bg-brand-500/40" />
        <span className="absolute inset-0 animate-pulseRing rounded-full bg-accent-500/30 [animation-delay:.6s]" />
        <span className="relative grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-accent-500">
          <Search className="h-7 w-7" />
        </span>
      </div>
      <div role="status" aria-live="polite">
        <h2 className="text-xl font-semibold">Looking for someone…</h2>
        <p className="mt-1 text-sm text-slate-400">{fallback || !prefs.tags.length ? 'Widening the search to everyone online.' : `Looking for people into ${prefs.tags.map((t) => `#${t}`).join(', ')}`}</p>
      </div>
      <button className="btn-ghost" onClick={leave}>
        Cancel
      </button>
    </div>
  );
}

export default function ChatPage() {
  useDocumentTitle('Chat');
  const c = useChat();
  const user = useAuth((s) => s.user);
  const [report, setReport] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const call = useVideoCall(c.chatId);

  const items = useMemo(() => c.messages.map((m) => ({ ...m, key: m.key })), [c.messages]);
  if (c.phase === 'idle') return <Idle />;
  if (c.phase === 'searching') return <Searching />;

  const ended = c.phase === 'ended';
  const endText = { partner_left: 'Your partner left the chat.', partner_disconnected: 'Your partner disconnected.', moderation: 'This chat was ended by moderation.' }[c.endedReason] || 'Chat ended.';
  const registered = isRegistered(user);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-white/5 bg-bg-soft px-safe py-2.5 pt-safe">
        <Avatar avatar={c.partner?.avatar} name={c.partner?.nickname} size={38} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{c.partner?.nickname || 'Stranger'}</p>
          <p className="truncate text-xs text-slate-400" aria-live="polite">
            {ended ? 'Chat ended' : c.partnerStatus === 'reconnecting' ? 'Reconnecting…' : c.typing ? 'typing…' : c.sharedTags.length ? c.sharedTags.map((t) => `#${t}`).join(' ') : 'Online'}
          </p>
        </div>
        {!ended && (
          <div className="flex items-center gap-1">
            <button className="btn-ghost btn-sm !px-2.5" onClick={call.request} aria-label="Start video chat" disabled={call.rtc !== 'idle'}>
              <Video className="h-4 w-4" />
            </button>
            {registered && (
              <button className="btn-ghost btn-sm !px-2.5" onClick={c.save === 'active' ? c.saveStop : c.saveRequest} aria-label={c.save === 'active' ? 'Stop saving chat' : 'Save chat (needs both people to agree)'} disabled={c.save === 'requested'}>
                {c.save === 'active' ? <BookmarkCheck className="h-4 w-4 text-emerald-400" /> : <Bookmark className="h-4 w-4" />}
              </button>
            )}
            <button className="btn-ghost btn-sm !px-2.5" onClick={() => setReport(true)} aria-label="Report">
              <Flag className="h-4 w-4" />
            </button>
            <button className="btn-ghost btn-sm !px-2.5" onClick={() => setConfirmBlock(true)} aria-label="Block">
              <UserX className="h-4 w-4" />
            </button>
          </div>
        )}
      </header>

      {c.save === 'prompt' && (
        <div className="flex items-center justify-between gap-3 bg-brand-700/20 px-safe py-2 text-sm" role="alert">
          <span>Your partner wants to save this chat (encrypted, both can delete). Allow?</span>
          <span className="flex shrink-0 gap-2">
            <button className="btn-ghost btn-sm" onClick={() => c.saveRespond(false)}>No</button>
            <button className="btn-primary btn-sm" onClick={() => c.saveRespond(true)}>Yes</button>
          </span>
        </div>
      )}
      {c.save === 'active' && <p className="bg-emerald-500/10 px-safe py-1 text-center text-xs text-emerald-300">Saving is ON for both of you. Either of you can stop at any time.</p>}
      {c.save === 'requested' && <p className="bg-white/5 px-safe py-1 text-center text-xs text-slate-300">Waiting for your partner to accept saving…</p>}
      {c.save === 'declined' && <p className="bg-white/5 px-safe py-1 text-center text-xs text-slate-400">Your partner declined saving.</p>}
      {c.notice && (
        <p className="bg-amber-500/10 px-safe py-1.5 text-center text-xs text-amber-200" role="status" onClick={c.dismissNotice}>
          {c.notice}
        </p>
      )}

      <MessageList
        items={items}
        label="Conversation"
        emptyState={<p className="py-10 text-center text-sm text-slate-500">Say hi 👋 Be kind, and never share personal details.</p>}
        renderItem={(m) => <Bubble m={m} mine={m.from === 'me'} onRetry={(x) => c.send(x.text, { retryKey: x.key })} />}
        footer={c.typing ? <p className="px-2 pb-1 text-xs text-slate-500" aria-hidden="true">typing<span className="animate-dots">…</span></p> : null}
      />

      {ended ? (
        <div className="space-y-2 border-t border-white/5 bg-bg-soft px-safe py-3 pb-safe text-center">
          <p className="text-sm text-slate-300">{endText}</p>
          <div className="flex justify-center gap-2">
            <button className="btn-primary" onClick={c.next}>
              <SkipForward className="h-4 w-4" /> Find someone new
            </button>
            <button className="btn-ghost" onClick={c.reset}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-t border-white/5 bg-bg-soft px-safe pt-2">
            <button className="btn-ghost btn-sm" onClick={c.leave}>
              <LogOut className="h-3.5 w-3.5" /> Leave
            </button>
            <button className="btn-primary btn-sm" onClick={c.next}>
              Next <SkipForward className="h-3.5 w-3.5" />
            </button>
          </div>
          <Composer
            onSend={(t) => c.send(t)}
            onTyping={c.sendTyping}
            leading={<ImageAttach scope="chat" scopeId={c.chatId} onUploaded={async (imageId) => (await c.sendImage(imageId).catch(() => null)) && toast('Photo sent')} />}
            hint={null}
          />
        </>
      )}

      <ReportDialog open={report} onClose={() => setReport(false)} onSubmit={(v) => c.report(v)} />
      <Modal
        open={confirmBlock}
        onClose={() => setConfirmBlock(false)}
        title="Block this person?"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConfirmBlock(false)}>
              Cancel
            </button>
            <button
              className="btn-danger"
              data-autofocus
              onClick={async () => {
                setConfirmBlock(false);
                await c.block().catch((e) => toast(e.message, 'warn'));
                toast('Blocked. You will not be matched with them again.');
              }}
            >
              Block
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">The chat ends and you will never be matched with this person again.</p>
      </Modal>
      <VideoPanel call={call} />
    </div>
  );
}
