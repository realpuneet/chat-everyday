import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import gsap from 'gsap';
import { MessageCircle, Users, ShieldCheck, EyeOff, Zap, Sparkles } from 'lucide-react';
import { get } from '../lib/api.js';
import { startGuest } from '../lib/session.js';
import { useReducedMotion, useDocumentTitle } from '../hooks/hooks.js';
import { useSmoothScroll } from '../hooks/useSmoothScroll.js';
import { Spinner, ErrorText } from '../components/ui.jsx';
import { Footer } from './Legal.jsx';

const FEATURES = [
  { icon: Zap, title: 'Instant random chat', text: 'One tap to match with someone new. Add interests to find people who like what you like.' },
  { icon: Users, title: 'Anonymous group rooms', text: 'Join interest rooms or create your own. Every room gives you a fresh random alias.' },
  { icon: EyeOff, title: 'Private by default', text: 'No chats stored on our servers. Photos are blurred, location data is stripped, view-once supported.' },
  { icon: ShieldCheck, title: 'Safety tools built in', text: 'Report, block and mute in one tap. 18+ only, with moderators and automated protection.' },
];

export default function Landing() {
  useDocumentTitle();
  useSmoothScroll();
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const root = useRef(null);
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stats = useQuery({ queryKey: ['public-stats'], queryFn: () => get('/api/stats/public', { auth: false }), refetchInterval: 15_000 });

  useEffect(() => {
    if (reduce || !root.current) return undefined;
    const ctx = gsap.context(() => {
      gsap.from('[data-hero]', { y: 28, opacity: 0, duration: 0.8, stagger: 0.12, ease: 'power3.out' });
      gsap.from('[data-feature]', { y: 36, opacity: 0, duration: 0.7, stagger: 0.1, ease: 'power2.out', delay: 0.5 });
      gsap.to('[data-orb]', { y: -18, repeat: -1, yoyo: true, duration: 3.2, ease: 'sine.inOut', stagger: 0.6 });
    }, root);
    return () => ctx.revert();
  }, [reduce]);

  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      await startGuest({ nickname: nick.trim() || undefined });
      nav('/chat');
    } catch (e) {
      setErr(e.code === 'UNDERAGE' || e.code === 'AGE_BLOCKED' ? 'You must be 18+ to use this service.' : e.message);
      if (e.code === 'SIGNUP_REQUIRED' || e.code === 'RISK_SIGNIN_REQUIRED') nav('/signup');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="min-h-screen overflow-x-hidden pt-safe">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-safe py-4">
        <span className="flex items-center gap-2 font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-accent-500">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
          </span>
          Chat Everyday
        </span>
        <nav className="flex items-center gap-2" aria-label="Account">
          <Link to="/login" className="btn-ghost btn-sm">
            Log in
          </Link>
          <Link to="/signup" className="btn-primary btn-sm">
            Sign up
          </Link>
        </nav>
      </header>

      <section className="relative mx-auto max-w-5xl px-safe pb-14 pt-8 text-center sm:pt-16">
        <div data-orb className="pointer-events-none absolute -left-10 top-10 h-48 w-48 rounded-full bg-brand-600/25 blur-3xl" aria-hidden="true" />
        <div data-orb className="pointer-events-none absolute -right-10 top-32 h-56 w-56 rounded-full bg-accent-500/20 blur-3xl" aria-hidden="true" />
        <p data-hero className="chip mx-auto mb-4">
          <Sparkles className="h-3.5 w-3.5 text-accent-400" aria-hidden="true" /> {stats.data ? `${stats.data.online} online now` : '18+ community'}
        </p>
        <h1 data-hero className="text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
          Talk to someone <span className="bg-gradient-to-r from-brand-400 to-accent-400 bg-clip-text text-transparent">new</span>, anonymously.
        </h1>
        <p data-hero className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
          Random 1-to-1 chats and anonymous group rooms for adults. No profile needed. Start as a guest in one tap.
        </p>
        <div data-hero className="mx-auto mt-8 max-w-sm space-y-3">
          <label htmlFor="nick" className="sr-only">
            Nickname (optional)
          </label>
          <input id="nick" className="input text-center" placeholder="Nickname (optional, random if empty)" maxLength={24} value={nick} onChange={(e) => setNick(e.target.value)} />
          <button className="btn-primary w-full py-3 text-base" onClick={go} disabled={busy}>
            {busy ? <Spinner /> : 'Start chatting as guest'}
          </button>
          <ErrorText>{err}</ErrorText>
          <p className="text-xs text-slate-500">
            Guests can chat and share photos (limited). <Link className="link" to="/signup">Create an account</Link> to save chats, create rooms and send more photos.
          </p>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-3 px-safe pb-14 sm:grid-cols-2" aria-label="Features">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <article key={title} data-feature className="card">
            <Icon className="mb-2 h-6 w-6 text-brand-400" aria-hidden="true" />
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-slate-400">{text}</p>
          </article>
        ))}
      </section>

      <section className="mx-auto max-w-3xl px-safe pb-10 text-center text-sm text-slate-500">
        <p>Strangers online can be anyone. Gender in rooms is self-declared and not verified. Never share money, passwords or private photos. Screenshots of photos cannot be reliably prevented on the web.</p>
      </section>
      <Footer />
    </div>
  );
}
