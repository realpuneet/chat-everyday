import { config } from '../config/env.js';

const SLOT_RE = /^[a-z0-9]{6,24}$/;
export const cookieName = (slot) => `rt_${slot}`;

/**
 * Refresh cookies are namespaced per "slot" (a random id each browser TAB generates in sessionStorage).
 * That keeps several accounts / tabs in ONE browser from overwriting each other's session.
 */
export function readSlot(req) {
  const slot = String(req.headers['x-session-slot'] || '');
  return SLOT_RE.test(slot) ? slot : null;
}

export function setRefreshCookie(res, slot, refresh) {
  if (!slot || !refresh) return;
  res.cookie(cookieName(slot), refresh.token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: '/api/auth',
    maxAge: refresh.maxAgeMs,
  });
}

export function clearRefreshCookie(res, slot) {
  if (!slot) return;
  res.clearCookie(cookieName(slot), { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SAMESITE, path: '/api/auth' });
}

export function sessionResponse(res, slot, session) {
  setRefreshCookie(res, slot, session.refresh);
  const { refresh: _r, ...body } = session;
  res.json(body);
}

export const authController = (svc) => ({
  guest: async (req, res) => {
    const s = await svc.auth.createGuest(req.body, req.client);
    sessionResponse(res, readSlot(req), s);
  },
  guestRefresh: async (req, res) => {
    const s = await svc.auth.refreshGuest(String(req.user._id), req.client);
    res.json(s);
  },
  me: async (req, res) => {
    res.json({ user: req.user.toPublicSelf() });
  },
  updateMe: async (req, res) => {
    res.json({ user: await svc.auth.updateProfile(String(req.user._id), req.body) });
  },
});
