import { config } from '../config/env.js';
import { unauthorized } from '../utils/errors.js';

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

export const readRefreshCookie = (req) => {
  const slot = readSlot(req);
  return slot ? { slot, token: req.cookies?.[cookieName(slot)] } : { slot: null, token: undefined };
};

export const authController = (svc) => ({
  guest: async (req, res) => {
    const s = await svc.auth.createGuest(req.body, req.client);
    sessionResponse(res, readSlot(req), s);
  },
  guestRefresh: async (req, res) => {
    const s = await svc.auth.refreshGuest(String(req.user._id), req.client);
    res.json(s);
  },
  signup: async (req, res) => {
    const s = await svc.auth.signupEmail(req.body, req.client, req.user);
    sessionResponse(res, readSlot(req), s);
  },
  login: async (req, res) => {
    const s = await svc.auth.loginEmail(req.body, req.client);
    sessionResponse(res, readSlot(req), s);
  },
  google: async (req, res) => {
    const s = await svc.auth.loginGoogle(req.body, req.client, req.user);
    sessionResponse(res, readSlot(req), s);
  },
  phoneRequest: async (req, res) => {
    res.json(await svc.auth.phoneRequest(req.body, req.client));
  },
  phoneVerify: async (req, res) => {
    const s = await svc.auth.phoneVerify(req.body, req.client, req.user);
    sessionResponse(res, readSlot(req), s);
  },
  refresh: async (req, res) => {
    const { slot, token } = readRefreshCookie(req);
    if (!slot) throw unauthorized('Missing session slot');
    try {
      const s = await svc.auth.refresh(token, req.client);
      sessionResponse(res, slot, s);
    } catch (e) {
      clearRefreshCookie(res, slot);
      throw e;
    }
  },
  logout: async (req, res) => {
    const { slot, token } = readRefreshCookie(req);
    await svc.auth.logout(token);
    clearRefreshCookie(res, slot);
    res.json({ ok: true });
  },
  logoutAll: async (req, res) => {
    await svc.auth.logoutAll(String(req.user._id));
    clearRefreshCookie(res, readSlot(req));
    res.json({ ok: true });
  },
  devices: async (req, res) => {
    const devices = await svc.presence.devicesOf(String(req.user._id));
    res.json({ devices: devices.map((d) => ({ socketId: d.socketId, deviceId: d.did ? `${d.did.slice(0, 4)}…` : null, since: Number(d.at) || null })) });
  },
  me: async (req, res) => {
    res.json({ user: req.user.toPublicSelf() });
  },
  updateMe: async (req, res) => {
    res.json({ user: await svc.auth.updateProfile(String(req.user._id), req.body) });
  },
});
