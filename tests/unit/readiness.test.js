import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readiness, baselines, travelShift, normalizeHealth } from '../../coach/readiness.js';
import { planDay } from '../../coach/progression.js';
import { addDays } from '../../coach/time.js';

const program = JSON.parse(readFileSync(new URL('../../data/program.json', import.meta.url), 'utf8'));
const TODAY = '2026-10-14'; // a Wednesday: Legs and abs
const week = (over = {}) => {
  const h = {};
  for (let i = 1; i <= 7; i += 1) h[addDays(TODAY, -i)] = { hrv_ms: 60 + (i % 3) * 2, resting_hr: 52, sleep_h: 7.5 };
  h[TODAY] = { hrv_ms: 61, resting_hr: 52, sleep_h: 7.4, ...over };
  return h;
};

test('green when nothing is flagged; baselines come from the 7 nights before', () => {
  const r = readiness({ today: TODAY, health: week() });
  assert.equal(r.status, 'green');
  assert.equal(r.reason, 'recovery normal');
  const b = baselines(week(), TODAY);
  assert.equal(b.hrv.n, 7);
  assert.equal(Math.round(b.rhr.mean), 52);
});

test('no recovery data → green with the reason "no recovery data" (spec §6.3)', () => {
  const r = readiness({ today: TODAY, health: {} });
  assert.deepEqual([r.status, r.reason, r.missing], ['green', 'no recovery data', true]);
});

test('one flag → amber (hold); two → red; amber three days running → red', () => {
  assert.equal(readiness({ today: TODAY, health: week({ sleep_h: 5.2 }) }).status, 'amber');
  const red = readiness({ today: TODAY, health: week({ sleep_h: 5.2, resting_hr: 59 }) });
  assert.equal(red.status, 'red');
  assert.match(red.reason, /resting HR up \(59 vs 52\), 5\.2 h sleep/);
  const hrvLow = readiness({ today: TODAY, health: week({ hrv_ms: 50 }) });
  assert.match(hrvLow.reason, /HRV low \(50 vs 62 ms\)/);
  const history = [{ local_date: addDays(TODAY, -1), status: 'amber' }, { local_date: addDays(TODAY, -2), status: 'amber' }];
  const run = readiness({ today: TODAY, health: week({ sleep_h: 5.5 }), history });
  assert.equal(run.status, 'red');
  assert.match(run.reason, /amber 3 days running/);
});

test('a hard session in the 24 h before Wednesday legs flags amber; not before other days', () => {
  const ride = { id: '1', type: 'Ride', local_date: addDays(TODAY, -1), start_local: `${addDays(TODAY, -1)}T09:00:00`, duration_s: 2 * 3600 + 600, relative_effort: 90 };
  const legs = readiness({ today: TODAY, health: week(), activities: [ride], dayName: 'Legs and abs' });
  assert.equal(legs.status, 'amber');
  assert.equal(legs.reason, '2 h 10 min ride yesterday');
  assert.equal(readiness({ today: TODAY, health: week(), activities: [ride], dayName: 'Push #1' }).status, 'green');
});

test('travel: a ≥ 3 h shift caps red at amber for 2 nights (spec §2b)', () => {
  const tzHistory = [{ tz: 'America/Los_Angeles', from_utc: '2026-09-01T00:00:00Z' }, { tz: 'Europe/Berlin', from_utc: `${addDays(TODAY, -1)}T10:00:00Z` }];
  const shift = travelShift(tzHistory, TODAY, 'Europe/Berlin');
  assert.equal(shift.hours, 9);
  const r = readiness({ today: TODAY, health: week({ sleep_h: 4.9, resting_hr: 60 }), tzHistory, tz: 'Europe/Berlin' });
  assert.equal(r.status, 'amber');
  assert.match(r.reason, /travel \(9 h shift\)/);
  assert.equal(travelShift(tzHistory, addDays(TODAY, 3), 'Europe/Berlin'), null, 'only the first 2 nights');
});

test('targets: amber holds every load (reason chip), red also drops one set', () => {
  const day = program.days.find((d) => d.name === 'Push #1');
  const ex = day.exercises.find((e) => e.type === 'range');
  // two sessions that hit the top of the range → normally +increment
  const sets = Array.from({ length: ex.sets }, () => ({ kind: 'work', load: 50, reps: ex.scheme.max, rir: 1, done: true }));
  const sessions = [{ id: 's1', local_date: '2026-10-05', status: 'finished', week: 1, exercises: [{ slot_id: ex.id, movement: ex.movement, sets }] }];
  const normal = planDay(day, sessions, { mode: 'bulk', week: 2 }).find((p) => p.ex.id === ex.id);
  assert.equal(normal.target.change, 'up');
  const amber = planDay(day, sessions, { mode: 'bulk', week: 2, readiness: { status: 'amber', reason: '5.2 h sleep' } }).find((p) => p.ex.id === ex.id);
  assert.equal(amber.target.load, 50);
  assert.equal(amber.target.reason, 'Held: 5.2 h sleep');
  assert.equal(amber.target.sets.length, ex.sets);
  const red = planDay(day, sessions, { mode: 'bulk', week: 2, readiness: { status: 'red', reason: 'HRV low, 5.2 h sleep' } }).find((p) => p.ex.id === ex.id);
  assert.equal(red.target.load, 50);
  assert.equal(red.target.sets.length, ex.sets - 1);
  assert.match(red.target.reason, /one set fewer today/);
});

test('Health files from the Shortcut: numeric strings and decimal commas count, empty values are missing', () => {
  assert.deepEqual(normalizeHealth({ date: '2026-10-14', hrv_ms: '62,5', resting_hr: 52, sleep_h: '7.25', steps: '', weight_lb: null }),
    { date: '2026-10-14', hrv_ms: 62.5, resting_hr: 52, sleep_h: 7.25, steps: null, weight_lb: null });
  assert.equal(normalizeHealth(null), null);
});
