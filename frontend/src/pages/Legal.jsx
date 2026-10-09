import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { post } from '../lib/api.js';
import { useSmoothScroll } from '../hooks/useSmoothScroll.js';
import { useDocumentTitle } from '../hooks/hooks.js';
import { Field, ErrorText, Spinner } from '../components/ui.jsx';

export function Footer() {
  return (
    <footer className="border-t border-white/5 px-safe py-6 pb-safe text-center text-xs text-slate-500">
      <p className="mb-2">Chat Everyday · 18+ only</p>
      <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1" aria-label="Legal">
        <Link className="link" to="/terms">Terms</Link>
        <Link className="link" to="/privacy">Privacy</Link>
        <Link className="link" to="/grievance">Grievance Officer</Link>
        <Link className="link" to="/takedown">Report / Takedown</Link>
      </nav>
    </footer>
  );
}

function Shell({ title, children }) {
  useSmoothScroll();
  useDocumentTitle(title);
  return (
    <div className="min-h-screen pt-safe">
      <div className="mx-auto max-w-2xl px-safe py-6">
        <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200" onClick={(e) => window.history.length > 1 && (e.preventDefault(), window.history.back())}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Link>
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200" role="note">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <strong>PLACEHOLDER TEXT.</strong> This page is a template, not legal advice. Replace it with content reviewed by a cyber-law lawyer before launch (see <code>docs/legal.md</code>).
          </p>
        </div>
        <h1 className="h-page mb-4">{title}</h1>
        <article className="space-y-4 text-[15px] leading-relaxed text-slate-300">{children}</article>
      </div>
      <Footer />
    </div>
  );
}

const H = ({ children }) => <h2 className="pt-2 text-lg font-semibold text-slate-100">{children}</h2>;

export function Terms() {
  return (
    <Shell title="Terms of Service">
      <p>Last updated: [DATE]. Operator: [LEGAL ENTITY NAME], [ADDRESS].</p>
      <H>1. Who may use this service</H>
      <p>You must be at least 18 years old. By using the service you confirm that you are an adult. We may end any session we suspect belongs to a minor, and we ban such accounts and devices.</p>
      <H>2. What is not allowed</H>
      <ul className="list-disc space-y-1 pl-5">
        <li>Any sexual or intimate content involving a minor (reported to the authorities).</li>
        <li>Sharing intimate images of anyone without their consent; blackmail or sextortion.</li>
        <li>Threats of violence, harassment, doxxing (publishing private information), trafficking or exploitation.</li>
        <li>Spam, scams, impersonation, illegal goods or services, and attempts to evade a ban.</li>
      </ul>
      <p>These rules apply everywhere, including rooms marked 18+, and cannot be switched off by anyone.</p>
      <H>3. Adult content</H>
      <p>Conversation between consenting adults may be permitted in rooms marked 18+. Photos are blurred until the recipient taps. We use automated checks and human review and may remove content or restrict accounts at any time.</p>
      <H>4. Photos and screenshots</H>
      <p>We use view-once, timers, blurring and watermarks to discourage copying, but <strong>screenshots and screen recordings cannot be reliably prevented on the web</strong>. Only send photos you are comfortable with, and never share a photo of someone else without their permission.</p>
      <H>5. Gender and identity</H>
      <p>Gender, identity and "LGBTQ+" settings are <strong>self-declared and not verified</strong>. Do not rely on them to judge who someone really is.</p>
      <H>6. Safety advice</H>
      <p>People online may not be who they say they are. Do not share money, passwords, OTPs, addresses or private photos. Use Report and Block at any time.</p>
      <H>7. Moderation and termination</H>
      <p>We may suspend or terminate access, with or without notice, for breaking these terms or the law. Bans can apply to your account, device and network.</p>
      <H>8. Disclaimers and liability</H>
      <p>[Placeholder: warranty disclaimer, limitation of liability, indemnity, governing law and jurisdiction — to be drafted by counsel.]</p>
      <H>9. Contact</H>
      <p>See the <Link className="link" to="/grievance">Grievance Officer</Link> page.</p>
    </Shell>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy Policy">
      <p>Last updated: [DATE]. Data fiduciary: [LEGAL ENTITY NAME].</p>
      <H>What we store</H>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Chats:</strong> not stored. Messages exist only briefly in a temporary buffer (so you can reconnect and so a report can include the last messages). They are stored permanently only if (a) both people choose "Save chat" (encrypted, deletable), or (b) a report is filed (kept as evidence for review).</li>
        <li><strong>Photos:</strong> checked automatically, stripped of location data, deleted after a short period. A photo is kept only if it is reported.</li>
        <li><strong>Account data:</strong> email (if you sign up with it), a one-way hash of your phone number, your Google account ID (if used), nickname and the settings you choose.</li>
        <li><strong>Date of birth:</strong> checked on your device and not saved by us; we store only that you declared you are an adult.</li>
        <li><strong>Technical/safety data:</strong> hashed IP address and device identifiers used to stop abuse and ban evasion.</li>
      </ul>
      <H>Why</H>
      <p>To run the service, keep it safe, comply with law and respond to legal requests. [Placeholder: lawful bases / consent notices under the DPDP Act 2023.]</p>
      <H>Retention</H>
      <p>Reports and audit logs: [PERIOD]. Saved chats: 30 days by default. Bans: until lifted or for the ban duration. Guest accounts: deleted within a day after the session.</p>
      <H>Your rights</H>
      <p>You can access, correct and delete your data, withdraw consent and raise a grievance: see <Link className="link" to="/grievance">Grievance Officer</Link>.</p>
      <H>Sharing</H>
      <p>We use infrastructure and SMS/verification providers: [LIST]. We may disclose data to authorities where legally required.</p>
    </Shell>
  );
}

export function Grievance() {
  return (
    <Shell title="Grievance Officer">
      <p>In line with the IT Rules, 2021, complaints can be sent to our Grievance Officer. We acknowledge within 24 hours and aim to resolve within 15 days (placeholder: confirm timelines with counsel).</p>
      <dl className="card space-y-1 text-sm">
        <div><dt className="inline font-semibold">Name:</dt> <dd className="inline">[GRIEVANCE OFFICER NAME]</dd></div>
        <div><dt className="inline font-semibold">Email:</dt> <dd className="inline">[grievance@your-domain.example]</dd></div>
        <div><dt className="inline font-semibold">Address:</dt> <dd className="inline">[POSTAL ADDRESS]</dd></div>
        <div><dt className="inline font-semibold">Hours:</dt> <dd className="inline">[Mon–Fri, 10:00–17:00 IST]</dd></div>
      </dl>
      <p>To report illegal content, intimate images shared without consent or anything urgent, please use the <Link className="link" to="/takedown">takedown form</Link>. Content involving minors is escalated immediately.</p>
      <p>If you were banned by mistake, write to the Grievance Officer with the reference shown on the ban screen.</p>
    </Shell>
  );
}

export function Takedown() {
  const [f, setF] = useState({ requesterName: '', requesterContact: '', category: 'nonconsensual', reference: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      setDone(await post('/api/takedown', { ...f, requesterName: f.requesterName || undefined, reference: f.reference || undefined }, { auth: false }));
    } catch (ex) {
      setErr(ex.details?.issues?.[0]?.message || ex.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Report content / takedown request">
      <p>Use this form to ask us to remove content, for example intimate images shared without your consent, impersonation or privacy violations. Requests about non-consensual intimate images are prioritised for removal within 24 hours.</p>
      {done ? (
        <div className="card" role="status">
          <p className="font-semibold text-emerald-300">Request received</p>
          <p className="mt-1 text-sm">Ticket: <code>{done.ticket}</code>. Target resolution: {new Date(done.dueAt).toLocaleString()}.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="card">
          <Field label="Type of request" htmlFor="tc">
            <select id="tc" className="input" value={f.category} onChange={set('category')}>
              <option value="nonconsensual">Intimate images shared without my consent</option>
              <option value="csam">Sexual content involving a minor</option>
              <option value="impersonation">Impersonation</option>
              <option value="privacy">Privacy / personal information</option>
              <option value="copyright">Copyright</option>
              <option value="grievance">General grievance</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Your name (optional)" htmlFor="tn">
            <input id="tn" className="input" maxLength={100} value={f.requesterName} onChange={set('requesterName')} />
          </Field>
          <Field label="Your email or phone (so we can reply)" htmlFor="tcontact">
            <input id="tcontact" className="input" required minLength={5} maxLength={200} value={f.requesterContact} onChange={set('requesterContact')} />
          </Field>
          <Field label="Where is the content? (room name, chat time, image ID…)" htmlFor="tr">
            <input id="tr" className="input" maxLength={500} value={f.reference} onChange={set('reference')} />
          </Field>
          <Field label="Describe the problem" htmlFor="td">
            <textarea id="td" className="input min-h-[110px]" required minLength={10} maxLength={2000} value={f.description} onChange={set('description')} />
          </Field>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? <Spinner /> : 'Submit request'}
          </button>
          <ErrorText>{err}</ErrorText>
        </form>
      )}
    </Shell>
  );
}
