import { useState } from 'react';
import { Modal, Spinner, ErrorText } from './ui.jsx';
import { toast } from '../lib/toast.js';

export const REPORT_CATEGORIES = [
  ['harassment', 'Harassment or abuse'],
  ['minor', 'Seems to be under 18'],
  ['csam', 'Sexual content involving a minor'],
  ['nonconsensual', 'Intimate images shared without consent'],
  ['sextortion', 'Blackmail / sextortion'],
  ['threat', 'Threats of violence'],
  ['doxxing', 'Sharing private information'],
  ['trafficking', 'Trafficking / exploitation'],
  ['spam', 'Spam or scam'],
  ['other', 'Something else'],
];

export default function ReportDialog({ open, onClose, onSubmit, title = 'Report this user' }) {
  const [category, setCategory] = useState('harassment');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await onSubmit({ category, details });
      toast('Report sent. The user was blocked for you.', 'success');
      setDetails('');
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-danger" onClick={submit} disabled={busy} data-autofocus>
            {busy ? <Spinner /> : 'Send report'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-400">We attach the last messages of this conversation so a moderator can review them. The person is never told who reported them.</p>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Reason</legend>
        {REPORT_CATEGORIES.map(([v, label]) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
            <input type="radio" name="reason" value={v} checked={category === v} onChange={() => setCategory(v)} />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="label mt-3" htmlFor="rep-details">
        Details (optional)
      </label>
      <textarea id="rep-details" className="input min-h-[72px]" maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
      <ErrorText>{err}</ErrorText>
    </Modal>
  );
}
