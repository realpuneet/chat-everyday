export const MIN_AGE = 18; // hard-coded on purpose: not an admin setting

/** Returns age in whole years for an ISO date (YYYY-MM-DD), or null if invalid / in the future. */
export function ageFromDob(dob, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (date > now) return null;
  let age = now.getUTCFullYear() - y;
  const hadBirthday = now.getUTCMonth() + 1 > mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}

export const isAdult = (dob, now) => {
  const a = ageFromDob(dob, now);
  return a !== null && a >= MIN_AGE && a < 120;
};
