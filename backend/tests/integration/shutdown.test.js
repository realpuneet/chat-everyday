import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { HAS_MONGO } from '../helpers/harness.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_MONGO)('graceful shutdown', () => {
  it('SIGTERM: /readyz flips to 503, sockets are told, process exits 0 within the deadline', async () => {
    const port = 4100 + Math.floor(Math.random() * 500);
    const u = new URL(process.env.TEST_MONGO_URI);
    u.pathname = `/ce_shutdown_${process.pid}`;
    const child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), MONGO_URI: u.toString(), REDIS_URL: process.env.REDIS_URL, LOG_LEVEL: 'silent', DISABLE_SWEEPER: 'true' },
      stdio: 'ignore',
    });
    const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/readyz`).then((r) => r.ok, () => false);
      if (!up) await sleep(250);
    }
    expect(up).toBe(true);

    const { io } = await import('socket.io-client');
    const g = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': 'shutdowndev01' }, body: JSON.stringify({ dob: '1990-01-01', ageConfirmed: true }) }).then((r) => r.json());
    const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { token: g.accessToken, deviceId: 'shutdowndev01' }, reconnection: false });
    await new Promise((r) => s.once('session:ready', r));
    const notice = new Promise((r) => s.once('server:shutdown', r));
    const closed = new Promise((r) => s.once('disconnect', r));

    const t0 = Date.now();
    child.kill('SIGTERM');
    expect(await notice).toMatchObject({ reconnectInMs: expect.any(Number) });
    await closed;
    const res = await exited;
    expect(res.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    s.close();
  }, 40_000);
});
