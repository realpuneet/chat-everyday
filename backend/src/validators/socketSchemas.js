import { z } from 'zod';

const tag = z.string().trim().toLowerCase().regex(/^#?[a-z0-9_-]{1,24}$/);
const id = z.string().min(1).max(64);
const clientMsgId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const matchStart = z
  .object({
    tags: z.array(tag).max(5).default([]),
    lang: z.string().trim().toLowerCase().max(8).regex(/^[a-z-]*$/).default(''),
    genderPref: z.enum(['any', 'male', 'female', 'nonbinary']).default('any'),
  })
  .strict();

export const chatSend = z
  .object({
    chatId: id,
    clientMsgId,
    kind: z.enum(['text', 'image']).default('text'),
    text: z.string().max(8000).default(''),
    imageId: id.optional(),
  })
  .strict();

export const chatTyping = z.object({ chatId: id, on: z.boolean() }).strict();
export const chatResume = z.object({ chatId: id.optional(), lastSeq: z.number().int().min(0).default(0) }).strict();
export const authRefresh = z.object({ token: z.string().min(20).max(2000) }).strict();

export const blockAdd = z
  .object({ chatId: id.optional(), roomId: id.optional(), memberId: id.optional() })
  .strict()
  .refine((v) => v.chatId || (v.roomId && v.memberId), 'chatId or roomId+memberId required');

export const reportCreate = z
  .object({
    context: z.enum(['random', 'room']),
    chatId: id.optional(),
    roomId: id.optional(),
    memberId: id.optional(),
    imageId: id.optional(),
    category: z.enum(['minor', 'csam', 'nonconsensual', 'sextortion', 'doxxing', 'trafficking', 'threat', 'harassment', 'spam', 'other']),
    details: z.string().trim().max(1000).default(''),
  })
  .strict();

export const roomJoin = z.object({ roomId: id.optional(), inviteCode: z.string().trim().min(4).max(24).optional() }).strict().refine((v) => v.roomId || v.inviteCode, 'roomId or inviteCode required');
export const roomLeave = z.object({ roomId: id }).strict();
export const roomSend = z
  .object({
    roomId: id,
    clientMsgId,
    kind: z.enum(['text', 'image']).default('text'),
    text: z.string().max(8000).default(''),
    imageId: id.optional(),
  })
  .strict();
export const roomTyping = z.object({ roomId: id, on: z.boolean() }).strict();
export const roomResume = z.object({ roomId: id, lastSeq: z.number().int().min(0).default(0) }).strict();
export const roomMod = z
  .object({
    roomId: id,
    action: z.enum(['kick', 'mute', 'unmute', 'slow', 'rules', 'promote', 'demote']),
    memberId: id.optional(),
    minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    seconds: z.number().int().min(0).max(300).optional(),
    rules: z.string().max(600).optional(),
  })
  .strict();

export const saveRequest = z.object({ chatId: id }).strict();
export const saveRespond = z.object({ chatId: id, accept: z.boolean() }).strict();
export const saveStop = z.object({ chatId: id }).strict();

export const imageSend = z.object({ chatId: id.optional(), roomId: id.optional(), imageId: id, clientMsgId }).strict();

export const rtcRequest = z.object({ chatId: id }).strict();
export const rtcRespond = z.object({ chatId: id, accept: z.boolean() }).strict();
export const rtcSignal = z
  .object({
    chatId: id,
    type: z.enum(['offer', 'answer', 'ice']),
    data: z.any().refine((v) => JSON.stringify(v ?? null).length < 16_000, 'signal too large'),
  })
  .strict();
export const rtcEnd = z.object({ chatId: id }).strict();
