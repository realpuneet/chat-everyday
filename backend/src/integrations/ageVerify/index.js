import crypto from 'node:crypto';
import { config } from '../../config/env.js';
import { badRequest, forbidden } from '../../utils/errors.js';

/**
 * Optional STRICT age-verification provider hook for adult rooms (document / selfie / carrier based).
 * Contract for provider `http`:
 *   POST {AGE_VERIFY_HTTP_URL}/sessions  {userRef}            -> {sessionId, url}
 *   webhook -> POST /api/age/webhook (raw body) header x-signature = hex HMAC-SHA256(body, AGE_VERIFY_HTTP_KEY)
 *              body {sessionId, userRef, verified: true|false}
 * Default `dryrun` lets a developer "verify" instantly (disabled in production).
 */
export function createAgeVerifier(cfg = config) {
  if (cfg.AGE_VERIFY_PROVIDER === 'http' && cfg.AGE_VERIFY_HTTP_URL) {
    return {
      name: 'http',
      async start(userRef) {
        const r = await fetch(`${cfg.AGE_VERIFY_HTTP_URL}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.AGE_VERIFY_HTTP_KEY}` },
          body: JSON.stringify({ userRef }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw badRequest('Age verification provider unavailable');
        const j = await r.json();
        return { mode: 'redirect', url: j.url, sessionId: j.sessionId };
      },
      verifyWebhook(rawBody, signature) {
        const expected = crypto.createHmac('sha256', cfg.AGE_VERIFY_HTTP_KEY).update(rawBody).digest('hex');
        const a = Buffer.from(expected);
        const b = Buffer.from(String(signature || ''));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw forbidden('Bad signature');
        return JSON.parse(rawBody.toString('utf8'));
      },
    };
  }
  return {
    name: 'dryrun',
    dryRun: true,
    async start(userRef) {
      if (!cfg.demo) throw forbidden('Age verification provider is not configured');
      return { mode: 'dryrun', sessionId: `dry_${userRef}`, url: null };
    },
    verifyWebhook() {
      throw forbidden('Webhook disabled in dry-run mode');
    },
  };
}
