import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Trash2, Lock } from 'lucide-react';
import { get, del } from '../lib/api.js';
import { Modal, Empty, Spinner } from '../components/ui.jsx';
import { useDocumentTitle } from '../hooks/hooks.js';
import { toast } from '../lib/toast.js';

export default function SavedChats() {
  useDocumentTitle('Saved chats');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['saved'], queryFn: () => get('/api/saved') });
  const [open, setOpen] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const read = async (id) => setOpen(await get(`/api/saved/${id}`));
  const remove = async (id) => {
    await del(`/api/saved/${id}`);
    toast('Deleted');
    setOpen(null);
    qc.invalidateQueries({ queryKey: ['saved'] });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-safe pb-6 pt-safe">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between py-4">
          <h1 className="h-page">Saved chats</h1>
          {data?.chats?.length > 0 && (
            <button className="btn-ghost btn-sm text-red-300" onClick={() => setConfirmAll(true)}>
              <Trash2 className="h-4 w-4" /> Delete all
            </button>
          )}
        </div>
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-white/5 p-3 text-xs text-slate-400">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Chats are only saved when both people agree. They are encrypted at rest, only you can open your copy, and they are deleted automatically after the retention period. Photos are never saved.
        </p>
        {isLoading && <Spinner className="mx-auto h-6 w-6" />}
        {data?.chats?.length === 0 && <Empty icon={Bookmark} title="Nothing saved yet">During a chat, tap the bookmark icon. Your partner has to accept.</Empty>}
        <ul className="space-y-2">
          {data?.chats?.map((c) => (
            <li key={c.id}>
              <button onClick={() => read(c.id)} className="card flex w-full items-center justify-between text-left hover:border-brand-500/40">
                <span>
                  <span className="block font-semibold">{c.peerLabel || 'Stranger'}</span>
                  <span className="text-xs text-slate-400">
                    {c.count} messages · {new Date(c.startedAt).toLocaleDateString()} · expires {new Date(c.expiresAt).toLocaleDateString()}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.peerLabel || 'Saved chat'} wide footer={<button className="btn-danger" onClick={() => remove(open.id)}>Delete this chat</button>}>
        <ol className="max-h-[55dvh] space-y-1.5 overflow-y-auto">
          {open?.messages.map((m, i) => (
            <li key={i} className={m.from === 'me' ? 'text-right' : ''}>
              <span className={`bubble inline-block ${m.from === 'me' ? 'bubble-me' : 'bubble-them'}`}>{m.text}</span>
              <span className="block px-1 text-[10px] text-slate-500">{new Date(m.ts).toLocaleString()}</span>
            </li>
          ))}
        </ol>
      </Modal>
      <Modal open={confirmAll} onClose={() => setConfirmAll(false)} title="Delete all saved chats?" footer={<button className="btn-danger" onClick={async () => { await del('/api/saved'); setConfirmAll(false); qc.invalidateQueries({ queryKey: ['saved'] }); toast('All saved chats deleted'); }}>Delete everything</button>}>
        <p className="text-sm text-slate-300">This cannot be undone. Your partner keeps their own copy unless they delete it.</p>
      </Modal>
    </div>
  );
}
