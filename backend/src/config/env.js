import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
// NOTE: the default is applied to the raw STRING before the split (zod 4 applies .default() on a transformed
// schema to the OUTPUT, which would leave a bare string in place of an array).
const list = (def = '') =>
  z
    .string()
    .default(def)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
const blank = z.string().default('');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  INSTANCE_ID: z.string().default(() => `i-${crypto.randomBytes(3).toString('hex')}`),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: list('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().default(0),

  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/chat_everyday'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  JWT_ACCESS_SECRET: blank,
  JWT_GUEST_SECRET: blank,
  ENCRYPTION_KEY: blank, // base64, 32 bytes. App-level key for saved chats.
  PEPPER: blank, // HMAC key for hashing IPs / device ids / phones
  URL_SIGNING_SECRET: blank,
  ACCESS_TTL_SEC: z.coerce.number().default(15 * 60),
  GUEST_TTL_SEC: z.coerce.number().default(6 * 3600),
  GUEST_MAX_SESSION_SEC: z.coerce.number().default(24 * 3600),
  REFRESH_TTL_SEC: z.coerce.number().default(30 * 24 * 3600),
  COOKIE_SECURE: bool.optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  ADMIN_EMAILS: list(),
  GOOGLE_CLIENT_ID: blank,

  OTP_PROVIDER: z.enum(['console', 'twilio', 'msg91', 'firebase']).default('console'),
  OTP_ALLOWED_COUNTRY_CODES: list('+91'),
  TWILIO_ACCOUNT_SID: blank,
  TWILIO_AUTH_TOKEN: blank,
  TWILIO_FROM: blank,
  MSG91_AUTH_KEY: blank,
  MSG91_TEMPLATE_ID: blank,
  FIREBASE_PROJECT_ID: blank,

  STORAGE_PROVIDER: z.enum(['local', 's3', 'imagekit']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./.data/uploads'),
  S3_ENDPOINT: blank,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: blank,
  S3_ACCESS_KEY_ID: blank,
  S3_SECRET_ACCESS_KEY: blank,
  S3_FORCE_PATH_STYLE: bool.default(true),
  IMAGEKIT_PUBLIC_KEY: blank,
  IMAGEKIT_PRIVATE_KEY: blank,
  IMAGEKIT_URL_ENDPOINT: blank,

  MODERATION_PROVIDER: z.enum(['dryrun', 'http']).default('dryrun'),
  MODERATION_HTTP_URL: blank,
  MODERATION_HTTP_KEY: blank,
  HASHMATCH_PROVIDER: z.enum(['dryrun', 'http']).default('dryrun'),
  HASHMATCH_HTTP_URL: blank,
  HASHMATCH_HTTP_KEY: blank,
  AGE_VERIFY_PROVIDER: z.enum(['dryrun', 'http']).default('dryrun'),
  AGE_VERIFY_HTTP_URL: blank,
  AGE_VERIFY_HTTP_KEY: blank,
  IP_RISK_PROVIDER: z.enum(['dryrun', 'http']).default('dryrun'),
  IP_RISK_HTTP_URL: blank,
  IP_RISK_HTTP_KEY: blank,

  TURN_URLS: list(),
  STUN_URLS: list('stun:stun.l.google.com:19302'),
  TURN_SECRET: blank,
  TURN_TTL_SEC: z.coerce.number().default(3600),

  RATE_LIMIT_MULTIPLIER: z.coerce.number().default(1), // tests / load tests raise this; never in prod
  RUN_WORKER_INLINE: bool.default(true),
  DISABLE_SWEEPER: bool.default(false),
});

function load(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const dev = (name) => crypto.createHash('sha256').update(`dev-only:${name}`).digest();

  const missing = [];
  const secret = (key, name) => {
    if (e[key]) return e[key];
    if (prod) missing.push(key);
    return dev(name).toString('hex');
  };
  const cfg = {
    ...e,
    isProd: prod,
    isTest: e.NODE_ENV === 'test',
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET', 'access'),
    JWT_GUEST_SECRET: secret('JWT_GUEST_SECRET', 'guest'),
    PEPPER: secret('PEPPER', 'pepper'),
    URL_SIGNING_SECRET: secret('URL_SIGNING_SECRET', 'url'),
    COOKIE_SECURE: e.COOKIE_SECURE ?? prod,
  };
  if (e.ENCRYPTION_KEY) {
    const buf = Buffer.from(e.ENCRYPTION_KEY, 'base64');
    if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes');
    cfg.ENCRYPTION_KEY_BUF = buf;
  } else {
    if (prod) missing.push('ENCRYPTION_KEY');
    cfg.ENCRYPTION_KEY_BUF = dev('enc');
  }
  if (missing.length) throw new Error(`Missing required secrets in production: ${missing.join(', ')}`);
  cfg.dryRun = {
    google: !e.GOOGLE_CLIENT_ID,
    otp: e.OTP_PROVIDER === 'console',
    storage: e.STORAGE_PROVIDER === 'local',
    moderation: e.MODERATION_PROVIDER === 'dryrun',
    hashmatch: e.HASHMATCH_PROVIDER === 'dryrun',
    ageVerify: e.AGE_VERIFY_PROVIDER === 'dryrun',
    ipRisk: e.IP_RISK_PROVIDER === 'dryrun',
  };
  return Object.freeze(cfg);
}

export { load as loadConfig };
export const ENV_KEYS = Object.keys(schema.shape);
export const config = load();
