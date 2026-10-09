import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, VideoOff, Mic, MicOff, PhoneOff } from 'lucide-react';
import { emitAck, getSocket } from '../lib/socket.js';
import { rtcBus } from '../lib/wire.js';
import { useChat } from '../lib/chatStore.js';
import { get } from '../lib/api.js';
import { Modal } from './ui.jsx';
import { toast } from '../lib/toast.js';

/**
 * Optional 1:1 video. Signalling goes over Socket.io; media is peer-to-peer (TURN relay only if configured and needed).
 * The other person must explicitly accept; nothing is recorded by the service.
 */
export function useVideoCall(chatId) {
  const rtc = useChat((s) => s.rtc);
  const setRtc = useChat((s) => s.setRtc);
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const pcRef = useRef(null);
  const pending = useRef([]);
  const media = useRef(null);
  const ready = useRef(false);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    media.current?.getTracks().forEach((t) => t.stop());
    media.current = null;
    pending.current = [];
    ready.current = false;
    setLocal(null);
    setRemote(null);
    setRtc('idle');
  }, [setRtc]);

  const signal = useCallback((type, data) => getSocket()?.emit('rtc:signal', { chatId, type, data }, () => {}), [chatId]);

  const handleSignal = useCallback(
    async ({ type, data }) => {
      const pc = pcRef.current;
      if (!pc) return pending.current.push({ type, data });
      try {
        if (type === 'offer') {
          await pc.setRemoteDescription(data);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signal('answer', pc.localDescription);
        } else if (type === 'answer') {
          await pc.setRemoteDescription(data);
        } else if (type === 'ice' && data) {
          await pc.addIceCandidate(data).catch(() => {});
        }
      } catch {
        toast('Video connection failed', 'warn');
      }
    },
    [signal],
  );

  const begin = useCallback(
    async (role) => {
      try {
        const [{ iceServers }, stream] = await Promise.all([get('/api/rtc/ice'), navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true })]);
        media.current = stream;
        setLocal(stream);
        const pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.onicecandidate = (e) => e.candidate && signal('ice', e.candidate.toJSON());
        pc.ontrack = (e) => setRemote(e.streams[0]);
        pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && toast('Video call disconnected', 'warn');
        setRtc('active');
        ready.current = true;
        if (role === 'caller') {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signal('offer', pc.localDescription);
        }
        const queued = pending.current.splice(0);
        for (const q of queued) await handleSignal(q);
      } catch (e) {
        toast(e.name === 'NotAllowedError' ? 'Camera/microphone permission was denied' : 'Could not start video', 'warn');
        emitAck('rtc:end', { chatId }).catch(() => {});
        cleanup();
      }
    },
    [chatId, signal, setRtc, cleanup, handleSignal],
  );

  useEffect(() => {
    const on = (name, fn) => {
      const h = (e) => fn(e.detail);
      rtcBus.addEventListener(name, h);
      return () => rtcBus.removeEventListener(name, h);
    };
    const offs = [
      on('rtc:incoming', () => setRtc('incoming')),
      on('rtc:accepted', (p) => begin(p.role)),
      on('rtc:declined', () => (toast('Video request declined'), cleanup())),
      on('rtc:signal', (p) => handleSignal(p)),
      on('rtc:ended', () => {
        if (pcRef.current || useChat.getState().rtc !== 'idle') toast('Video call ended');
        cleanup();
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [begin, cleanup, handleSignal, setRtc]);

  useEffect(() => cleanup, [cleanup]);

  return {
    rtc,
    local,
    remote,
    mic,
    cam,
    request: async () => {
      try {
        await emitAck('rtc:request', { chatId });
        setRtc('requested');
        toast('Video request sent. Waiting for them to accept…');
      } catch (e) {
        toast(e.message, 'warn');
      }
    },
    respond: async (accept) => {
      await emitAck('rtc:respond', { chatId, accept }).catch((e) => toast(e.message, 'warn'));
      if (!accept) setRtc('idle');
    },
    hangup: async () => {
      await emitAck('rtc:end', { chatId }).catch(() => {});
      cleanup();
    },
    toggleMic() {
      media.current?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
      setMic((m) => !m);
    },
    toggleCam() {
      media.current?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
      setCam((c) => !c);
    },
  };
}

function Stream({ stream, muted, className, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={className} />;
}

export default function VideoPanel({ call }) {
  const { rtc, local, remote, mic, cam } = call;
  return (
    <>
      <Modal open={rtc === 'incoming'} onClose={() => call.respond(false)} title="Video chat request">
        <p className="mb-4 text-sm text-slate-300">Your chat partner would like to start a video call. Video is peer-to-peer and not recorded by us, but the other person could still record their screen. Only accept if you are comfortable.</p>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => call.respond(false)}>
            Decline
          </button>
          <button className="btn-primary" onClick={() => call.respond(true)} data-autofocus>
            <Video className="h-4 w-4" /> Accept
          </button>
        </div>
      </Modal>
      {rtc === 'active' && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black pt-safe pb-safe" role="dialog" aria-label="Video call">
          <div className="relative flex-1">
            {remote ? <Stream stream={remote} className="h-full w-full object-cover" label="Partner video" /> : <div className="flex h-full items-center justify-center text-slate-400">Connecting…</div>}
            {local && <Stream stream={local} muted className="absolute bottom-3 right-3 h-36 w-24 rounded-xl border border-white/20 object-cover shadow-xl" label="Your video" />}
          </div>
          <div className="flex items-center justify-center gap-4 p-4">
            <button className="btn-ghost h-12 w-12 !rounded-full !p-0" onClick={call.toggleMic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}>
              {mic ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5 text-red-400" />}
            </button>
            <button className="btn-danger h-14 w-14 !rounded-full !p-0" onClick={call.hangup} aria-label="End call">
              <PhoneOff className="h-6 w-6" />
            </button>
            <button className="btn-ghost h-12 w-12 !rounded-full !p-0" onClick={call.toggleCam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'}>
              {cam ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5 text-red-400" />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
