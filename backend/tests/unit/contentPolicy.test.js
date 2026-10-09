import { describe, it, expect } from 'vitest';
import { scanHardBlocks, HARD_BLOCK_CATEGORIES, IMMEDIATE_BAN_CATEGORIES, isHardBlock } from '../../src/services/contentPolicy.js';
import { settingsSchema, DEFAULT_SETTINGS } from '../../src/services/settingsService.js';

describe('content policy', () => {
  it('hard-block categories are frozen and cannot be mutated at runtime', () => {
    expect(Object.isFrozen(HARD_BLOCK_CATEGORIES)).toBe(true);
    expect(() => HARD_BLOCK_CATEGORIES.push('x')).toThrow();
    expect(Object.isFrozen(IMMEDIATE_BAN_CATEGORIES)).toBe(true);
    for (const c of ['csam', 'minor', 'nonconsensual', 'sextortion', 'doxxing', 'trafficking', 'threat']) expect(isHardBlock(c)).toBe(true);
  });

  it('settings schema has no way to disable hard blocks or the 18+ age floor', () => {
    const keys = Object.keys(settingsSchema.shape).flatMap((g) => Object.keys(settingsSchema.shape[g].shape));
    for (const k of keys) expect(k).not.toMatch(/^(csam|minor|minors|hardBlocks?|minAge|nonconsensual|sextortion|threats?|trafficking)$/i);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, moderation: { ...DEFAULT_SETTINGS.moderation, hardBlocks: false } }).success).toBe(false);
  });

  it('flags minor-age self disclosures with immediate ban', () => {
    for (const s of ['i am 15 years old', "I'm 16 yo", 'mai 14 saal ka hu', 'im 17 yrs', 'I am in class 9th', 'age 13 years']) {
      const r = scanHardBlocks(s);
      expect(r?.category, s).toBe('minor');
      expect(r.immediateBan).toBe(true);
    }
  });

  it('does not flag adults or unrelated numbers', () => {
    for (const s of ['i am 25 years old', 'main 8 baje aaunga', 'im 18 yo', 'meeting at 5 pm', 'I have 15 apples', 'my pedometer says 5k', 'I am 30 years old and in class 9 of my course?']) {
      expect(scanHardBlocks(s), s).toBe(null);
    }
  });

  it('flags csam solicitation terms with immediate ban', () => {
    const r = scanHardBlocks('anyone has child porn links');
    expect(r.category).toBe('csam');
    expect(r.immediateBan).toBe(true);
  });

  it('flags sextortion, threats, doxxing and trafficking (no immediate ban)', () => {
    expect(scanHardBlocks('send money or else i will leak your nudes').category).toBe('sextortion');
    expect(scanHardBlocks("i will kill you tonight").category).toBe('threat');
    expect(scanHardBlocks('his address is 12 Park Street').category).toBe('doxxing');
    expect(scanHardBlocks('her aadhaar 1234 5678 9012').category).toBe('doxxing');
    expect(scanHardBlocks('selling girls cheap').category).toBe('trafficking');
    expect(scanHardBlocks('i will kill you tonight').immediateBan).toBe(false);
  });

  it('lets ordinary adult chat through', () => {
    for (const s of ['hey wanna chat about movies?', 'I love cricket', 'kya haal hai', 'send me a meme lol']) expect(scanHardBlocks(s), s).toBe(null);
  });
});
