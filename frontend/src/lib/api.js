import { useAuth } from './auth.js';
import { getDeviceId, getSlot, getFingerprint } from './device.js';

const BASE = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.message || `Request failed (${status})`);
    this.status = status;
    this.code = e.code || 'ERROR';
    this.details = e.details || {};
  }
}

/** Optional admin 2FA (TOTP) code, kept in memory only and sent with /api/admin requests. */
export const adminOtp = { code: '' };

let refresher = null;
/** session.js registers the single-flight refresh function (avoids an import cycle). */
export const setRefresher = (fn) => {
  refresher = fn;
};

async function baseHeaders(auth) {
  const h = { 'x-device-id': getDeviceId(), 'x-session-slot': getSlot(), 'x-fp': await getFingerprint() };
  const token = useAuth.getState().token;
  if (auth && token) h.authorization = `Bearer ${token}`;
  return h;
}

export async function api(path, { method = 'GET', body, auth = true, headers = {}, signal, retry = true, token } = {}) {
  const h = { ...(await baseHeaders(auth)), ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (adminOtp.code && path.startsWith('/api/admin')) h['x-admin-otp'] = adminOtp.code;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) h['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body),
      credentials: 'include',
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Network error. Check your connection.' } });
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && err.details?.expired && retry && auth && refresher) {
      const ok = await refresher().catch(() => false);
      if (ok) return api(path, { method, body, auth, headers, signal, retry: false });
    }
    throw err;
  }
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { method: 'POST', body, ...o });
export const put = (p, body, o) => api(p, { method: 'PUT', body, ...o });
export const patch = (p, body, o) => api(p, { method: 'PATCH', body, ...o });
export const del = (p, o) => api(p, { method: 'DELETE', ...o });

export const apiUrl = (p) => `${BASE}${p}`;
