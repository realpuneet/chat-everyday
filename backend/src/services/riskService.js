import { K } from '../config/redis.js';
import { config } from '../config/env.js';
import { forbidden } from '../utils/errors.js';
import { logger } from '../config/logger.js';

const HOUR = 3600;

/**
 * Ban-evasion risk scoring. Signals:
 *  - device previously linked to a banned account
 *  - guest-account churn per IP / device (many fresh guests in an hour)
 *  - VPN / datacenter flag from a pluggable IP-risk provider (dry-run returns 0)
 * Scores are advisory: they gate guest creation and are shown to admins; they never auto-ban.
 */
export class RiskService {
  constructor({ redis, settings, bans, provider }) {
    Object.assign(this, { redis, settings, bans, provider });
  }

  async recordGuestCreated(client) {
    const p = this.redis.pipeline();
    if (client.ipHash) p.incr(K.churn('ip', client.ipHash)).expire(K.churn('ip', client.ipHash), HOUR);
    if (client.deviceHash) p.incr(K.churn('dev', client.deviceHash)).expire(K.churn('dev', client.deviceHash), HOUR);
    await p.exec();
  }

  async score(client) {
    const signals = {};
    let score = 0;
    const [ipN, devN] = await Promise.all([
      client.ipHash ? this.redis.get(K.churn('ip', client.ipHash)) : 0,
      client.deviceHash ? this.redis.get(K.churn('dev', client.deviceHash)) : 0,
    ]);
    if (Number(ipN) >= 5) (signals.ipChurn = Number(ipN)), (score += Math.min(40, Number(ipN) * 5));
    if (Number(devN) >= 3) (signals.deviceChurn = Number(devN)), (score += Math.min(40, Number(devN) * 10));
    if (client.deviceHash) {
      const users = await this.redis.smembers(K.deviceUsers(client.deviceHash));
      if (users.length) {
        const banned = await Promise.all(users.map((u) => this.bans.check({ userId: u })));
        if (banned.some(Boolean)) (signals.bannedLinkedAccount = true), (score += 60);
      }
    }
    if (client.ip) {
      const ipRisk = await this.provider.lookup(client.ip).catch((e) => {
        logger.warn({ err: e.message }, 'ip risk provider failed');
        return { vpn: false, datacenter: false };
      });
      if (ipRisk.vpn || ipRisk.datacenter) (signals.vpnOrDatacenter = true), (score += 25);
    }
    return { score: Math.min(100, score), signals };
  }

  /** Guests from high-risk clients must sign up (phone / Google) instead. */
  async assertGuestAllowed(client) {
    if (config.isTest) return;
    const { score, signals } = await this.score(client);
    if (score >= 70) throw forbidden('Please sign in with phone or Google to continue', { code: 'RISK_SIGNIN_REQUIRED', signals: Object.keys(signals) });
  }
}
