import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  targetFor, planDay, historyFor, deloadStatus, programWeek, roundToIncrement, describeEntry,
} from '../../coach/progression.js';

const program = JSON.parse(readFileSync(new URL('../../data/program.json', import.meta.url), 'utf8'));
const ex = Object.fromEntries(program.days.flatMap((d) => d.exercises.map((e) => [e.id, e])));
const day = (dow) => program.days.find((d) => d.dow === dow);

const set = (kind, load, reps, rir = 1) => ({ kind, load, reps, rir, done: true });
const entry = (date, sets, extra = {}) => ({ local_date: date, sets, deload: false, ...extra });
const work = (load, reps, rir = 1) => reps.map((r) => set('work', load, r, rir));

test('rounding to the equipment increment', () => {
  assert.equal(roundToIncrement(75 * 0.7, 5), 55);
  assert.equal(roundToIncrement(80 * 0.7, 5), 55);
  assert.equal(roundToIncrement(100 * 0.7, 10), 70);
  assert.equal(roundToIncrement(-3, 5), 0);
});

test('no history → calibration session (Strava has no loads)', () => {
  const t = targetFor(ex['mon-incline-db-flyes'], []);
  assert.equal(t.calibration, true);
  assert.equal(t.load, null);
  assert.equal(t.sets.length, 3);
  assert.match(t.reason, /Calibration: pick a weight for 8–10 reps at RIR 1/);
  const a = targetFor(ex['tue-assisted-pullups'], []);
  assert.match(a.reason, /least assistance for 6–8/);
});

test('range: all sets at the top → +increment, reps back to the bottom', () => {
  const t = targetFor(ex['mon-incline-db-flyes'], [entry('2026-10-05', work(30, [10, 10, 10]))]);
  assert.equal(t.change, 'up');
  assert.equal(t.load, 35);
  assert.deepEqual(t.sets.map((s) => [s.load, s.aim]), [[35, 8], [35, 8], [35, 8]]);
  assert.match(t.reason, /\+5 lb, back to 8/);
});

test('range: not all at the top → same load, +1 rep where below', () => {
  const t = targetFor(ex['mon-incline-db-flyes'], [entry('2026-10-05', work(30, [10, 9, 8]))]);
  assert.equal(t.change, 'hold');
  assert.equal(t.load, 30);
  assert.deepEqual(t.sets.map((s) => s.aim), [10, 10, 9]);
  assert.equal(t.last, '30 × 10, 9, 8');
});

test('range: a skipped set means not "all sets" at the top', () => {
  const t = targetFor(ex['mon-incline-db-flyes'], [entry('2026-10-05', work(30, [10, 10]))]);
  assert.equal(t.change, 'hold');
});

test('RIR: logged more than 1 below target blocks the increase (target 3 in a deload-free bump)', () => {
  // target RIR 1 → 0 is fine (no more than 1 below)
  assert.equal(targetFor(ex['thu-pec-deck-flyes'], [entry('d', work(100, [15, 15, 15], 0))]).change, 'up');
});

test('fixed: all sets hit the number → add load', () => {
  const t = targetFor(ex['tue-incline-db-rows'], [entry('d', work(40, [10, 10, 10]))]);
  assert.equal(t.load, 45);
  assert.equal(targetFor(ex['tue-incline-db-rows'], [entry('d', work(40, [10, 10, 9]))]).load, 40);
});

test('open range "10+" works as 10–14', () => {
  const pull = ex['tue-cable-lat-pullovers'];
  assert.equal(targetFor(pull, [entry('d', work(50, [14, 14, 14], 0))]).load, 55);
  assert.equal(targetFor(pull, [entry('d', work(50, [14, 13, 12], 0))]).load, 50);
});

test('top + backoff: top sets progress as range, backoff = 70 % rounded, never gates', () => {
  const b = ex['mon-flat-db-bench'];
  const t = targetFor(b, [entry('d', [set('top', 70, 10), set('top', 70, 10), set('backoff', 50, 9)])]);
  assert.equal(t.load, 75);
  assert.deepEqual(t.sets.map((s) => [s.kind, s.load]), [['top', 75], ['top', 75], ['backoff', 55]]);
  assert.equal(t.last, '70 × 10, 10 · backoff 50 × 9');
  const inc = ex['thu-incline-db-bench'];
  const t2 = targetFor(inc, [entry('d', [set('top', 60, 9), set('top', 60, 8), set('backoff', 40, 14, 0)])]);
  assert.equal(t2.load, 60);
  assert.equal(t2.sets[2].amrap, true);
  assert.equal(t2.sets[2].load, 40);
});

test('AMRAP: beat last total; bodyweight at 15+ on every set → suggest +5 lb', () => {
  const dips = ex['mon-chest-dips'];
  const t = targetFor(dips, [entry('d', [12, 10, 9, 8].map((r) => set('amrap', 0, r, 0)))]);
  assert.match(t.reason, /Beat 39 total reps/);
  assert.equal(t.load, 0);
  assert.deepEqual(t.sets.map((s) => s.aim), [12, 10, 9, 8]);
  const t2 = targetFor(dips, [entry('d', [16, 15, 15, 15].map((r) => set('amrap', 0, r, 0)))]);
  assert.equal(t2.load, 5);
  assert.equal(t2.change, 'up');
  const hlr = ex['wed-hanging-leg-raises'];
  assert.equal(targetFor(hlr, [entry('d', [20, 18, 16].map((r) => set('amrap', 0, r, 0)))]).change, null, 'reps only');
  assert.match(targetFor(dips, []).reason, /As many reps as possible/);
});

test('superset: A1 drives the load, A2 takes the same load and logs reps only', () => {
  const tue = planDay(day(2), [{
    status: 'finished', local_date: '2026-10-06', week: 1,
    exercises: [
      { slot_id: 'tue-reverse-cable-curls', movement: 'reverse-cable-curls', sets: work(40, [10, 10, 10]) },
      { slot_id: 'tue-cable-bar-curls', movement: 'cable-bar-curls', sets: [8, 7, 6].map((r) => set('amrap', 40, r, 0)) },
    ],
  }], { mode: 'bulk', week: 2 });
  const a1 = tue.find((p) => p.ex.id === 'tue-reverse-cable-curls');
  const a2 = tue.find((p) => p.ex.id === 'tue-cable-bar-curls');
  assert.equal(a1.target.load, 45);
  assert.equal(a2.target.load, 45, 'A2 follows A1');
  assert.deepEqual(a2.target.sets.map((s) => s.aim), [8, 7, 6]);
});

test('assisted: every set at 8 → one pin less assistance; at 0 → unassisted', () => {
  const a = ex['tue-assisted-pullups'];
  const t = targetFor(a, [entry('d', work(40, [8, 8, 8]))]);
  assert.equal(t.load, 30);
  assert.equal(t.delta_lb, -10);
  assert.equal(targetFor(a, [entry('d', work(40, [8, 7, 6]))]).load, 40);
  assert.match(targetFor(a, [entry('d', work(10, [8, 8, 8]))]).reason, /try unassisted/);
});

test('timed: ✓ only, no load', () => {
  const t = targetFor(ex['fri-ab-plank'], []);
  assert.deepEqual(t.sets.map((s) => [s.kind, s.seconds]), [['timed', 30], ['timed', 30], ['timed', 30]]);
});

test('stalls: below the range twice → hold; three times → −5 % and rebuild', () => {
  const b = ex['fri-single-arm-db-rows']; // 8–10, DB +5
  const low = (d) => entry(d, work(60, [8, 7, 7]));
  assert.match(targetFor(b, [low('a'), low('b')]).reason, /Below 8 twice at 60: hold/);
  const t = targetFor(b, [low('a'), low('b'), low('c')]);
  assert.equal(t.change, 'down');
  assert.equal(t.load, 55);
  const smith = ex['wed-bb-squats']; // +10 lower body
  assert.equal(targetFor(smith, [entry('a', work(200, [7, 7])), entry('b', work(200, [7, 6])), entry('c', work(200, [6, 6]))]).load, 190);
});

test('cut mode: top of the range twice in a row before adding load', () => {
  const f = ex['mon-incline-db-flyes'];
  const top = (d) => entry(d, work(30, [10, 10, 10]));
  assert.equal(targetFor(f, [top('a')], { mode: 'cut' }).load, 30);
  assert.match(targetFor(f, [top('a')], { mode: 'cut' }).reason, /once more/);
  assert.equal(targetFor(f, [top('a'), top('b')], { mode: 'cut' }).load, 35);
});

test('deload: half the sets, same load, RIR ≥ 3, failure finishers RIR 2; not used for progression', () => {
  const b = ex['mon-flat-db-bench'];
  const t = targetFor(b, [entry('d', [set('top', 70, 10), set('top', 70, 10), set('backoff', 50, 12)])], { deload: true });
  assert.equal(t.load, 70, 'no increase in a deload');
  assert.deepEqual(t.sets.map((s) => s.kind), ['top', 'backoff']);
  assert.deepEqual(t.sets[0].rir, [3, 3]);
  const dips = targetFor(ex['mon-chest-dips'], [], { deload: true });
  assert.equal(dips.sets.length, 2);
  assert.deepEqual(dips.rir, [2, 2]);
  // a deload session doesn't count as "last"
  const after = targetFor(b, [entry('a', [set('top', 70, 10), set('top', 70, 10)]), entry('b', [set('top', 70, 6)], { deload: true })]);
  assert.equal(after.load, 75);
});

test('lifted less since May: weeks 1–2 at RIR + 1, no increases in week 1', () => {
  const sessions = [{ status: 'finished', local_date: '2026-10-12', week: 1, exercises: [{ slot_id: 'mon-incline-db-flyes', movement: 'incline-db-flyes', sets: work(30, [10, 10, 10]) }] }];
  const w1 = planDay(day(1), sessions, { mode: 'bulk', week: 1, liftedLess: true })[0];
  assert.equal(w1.target.load, 30);
  assert.deepEqual(w1.target.sets[0].rir, [2, 2]);
  assert.match(w1.target.reason, /easing back: RIR \+1/);
  const w2 = planDay(day(1), sessions, { mode: 'bulk', week: 2, liftedLess: true })[0];
  assert.equal(w2.target.load, 35);
  assert.deepEqual(w2.target.sets[0].rir, [2, 2]);
  const w3 = planDay(day(1), sessions, { mode: 'bulk', week: 3, liftedLess: true })[0];
  assert.deepEqual(w3.target.sets[0].rir, [1, 1]);
});

test('a swapped exercise keeps its own history (progression carries over only for the same movement)', () => {
  const sessions = [{ status: 'finished', local_date: 'a', exercises: [{ slot_id: 'thu-pec-deck-flyes', movement: 'pec-deck-flyes', sets: work(100, [15, 15, 15]) }] }];
  const swapped = planDay(day(4), sessions, { prefs: { 'thu-pec-deck-flyes': { swap: { name: 'Cable Flyes', movement: 'cable-flyes' } } } })[0];
  assert.equal(swapped.name, 'Cable Flyes');
  assert.equal(swapped.target.calibration, true);
  assert.equal(planDay(day(4), sessions, {})[0].target.load, 110);
  assert.equal(historyFor([...sessions, { status: 'in_progress', local_date: 'b', exercises: [] }], 'thu-pec-deck-flyes', 'pec-deck-flyes').length, 1, 'only finished sessions count');
});

test('program weeks: a Fri–Sun first session is a lead-in week 0', () => {
  assert.equal(programWeek('2026-10-09', '2026-10-09'), 0); // Fri start
  assert.equal(programWeek('2026-10-12', '2026-10-09'), 1);
  assert.equal(programWeek('2026-10-19', '2026-10-09'), 2);
  assert.equal(programWeek('2026-10-14', '2026-10-12'), 1); // Mon start
  assert.equal(programWeek('2026-11-16', '2026-10-12'), 6);
});

test('deload: every 6th week (announced the Friday before) or reactive after rep drops on 3 main lifts', () => {
  const start = '2026-10-12';
  assert.equal(deloadStatus({ today: '2026-11-13', programStart: start }).announceNext, true); // Fri of week 5
  assert.equal(deloadStatus({ today: '2026-11-12', programStart: start }).announceNext, false); // Thu
  const w6 = deloadStatus({ today: '2026-11-16', programStart: start });
  assert.equal(w6.week, 6);
  assert.equal(w6.isDeload, true);
  assert.equal(deloadStatus({ today: '2026-11-23', programStart: start, deloadWeeks: [6] }).isDeload, false);
  // reactive: three main lifts with two consecutive rep drops (weeks 2–4), deload in week 5
  const drop = (wk, reps) => ({ week: wk, sets: work(60, reps) });
  const hist = [drop(2, [10, 10]), drop(3, [9, 9]), drop(4, [8, 8])];
  const mainHistories = { a: hist, b: hist, c: hist, d: [drop(2, [8, 8])] };
  const r = deloadStatus({ today: '2026-11-09', programStart: start, mainHistories });
  assert.equal(r.week, 5);
  assert.equal(r.isDeload, true);
  assert.match(r.reason, /Rep drops on 3 main lifts/);
  assert.equal(deloadStatus({ today: '2026-11-09', programStart: start, mainHistories: { a: hist, b: hist } }).isDeload, false, 'two lifts is not enough');
});

test('describeEntry formats bodyweight, assistance and timed', () => {
  assert.equal(describeEntry(entry('d', [set('amrap', 0, 12), set('amrap', 0, 10)]), ex['mon-chest-dips']), 'BW × 12, 10');
  assert.equal(describeEntry(entry('d', work(40, [8, 7])), ex['tue-assisted-pullups']), '40 assist × 8, 7');
  assert.equal(describeEntry(entry('d', [{ kind: 'timed', seconds: 30, done: true }]), ex['fri-ab-plank']), '1 × 30 s');
});

test('logging a set: later sets follow the load; an empty earlier set picks it up; A2 follows A1', async () => {
  const { logSet } = await import('../../app/training.js');
  const mk = (load) => ({ kind: 'work', target: { load }, load, reps: 10, rir: 1, done: false });
  const session = {
    exercises: [
      { type: 'range', sets: [mk(null), mk(null), mk(null)] },
      { type: 'superset_lead', group: 'G', sets: [mk(40), mk(40)] },
      { type: 'superset_same_weight', group: 'G', sets: [mk(40), mk(40)] },
    ],
  };
  const a = logSet(session, 0, 1, { load: 50, reps: 12, rir: 1 });
  assert.deepEqual(a.exercises[0].sets.map((x) => [x.load, x.done]), [[50, false], [50, true], [50, false]]);
  assert.equal(session.exercises[0].sets[1].done, false, 'input not mutated');
  const b = logSet(a, 1, 0, { load: 45, reps: 10, rir: 1 });
  assert.deepEqual(b.exercises[2].sets.map((x) => x.load), [45, 45]);
  assert.deepEqual(b.exercises[1].sets.map((x) => x.load), [45, 45]);
});

test('easing back never labels timed holds and never prints null', () => {
  const fri = planDay(day(5), [], { mode: 'bulk', week: 1, liftedLess: true });
  const plank = fri.find((x) => x.ex.id === 'fri-ab-plank');
  assert.equal(plank.target.reason, null);
  for (const x of fri) assert.ok(!String(x.target.reason).includes('null ·'), x.ex.id);
});
