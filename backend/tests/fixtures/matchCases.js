// Shared fixtures: run against the JS reference model (unit) AND the Redis Lua matcher (integration).
// `me` / `cand` tickets. fallbackAt is relative: 'past' means already in fallback mode.
const NOW = 1_000_000;
const PAST = NOW - 1;
const FUTURE = NOW + 100_000;
const t = (o) => ({ tags: [], lang: '', gender: 'male', pref: 'any', fallbackAt: PAST, ...o });

export const FIXTURE_NOW = NOW;

export const CASES = [
  { name: 'shared tag matches even before fallback', me: t({ tags: ['cricket'], fallbackAt: FUTURE }), cand: t({ tags: ['cricket', 'music'], fallbackAt: FUTURE }), expect: true },
  { name: 'different tags, neither in fallback -> no match', me: t({ tags: ['cricket'], fallbackAt: FUTURE }), cand: t({ tags: ['music'], fallbackAt: FUTURE }), expect: false },
  { name: 'different tags, only one in fallback -> no match', me: t({ tags: ['cricket'], fallbackAt: PAST }), cand: t({ tags: ['music'], fallbackAt: FUTURE }), expect: false },
  { name: 'different tags, both in fallback -> match', me: t({ tags: ['cricket'], fallbackAt: PAST }), cand: t({ tags: ['music'], fallbackAt: PAST }), expect: true },
  { name: 'no-tag users are always fallback-eligible', me: t({}), cand: t({}), expect: true },
  { name: 'no-tag user vs waiting tag user not yet in fallback -> no match', me: t({}), cand: t({ tags: ['music'], fallbackAt: FUTURE }), expect: false },
  { name: 'language mismatch blocks', me: t({ lang: 'hi' }), cand: t({ lang: 'en' }), expect: false },
  { name: 'language any matches specific', me: t({ lang: '' }), cand: t({ lang: 'en' }), expect: true },
  { name: 'same language matches', me: t({ lang: 'hi' }), cand: t({ lang: 'hi' }), expect: true },
  { name: 'gender preference satisfied both ways', me: t({ gender: 'male', pref: 'female' }), cand: t({ gender: 'female', pref: 'male' }), expect: true },
  { name: 'gender preference not mutual', me: t({ gender: 'male', pref: 'female' }), cand: t({ gender: 'female', pref: 'female' }), expect: false },
  { name: 'gender preference vs undisclosed candidate', me: t({ gender: 'male', pref: 'female' }), cand: t({ gender: 'undisclosed' }), expect: false },
  { name: 'blocked pair never matches', me: t({}), cand: t({}), blocked: true, expect: false },
  { name: 'recently matched pair (cooldown) never matches', me: t({}), cand: t({}), cooldown: true, expect: false },
];
