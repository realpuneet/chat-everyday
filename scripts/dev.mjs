// One command for local development: starts the API (with inline image worker) and the Vite dev server.
//   npm run dev        (needs MongoDB + Redis: `npm run db:up` starts them with Docker)
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const wait = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const [mongo, redis] = await Promise.all([wait(27017), wait(6379)]);
if (!mongo || !redis) {
  console.error(`\n  ${mongo ? '✓' : '✗'} MongoDB :27017    ${redis ? '✓' : '✗'} Redis :6379\n  Start them with:  npm run db:up   (Docker)  or install/run mongod and redis-server yourself.\n`);
  process.exit(1);
}
const run = (name, cwd, cmd) => {
  const p = spawn('npm', ['run', cmd], { cwd: path.join(root, cwd), stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (c) => {
    console.log(`[${name}] exited (${c})`);
    process.exit(c ?? 0);
  });
  return p;
};
console.log('\n  API      http://localhost:4000\n  Web app  http://localhost:5173   <- open this\n');
const procs = [run('api', 'backend', 'dev'), run('web', 'frontend', 'dev')];
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
