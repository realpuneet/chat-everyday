import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config/env.js';
import { unauthorized } from '../../utils/errors.js';

/**
 * Verifies a Google Sign-In ID token ON THE SERVER. Never trust the profile sent by the client.
 * DRY-RUN (GOOGLE_CLIENT_ID blank, non-production only): accepts `dryrun:<email>` or `dryrun:<sub>:<email>`.
 */
export function createGoogleVerifier(cfg = config) {
  const client = cfg.GOOGLE_CLIENT_ID ? new OAuth2Client(cfg.GOOGLE_CLIENT_ID) : null;
  return {
    dryRun: !client,
    async verify(idToken) {
      if (!client) {
        if (!cfg.demo) throw unauthorized('Google sign-in is not configured');
        const m = /^dryrun:(?:([\w-]+):)?([^\s:@]+@[^\s:@]+)$/.exec(idToken);
        if (!m) throw unauthorized('Invalid Google token (dry-run expects "dryrun:<email>")');
        const email = m[2].toLowerCase();
        return { sub: m[1] || `dry_${Buffer.from(email).toString('hex').slice(0, 16)}`, email, emailVerified: true, name: email.split('@')[0] };
      }
      try {
        const ticket = await client.verifyIdToken({ idToken, audience: cfg.GOOGLE_CLIENT_ID });
        const p = ticket.getPayload();
        return { sub: p.sub, email: p.email?.toLowerCase(), emailVerified: !!p.email_verified, name: p.name };
      } catch {
        throw unauthorized('Invalid Google token');
      }
    },
  };
}
