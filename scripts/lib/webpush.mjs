// Web Push without dependencies (spec §8.4): RFC 8291 message encryption
// (aes128gcm, RFC 8188) and RFC 8292 VAPID, with node:crypto only.
import { createECDH, createHmac, createCipheriv, randomBytes, createPrivateKey, sign } from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 8291 §3.4 + RFC 8188: one record, padding delimiter 0x02.
export function encrypt({ payload, uaPublic, authSecret, asPrivate = null, salt = randomBytes(16), rs = 4096 }) {
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export function publicFromPrivate(privateKeyB64u) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64u.dec(privateKeyB64u));
  return b64u.enc(ecdh.getPublicKey());
}

// RFC 8292: Authorization: vapid t=<ES256 JWT>, k=<public key>
export function vapidAuthorization({ endpoint, privateKey, publicKey = null, subject, now = Date.now(), ttlSeconds = 12 * 3600 }) {
  const pub = publicKey || publicFromPrivate(privateKey);
  const raw = b64u.dec(pub);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u.enc(raw.subarray(1, 33)), y: b64u.enc(raw.subarray(33, 65)) }, format: 'jwk' });
  const head = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + ttlSeconds, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${pub}`;
}

// subscription: { endpoint, keys: { p256dh, auth } }; message: { title, body, url, tag }
export async function sendPush({ subscription, message, vapid, ttl = 24 * 3600, urgency = 'normal', fetchImpl = globalThis.fetch, now = Date.now() }) {
  const body = encrypt({ payload: Buffer.from(JSON.stringify(message)), uaPublic: b64u.dec(subscription.keys.p256dh), authSecret: b64u.dec(subscription.keys.auth) });
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidAuthorization({ endpoint: subscription.endpoint, privateKey: vapid.privateKey, publicKey: vapid.publicKey, subject: vapid.subject, now }),
      ...(message.tag ? { Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body,
  });
  let detail = '';
  try { detail = await res.text(); } catch { /* none */ }
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, detail: detail.slice(0, 300) };
}
