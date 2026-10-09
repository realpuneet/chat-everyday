import { useRef, useState } from 'react';
import { ImagePlus, Timer, EyeOff } from 'lucide-react';
import { Modal, Spinner, ErrorText } from './ui.jsx';
import { prepareImage, uploadImage } from '../lib/images.js';
import { toast } from '../lib/toast.js';

/** Attach button + options dialog. `scope`/`scopeId` tell the server which conversation the image is for. */
export default function ImageAttach({ scope, scopeId, disabled, onUploaded }) {
  const input = useRef(null);
  const [prepared, setPrepared] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('once');
  const [timer, setTimer] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const close = () => {
    if (busy) return;
    if (preview) URL.revokeObjectURL(preview);
    setPrepared(null);
    setPreview(null);
    setErr('');
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = await prepareImage(file);
      setPrepared(p);
      setPreview(URL.createObjectURL(p.blob));
      setErr('');
    } catch (ex) {
      toast(ex.message, 'warn');
    }
  };

  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await uploadImage({ ...prepared, scope, scopeId, viewMode: mode, timerSec: mode === 'timer' ? timer : undefined });
      await onUploaded(res.imageId);
      setBusy(false);
      close();
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pick} aria-hidden="true" tabIndex={-1} />
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="btn-ghost h-11 w-11 shrink-0 !p-0" aria-label="Send a photo">
        <ImagePlus className="h-5 w-5" aria-hidden="true" />
      </button>
      <Modal
        open={!!prepared}
        onClose={close}
        title="Send photo"
        footer={
          <>
            <button className="btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={send} disabled={busy} data-autofocus>
              {busy ? (
                <>
                  <Spinner /> Checking…
                </>
              ) : (
                'Send'
              )}
            </button>
          </>
        }
      >
        {preview && <img src={preview} alt="Selected photo preview" className="mx-auto mb-3 max-h-56 rounded-xl object-contain" draggable={false} />}
        <fieldset className="space-y-2">
          <legend className="label">How should it be viewed?</legend>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-white/5 p-3 text-sm">
            <input type="radio" name="vm" checked={mode === 'once'} onChange={() => setMode('once')} />
            <EyeOff className="h-4 w-4" aria-hidden="true" /> View once
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-white/5 p-3 text-sm">
            <input type="radio" name="vm" checked={mode === 'timer'} onChange={() => setMode('timer')} />
            <Timer className="h-4 w-4" aria-hidden="true" /> Timer
            {mode === 'timer' && (
              <select value={timer} onChange={(e) => setTimer(Number(e.target.value))} className="input ml-auto !w-24 !py-1" aria-label="Timer seconds">
                {[5, 10, 30, 60].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            )}
          </label>
        </fieldset>
        <p className="mt-3 text-xs text-slate-500">Photos are checked automatically, location data is removed, and the other person sees it blurred until they tap. Screenshots can't be reliably prevented on the web. Only send photos you have permission to share. Sexual content involving minors is never allowed and is reported.</p>
        <ErrorText>{err}</ErrorText>
      </Modal>
    </>
  );
}
