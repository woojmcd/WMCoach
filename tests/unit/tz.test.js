import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeviceZone, setManualZone, setAutoZone, offsetLabel } from '../../app/tz.js';
import { defaultSettings } from '../../coach/seed.js';

const t0 = new Date('2026-10-09T07:00:00Z');
const t1 = new Date('2026-10-12T02:00:00Z');
const base = defaultSettings({ now: t0, tz: 'Europe/Berlin' });

test('auto: a new device zone is adopted and appended to the history', () => {
  const next = applyDeviceZone(base, 'Asia/Tokyo', t1);
  assert.equal(next.tz_current, 'Asia/Tokyo');
  assert.deepEqual(next.tz_history.at(-1), { tz: 'Asia/Tokyo', from_utc: t1.toISOString() });
  assert.equal(next.tz_history.length, 2);
  assert.equal(applyDeviceZone(next, 'Asia/Tokyo', t1), null, 'no change, no entry');
});

test('manual override ignores the device until switched back to auto', () => {
  const manual = setManualZone(base, 'America/Los_Angeles', t1);
  assert.equal(manual.tz_mode, 'manual');
  assert.equal(manual.tz_current, 'America/Los_Angeles');
  assert.equal(applyDeviceZone(manual, 'Asia/Tokyo', t1), null);
  const auto = setAutoZone(manual, 'Asia/Tokyo', t1);
  assert.equal(auto.tz_mode, 'auto');
  assert.equal(auto.tz_current, 'Asia/Tokyo');
  assert.equal(auto.tz_history.length, 3);
  assert.throws(() => setManualZone(base, 'Nowhere/Land', t1));
});

test('offset labels', () => {
  assert.equal(offsetLabel(540), 'UTC+9');
  assert.equal(offsetLabel(-420), 'UTC−7');
  assert.equal(offsetLabel(330), 'UTC+5:30');
  assert.equal(offsetLabel(0), 'UTC+0');
});
