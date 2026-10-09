import { config } from '../../config/env.js';
import { K } from '../../config/redis.js';
import { hamming } from '../../utils/phash.js';

/**
 * Pluggable image moderation hooks. Both default to DRY-RUN.
 *
 * NSFW classifier contract (provider `http`):
 *   POST {MODERATION_HTTP_URL}  body = image bytes (image/jpeg), Authorization: Bearer {MODERATION_HTTP_KEY}
 *   -> { nsfw: 0..1, minorRisk?: 0..1 }
 * Hash-match contract (provider `http`, e.g. a PhotoDNA / StopNCII / NCMEC-fed service):
 *   POST {HASHMATCH_HTTP_URL}  {sha256, phash} -> { match: boolean, source?: string }
 *
 * The local blocklist (Redis sets, fed by admin takedowns of confirmed illegal content) is ALWAYS consulted,
 * regardless of provider, so even dry-run deployments block re-uploads of removed material.
 */
export function createNsfwClassifier(cfg = config) {
  if (cfg.MODERATION_PROVIDER === 'http' && cfg.MODERATION_HTTP_URL) {
    return {
      name: 'http',
      async classify(buffer) {
        const r = await fetch(cfg.MODERATION_HTTP_URL, {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg', ...(cfg.MODERATION_HTTP_KEY ? { authorization: `Bearer ${cfg.MODERATION_HTTP_KEY}` } : {}) },
          body: buffer,
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`moderation provider ${r.status}`);
        const j = await r.json();
        return { nsfw: Number(j.nsfw) || 0, minorRisk: Number(j.minorRisk) || 0 };
      },
    };
  }
  return { name: 'dryrun', dryRun: true, classify: async () => ({ nsfw: 0, minorRisk: 0, dryRun: true }) };
}

export function createHashMatcher(cfg = config, redis) {
  const local = async ({ sha256, phash }, maxDistance) => {
    if (await redis.sismember(K.badHashes, `sha256:${sha256}`)) return { match: true, source: 'local-sha256', distance: 0 };
    for (const p of await redis.smembers(`${K.badHashes}:phash`)) {
      const d = hamming(p, phash);
      if (d <= maxDistance) return { match: true, source: 'local-phash', distance: d };
    }
    return { match: false };
  };
  const remote =
    cfg.HASHMATCH_PROVIDER === 'http' && cfg.HASHMATCH_HTTP_URL
      ? async (h) => {
          const r = await fetch(cfg.HASHMATCH_HTTP_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg.HASHMATCH_HTTP_KEY ? { authorization: `Bearer ${cfg.HASHMATCH_HTTP_KEY}` } : {}) },
            body: JSON.stringify(h),
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error(`hash-match provider ${r.status}`);
          const j = await r.json();
          return j.match ? { match: true, source: j.source || 'provider' } : { match: false };
        }
      : null;
  return {
    name: remote ? 'http+local' : 'dryrun+local',
    dryRun: !remote,
    async check(h, maxDistance = 6) {
      const l = await local(h, maxDistance);
      if (l.match) return l;
      return remote ? remote(h) : { match: false };
    },
    async addKnownBad({ sha256, phash }) {
      if (sha256) await redis.sadd(K.badHashes, `sha256:${sha256}`);
      if (phash) await redis.sadd(`${K.badHashes}:phash`, phash);
    },
  };
}
