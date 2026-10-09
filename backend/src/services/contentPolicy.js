// NON-NEGOTIABLE content policy. Nothing in here is configurable from settings / env / admin UI.
// Hard blocks apply to every surface (random chat, rooms, images, reports) regardless of "adult" flags.

export const HARD_BLOCK_CATEGORIES = Object.freeze([
  'csam', // any sexual / intimate content involving a minor
  'minor', // minor-presence signals: session ends, account is banned
  'nonconsensual', // intimate content without consent (revenge porn)
  'sextortion', // blackmail / extortion using intimate content
  'doxxing', // publishing private identifying info
  'trafficking',
  'threat', // credible threats of violence
]);

/** Categories that trigger an immediate permanent ban + session termination. */
export const IMMEDIATE_BAN_CATEGORIES = Object.freeze(['csam', 'minor']);

/** Report categories treated as critical in the admin queue. */
export const CRITICAL_REPORT_CATEGORIES = Object.freeze(['csam', 'minor', 'underage_signal', 'nonconsensual', 'sextortion', 'trafficking']);

export const isHardBlock = (category) => HARD_BLOCK_CATEGORIES.includes(category);

// Heuristic text scanners. These are a weak first line of defence, not a replacement for a real
// moderation provider (see docs/security.md). They deliberately err on the side of precision for
// auto-bans (minor/csam) and recall for message blocking.
const RULES = [
  {
    category: 'csam',
    re: /\b(child|kid|teen|minor|underage)\s*(porn|sex)\w*\b|\bpedo(?:s|phile|philes|philia)?\b|\b(?:lolicon|shotacon)\b|\b(?:underage|minors?|little\s+girls?|little\s+boys?)\b.{0,25}\b(?:nudes?|porn|sex\s*(?:video|pics?|chat))|\b(?:nudes?|porn)\b.{0,25}\b(?:underage|minors?|little\s+girls?|little\s+boys?)\b|\bcp\b.{0,20}\b(?:trade|trading|sell|selling|links?|collection)\b/i,
  },
  {
    category: 'minor',
    re: /\b(?:i\s*(?:am|m|'m)|im|mai|main|meri\s+umar|my\s+age\s+is|age)\s*[:-]?\s*(?:1[0-7]|[89])\s*(?:y\.?o\.?|yo|yrs?|years?|saal|sal|varsh)\b|\bi\s*(?:am|m|'m)?\s*in\s*(?:class|grade|std)\s*(?:[5-9]|10|11|12)(?:th)?\b|\bmai\s+(?:class|kaksha)\s*(?:[5-9]|10|11|12)\b/i,
  },
  {
    category: 'sextortion',
    re: /\b(?:leak|post|upload|share|send|viral|expose)\w*\b.{0,40}\b(?:your|ur|tumhari|teri|tera|tumhare)\b.{0,25}\b(?:nudes?|pics?|photos?|videos?|vids?|pictures?|screenshots?)\b.{0,60}\b(?:unless|or\s+else|if\s+you\s+(?:don'?t|do\s+not)|warna|nahi\s+to|pay|money|paise|rupees?|₹|send\s+(?:more|me))|\b(?:pay|send|give|transfer)\b.{0,30}\b(?:money|paise|rupees?|₹|\d{3,})\b.{0,40}\b(?:or|otherwise|warna|nahi\s+to)\b.{0,30}\b(?:leak|post|share|viral|expose|upload)\w*\b.{0,40}\b(?:your|ur|tumhari|teri|tera)\b.{0,25}\b(?:nudes?|pics?|photos?|videos?|vids?|pictures?)\b/i,
  },
  {
    category: 'threat',
    re: /\b(i(?:'ll|\s+will|\s+am\s+going\s+to)|i'?m\s+gonna|main|mai)\s+(?:\w+\s+){0,3}(kill|murder|rape|stab|shoot|burn)\s+(you|u|ur\s+family|your\s+family|tumhe|tujhe)\b|\b(maar\s+dunga|jaan\s+se\s+maar|acid\s+(?:daal|phek)\w*)\b|\bi\s+know\s+where\s+(you|u)\s+live\b/i,
  },
  {
    category: 'doxxing',
    re: /\b\d{4}\s\d{4}\s\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b|\b(?:his|her|their)\s+(?:home\s+)?(?:address|phone|number)\s+is\b|\bshe\s+lives\s+(?:at|in)\b|\bhe\s+lives\s+(?:at|in)\b/,
  },
  {
    category: 'trafficking',
    re: /\b(sell|selling|buy|buying|bech\w*|kharid\w*)\b.{0,20}\b(girls?|women|woman|kids?|child(?:ren)?|ladki\w*|bachh\w*)\b/i,
  },
];

/** @returns {{category:string, immediateBan:boolean}|null} */
export function scanHardBlocks(text) {
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.re.test(text)) return { category: rule.category, immediateBan: IMMEDIATE_BAN_CATEGORIES.includes(rule.category) };
  }
  return null;
}
