// Frontend static checks: (1) esbuild bundle of the whole app (catches syntax / missing imports),
// (2) eslint with no-unused-vars + no-undef + react-hooks rules, zero warnings allowed.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stub = { name: 'stub-virtual', setup: (b) => {
  b.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path, namespace: 'virtual' }));
  b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: 'export const registerSW = () => {}', loader: 'js' }));
} };
let failed = 0;
try {
  const r = await build({ entryPoints: [path.join(root, 'src/main.jsx')], bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty', '.js': 'jsx' }, plugins: [stub], logLevel: 'silent', metafile: true, minify: true });
  const kb = Object.values(r.metafile.outputs).reduce((n, o) => n + o.bytes, 0) / 1024;
  console.log(`esbuild bundle OK (${Object.keys(r.metafile.inputs).length} modules, ${kb.toFixed(0)} KB minified)`);
} catch (e) {
  failed++;
  console.error('esbuild bundle FAILED\n', e.errors?.map((x) => `${x.location?.file}:${x.location?.line} ${x.text}`).join('\n') || e.message);
}
try {
  execFileSync('npx', ['eslint', 'src', '--max-warnings=0'], { cwd: root, stdio: 'inherit' });
  console.log('eslint (unused/undefined identifiers, react-hooks): OK');
} catch {
  failed++;
}
process.exit(failed ? 1 : 0);
