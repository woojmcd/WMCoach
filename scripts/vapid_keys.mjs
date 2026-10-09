// Generate a VAPID key pair for Web Push (spec §8.4).
// The public key goes in app/push-config.js (it is public by design).
// The private key is a secret: it goes ONLY into the daily routine's credentials,
// never into this repo. Usage: node scripts/vapid_keys.mjs [private-key-output-file]
import { createECDH } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = b64url(ecdh.getPublicKey());
const privateKey = b64url(ecdh.getPrivateKey());
console.log(`VAPID public key (app/push-config.js):\n${publicKey}`);
const out = process.argv[2];
if (out) {
  writeFileSync(out, `WMCoach Web Push keys (generated ${new Date().toISOString()})\n\nVAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n\nKeep the private key secret. It goes only into the daily routine's credentials (stage 6), never into the repo.\n`, { mode: 0o600 });
  console.log(`Private key written to ${out} (not printed).`);
} else {
  console.log(`VAPID private key (secret, routine credentials only):\n${privateKey}`);
}
