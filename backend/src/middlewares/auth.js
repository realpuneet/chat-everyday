import { unauthorized, forbidden } from '../utils/errors.js';
import { verifyTotp } from '../utils/crypto.js';

export function makeAuth({ tokens, authService, bans }) {
  async function authenticate(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const claims = tokens.verifyAccess(token);
    const user = await authService.getUser(claims.userId);
    await bans.assertNotBanned({ userId: String(user._id), ipHash: req.client?.ipHash, deviceHash: req.client?.deviceHash });
    req.auth = claims;
    req.user = user;
    return user;
  }

  return {
    requireAuth: (req, _res, next) => authenticate(req).then(() => next(), next),
    optionalAuth: (req, _res, next) => {
      if (!req.headers.authorization) return next();
      return authenticate(req).then(() => next(), next);
    },
    requireRegistered: (req, _res, next) => {
      if (req.user?.kind !== 'registered') return next(forbidden('Sign up or log in to use this feature', { code: 'SIGNUP_REQUIRED' }));
      next();
    },
    requireAdmin: (req, _res, next) => {
      if (req.user?.role !== 'admin') return next(forbidden('Admin only'));
      // Optional 2FA hook: when the admin enabled TOTP, every admin request must carry a valid code.
      if (req.user.totpEnabled) {
        const code = req.headers['x-admin-otp'];
        if (!code || !verifyTotp(req.user.totpSecret, String(code))) return next(unauthorized('Admin 2FA code required', { code: 'ADMIN_2FA' }));
      }
      next();
    },
  };
}
