import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRAVEL, travelExercise, travelDay, isTravelMovement } from '../../coach/travel.js';
import { planDay, historyFor } from '../../coach/progression.js';
import { weeklySummary } from '../../coach/summary.js';

const program = JSON.parse(readFileSync(new URL('../../data/program.json', import.meta.url), 'utf8'));
const slots = program.days.flatMap((d) => d.exercises);
const GYM_ONLY = ['machine', 'cable', 'smith_upper', 'smith_lower', 'assisted'];

test('every travel swap names a real slot, and no travel lift needs a machine, cable or Smith', () => {
  const ids = new Set(slots.map((e) => e.id));
  for (const id of Object.keys(TRAVEL)) assert.ok(ids.has(id), `${id} is in the program`);
  for (const ex of slots) {
    const t = travelExercise(ex);
    assert.ok(!GYM_ONLY.includes(t.equipment), `${ex.name} → ${t.name} (${t.equipment})`);
    assert.ok(isTravelMovement(t.movement), 'its own history');
    assert.equal(t.id, ex.id, 'same slot');
    assert.equal(t.sets, ex.sets, 'same sets');
    assert.ok(!t.alternates.includes(t.name));
  }
  const pull = travelExercise(slots.find((e) => e.id === 'tue-assisted-pullups'));
  assert.deepEqual([pull.name, pull.type, pull.load_kind], ['Pull-ups', 'amrap', 'bodyweight']);
  const push = travelExercise(slots.find((e) => e.id === 'mon-flat-db-bench'), 'Feet-Elevated Push-ups');
  assert.deepEqual([push.load_kind, push.type], ['bodyweight', 'amrap'], 'a bodyweight alternative is logged as reps');
});

const session = (date, dow, exercises, extra = {}) => ({ id: `s-${date}`, local_date: date, status: 'finished', started_utc: `${date}T17:00:00Z`, day_dow: dow, week: 1, deload: false, exercises, ...extra });
const sets = (load, reps, n = 2) => Array.from({ length: n }, () => ({ kind: 'work', load, reps, rir: 1, done: true, skipped: false }));

test('a travel workout progresses from the last travel workout and never moves the gym targets', () => {
  const mon = program.days.find((d) => d.dow === 1);
  const bench = mon.exercises.find((e) => e.id === 'mon-flat-db-bench');
  const flyes = mon.exercises.find((e) => e.id === 'mon-incline-db-flyes');
  const gym = session('2026-10-12', 1, [{ slot_id: flyes.id, movement: flyes.movement, name: flyes.name, sets: sets(30, 10, 3) }]);
  const before = planDay(mon, [gym], { mode: 'bulk', week: 2 }).find((p) => p.ex.id === flyes.id).target;
  // on the road: much lighter dumbbells, logged as the travel version
  const tFlyes = travelExercise(flyes);
  const trip = session('2026-10-19', 1, [{ slot_id: flyes.id, movement: tFlyes.movement, name: tFlyes.name, sets: sets(15, 10, 3) }], { travel: true });
  const after = planDay(mon, [gym, trip], { mode: 'bulk', week: 3 }).find((p) => p.ex.id === flyes.id).target;
  assert.deepEqual([after.load, after.change], [before.load, before.change], 'gym target unchanged by the trip');
  const travelPlan = planDay(travelDay(mon), [gym, trip], { mode: 'bulk', week: 3 });
  const tf = travelPlan.find((p) => p.ex.id === flyes.id);
  assert.equal(tf.movement, tFlyes.movement);
  assert.equal(tf.target.calibration, false, 'the second travel workout has a target');
  assert.ok(tf.target.load >= 15 && tf.target.load <= 20, `from the last travel load (got ${tf.target.load})`);
  assert.equal(travelPlan.find((p) => p.ex.id === bench.id).target.calibration, true, 'first time on the road: calibrate');
  assert.equal(historyFor([gym, trip], flyes.id, flyes.movement).length, 1);
});

test('the Week in review counts a travel workout as done and says so', () => {
  const days = program.days.filter((d) => d.exercises.length);
  const dates = { 1: '2026-10-12', 2: '2026-10-13', 3: '2026-10-14', 4: '2026-10-15', 5: '2026-10-16' };
  const ss = days.map((d) => {
    const day = d.dow === 3 ? travelDay(d) : d;
    return session(dates[d.dow], d.dow, day.exercises.map((e) => ({ slot_id: e.id, movement: e.movement, name: e.name, sets: sets(20, 10) })), d.dow === 3 ? { travel: true } : {});
  });
  const s = weeklySummary({
    checkin: { local_date: '2026-10-16', adherence_pct: 95, biofeedback: { hunger: 4, energy: 4, sleep: 4, stress: 4, digestion: 4 } },
    sessions: ss, program, weighins: [], measurements: [], bands: { bulk: { target: [0.1, 0.2], cap: 0.35 } }, today: '2026-10-16',
  });
  const t = s.points.find((p) => p.key === 'training').text;
  assert.match(t, /^5 of 5 sessions\. Travel workout: Legs and abs \(done with comparable lifts; strength is judged on gym days\)\./);
  assert.doesNotMatch(t, /Missed/);
});
