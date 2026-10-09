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
import { RoomService, RoomFanout } from './roomService.js';
import { ReportService } from './reportService.js';
import { SavedChatService } from './savedChatService.js';
import { AdminService } from './adminService.js';
import { createAgeVerifier } from '../integrations/ageVerify/index.js';
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

  const fanout = new RoomFanout({ emit, settings });
  const rooms = new RoomService({ redis, settings, events, limiter, moderation, emit, audit, fanout });

  const reports = new ReportService({ redis, settings, limiter, matching, events, rooms, moderation, audit, emit, chat });
  moderation.reports = reports;
  const saved = new SavedChatService({ redis, settings, matching, emit, audit });
  chat.hooks.onMessage = (chatId, from, partner, ev) => saved.onMessage(chatId, from, partner, ev);
  chat.hooks.onChatEnded = (chatId) => saved.onChatEnded(chatId);
  const admin = new AdminService({ redis, settings, audit, matching, presence, bans, rooms, images: null, emit });
  const ageVerifier = createAgeVerifier(cfg);

  const svc = { reports, saved, admin, ageVerifier, rooms, fanout, redis, cfg, emit, settings, audit, limiter, tokens, bans, risk, otp, matching, presence, events, moderation, auth, chat };

  // Ban => leave random chat and every room.
  moderation.on('user:banned', ({ userId }) => {
    chat.leave(userId, { reason: 'partner_left' }).catch(() => {});
    rooms.removeEverywhere(userId).catch(() => {});
  });

  svc.afterBoot = async () => {
    await rooms.ensureSystemRooms();
  };
  svc.stop = async () => fanout.flushAll();
  svc.sweeperTasks = [
    { name: 'room-disconnects', ms: 2000, fn: () => rooms.processDisconnects(presence) },
    { name: 'saved-purge', ms: 10 * 60_000, lock: true, fn: () => saved.purgeExpired() },
  ];
  return svc;
}
