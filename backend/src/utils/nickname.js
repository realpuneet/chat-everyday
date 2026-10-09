import crypto from 'node:crypto';

const ADJ = ['Silent', 'Cosmic', 'Mellow', 'Velvet', 'Neon', 'Misty', 'Lucky', 'Quirky', 'Sunny', 'Midnight', 'Gentle', 'Brave', 'Witty', 'Dreamy', 'Breezy', 'Cheeky', 'Amber', 'Jade', 'Indigo', 'Rusty'];
const NOUN = ['Panda', 'Falcon', 'Otter', 'Tiger', 'Koala', 'Comet', 'Lotus', 'Mango', 'Raven', 'Pixel', 'Monsoon', 'Chai', 'Maple', 'Dolphin', 'Lynx', 'Ember', 'Cedar', 'Nimbus', 'Fox', 'Yak'];
const COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#818cf8', '#c084fc', '#f472b6'];
const EMOJI = ['🦊', '🐼', '🦉', '🐙', '🦄', '🐢', '🦋', '🐳', '🦔', '🐸', '🦁', '🐧', '🦜', '🐝', '🌵', '🍉'];

const pick = (arr, n) => arr[n % arr.length];

/** Deterministic identity from a seed (stable per room / per user), or random if no seed. */
export function generateIdentity(seed) {
  const h = crypto
    .createHash('sha256')
    .update(seed ?? crypto.randomBytes(16))
    .digest();
  const n = (i) => h.readUInt16BE(i * 2);
  const tag = 100 + (n(4) % 900);
  return {
    alias: `${pick(ADJ, n(0))}${pick(NOUN, n(1))}${tag}`,
    avatar: { emoji: pick(EMOJI, n(2)), color: pick(COLORS, n(3)) },
  };
}

export const randomNickname = () => generateIdentity().alias;
