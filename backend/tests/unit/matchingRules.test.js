import { describe, it, expect } from 'vitest';
import { isCompatible, pickBest, tagOverlap, genderCompatible, normalizeTags, isFallback } from '../../src/services/matchingRules.js';
import { CASES } from '../fixtures/matchCases.js';

const NOW = 1_000_000;

describe('matching rules (reference model)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const me = { uid: 'me', at: NOW - 1000, ...c.me };
      const cand = { uid: 'cand', at: NOW - 500, ...c.cand };
      const ctx = { now: NOW, blocked: () => !!c.blocked, cooledDown: () => !!c.cooldown };
      expect(isCompatible(me, cand, ctx)).toBe(c.expect);
    });
  }

  it('prefers more tag overlap, then longest waiting', () => {
    const me = { uid: 'me', tags: ['a', 'b'], lang: '', gender: 'male', pref: 'any', at: 0, fallbackAt: 99 };
    const mk = (uid, tags, at) => ({ uid, tags, lang: '', gender: 'female', pref: 'any', at, fallbackAt: 99 });
    const best = pickBest(me, [mk('x', ['a'], 1), mk('y', ['a', 'b'], 5), mk('z', ['a', 'b'], 3)], { now: 10 });
    expect(best.uid).toBe('z');
  });

  it('never matches a user with themself', () => {
    const t = { uid: 'u', tags: [], lang: '', gender: 'male', pref: 'any', at: 0, fallbackAt: 0 };
    expect(isCompatible(t, t, { now: 1 })).toBe(false);
  });

  it('helpers', () => {
    expect(tagOverlap({ tags: ['a', 'b'] }, { tags: ['b', 'c'] })).toEqual(['b']);
    expect(genderCompatible({ pref: 'female', gender: 'male' }, { pref: 'male', gender: 'female' })).toBe(true);
    expect(genderCompatible({ pref: 'female', gender: 'male' }, { pref: 'female', gender: 'female' })).toBe(false);
    expect(isFallback({ tags: [], fallbackAt: 100 }, 0)).toBe(true);
    expect(isFallback({ tags: ['x'], fallbackAt: 100 }, 50)).toBe(false);
  });

  it('normalizes tags: lowercase, strips #, dedupes, caps at 5, drops invalid', () => {
    expect(normalizeTags(['#Cricket', 'cricket', 'MUSIC', 'bad tag!', 'a', 'b', 'c', 'd', 'e'])).toEqual(['cricket', 'music', 'a', 'b', 'c']);
  });
});
