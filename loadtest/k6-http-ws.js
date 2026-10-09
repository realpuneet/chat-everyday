// k6 scenario template (NOT executed in the authoring environment). Install k6, run against STAGING:
//   k6 run -e BASE=http://localhost:8080 loadtest/k6-http-ws.js
// The API must run with RATE_LIMIT_MULTIPLIER raised, otherwise per-IP limits will (correctly) throttle the test.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

export const options = {
  scenarios: { chatters: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 500 }, { duration: '3m', target: 500 }, { duration: '30s', target: 0 }] } },
  thresholds: { http_req_failed: ['rate<0.01'], match_ms: ['p(95)<1500'], ack_ms: ['p(95)<250'] },
};
const BASE = __ENV.BASE || 'http://localhost:4000';
const matchMs = new Trend('match_ms');
const ackMs = new Trend('ack_ms');
const sent = new Counter('msgs_sent');

export default function () {
  const dev = `k6_${__VU}_${__ITER}_${Date.now()}`;
  const res = http.post(`${BASE}/api/auth/guest`, JSON.stringify({ dob: '1990-01-01', ageConfirmed: true }), { headers: { 'content-type': 'application/json', 'x-device-id': dev, 'x-forwarded-for': `10.${__VU % 250}.${__ITER % 250}.${(__VU % 250) + 1}` } });
  if (!check(res, { 'guest ok': (r) => r.status === 200 })) return;
  const token = res.json('accessToken');
  const url = `${BASE.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`;
  ws.connect(url, {}, (socket) => {
    let t0 = 0, chatId = null, ackId = 1;
    const pending = {};
    socket.on('message', (m) => {
      if (m.startsWith('0')) socket.send(`40${JSON.stringify({ token, deviceId: dev })}`); // Engine.IO open -> Socket.IO CONNECT with auth
      else if (m === '2') socket.send('3'); // ping/pong
      else if (m.startsWith('40')) { t0 = Date.now(); socket.send(`42${ackId++}["match:start",{}]`); }
      else if (m.startsWith('42')) {
        const [ev, payload] = JSON.parse(m.slice(2));
        if (ev === 'match:found' && !chatId) { chatId = payload.chatId; matchMs.add(Date.now() - t0); }
      } else if (m.startsWith('43')) { const id = parseInt(m.slice(2), 10); if (pending[id]) { ackMs.add(Date.now() - pending[id]); delete pending[id]; } }
    });
    socket.setInterval(() => {
      if (!chatId) return;
      const id = ackId++; pending[id] = Date.now();
      socket.send(`42${id}["chat:send",{"chatId":"${chatId}","clientMsgId":"k${__VU}${id}${Date.now()}","text":"hello from k6"}]`);
      sent.add(1);
    }, 1500);
    socket.setTimeout(() => socket.close(), 60000);
  });
  sleep(1);
}
