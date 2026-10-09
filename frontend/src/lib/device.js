// Per-device and per-tab identifiers.
//  - deviceId: stable per browser profile (localStorage). Used for multi-device presence + ban/abuse signals.
//  - slot:     random per TAB (sessionStorage). Namespaces the refresh cookie so several accounts / tabs in one
//              browser never overwrite each other's session.

const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 2);

function safeGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store, key, val) {
  try {
    store.setItem(key, val);
  } catch {
    /* storage may be blocked (private mode); falls back to in-memory values below */
  }
}

let memDevice;
let memSlot;

export function getDeviceId() {
  const existing = safeGet(localStorage, 'ce_device');
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const id = `d_${rand(12)}`;
  memDevice ||= id;
  safeSet(localStorage, 'ce_device', memDevice);
  return memDevice;
}

export function getSlot() {
  const existing = safeGet(sessionStorage, 'ce_slot');
  if (existing && /^[a-z0-9]{6,24}$/.test(existing)) return existing;
  memSlot ||= rand(8);
  safeSet(sessionStorage, 'ce_slot', memSlot);
  return memSlot;
}

let fpPromise;
/** Coarse, non-invasive fingerprint (abuse signal only; never used to identify users to each other). */
export function getFingerprint() {
  fpPromise ||= (async () => {
    try {
      const raw = [navigator.userAgent, navigator.language, screen.width, screen.height, screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency || 0].join('|');
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch {
      return '';
    }
  })();
  return fpPromise;
}

// ---- age gate memory (DOB stays on the device; it is only sent with the signup/guest requests) ----
export const getStoredDob = () => safeGet(localStorage, 'ce_dob');
export const storeDob = (dob) => safeSet(localStorage, 'ce_dob', dob);
export const clearDob = () => {
  try {
    localStorage.removeItem('ce_dob');
  } catch {
    /* ignore */
  }
};
export const getGuestToken = () => safeGet(sessionStorage, 'ce_guest');
export const setGuestToken = (t) => {
  if (t) safeSet(sessionStorage, 'ce_guest', t);
  else
    try {
      sessionStorage.removeItem('ce_guest');
    } catch {
      /* ignore */
    }
};
