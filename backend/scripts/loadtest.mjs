// Small, dependency-light load generator (guests -> random matching -> chat) using the real client protocol.
//   API must run with RATE_LIMIT_MULTIPLIER=1000 (guest creation is IP limited).
//   node scripts/loadtest.mjs --users 400 --seconds 30 --url http://127.0.0.1:4000
import { io } from 'socket.io-client';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const N = Number(arg('users', 200));
const SECONDS = Number(arg('seconds', 20));
const URLS = arg('url', 'http://127.0.0.1:4000').split(',');
const URL_ = URLS[0]; // guests are created on the first instance; sockets are spread round-robin over ALL instances
const MSG_EVERY_MS = Number(arg('msgEveryMs', 1500));

const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const stats = { matched: 0, matchMs: [], ackMs: [], deliverMs: [], sent: 0, recv: 0, errors: 0, connectErrors: 0, rateLimited: 0 };

async function guest(i) {
  const device = `load_${Date.now().toString(36)}_${i}`;
  const r = await fetch(`${URL_}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': device, 'x-forwarded-for': `10.${(i >> 8) & 255}.${i & 255}.${1 + (i % 250)}` }, body: JSON.stringify({ dob: '1990-01-01', ageConfirmed: true }) });
  if (!r.ok) throw new Error(`guest ${r.status}`);
  return { token: (await r.json()).accessToken, device };
}

const sockets = [];
async function user(i) {
  const g = await guest(i);
  const s = io(URLS[i % URLS.length], { transports: ['websocket'], auth: { token: g.token, deviceId: g.device }, reconnection: false, forceNew: true });
  sockets.push(s);
  await new Promise((res, rej) => {
    s.once('session:ready', res);
    s.once('connect_error', rej);
  });
  let chatId = null;
  let timer;
  const t0 = Date.now();
  s.on('match:found', (m) => {
    if (chatId) return;
    chatId = m.chatId;
    stats.matched++;
    stats.matchMs.push(Date.now() - t0);
    timer = setInterval(() => {
      const sentAt = Date.now();
      s.emit('chat:send', { chatId, clientMsgId: `m${i}_${sentAt}_${Math.random().toString(36).slice(2, 8)}`, text: `t:${sentAt}` }, (ack) => {
        if (ack?.ok) stats.ackMs.push(Date.now() - sentAt);
        else if (ack?.error?.code === 'RATE_LIMITED') stats.rateLimited++;
        else stats.errors++;
      });
      stats.sent++;
    }, MSG_EVERY_MS + Math.floor(Math.random() * 300));
  });
  s.on('chat:msg', (m) => {
    stats.recv++;
    const t = /^t:(\d+)$/.exec(m.text || '');
    if (t) stats.deliverMs.push(Date.now() - Number(t[1]));
  });
  s.on('chat:ended', () => clearInterval(timer));
  s.emit('match:start', {}, () => {});
}

console.log(`load test: ${N} users, ${SECONDS}s, instances: ${URLS.join(', ')}`);
const started = Date.now();
const batch = 50;
for (let i = 0; i < N; i += batch) {
  await Promise.all(Array.from({ length: Math.min(batch, N - i) }, (_, k) => user(i + k).catch(() => stats.connectErrors++)));
}
console.log(`connected ${sockets.length}/${N} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const secs = (Date.now() - started) / 1000;
sockets.forEach((s) => s.close());
const fmt = (a) => `p50=${pct(a, 50)}ms p95=${pct(a, 95)}ms p99=${pct(a, 99)}ms (n=${a.length})`;
console.log(JSON.stringify({ users: N, connected: sockets.length, connectErrors: stats.connectErrors, matchedUsers: stats.matched, matchedPct: +((stats.matched / Math.max(1, sockets.length)) * 100).toFixed(1), sent: stats.sent, received: stats.recv, errors: stats.errors, rateLimited: stats.rateLimited, msgPerSec: +(stats.sent / secs).toFixed(1) }));
console.log('time to match :', fmt(stats.matchMs));
console.log('send ack      :', fmt(stats.ackMs));
console.log('end-to-end    :', fmt(stats.deliverMs));
process.exit(0);
