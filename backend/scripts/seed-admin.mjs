// Create (or promote) an admin account from the command line.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' node scripts/seed-admin.mjs
// Prints a TOTP secret when ADMIN_2FA=1 so you can add it to an authenticator app.
import argon2 from 'argon2';
import { connectMongo, disconnectMongo, syncIndexes } from '../src/config/mongo.js';
import { User } from '../src/models/User.js';
import { generateIdentity } from '../src/utils/nickname.js';
import { newTotpSecret } from '../src/utils/crypto.js';

const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const password = process.env.ADMIN_PASSWORD || '';
if (!email || password.length < 12) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars).');
  process.exit(1);
}
await connectMongo();
await syncIndexes();
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
const ident = generateIdentity();
const set = { role: 'admin', kind: 'registered', passwordHash, ageLevel: 'strict', ageDeclaredAt: new Date() };
let secret;
if (process.env.ADMIN_2FA === '1') {
  secret = newTotpSecret();
  Object.assign(set, { totpSecret: secret, totpEnabled: true });
}
const user = await User.findOneAndUpdate({ email }, { $set: set, $setOnInsert: { nickname: ident.alias, avatar: ident.avatar } }, { upsert: true, new: true });
console.log(`Admin ready: ${user.email} (id ${user._id})`);
if (secret) console.log(`TOTP secret (base32): ${secret}\notpauth://totp/ChatEveryday:${encodeURIComponent(email)}?secret=${secret}&issuer=ChatEveryday`);
await disconnectMongo();
