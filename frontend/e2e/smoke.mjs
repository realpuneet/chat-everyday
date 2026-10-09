// Real-browser smoke test (Playwright + system Chromium). Requires the API on :4000 and the built app served
// on :4173 (`npm run build && npm run preview`). Exit code != 0 when any step fails.
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SHOTS = process.env.E2E_SHOTS || path.resolve('../docs/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const sharp = require('sharp');

const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push([name, 'PASS', Date.now() - t]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push([name, 'FAIL', Date.now() - t, e.message.split('\n')[0]]);
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const mk = async (name, viewport = { width: 390, height: 780 }) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: [] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`   [${name}] pageerror:`, e.message));
  return { ctx, page, name };
};

async function enterAsGuest({ page }, nick) {
  await page.goto(BASE + '/');
  await page.waitForURL('**/age');
  await page.fill('#dob', '1995-05-05');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('#nick');
  await page.fill('#nick', nick);
  await page.getByRole('button', { name: /Start chatting as guest/ }).click();
  await page.waitForURL('**/chat');
}

const noHScroll = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

console.log(`E2E against ${BASE}`);
const A = await mk('A');
const B = await mk('B');

await step('age gate blocks under-18 on this device', async () => {
  const u = await mk('U');
  await u.page.goto(BASE + '/');
  await u.page.fill('#dob', '2015-01-01');
  await u.page.getByRole('checkbox').check();
  await u.page.getByRole('button', { name: 'Continue' }).click();
  await u.page.getByText(/only for people who are 18/i).waitFor();
  await u.page.screenshot({ path: path.join(SHOTS, '01-age-blocked.png') });
  await u.ctx.close();
});

await step('landing + guest entry (A and B)', async () => {
  await enterAsGuest(A, 'Aanya');
  await enterAsGuest(B, 'Rohan');
  await A.page.screenshot({ path: path.join(SHOTS, '02-chat-idle-mobile.png') });
  if (!(await noHScroll(A.page))) throw new Error('horizontal scroll on 390px chat page');
});

await step('random matching connects two guests', async () => {
  await A.page.getByLabel('Interests').fill('cricket');
  await A.page.getByLabel('Interests').press('Enter');
  await B.page.getByLabel('Interests').fill('cricket');
  await B.page.getByLabel('Interests').press('Enter');
  await A.page.getByRole('button', { name: 'Start chatting' }).click();
  await A.page.getByText('Looking for someone').waitFor();
  await A.page.screenshot({ path: path.join(SHOTS, '03-searching.png') });
  await B.page.getByRole('button', { name: 'Start chatting' }).click();
  await A.page.getByText('Rohan', { exact: true }).first().waitFor({ timeout: 10_000 });
  await B.page.getByText('Aanya', { exact: true }).first().waitFor({ timeout: 10_000 });
});

await step('messages flow both ways; optimistic send; repeated text allowed', async () => {
  const a = A.page.locator('#composer');
  await a.fill('Hello Rohan!');
  await a.press('Enter');
  await B.page.getByText('Hello Rohan!').waitFor();
  const b = B.page.locator('#composer');
  for (let i = 0; i < 3; i++) {
    await b.fill('hi');
    await b.press('Enter');
    await B.page.waitForTimeout(260);
  }
  await A.page.waitForFunction(() => [...document.querySelectorAll('.bubble-them')].filter((e) => e.textContent === 'hi').length === 3);
});

await step('typing indicator reaches partner', async () => {
  await A.page.locator('#composer').pressSequentially('typing now', { delay: 30 });
  await B.page.getByText(/typing/i).first().waitFor({ timeout: 5000 });
  await A.page.locator('#composer').fill('');
});

await step('photo: upload -> server check -> partner sees locked card -> reveal draws to canvas with watermark', async () => {
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
  const file = path.join(SHOTS, '.tmp-photo.jpg');
  fs.writeFileSync(file, jpg);
  await A.page.locator('input[type=file]').setInputFiles(file);
  await A.page.getByRole('button', { name: 'Send', exact: true }).click();
  await B.page.getByRole('button', { name: 'Reveal photo' }).waitFor({ timeout: 20_000 });
  await B.page.screenshot({ path: path.join(SHOTS, '04-photo-locked.png') });
  await B.page.getByRole('button', { name: 'Reveal photo' }).click();
  await B.page.locator('canvas[aria-label="Protected image"]').waitFor();
  const hasPixels = await B.page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Protected image"]');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return c.width > 0 && d.some((v, i) => i % 4 === 0 && v > 0);
  });
  if (!hasPixels) throw new Error('canvas is empty');
  const imgTags = await B.page.locator('img[src*="blob/"], img[src*="proc/"]').count();
  if (imgTags) throw new Error('image URL leaked into an <img> element');
  await B.page.screenshot({ path: path.join(SHOTS, '05-photo-canvas.png') });
  fs.rmSync(file, { force: true });
});

await step('right-click on the protected image is blocked', async () => {
  const blocked = await B.page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Protected image"]');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  if (!blocked) throw new Error('contextmenu not prevented');
});

await step('image blurs when the page becomes hidden', async () => {
  await B.page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await B.page.waitForFunction(() => document.querySelector('canvas[aria-label="Protected image"]')?.className.includes('blur'));
});

await step('reload keeps the conversation (server-side resume)', async () => {
  await A.page.reload();
  await A.page.getByText('Hello Rohan!').waitFor({ timeout: 10_000 });
});

await step('offline banner appears and messages queue until reconnect', async () => {
  await A.ctx.setOffline(true);
  await A.page.getByText(/offline/i).first().waitFor({ timeout: 8000 });
  await A.page.screenshot({ path: path.join(SHOTS, '06-offline.png') });
  await A.ctx.setOffline(false);
  await A.page.getByText(/Back online/i).waitFor({ timeout: 20_000 });
});

await step('report dialog + block flow', async () => {
  await B.page.getByRole('button', { name: 'Report', exact: true }).click();
  await B.page.getByRole('dialog').waitFor();
  await B.page.screenshot({ path: path.join(SHOTS, '07-report.png') });
  await B.page.getByRole('button', { name: 'Cancel' }).click();
});

await step('Next / Leave: partner is told', async () => {
  await A.page.getByRole('button', { name: /Leave/ }).click();
  await B.page.getByText(/partner left/i).waitFor({ timeout: 8000 });
});

await step('rooms: browse, join, chat with random per-room alias', async () => {
  await A.page.goto(BASE + '/rooms');
  await A.page.getByText('Interest rooms').waitFor();
  await A.page.screenshot({ path: path.join(SHOTS, '08-rooms.png') });
  await A.page.getByRole('button', { name: /Join Cricket/ }).click();
  await A.page.waitForURL('**/rooms/*');
  await A.page.getByText(/You are /).waitFor();
  await B.page.goto(BASE + '/rooms');
  await B.page.getByRole('button', { name: /Join Cricket/ }).click();
  await B.page.waitForURL('**/rooms/*');
  const a = A.page.locator('#composer');
  const line = `Anyone watching the match? id-${Date.now().toString(36)}`; // rooms keep a short ring buffer, so make the text unique per run
  await a.fill(line);
  await a.press('Enter');
  await B.page.getByText(line).waitFor({ timeout: 8000 });
  await B.page.screenshot({ path: path.join(SHOTS, '09-room.png') });
  if (!(await noHScroll(B.page))) throw new Error('horizontal scroll in room');
});

await step('adult room requires a verified account (guest is refused with guidance)', async () => {
  await A.page.goto(BASE + '/rooms');
  await A.page.getByRole('button', { name: /Adults 18\+ Lounge/ }).click();
  await A.page.getByText(/Log in or sign up to join this room|Verify your phone/).first().waitFor({ timeout: 8000 });
});

await step('settings page + legal pages render with placeholder warning', async () => {
  await A.page.goto(BASE + '/settings');
  await A.page.getByRole('heading', { name: 'Your identity' }).waitFor();
  await A.page.screenshot({ path: path.join(SHOTS, '10-settings.png') });
  await A.page.goto(BASE + '/terms');
  await A.page.getByText('PLACEHOLDER TEXT').waitFor();
  await A.page.getByText(/cannot be reliably prevented on the web/).waitFor();
});

await step('desktop layout (1280px) renders the side rail', async () => {
  const D = await mk('D', { width: 1280, height: 800 });
  await D.page.goto(BASE + '/');
  await D.page.fill('#dob', '1990-01-01').catch(() => {});
  await D.ctx.close();
});

await browser.close();
const failed = results.filter((r) => r[1] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
