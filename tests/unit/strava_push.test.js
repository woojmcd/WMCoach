import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { normalizeFetch, stravaPath, isEndurance, enduranceAddons, cardioByDate, effortQuartile, isHard } from '../../coach/strava.js';
import { encrypt, b64u, vapidAuthorization, publicFromPrivate, sendPush } from '../../scripts/lib/webpush.mjs';

// Shaped like the Strava connector's list_activities output.
const FETCHED = {
  activities: [
    { id: '20460941096', name: 'Lunch Ride', sport_type: 'Ride', start_local: '2026-10-05T15:17:33', location_summary: 'Koblenz, Germany', summary: { distance: 61113.8, moving_time: 10811, elapsed_time: 19524, elevation_gain: 135.2, relative_effort: 31, total_calories: 990 } },
    { id: '20325414423', name: 'Afternoon Trail Run', sport_type: 'TrailRun', start_local: '2026-09-25T17:11:29', summary: { distance: 4835.8, moving_time: 1619, elapsed_time: 1847, relative_effort: 46, total_calories: 549 } },
    { id: '1', name: 'Leg day', sport_type: 'WeightTraining', start_local: '2026-10-06T07:00:00', summary: { moving_time: 3600, total_calories: 300 } },
  ],
  performance: { 20460941096: { average_heartrate: 128.4, max_heartrate: 171 } },
};

test('Strava: normalized to one file per activity with the fields the coach uses', () => {
  const [ride, run, lift] = normalizeFetch(FETCHED);
  assert.deepEqual(ride, {
    schema_version: 1, id: '20460941096', name: 'Lunch Ride', type: 'Ride', start_local: '2026-10-05T15:17:33', local_date: '2026-10-05',
    duration_s: 10811, elapsed_s: 19524, distance_km: 61.11, elevation_m: 135, avg_hr: 128, max_hr: 171, hr_zones_s: null,
    relative_effort: 31, kcal: 990, location: 'Koblenz, Germany', source: 'strava',
  });
  assert.equal(stravaPath(ride), 'data/strava/2026-10-05-20460941096.json');
  assert.equal(isEndurance(ride), true, 'a ride over 2 h');
  assert.equal(isEndurance(run), false);
  // lifting is inside the 13.2 kcal/lb base; only cardio counts as expenditure on top
  const kcal = cardioByDate([ride, run, lift], [{ local_date: '2026-10-07', minutes: 30 }], 172);
  assert.equal(kcal.get('2026-10-05'), 990);
  assert.equal(kcal.get('2026-10-06'), undefined);
  assert.equal(Math.round(kcal.get('2026-10-07')), 221, 'stairs ✓ 30 min ≈ 220 kcal at ~172 lb (brief §1)');
});

test('Endurance add-on (spec §8.5): a long session that finished late yesterday → grab-and-go carbs today', () => {
  const [ride] = normalizeFetch(FETCHED);
  const [a] = enduranceAddons([ride], '2026-10-06');
  assert.equal(a.kcal, 500);
  assert.equal(a.carbs_g, 125);
  assert.ok(a.ideas.length >= 2);
  assert.equal(enduranceAddons([{ ...ride, start_local: '2026-10-05T06:00:00', elapsed_s: 11000 }], '2026-10-06').length, 0, 'an early ride was fuelled the same day');
  const efforts = Array.from({ length: 12 }, (_, i) => ({ relative_effort: 10 * i, type: 'Run', duration_s: 1800 }));
  const q = effortQuartile(efforts);
  assert.equal(q, 80);
  assert.equal(isHard({ type: 'Run', duration_s: 1800, relative_effort: 95 }, q), true);
  assert.equal(isHard({ type: 'WeightTraining', duration_s: 7200, relative_effort: 95 }, q), false);
});

test('Web Push encryption reproduces RFC 8291 Appendix A byte for byte', () => {
  const out = encrypt({
    payload: b64u.dec('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    uaPublic: b64u.dec('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    authSecret: b64u.dec('BTBZMqHH6r4Tts7J_aSIgg'),
    asPrivate: b64u.dec('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    salt: b64u.dec('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(b64u.enc(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID (RFC 8292): an ES256 JWT for the push service origin that verifies with the public key', async () => {
  const privateKey = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const pub = publicFromPrivate(privateKey);
  assert.equal(pub, 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const auth = vapidAuthorization({ endpoint: 'https://web.push.apple.com/QAbc', privateKey, subject: 'https://woojmcd.github.io/WMCoach/', now: Date.parse('2026-10-10T15:00:00Z') });
  const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, pub);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64u.dec(c).toString()), { aud: 'https://web.push.apple.com', exp: Date.parse('2026-10-10T15:00:00Z') / 1000 + 12 * 3600, sub: 'https://woojmcd.github.io/WMCoach/' });
  const raw = b64u.dec(pub);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.enc(raw.subarray(1, 33)), y: b64u.enc(raw.subarray(33)) }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.dec(s)), true);
  // sendPush posts an aes128gcm body with the right headers
  let seen = null;
  const r = await sendPush({
    subscription: { endpoint: 'https://web.push.apple.com/QAbc', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
    message: { title: 'Check-in today', body: 'x', url: './#/body', tag: 'checkin-2026-10-12' },
    vapid: { privateKey, subject: 'https://woojmcd.github.io/WMCoach/' },
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.Topic, 'checkin-2026-10-12');
  assert.equal(seen.init.body.length, 21 + 65 + JSON.stringify({ title: 'Check-in today', body: 'x', url: './#/body', tag: 'checkin-2026-10-12' }).length + 1 + 16);
});
