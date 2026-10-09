import { z } from 'zod';

const dob = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DOB must be YYYY-MM-DD');
const nickname = z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N} _.-]+$/u, 'Letters, numbers, space, _ . - only');
const gender = z.enum(['male', 'female', 'nonbinary', 'undisclosed']);

export const ageGate = z.object({ dob, ageConfirmed: z.literal(true, { message: 'You must confirm you are 18+' }) });

export const guestBody = ageGate.extend({ nickname: nickname.optional(), gender: gender.optional(), lang: z.string().max(8).optional() }).strict();

export const profileBody = z
  .object({
    nickname: nickname.optional(),
    gender: gender.optional(),
    lgbtq: z.boolean().optional(),
    lang: z.string().trim().toLowerCase().max(8).regex(/^[a-z-]*$/).optional(),
    interests: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,24}$/)).max(10).optional(),
    regenerateIdentity: z.boolean().optional(),
  })
  .strict();

export const emailSignupBody = ageGate
  .extend({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, 'Use at least 10 characters').max(128),
    nickname: nickname.optional(),
    gender: gender.optional(),
  })
  .strict();

export const emailLoginBody = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional() })
  .strict();

export const googleBody = ageGate.extend({ idToken: z.string().min(10).max(4096) }).strict();

const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919876543210');
export const phoneRequestBody = ageGate.extend({ phone }).strict();
export const phoneVerifyBody = ageGate
  .extend({ phone: phone.optional(), code: z.string().regex(/^\d{6}$/).optional(), idToken: z.string().max(4096).optional() })
  .strict()
  .refine((v) => (v.code && v.phone) || v.idToken, 'code and phone (or idToken) required');

export const idParam = z.object({ id: z.string().min(1).max(64) });
