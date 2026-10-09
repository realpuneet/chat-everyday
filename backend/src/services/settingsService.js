import { z } from 'zod';
import { Setting } from '../models/Setting.js';
import { badRequest } from '../utils/errors.js';

// NOTE: Hard content-policy blocks (CSAM, minors, non-consensual intimate content, sextortion, doxxing,
// trafficking, real threats) are NOT settings. They live in contentPolicy.js and cannot be switched off.
export const DEFAULT_SETTINGS = Object.freeze({
  limits: {
    msgMaxLength: 1000,
    msgBurst: 5,
    msgRefillPerSec: 5,
    msgPer10s: 20,
    matchPerMin: 12,
    reportPerHour: 10,
    roomJoinPerMin: 20,
    guestImagesPerHour: 5,
    userImagesPerHour: 30,
  },
  matching: {
    fallbackMs: 8000,
    cooldownSec: 600,
    maxWaitMs: 120000,
    disconnectGraceMs: 10000,
    scan: 50,
  },
  images: {
    maxBytes: 5 * 1024 * 1024,
    maxDimension: 4096,
    viewTimerSec: 10,
    defaultViewMode: 'once',
    urlTtlSec: 45,
    nsfwBlurThreshold: 0.35,
    nsfwRejectThreshold: 0.9,
    hashMatchMaxDistance: 6,
    retentionHours: 24,
    allowInRandomChat: true,
  },
  moderation: {
    autoHideReports: 3,
    autoSuspendReporters: 5,
    evidenceMessages: 20,
    blockLinks: true,
    blockPiiInRooms: true,
    spamRepeatLinkLimit: 3,
    badWords: [],
    banEscalationHours: [24, 168],
  },
  rooms: {
    guestsCanCreate: false,
    guestsCanJoinAdult: false,
    adultMinAgeLevel: 'phone', // declared | phone | google | strict
    requireStrictForAdult: false,
    maxCustomRoomsPerUser: 3,
    fanoutBatchMs: 50,
  },
  savedChats: { retentionDays: 30, maxMessages: 5000 },
  auth: { guestAllowed: true, emailSignupAllowed: true, phoneAllowedCountryCodes: ['+91'] },
});

const num = (min, max) => z.number().min(min).max(max);
const schema = z
  .object({
    limits: z
      .object({
        msgMaxLength: num(1, 4000),
        msgBurst: num(1, 50),
        msgRefillPerSec: num(0.1, 50),
        msgPer10s: num(1, 200),
        matchPerMin: num(1, 120),
        reportPerHour: num(1, 100),
        roomJoinPerMin: num(1, 200),
        guestImagesPerHour: num(0, 100),
        userImagesPerHour: num(0, 500),
      })
      .strict(),
    matching: z
      .object({
        fallbackMs: num(0, 60000),
        cooldownSec: num(0, 86400),
        maxWaitMs: num(10000, 900000),
        disconnectGraceMs: num(0, 120000),
        scan: num(5, 200),
      })
      .strict(),
    images: z
      .object({
        maxBytes: num(10_000, 20 * 1024 * 1024),
        maxDimension: num(256, 8192),
        viewTimerSec: num(3, 120),
        defaultViewMode: z.enum(['once', 'timer']),
        urlTtlSec: num(30, 60),
        nsfwBlurThreshold: num(0, 1),
        nsfwRejectThreshold: num(0, 1),
        hashMatchMaxDistance: num(0, 16),
        retentionHours: num(1, 168),
        allowInRandomChat: z.boolean(),
      })
      .strict(),
    moderation: z
      .object({
        autoHideReports: num(1, 50),
        autoSuspendReporters: num(2, 50),
        evidenceMessages: num(5, 100),
        blockLinks: z.boolean(),
        blockPiiInRooms: z.boolean(),
        spamRepeatLinkLimit: num(1, 20),
        badWords: z.array(z.string().max(40)).max(2000),
        banEscalationHours: z.array(num(1, 24 * 365)).max(5),
      })
      .strict(),
    rooms: z
      .object({
        guestsCanCreate: z.boolean(),
        guestsCanJoinAdult: z.boolean(),
        adultMinAgeLevel: z.enum(['declared', 'phone', 'google', 'strict']),
        requireStrictForAdult: z.boolean(),
        maxCustomRoomsPerUser: num(0, 50),
        fanoutBatchMs: num(0, 500),
      })
      .strict(),
    savedChats: z.object({ retentionDays: num(1, 365), maxMessages: num(10, 20000) }).strict(),
    auth: z
      .object({
        guestAllowed: z.boolean(),
        emailSignupAllowed: z.boolean(),
        phoneAllowedCountryCodes: z.array(z.string().regex(/^\+\d{1,4}$/)).max(50),
      })
      .strict(),
  })
  .strict();

export const settingsSchema = schema;

export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base?.[k], v);
  return out;
}

export class SettingsService {
  constructor({ ttlMs = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.cache = null;
    this.loadedAt = 0;
  }

  async get() {
    if (this.cache && Date.now() - this.loadedAt < this.ttlMs) return this.cache;
    let overrides = {};
    try {
      const rows = await Setting.find({}).lean();
      overrides = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } catch {
      if (this.cache) return this.cache; // keep serving last good value if Mongo blips
    }
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), overrides);
    const ok = schema.safeParse(merged);
    this.cache = ok.success ? ok.data : structuredClone(DEFAULT_SETTINGS);
    this.loadedAt = Date.now();
    return this.cache;
  }

  /** Admin update: patch is { group: { key: value } }. Unknown groups/keys are rejected (strict schema). */
  async update(patch, actorId) {
    const current = await this.get();
    const merged = deepMerge(structuredClone(current), patch);
    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      throw badRequest('Invalid settings', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    for (const group of Object.keys(patch)) {
      await Setting.updateOne({ key: group }, { $set: { value: parsed.data[group], updatedBy: actorId } }, { upsert: true });
    }
    this.invalidate();
    return this.get();
  }

  invalidate() {
    this.cache = null;
    this.loadedAt = 0;
  }
}
