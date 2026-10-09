import { Check, Clock, RotateCw, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import SecureImage from './SecureImage.jsx';
import { Avatar } from './ui.jsx';

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/** One chat message (random chat or room). `mine` aligns right. Rooms pass alias/avatar/role. */
export default function Bubble({ m, mine, showAuthor, onRetry, onAuthorClick }) {
  if (m.kind === 'system') {
    return <p className="my-2 text-center text-xs text-slate-500">{m.text}</p>;
  }
  return (
    <div className={clsx('flex gap-2 py-1', mine ? 'justify-end' : 'justify-start')}>
      {!mine && showAuthor && (
        <button className="mt-4 self-start" onClick={() => onAuthorClick?.(m)} aria-label={`Options for ${m.alias}`}>
          <Avatar avatar={m.avatar} name={m.alias} size={30} />
        </button>
      )}
      {!mine && !showAuthor && null}
      <div className={clsx('flex min-w-0 max-w-[82%] flex-col', mine ? 'items-end' : 'items-start')}>
        {showAuthor && !mine && (
          <span className="mb-0.5 px-1 text-[11px] text-slate-400">
            {m.alias}
            {m.role && m.role !== 'member' && <span className="ml-1 rounded bg-brand-600/30 px-1 text-[10px] uppercase text-brand-400">{m.role}</span>}
          </span>
        )}
        {m.kind === 'image' ? (
          <SecureImage imageId={m.imageId} meta={m.image} own={mine} />
        ) : (
          <div className={clsx('bubble', mine ? 'bubble-me' : 'bubble-them', m.status === 'rejected' && 'opacity-70 ring-1 ring-red-500/60')}>{m.text}</div>
        )}
        <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-slate-500">
          <span>{time(m.ts)}</span>
          {mine && m.status === 'sending' && <Clock className="h-3 w-3" aria-label="Sending" />}
          {mine && m.status === 'sent' && <Check className="h-3 w-3" aria-label="Sent" />}
          {mine && m.status === 'failed' && (
            <button onClick={() => onRetry?.(m)} className="inline-flex items-center gap-1 text-amber-400" aria-label="Retry sending">
              <RotateCw className="h-3 w-3" /> Retry
            </button>
          )}
          {mine && m.status === 'rejected' && (
            <span className="inline-flex items-center gap-1 text-red-400" role="alert">
              <AlertCircle className="h-3 w-3" /> {m.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
