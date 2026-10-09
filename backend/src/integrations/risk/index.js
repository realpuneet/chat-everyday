import { config } from '../../config/env.js';

/** IP-risk provider hook. `dryrun` (default) reports nothing. `http` calls a JSON endpoint you configure. */
export function createIpRiskProvider(cfg = config) {
  if (cfg.IP_RISK_PROVIDER === 'http' && cfg.IP_RISK_HTTP_URL) {
    return {
      name: 'http',
      async lookup(ip) {
        const r = await fetch(`${cfg.IP_RISK_HTTP_URL}?ip=${encodeURIComponent(ip)}`, {
          headers: cfg.IP_RISK_HTTP_KEY ? { authorization: `Bearer ${cfg.IP_RISK_HTTP_KEY}` } : {},
          signal: AbortSignal.timeout(2000),
        });
        if (!r.ok) throw new Error(`ip risk ${r.status}`);
        const j = await r.json();
        return { vpn: !!j.vpn, datacenter: !!(j.datacenter || j.hosting) };
      },
    };
  }
  return { name: 'dryrun', lookup: async () => ({ vpn: false, datacenter: false }) };
}
