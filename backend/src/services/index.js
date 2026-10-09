import { SettingsService } from './settingsService.js';
import { AuditService } from './auditService.js';
import { TokenService } from './tokenService.js';
import { BanService } from './banService.js';
import { RiskService } from './riskService.js';
import { AuthService } from './authService.js';
import { MatchingService } from './matchingService.js';
import { PresenceService } from './presenceService.js';
import { EventStore } from './eventStore.js';
import { ModerationService } from './moderationService.js';
import { ChatService } from './chatService.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { createLazyEmitter } from '../sockets/emitter.js';
import { createIpRiskProvider } from '../integrations/risk/index.js';
import { OtpService } from './otpService.js';
import { createOtpProvider } from '../integrations/otp/index.js';
import { createGoogleVerifier } from '../integrations/google/index.js';
import { config } from '../config/env.js';

/**
 * Dependency container. Everything is constructed once per process; services never import each
 * other directly, they receive collaborators here (keeps tests and the worker process simple).
 */
export function createServices({ redis, cfg = config }) {
  const emit = createLazyEmitter();
  const settings = new SettingsService();
  const audit = new AuditService();
  const limiter = new RateLimiter(redis);
  const tokens = new TokenService(redis);
  const bans = new BanService({ redis, settings, audit });
  const risk = new RiskService({ redis, settings, bans, provider: createIpRiskProvider(cfg) });
  const matching = new MatchingService({ redis, settings });
  const presence = new PresenceService({ redis, instanceId: cfg.INSTANCE_ID });
  const events = new EventStore({ redis });
  const moderation = new ModerationService({ redis, settings, bans, audit, emit });
  const otp = new OtpService({ redis, limiter, settings, provider: createOtpProvider(cfg), audit });
  const auth = new AuthService({ redis, tokens, bans, settings, audit, risk, otp, google: createGoogleVerifier(cfg), limiter });
  auth.setAdminEmails(cfg.ADMIN_EMAILS);
  const chat = new ChatService({ redis, settings, matching, events, limiter, moderation, emit, presence });

  const svc = { redis, cfg, emit, settings, audit, limiter, tokens, bans, risk, otp, matching, presence, events, moderation, auth, chat };

  // Ban => leave random chat. (Rooms subscribe in P3.)
  moderation.on('user:banned', ({ userId }) => {
    chat.leave(userId, { reason: 'partner_left' }).catch(() => {});
  });
  return svc;
}
