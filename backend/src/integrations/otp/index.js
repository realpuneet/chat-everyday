import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { OAuth2Client } from 'google-auth-library';

/**
 * OTP delivery adapters. Interface: { name, mode: 'sms'|'client-token', send(phone, code), verifyIdToken?(token) }
 *  - console  : DRY-RUN. Prints the code to the server log (never in production logs without opt-in).
 *  - twilio   : Twilio Programmable SMS REST API.
 *  - msg91    : MSG91 OTP API (India; DLT registered template required).
 *  - firebase : Firebase Phone Auth happens on the client; the server only verifies the resulting ID token.
 */
export function createOtpProvider(cfg = config) {
  switch (cfg.OTP_PROVIDER) {
    case 'twilio':
      return twilio(cfg);
    case 'msg91':
      return msg91(cfg);
    case 'firebase':
      return firebase(cfg);
    default:
      return consoleProvider();
  }
}

function consoleProvider() {
  return {
    name: 'console',
    mode: 'sms',
    dryRun: true,
    async send(phone, code) {
      // PII-safe: show only last 4 digits of the number; the OTP itself is the point of dry-run mode.
      logger.warn({ phoneLast4: phone.slice(-4), otp: code }, '[DRY-RUN OTP] would send SMS');
    },
  };
}

function twilio(cfg) {
  return {
    name: 'twilio',
    mode: 'sms',
    async send(phone, code) {
      if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_FROM) throw new Error('Twilio is not configured');
      const body = new URLSearchParams({ To: phone, From: cfg.TWILIO_FROM, Body: `Your Chat Everyday code is ${code}. Valid for 5 minutes. Do not share it.` });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`twilio ${res.status}`);
    },
  };
}

function msg91(cfg) {
  return {
    name: 'msg91',
    mode: 'sms',
    async send(phone, code) {
      if (!cfg.MSG91_AUTH_KEY || !cfg.MSG91_TEMPLATE_ID) throw new Error('MSG91 is not configured');
      const url = new URL('https://control.msg91.com/api/v5/otp');
      url.search = new URLSearchParams({ template_id: cfg.MSG91_TEMPLATE_ID, mobile: phone.replace('+', ''), otp: code }).toString();
      const res = await fetch(url, { method: 'POST', headers: { authkey: cfg.MSG91_AUTH_KEY, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`msg91 ${res.status}`);
    },
  };
}

const FIREBASE_CERTS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
function firebase(cfg) {
  const client = new OAuth2Client();
  return {
    name: 'firebase',
    mode: 'client-token',
    async send() {
      throw new Error('Firebase phone auth is performed on the client; send the resulting ID token to /auth/phone/verify');
    },
    /** Verify a Firebase Auth ID token and return the verified E.164 phone number. */
    async verifyIdToken(idToken) {
      if (!cfg.FIREBASE_PROJECT_ID) throw new Error('Firebase is not configured');
      const res = await fetch(FIREBASE_CERTS, { signal: AbortSignal.timeout(5000) });
      const certs = await res.json();
      const ticket = await client.verifySignedJwtWithCertsAsync(idToken, certs, cfg.FIREBASE_PROJECT_ID, [`https://securetoken.google.com/${cfg.FIREBASE_PROJECT_ID}`]);
      const p = ticket.getPayload();
      if (!p.phone_number) throw new Error('token has no phone number');
      return p.phone_number;
    },
  };
}
