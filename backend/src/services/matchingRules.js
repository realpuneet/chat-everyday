// Pure reference implementation of the matching rules. The Lua script in config/lua.js mirrors
// this logic (tests/integration/matching.rules.test.js runs the same fixtures against both).

export const isFallback = (ticket, now) => ticket.tags.length === 0 || now >= ticket.fallbackAt;

export function tagOverlap(a, b) {
  const set = new Set(b.tags);
  return a.tags.filter((t) => set.has(t));
}

export function genderCompatible(a, b) {
  const aOk = a.pref === 'any' || a.pref === b.gender;
  const bOk = b.pref === 'any' || b.pref === a.gender;
  return aOk && bOk;
}

export function languageCompatible(a, b) {
  return !a.lang || !b.lang || a.lang === b.lang;
}

/**
 * @param me   ticket of the searching user
 * @param cand candidate ticket
 * @param ctx  { now, blocked: (a,b)=>bool, cooledDown: (a,b)=>bool }
 */
export function isCompatible(me, cand, ctx) {
  if (me.uid === cand.uid) return false;
  if (ctx.blocked?.(me.uid, cand.uid)) return false;
  if (ctx.cooledDown?.(me.uid, cand.uid)) return false;
  if (!languageCompatible(me, cand)) return false;
  if (!genderCompatible(me, cand)) return false;
  if (tagOverlap(me, cand).length > 0) return true;
  return isFallback(me, ctx.now) && isFallback(cand, ctx.now);
}

/** Higher overlap first, then longest waiting. Returns the best candidate or null. */
export function pickBest(me, candidates, ctx) {
  let best = null;
  let bestOv = -1;
  for (const c of candidates) {
    if (!isCompatible(me, c, ctx)) continue;
    const ov = tagOverlap(me, c).length;
    if (ov > bestOv || (ov === bestOv && c.at < best.at)) {
      best = c;
      bestOv = ov;
    }
  }
  return best;
}

export const normalizeTags = (tags = []) =>
  [...new Set(tags.map((t) => String(t).toLowerCase().trim().replace(/^#/, '')).filter((t) => /^[a-z0-9_-]{1,24}$/.test(t)))].slice(0, 5);
