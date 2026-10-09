// Static checks: syntax (node --check), unused / undefined identifiers (eslint no-unused-vars + no-undef).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(f)) files.push(p);
  }
};
['src', 'tests', 'scripts'].forEach((d) => walk(path.join(root, d)));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`SYNTAX ERROR ${path.relative(root, f)}\n${e.stderr}`);
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);

try {
  execFileSync('npx', ['eslint', 'src', 'tests', 'scripts', '--max-warnings=0'], { cwd: root, stdio: 'inherit' });
  console.log('eslint (no-unused-vars, no-undef, recommended): OK');
} catch {
  failed++;
}
process.exit(failed ? 1 : 0);
