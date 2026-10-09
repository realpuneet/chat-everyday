import { User } from '../models/User.js';
import { config } from '../config/env.js';
import { K } from '../config/redis.js';
import { generateIdentity } from '../utils/nickname.js';
import { isAdult } from '../utils/age.js';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { forbidden, unauthorized, conflict } from '../utils/errors.js';
import { hashIdentity } from '../utils/crypto.js';
import { verifyTotp } from '../utils/crypto.js';

const AGE_FAIL_TTL_SEC = 24 * 3600;
const AGE_RANK = { declared: 0, phone: 1, google: 1, strict: 2 };
// Valid argon2id hash of a random string, computed lazily; equalises timing for unknown accounts.
let dummyHash;
const getDummyHash = () => (dummyHash ??= argon2.hash(crypto.randomBytes(16).toString('hex'), { type: argon2.argon2id }));

export class AuthService {
  constructor({ redis, tokens, bans, settings, audit, risk, otp, google, limiter }) {
    Object.assign(this, { redis, tokens, bans, settings, audit, risk, otp, google, limiter });
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

  // ------------------------------------------------------------------ identities

  static identityHashes(user) {
    const out = [];
    if (user.email) out.push(hashIdentity('email', user.email));
    if (user.googleSub) out.push(hashIdentity('google', user.googleSub));
    if (user.phoneHash) out.push(user.phoneHash);
    return out;
  }

  /** Final gate for any login path: bans on account / device / ip / linked identities. */
  async #loginGate(user, client) {
    await this.bans.assertNotBanned({
      userId: String(user._id),
      ipHash: client.ipHash,
      deviceHash: client.deviceHash,
      identities: AuthService.identityHashes(user),
    });
  }

  async #registeredSession(user, client, extra = {}) {
    await this.#loginGate(user, client);
    await this.#trackClient(user, client);
    user.lastSeenAt = new Date();
    await user.save();
    const s = await this.#session(user, client);
    return { ...s, ...extra };
  }

  /**
   * Convert the caller's guest account into a registered one IN PLACE. userId, the access-token subject
   * and everything keyed on it (socket rooms, chats in progress, blocks) keep working, so the session
   * upgrades without dropping the live chat. `fields` are the new identity attributes.
   */
  async #upgradeGuest(guestUser, fields, { ageLevel } = {}) {
    Object.assign(guestUser, fields, { kind: 'registered' });
    guestUser.expiresAt = undefined;
    guestUser.guestSessionStartedAt = undefined;
    if (ageLevel && AGE_RANK[ageLevel] > AGE_RANK[guestUser.ageLevel]) guestUser.ageLevel = ageLevel;
    await guestUser.save();
    await this.audit.log({ actorId: String(guestUser._id), actorType: 'user', action: 'auth.guest_upgraded', targetType: 'user', targetId: String(guestUser._id) });
    return guestUser;
  }

  async #createRegistered(fields, { ageLevel = 'declared' } = {}) {
    const ident = generateIdentity();
    try {
      return await User.create({
        kind: 'registered',
        nickname: fields.nickname || ident.alias,
        avatar: ident.avatar,
        ageDeclaredAt: new Date(),
        ageLevel,
        ...fields,
      });
    } catch (e) {
      if (e?.code === 11000) throw conflict('This account already exists');
      throw e;
    }
  }

  #guestFrom(authedUser) {
    return authedUser?.kind === 'guest' ? authedUser : null;
  }

  // ------------------------------------------------------------------ email + password

  async signupEmail(body, client, authedUser) {
    const cfg = await this.settings.get();
    if (!cfg.auth.emailSignupAllowed) throw forbidden('Email signup is disabled');
    await this.assertAdult(body, client);
    const email = body.email;
    await this.bans.assertNotBanned({ ipHash: client.ipHash, deviceHash: client.deviceHash, identities: [hashIdentity('email', email)] });
    if (await User.exists({ email })) throw conflict('An account with this email already exists', { code: 'EMAIL_TAKEN' });
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    const fields = { email, passwordHash, ...(body.nickname ? { nickname: body.nickname } : {}), ...(body.gender ? { gender: body.gender } : {}) };
    const guest = this.#guestFrom(authedUser);
    let user;
    try {
      user = guest ? await this.#upgradeGuest(guest, fields) : await this.#createRegistered(fields);
    } catch (e) {
      if (e?.code === 11000) throw conflict('An account with this email already exists', { code: 'EMAIL_TAKEN' });
      throw e;
    }
    return this.#registeredSession(user, client, { upgraded: !!guest });
  }

  async loginEmail({ email, password, totp }, client) {
    await this.limiter.assertWindow('login-ip', client.ipHash || 'x', { limit: 30, windowMs: 3600_000 }, 'Too many login attempts');
    await this.limiter.assertWindow('login-acct', hashIdentity('email', email), { limit: 10, windowMs: 15 * 60_000 }, 'Too many login attempts for this account');
    const user = await User.findOne({ email });
    // Verify against a dummy hash when the account is missing so timing does not reveal existence.
    const ok = await argon2.verify(user?.passwordHash || (await getDummyHash()), password).catch(() => false);
    if (!user || !user.passwordHash || !ok) throw unauthorized('Incorrect email or password', { code: 'BAD_CREDENTIALS' });
    if (user.totpEnabled) {
      if (!totp) throw unauthorized('Two-factor code required', { code: 'TOTP_REQUIRED' });
      if (!verifyTotp(user.totpSecret, totp)) throw unauthorized('Incorrect two-factor code', { code: 'TOTP_INVALID' });
    }
    return this.#registeredSession(user, client);
  }

  // ------------------------------------------------------------------ Google

  async loginGoogle({ idToken, dob, ageConfirmed }, client, authedUser) {
    await this.assertAdult({ dob, ageConfirmed }, client);
    const g = await this.google.verify(idToken);
    const sub = g.sub;
    let user = await User.findOne({ googleSub: sub });
    if (!user && g.email && g.emailVerified) {
      // Same verified email as an existing password account: link instead of duplicating.
      user = await User.findOne({ email: g.email });
      if (user) {
        user.googleSub = sub;
        if (AGE_RANK.google > AGE_RANK[user.ageLevel]) user.ageLevel = 'google';
        await user.save();
      }
    }
    let upgraded = false;
    if (!user) {
      await this.bans.assertNotBanned({ ipHash: client.ipHash, deviceHash: client.deviceHash, identities: [hashIdentity('google', sub)] });
      const fields = { googleSub: sub, ...(g.email && g.emailVerified ? { email: g.email } : {}) };
      const guest = this.#guestFrom(authedUser);
      user = guest ? await this.#upgradeGuest(guest, fields, { ageLevel: 'google' }) : await this.#createRegistered(fields, { ageLevel: 'google' });
      upgraded = !!guest;
    }
    // Admin bootstrap is honoured ONLY for Google-verified emails (an unverified email could be claimed by anyone).
    if (g.emailVerified && g.email && this.adminEmails?.includes(g.email) && user.role !== 'admin') {
      user.role = 'admin';
      await user.save();
      await this.audit.log({ action: 'auth.admin_bootstrap', severity: 'warn', targetType: 'user', targetId: String(user._id) });
    }
    return this.#registeredSession(user, client, { upgraded });
  }

  // ------------------------------------------------------------------ phone OTP

  async phoneRequest({ phone, dob, ageConfirmed }, client) {
    await this.assertAdult({ dob, ageConfirmed }, client);
    await this.bans.assertNotBanned({ ipHash: client.ipHash, deviceHash: client.deviceHash, identities: [hashIdentity('phone', phone)] });
    return this.otp.request(phone, client);
  }

  async phoneVerify({ phone, code, idToken, dob, ageConfirmed }, client, authedUser) {
    await this.assertAdult({ dob, ageConfirmed }, client);
    const verified = idToken ? await this.otp.verifyClientToken(idToken) : await this.otp.verify(phone, code);
    const phoneHash = hashIdentity('phone', verified);
    let user = await User.findOne({ phoneHash });
    let upgraded = false;
    if (!user) {
      await this.bans.assertNotBanned({ ipHash: client.ipHash, deviceHash: client.deviceHash, identities: [phoneHash] });
      const fields = { phoneHash, phoneLast4: verified.slice(-4) };
      const guest = this.#guestFrom(authedUser);
      user = guest ? await this.#upgradeGuest(guest, fields, { ageLevel: 'phone' }) : await this.#createRegistered(fields, { ageLevel: 'phone' });
      upgraded = !!guest;
    } else if (AGE_RANK.phone > AGE_RANK[user.ageLevel]) {
      user.ageLevel = 'phone';
      await user.save();
    }
    return this.#registeredSession(user, client, { upgraded });
  }

  // ------------------------------------------------------------------ sessions

  async refresh(rawToken, client) {
    const rotated = await this.tokens.rotateRefresh(rawToken);
    const user = await User.findById(rotated.userId);
    if (!user) throw unauthorized('Account not found');
    await this.#loginGate(user, client);
    return {
      accessToken: this.tokens.signAccess(user, client.deviceId || rotated.deviceId),
      user: user.toPublicSelf(),
      refresh: { token: rotated.token, maxAgeMs: rotated.maxAgeMs },
    };
  }

  async logout(rawToken) {
    if (rawToken) await this.tokens.revokeRefresh(rawToken);
  }

  async logoutAll(userId) {
    await this.tokens.revokeAllForUser(userId);
  }

  async setAdminEmails(list) {
    this.adminEmails = list.map((e) => e.toLowerCase());
  }
}
