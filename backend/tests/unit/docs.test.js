import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_KEYS } from '../../src/config/env.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('documentation stays in sync with the code', () => {
  it('every environment variable is in backend/.env.example and docs/environment.md', () => {
    const example = read('backend/.env.example');
    const doc = read('docs/environment.md');
    for (const k of ENV_KEYS) {
      expect(example, `.env.example missing ${k}`).toMatch(new RegExp(`^${k}=`, 'm'));
      expect(doc, `docs/environment.md missing ${k}`).toContain(k);
    }
  });

  it('every HTTP route found in src/routes is documented in docs/openapi.json', () => {
    const spec = JSON.parse(read('docs/openapi.json'));
    const mounts = { 'auth.js': '/auth', 'rooms.js': '/rooms', 'admin.js': '/admin', 'images.js': '/images', 'safety.js': '' };
    const found = [];
    for (const [file, prefix] of Object.entries(mounts)) {
      const src = fs.readFileSync(path.join(root, 'backend/src/routes', file), 'utf8');
      for (const m of src.matchAll(/\br\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) found.push([m[1], `${prefix}${m[2]}`.replace(/:(\w+)/g, '{$1}').replace(/\/\*$/, '/{key}')]);
    }
    const idx = fs.readFileSync(path.join(root, 'backend/src/routes/index.js'), 'utf8');
    for (const m of idx.matchAll(/r\.(get|post)\(\s*'([^']+)'/g)) found.push([m[1], m[2]]);
    expect(found.length).toBeGreaterThan(40);
    const norm = (p) => `/api${p}`.replace(/(.)\/$/, '$1');
    const missing = found.filter(([method, p]) => !spec.paths[norm(p)]?.[method]).map(([m, p]) => `${m.toUpperCase()} ${norm(p)}`);
    expect(missing).toEqual([]);
  });

  it('docs mention the non-negotiable policy and honest limits', () => {
    const legal = read('docs/legal.md');
    expect(legal).toMatch(/not legal advice/i);
    expect(legal).toMatch(/IT Act/);
    expect(legal).toMatch(/DPDP/);
    expect(read('README.md')).toMatch(/Verification status/);
    expect(read('README.md')).toMatch(/FLAG_SECURE/);
  });
});
