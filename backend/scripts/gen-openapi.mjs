// Generates docs/openapi.json from the real Zod validators (z.toJSONSchema) + a declarative endpoint table.
// Run: node scripts/gen-openapi.mjs   (tests/unit/docs.test.js fails if a route is missing from the output)
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../src/validators/httpSchemas.js';
import * as S from '../src/validators/socketSchemas.js';

const js = (schema) => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  return rest;
};

const body = (schema) => ({ required: true, content: { 'application/json': { schema: js(schema) } } });
const obj = (props = {}, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const ok = (desc = 'OK', schema) => ({ 200: { description: desc, ...(schema ? { content: { 'application/json': { schema } } } : {}) } });

const takedownBody = obj({ requesterName: { type: 'string' }, requesterContact: { type: 'string' }, category: { type: 'string', enum: ['nonconsensual', 'csam', 'impersonation', 'privacy', 'copyright', 'grievance', 'other'] }, reference: { type: 'string' }, description: { type: 'string', minLength: 10 } }, ['requesterContact', 'category', 'description']);
const createRoomBody = obj({ name: { type: 'string' }, description: { type: 'string' }, visibility: { enum: ['public', 'private'] }, adult: { type: 'boolean' }, identity: { enum: ['everyone', 'men', 'women', 'lgbtq'] }, rules: { type: 'string' }, maxMembers: { type: 'integer' }, filters: obj({ blockLinks: { type: 'boolean' }, blockPii: { type: 'boolean' }, badWords: { type: 'array', items: { type: 'string' } } }) }, ['name']);
const uploadUrlBody = obj({ contentType: { enum: ['image/jpeg', 'image/png', 'image/webp'] }, size: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, scope: { enum: ['chat', 'room'] }, scopeId: { type: 'string' }, viewMode: { enum: ['once', 'timer'] }, timerSec: { type: 'integer' } }, ['contentType', 'size', 'width', 'height', 'scope', 'scopeId']);
const resolveBody = obj({ action: { enum: ['dismiss', 'warn', 'ban_temp', 'ban_perm', 'hide_content'] }, durationHours: { type: 'integer' }, note: { type: 'string' } }, ['action']);
const banBody = obj({ userId: { type: 'string' }, reason: { type: 'string' }, category: { type: 'string' }, permanent: { type: 'boolean' }, hours: { type: 'integer' } }, ['userId', 'reason']);
const session = obj({ accessToken: { type: 'string' }, user: { $ref: '#/components/schemas/User' }, upgraded: { type: 'boolean', description: 'true when a guest session was upgraded in place' } });

// [method, path, summary, { auth, body, tag, desc, responses }]
const E = [
  ['post', '/auth/guest', 'Start a guest session (age gate enforced server side)', { tag: 'Auth', body: body(H.guestBody), res: ok('Session', session) }],
  ['post', '/auth/guest/refresh', 'Extend a guest session (capped at GUEST_MAX_SESSION_SEC)', { tag: 'Auth', auth: 'bearer' }],
  ['post', '/auth/signup', 'Email + password signup. With a guest bearer token the guest is upgraded in place', { tag: 'Auth', auth: 'optional', body: body(H.emailSignupBody), res: ok('Session (refresh token is set as an httpOnly cookie `rt_<slot>`)', session) }],
  ['post', '/auth/login', 'Email + password login', { tag: 'Auth', body: body(H.emailLoginBody), res: ok('Session', session) }],
  ['post', '/auth/google', 'Google Sign-In (ID token verified server side)', { tag: 'Auth', auth: 'optional', body: body(H.googleBody), res: ok('Session', session) }],
  ['post', '/auth/phone/request', 'Request a phone OTP (rate limited, anti SMS-pumping)', { tag: 'Auth', body: body(H.phoneRequestBody) }],
  ['post', '/auth/phone/verify', 'Verify phone OTP (or Firebase ID token) and sign in / upgrade', { tag: 'Auth', auth: 'optional', body: body(H.phoneVerifyBody), res: ok('Session', session) }],
  ['post', '/auth/refresh', 'Rotate the refresh cookie (requires header x-session-slot). Reuse of an old token revokes the family', { tag: 'Auth', auth: 'cookie' }],
  ['post', '/auth/logout', 'Revoke this tab\'s refresh token', { tag: 'Auth' }],
  ['post', '/auth/logout-all', 'Revoke every refresh token of the user', { tag: 'Auth', auth: 'bearer' }],
  ['get', '/auth/devices', 'Currently connected devices (sockets)', { tag: 'Auth', auth: 'bearer' }],
  ['get', '/auth/me', 'Current user', { tag: 'Auth', auth: 'bearer' }],
  ['patch', '/auth/me', 'Update profile (nickname, self-declared gender, language, regenerate identity)', { tag: 'Auth', auth: 'bearer', body: body(H.profileBody) }],

  ['get', '/rooms', 'List public rooms with live member counts', { tag: 'Rooms', auth: 'bearer' }],
  ['get', '/rooms/mine', 'Rooms you own or are in', { tag: 'Rooms', auth: 'bearer' }],
  ['get', '/rooms/preview', 'Preview a private room by invite code (?code=)', { tag: 'Rooms', auth: 'bearer' }],
  ['post', '/rooms', 'Create a custom room (registered users)', { tag: 'Rooms', auth: 'bearer', body: { required: true, content: { 'application/json': { schema: createRoomBody } } } }],
  ['delete', '/rooms/{id}', 'Delete a room (owner / admin)', { tag: 'Rooms', auth: 'bearer' }],

  ['post', '/images/upload-url', 'Request an upload slot (size/type/dimension/rate limits, scope check)', { tag: 'Images', auth: 'bearer', body: { required: true, content: { 'application/json': { schema: uploadUrlBody } } } }],
  ['put', '/images/{id}/upload', 'Proxied upload (local / ImageKit): raw image bytes', { tag: 'Images', auth: 'bearer', raw: true }],
  ['post', '/images/{id}/complete', 'Finish upload and queue server-side processing', { tag: 'Images', auth: 'bearer' }],
  ['get', '/images/{id}/status', 'Public status/metadata of an image (no URL)', { tag: 'Images', auth: 'bearer' }],
  ['get', '/images/{id}/view', 'Open a viewing session: short-lived signed URL + watermark info (`Cache-Control: no-store`)', { tag: 'Images', auth: 'bearer' }],
  ['get', '/images/blob/{key}', 'Local (dry-run) storage delivery behind a signed link', { tag: 'Images', auth: 'signed-url' }],

  ['post', '/reports', 'Report a user (random chat or room) with automatic evidence capture', { tag: 'Safety', auth: 'bearer', body: body(S.reportCreate) }],
  ['post', '/takedown', 'Public takedown / grievance intake', { tag: 'Safety', body: { required: true, content: { 'application/json': { schema: takedownBody } } } }],
  ['get', '/saved', 'List your saved chats (registered)', { tag: 'Saved chats', auth: 'bearer' }],
  ['delete', '/saved', 'Delete all your saved chats', { tag: 'Saved chats', auth: 'bearer' }],
  ['get', '/saved/{id}', 'Read (decrypt) one saved chat', { tag: 'Saved chats', auth: 'bearer' }],
  ['delete', '/saved/{id}', 'Delete one saved chat', { tag: 'Saved chats', auth: 'bearer' }],
  ['get', '/blocks', 'Number of people you blocked', { tag: 'Safety', auth: 'bearer' }],
  ['delete', '/blocks', 'Unblock everyone', { tag: 'Safety', auth: 'bearer' }],
  ['post', '/age/start', 'Begin strict age verification (provider hook)', { tag: 'Safety', auth: 'bearer' }],
  ['post', '/age/dryrun-complete', 'Dry-run only: mark strict verification complete', { tag: 'Safety', auth: 'bearer' }],
  ['post', '/age/webhook', 'Provider webhook (HMAC signed raw body)', { tag: 'Safety', auth: 'signature', raw: true }],
  ['get', '/stats/public', 'Public online counter', { tag: 'Misc' }],
  ['get', '/rtc/ice', 'ICE servers (STUN + time-limited TURN credentials)', { tag: 'Video', auth: 'bearer' }],

  ['get', '/admin/stats', 'Live stats', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/reports', 'Reports queue (critical first)', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/reports/{id}', 'Report with evidence', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/reports/{id}/resolve', 'Resolve a report', { tag: 'Admin', auth: 'admin', body: { required: true, content: { 'application/json': { schema: resolveBody } } } }],
  ['get', '/admin/bans', 'Active bans', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/bans', 'Ban a user (account + device + IP)', { tag: 'Admin', auth: 'admin', body: { required: true, content: { 'application/json': { schema: banBody } } } }],
  ['delete', '/admin/bans/{id}', 'Lift a ban (all records of the same action)', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/users/{id}', 'User summary', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/settings', 'Current settings + defaults', { tag: 'Admin', auth: 'admin' }],
  ['put', '/admin/settings', 'Patch settings ({group:{key:value}}, strictly validated, audited). Hard policy blocks are not settings', { tag: 'Admin', auth: 'admin', body: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'object' } } } } } }],
  ['get', '/admin/audit', 'Audit log', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/takedowns', 'Takedown queue', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/takedowns/{id}/resolve', 'Resolve a takedown', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/rooms/{id}/hide', 'Hide a room', { tag: 'Admin', auth: 'admin' }],
  ['get', '/admin/evidence/{id}/{imageId}', 'Signed URL (60s) for an evidence image (audited)', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/hashes', 'Add a known-bad hash to the local blocklist', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/2fa/setup', 'Start TOTP enrolment', { tag: 'Admin', auth: 'admin' }],
  ['post', '/admin/2fa/enable', 'Confirm TOTP enrolment', { tag: 'Admin', auth: 'admin' }],
];

const security = { bearer: [{ bearerAuth: [] }], optional: [{}, { bearerAuth: [] }], admin: [{ bearerAuth: [] }], cookie: [{ refreshCookie: [] }], 'signed-url': [], signature: [] };
const paths = {};
for (const [method, p, summary, o] of E) {
  const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  paths[`/api${p}`] ||= {};
  paths[`/api${p}`][method] = {
    tags: [o.tag],
    summary,
    ...(o.auth ? { security: security[o.auth] } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(o.body ? { requestBody: o.body } : {}),
    ...(o.raw ? { requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } : {}),
    responses: { ...(o.res || ok()), 400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' }, 422: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' } },
  };
}
paths['/healthz'] = { get: { tags: ['Ops'], summary: 'Liveness probe', responses: ok('OK') } };
paths['/readyz'] = { get: { tags: ['Ops'], summary: 'Readiness probe (Redis + Mongo); 503 while shutting down', responses: { 200: { description: 'ready' }, 503: { description: 'not ready' } } } };

const spec = {
  openapi: '3.1.0',
  info: { title: 'Chat Everyday API', version: '1.0.0', description: 'HTTP API. Real-time features (matching, chat, rooms, video signalling) use Socket.io: see docs/architecture.md for the event catalogue. Errors share one shape: {error:{code,message,details?,requestId}}.' },
  servers: [{ url: 'http://localhost:4000' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, refreshCookie: { type: 'apiKey', in: 'cookie', name: 'rt_<slot>' } },
    responses: { Error: { description: 'Typed error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    schemas: {
      Error: obj({ error: obj({ code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' }, requestId: { type: 'string' } }, ['code', 'message']) }, ['error']),
      User: obj({ id: { type: 'string' }, kind: { enum: ['guest', 'registered'] }, role: { enum: ['user', 'admin'] }, nickname: { type: 'string' }, avatar: obj({ emoji: { type: 'string' }, color: { type: 'string' } }), gender: { type: 'string', description: 'SELF-DECLARED, not verified' }, ageLevel: { enum: ['declared', 'phone', 'google', 'strict'] } }),
    },
  },
  paths,
};

const out = path.resolve(import.meta.dirname, '../../docs/openapi.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(paths).length} paths)`);
