import { User } from '../models/User.js';
import { config } from '../config/env.js';
import { K } from '../config/redis.js';
import { generateIdentity, randomNickname } from '../utils/nickname.js';
import { isAdult } from '../utils/age.js';
import { forbidden, unauthorized, badRequest } from '../utils/errors.js';

const AGE_FAIL_TTL_SEC = 24 * 3600;

export class AuthService {
  constructor({ redis, tokens, bans, settings, audit, risk }) {
    Object.assign(this, { redis, tokens, bans, settings, audit, risk });
  }

  /**
   * Server-side age gate. The client checkbox + DOB are never trusted alone; a failed attempt locks
   * the device for 24h so users cannot simply retry with a different date of birth.
   */
  async assertAdult({ dob, ageConfirmed }, client) {
    const failKey = client.deviceHash ? `agefail:${client.deviceHash}` : null;
    if (failKey && (await this.redis.exists(failKey))) throw forbidden('You must be 18 or older to use this service', { code: 'AGE_BLOCKED' });
    if (!ageConfirmed || !isAdult(dob)) {
      if (failKey) await this.redis.set(failKey, '1', 'EX', AGE_FAIL_TTL_SEC);
      throw forbidden('You must be 18 or older to use this service', { code: 'UNDERAGE' });
    }
  }

  async #trackClient(user, client) {
    const update = {};
    if (client.ipHash) update.$addToSet = { ...(update.$addToSet || {}), ipHashes: client.ipHash };
    if (client.deviceHash) update.$addToSet = { ...(update.$addToSet || {}), deviceHashes: client.deviceHash };
    if (update.$addToSet) {
      await User.updateOne({ _id: user._id }, update);
    }
    if (client.deviceHash) {
      await this.redis.sadd(K.deviceUsers(client.deviceHash), String(user._id));
      await this.redis.expire(K.deviceUsers(client.deviceHash), 90 * 24 * 3600);
    }
  }

  async createGuest({ dob, ageConfirmed, nickname, gender, lang }, client) {
    const cfg = await this.settings.get();
    if (!cfg.auth.guestAllowed) throw forbidden('Guest access is disabled');
    await this.assertAdult({ dob, ageConfirmed }, client);
    await this.bans.assertNotBanned({ ipHash: client.ipHash, deviceHash: client.deviceHash });
    await this.risk.assertGuestAllowed(client);

    const ident = generateIdentity();
    const user = await User.create({
      kind: 'guest',
      nickname: (nickname?.trim() || ident.alias).slice(0, 32),
      avatar: ident.avatar,
      gender: gender || 'undisclosed',
      lang: lang || '',
      ageDeclaredAt: new Date(),
      ageLevel: 'declared',
      guestSessionStartedAt: new Date(),
      expiresAt: new Date(Date.now() + config.GUEST_MAX_SESSION_SEC * 1000),
    });
    await this.#trackClient(user, client);
    await this.risk.recordGuestCreated(client);
    return this.#session(user, client);
  }

  /** Guest session extension, capped at GUEST_MAX_SESSION_SEC from creation. */
  async refreshGuest(userId, client) {
    const user = await User.findById(userId);
    if (!user || user.kind !== 'guest') throw unauthorized('Not a guest session');
    const age = Date.now() - +user.guestSessionStartedAt;
    if (age > config.GUEST_MAX_SESSION_SEC * 1000) throw unauthorized('Guest session ended, please start again');
    await this.bans.assertNotBanned({ userId: String(user._id), ipHash: client.ipHash, deviceHash: client.deviceHash });
    return this.#session(user, client, { refresh: false });
  }

  async #session(user, client, { refresh = true } = {}) {
    const accessToken = this.tokens.signAccess(user, client.deviceId);
    const out = { accessToken, user: user.toPublicSelf() };
    if (refresh && user.kind === 'registered') out.refresh = await this.tokens.issueRefresh(String(user._id), client.deviceId);
    return out;
  }

  /** Exposed for the sub-flows (email/google/phone) added in auth.* modules. */
  session(user, client, opts) {
    return this.#session(user, client, opts);
  }
  trackClient(user, client) {
    return this.#trackClient(user, client);
  }

  async getUser(userId) {
    const user = await User.findById(userId);
    if (!user) throw unauthorized('Account not found');
    return user;
  }

  async updateProfile(userId, patch) {
    const user = await this.getUser(userId);
    const allowed = ['nickname', 'gender', 'lang', 'interests', 'avatar'];
    for (const k of allowed) if (patch[k] !== undefined) user[k] = patch[k];
    if (patch.regenerateIdentity) {
      const g = generateIdentity();
      user.nickname = g.alias;
      user.avatar = g.avatar;
    }
    await user.save();
    return user.toPublicSelf();
  }

  randomNickname = randomNickname;
  badRequest = badRequest;
}
