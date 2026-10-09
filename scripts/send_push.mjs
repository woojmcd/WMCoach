// Sends the notifications queued by scripts/daily.mjs (spec §8.4), after the
// commit is pushed, so the app finds the new plan when Walter taps one.
//
//   node scripts/send_push.mjs            send .coach/run.json's notifications
//   node scripts/send_push.mjs --test     one test notification (setup check)
//
// Needs the routine credential VAPID_PRIVATE_KEY (never in the repo). Optional:
// VAPID_SUBJECT (default: the app's URL). The subscription comes from
// data/log/push_subscription.json, written by the phone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendPush, publicFromPrivate } from './lib/webpush.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => { try { return readFileSync(`${root}${p}`, 'utf8'); } catch { return null; } };
const fail = (msg) => { console.error(msg); process.exit(1); };

const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
if (!privateKey) fail('VAPID_PRIVATE_KEY is not set: add it to the routine environment (docs/routine.md). Notifications not sent; the Week banner still shows.');
const appKey = (read('app/push-config.js') || '').match(/VAPID_PUBLIC_KEY = '([^']+)'/);
const publicKey = publicFromPrivate(privateKey);
if (appKey && appKey[1] !== publicKey) fail('VAPID_PRIVATE_KEY does not match the public key in app/push-config.js: the phone subscribed with a different key pair.');

const subDoc = JSON.parse(read('data/log/push_subscription.json') || 'null');
const sub = subDoc && subDoc.value;
if (!sub || !sub.endpoint || sub.revoked) fail('No push subscription yet: Walter turns notifications on in Settings → Notifications. Nothing sent.');
if (sub.vapid_public_key && sub.vapid_public_key !== publicKey) fail('The phone subscribed with another key: ask Walter to tap Turn on notifications again.');

let messages;
if (process.argv.includes('--test')) {
  messages = [{ kind: 'test', title: 'WMCoach', body: 'The daily coach run can reach your phone.', url: './#/week', tag: 'routine-test' }];
} else {
  const run = JSON.parse(read('.coach/run.json') || 'null');
  if (!run) fail('No .coach/run.json: run scripts/daily.mjs first.');
  messages = run.notifications || [];
}
if (!messages.length) {
  console.log('Nothing to send.');
  process.exit(0);
}

const vapid = { privateKey, publicKey, subject: process.env.VAPID_SUBJECT || 'https://woojmcd.github.io/WMCoach/' };
let failed = 0;
for (const m of messages) {
  const { kind, ...message } = m;
  try {
    const r = await sendPush({ subscription: sub, message, vapid });
    if (r.ok) console.log(`Sent (${kind}): ${message.title}`);
    else {
      failed += 1;
      console.error(`Push service said ${r.status} for "${message.title}"${r.gone ? ': the subscription is gone; Walter turns notifications on again in Settings' : ''}. ${r.detail}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`Couldn't reach the push service for "${message.title}": ${err.message}. Is ${new URL(sub.endpoint).host} allowed in the routine's network settings?`);
  }
}
process.exit(failed ? 1 : 0);
