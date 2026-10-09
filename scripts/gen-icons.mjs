// Generates PWA icons from the SVG logo. Uses the `sharp` copy installed in backend/.
// Run once: node scripts/gen-icons.mjs  (outputs are committed, builds do not need sharp)
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = require('sharp');
const svg = fs.readFileSync(new URL('../frontend/public/favicon.svg', import.meta.url));
const out = new URL('../frontend/public/icons/', import.meta.url);
const plain = async (size, name) => sharp(svg, { density: 384 }).resize(size, size).png().toFile(new URL(name, out).pathname);
await plain(192, 'icon-192.png');
await plain(512, 'icon-512.png');
await plain(180, 'apple-touch-icon.png');
// maskable: logo inside the 80% safe zone on a solid background
const inner = await sharp(svg, { density: 384 }).resize(Math.round(512 * 0.62), Math.round(512 * 0.62)).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0b0b14' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile(new URL('maskable-512.png', out).pathname);
console.log('icons written');
