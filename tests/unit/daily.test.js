// Daily executive summary (Walter, 2026-10-13): yesterday in review + today's focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dailySummary, trainingDay, cardioDay, foodDay, weightDay, recoveryNight, todayLine } from '../../coach/daily.js';
import { baseCardio } from '../../coach/cardio.js';
import { trendFromEntries } from '../../coach/trend.js';
import { startingPlan } from '../../coach/meals.js';

const program = JSON.parse(readFileSync(new URL('../../data/program.json', import.meta.url), 'utf8'));
const plansJson = JSON.parse(readFileSync(new URL('../../data/plans.json', import.meta.url), 'utf8'));
const push = program.days.find((d) => d.dow === 1);
const set = (load, reps, kind = 'work') => ({ kind, load, reps, rir: 1, done: true, skipped: false });
function session(date, exs, extra = {}) {
  return { id: `s-${date}`, local_date: date, status: 'finished', day_dow: 1, day_name: 'Push #1', week: 1, deload: false, exercises: exs, ...extra };
}
const ex = (slot, sets, extra = {}) => ({ slot_id: slot.id, movement: slot.movement, name: slot.name, type: slot.type, skipped: false, sets, ...extra });
const [flyes, bench, , lateral] = push.exercises;

test('training: logged sets, lifts that beat last time, baselines and unlogged sets', () => {
  const prev = session('2026-10-05', [ex(flyes, [set(45, 10), set(45, 10)]), ex(bench, [set(65, 9, 'top'), set(65, 8, 'top')])]);
  const cur = session('2026-10-12', [
    ex(flyes, [set(50, 8), set(50, 8)]),
    ex(bench, [set(65, 10, 'top'), set(65, 9, 'top'), { ...set(null, null, 'backoff'), done: false }]),
    ex(lateral, [set(12.5, 12)]),
  ]);
  const t = trainingDay({ date: '2026-10-12', program, sessions: [prev, cur], programStart: '2026-10-05' });
  assert.equal(t.state, 'logged');
  assert.deepEqual([t.done, t.total, t.missingSets], [5, 6, 1]);
  assert.deepEqual(t.up.map((l) => l.name), [flyes.name, bench.name]);
  assert.match(t.point.text, /^Push #1: 5 of 6 sets logged\. Beat last time on 2: /);
  assert.match(t.point.text, /Flat DB Bench 65×10 \(was 65×9\)/);
  assert.match(t.point.text, /1 baseline set \(first time logged\)/);
  assert.match(t.point.text, /1 set not logged: those can’t drive the next targets\.$/);
  assert.equal(t.point.tone, 'good', '1 of 6 missing is under the 20 % line');
});

test('training: assisted lifts improve with less help; bodyweight sets by total reps', () => {
  const pull = program.days.find((d) => d.dow === 2);
  const assisted = pull.exercises.find((e) => e.load_kind === 'assistance');
  const dipsSlot = push.exercises.find((e) => e.load_kind === 'bodyweight');
  const a = (date, load, reps, dips) => session(date, [ex(assisted, [set(load, reps)]), ex(dipsSlot, dips.map((r) => set(0, r, 'amrap')))]);
  const t = trainingDay({ date: '2026-10-20', program, sessions: [a('2026-10-13', 50, 8, [12, 10]), a('2026-10-20', 45, 8, [13, 11])], programStart: '2026-10-13' });
  assert.deepEqual(t.up.map((l) => l.name), [assisted.name, dipsSlot.name]);
  assert.match(t.point.text, /Assisted Pullups 45 assist × 8 \(was 50 assist × 8\); Chest Dips 24 reps \(was 22 reps\)/);
  const worse = trainingDay({ date: '2026-10-20', program, sessions: [a('2026-10-13', 50, 8, [12]), a('2026-10-20', 55, 8, [12])], programStart: '2026-10-13' });
  assert.deepEqual(worse.down.map((l) => l.name), [assisted.name], 'more help is a step back');
});

test('training: a lift day with nothing logged, a Strava lift with no sets, open days and days before the first session', () => {
  const s0 = session('2026-10-05', [ex(flyes, [set(45, 10)])]);
  const missed = trainingDay({ date: '2026-10-12', program, sessions: [s0], programStart: '2026-10-05' });
  assert.equal(missed.state, 'missed');
  assert.match(missed.point.text, /^Push #1 wasn’t logged\./);
  const strava = trainingDay({ date: '2026-10-12', program, sessions: [s0], programStart: '2026-10-05', activities: [{ local_date: '2026-10-12', type: 'WeightTraining', duration_s: 2700 }] });
  assert.equal(strava.state, 'unlogged');
  assert.match(strava.point.text, /Strava shows a 45-min lift, but no sets were logged/);
  assert.equal(trainingDay({ date: '2026-10-10', program, sessions: [s0], programStart: '2026-10-05' }), null, 'Saturday is an open day');
  assert.equal(trainingDay({ date: '2026-10-12', program, sessions: [], programStart: null }), null, 'nothing is "missed" before the first session');
});

test('cardio: prescribed and done, missed, or extra, with the heart rate against Zone 2', () => {
  const rx = baseCardio('bulk');
  const hr = { lo: 126, hi: 156, source: 'strava' };
  const done = cardioDay({ date: '2026-10-13', rx, hr, stairs: [{ local_date: '2026-10-13', minutes: 25 }] });
  assert.equal(done.state, 'done');
  assert.match(done.point.text, /^Prescribed 25 min cardio: done\. 25 min stairs\. Week so far: 1 of 2 sessions\.$/);
  const missed = cardioDay({ date: '2026-10-13', rx, hr });
  assert.equal(missed.state, 'missed');
  assert.match(missed.point.text, /not done\. Week so far: 0 of 2 sessions\. It moves to the next free day\./);
  const run = cardioDay({ date: '2026-10-12', rx, hr, activities: [{ id: 1, local_date: '2026-10-12', type: 'Run', duration_s: 1380, avg_hr: 165 }] });
  assert.equal(run.state, 'extra', 'Monday is not a cardio day in a bulk');
  // Friday with nothing done yet: a run counts as the make-up session
  const fri = cardioDay({ date: '2026-10-16', rx, hr, activities: [{ id: 2, local_date: '2026-10-16', type: 'Run', duration_s: 1800, avg_hr: 140 }] });
  assert.match(fri.point.text, /^Prescribed 25 min make-up cardio: done\. 30 min run \(Strava\)\. Average HR 140: in Zone 2\./);
  assert.match(run.point.text, /23 min run \(Strava\)\. Average HR 165: above your Zone 2 \(126–156\), so a hard session/);
  assert.equal(cardioDay({ date: '2026-10-12', rx, hr }), null, 'nothing planned, nothing done');
  assert.equal(cardioDay({ date: '2026-10-14', rx, hr }), null, 'never a make-up on Wednesday legs');
});

test('food, weight and last night', () => {
  const plan = startingPlan(plansJson, { weightLb: 175, weekStart: '2026-10-11' });
  const plans = [{ week_start: '2026-10-11', plan }];
  assert.match(foodDay({ date: '2026-10-12', plans, taps: [{ local_date: '2026-10-12', status: 'yes' }] }).point.text, /^On plan \(2,\d{3} kcal\)\.$/);
  assert.equal(foodDay({ date: '2026-10-12', plans, taps: [{ local_date: '2026-10-12', status: 'off' }] }).state, 'off');
  assert.equal(foodDay({ date: '2026-10-12', plans, taps: [] }).point.tone, 'warn');
  // the latest tap of the day wins
  assert.equal(foodDay({ date: '2026-10-12', plans, taps: [{ local_date: '2026-10-12', status: 'off', updated_utc: '1' }, { local_date: '2026-10-12', status: 'yes', updated_utc: '2' }] }).state, 'yes');

  const weighins = ['2026-10-03', '2026-10-05', '2026-10-08', '2026-10-10', '2026-10-11', '2026-10-12'].map((d, i) => ({ local_date: d, weight_lb: 174 + i * 0.2 }));
  const series = trendFromEntries(weighins);
  const w = weightDay({ date: '2026-10-12', weighins, series });
  assert.match(w.point.text, /^175\.0 lb\. Trend 17\d\.\d lb \(\+0\.\d lb in a week\)\. 4 of the last 7 days: keep going daily\.$/);
  assert.match(weightDay({ date: '2026-10-12', weighins, series, units: 'kg' }).point.text, /^79\.4 kg\./);
  assert.match(weightDay({ date: '2026-10-13', weighins, series }).point.text, /^No weigh-in \(4 of the last 7 days\)/);

  const r = recoveryNight({ health: { sleep_h: 5.4, resting_hr: 61, steps: 5732 }, readiness: { status: 'amber', reason: '5.4 h sleep', missing: false, baseline: { resting_hr: 55 } } });
  assert.equal(r.point.tone, 'warn');
  assert.equal(r.point.text, '5.4 h sleep, under 6 h. Resting HR 61 (+6 vs your 55 average: a sign of fatigue or something coming on). 5,732 steps yesterday. Readiness amber (5.4 h sleep).');
  assert.match(recoveryNight({ health: { sleep_h: 7.1, resting_hr: 60 }, readiness: null }).point.text, /your average builds over the first few nights/);
  assert.equal(recoveryNight({ health: { steps: 8000 } }).state, 'none', 'steps alone isn’t recovery data');
  assert.match(recoveryNight({ health: { sleep_h: 7.5, steps: 6000 }, mode: 'cut' }).point.text, /under the 8,000 floor/);
});

test('headline and focus: the first problem first, then what went well; a clean day says so', () => {
  const s = session('2026-10-12', [ex(flyes, [set(45, 10)])]);
  const base = {
    date: '2026-10-12', program, sessions: [s], programStart: '2026-10-12', rx: baseCardio('bulk'),
    health: { '2026-10-13': { sleep_h: 7.4, resting_hr: 55 } }, weighins: [{ local_date: '2026-10-12', weight_lb: 175 }],
    taps: [{ local_date: '2026-10-12', status: 'yes' }],
  };
  const good = dailySummary(base);
  assert.equal(good.tone, 'good');
  assert.equal(good.headline, 'Good day: every set logged, on plan, weighed in.');
  assert.equal(good.label, 'Mon 12 Oct');
  assert.deepEqual(good.points.map((p) => p.key), ['training', 'food', 'weight', 'recovery']);

  const rough = dailySummary({ ...base, taps: [{ local_date: '2026-10-12', status: 'off' }], weighins: [], health: { '2026-10-13': { sleep_h: 5.2 } } });
  assert.equal(rough.tone, 'warn');
  assert.match(rough.headline, /^You were off plan\. Also: no weigh-in; short night \(5\.2 h\)\. Good: every set logged\.$/);
  assert.match(rough.focus, /^Back on the prepped meals today/);

  const red = dailySummary({ ...base, readiness: { status: 'red', reason: 'resting HR up (63 vs 55), 5.1 h sleep', missing: false, baseline: {} } });
  assert.equal(red.tone, 'bad');
  assert.match(red.headline, /^Recovery is red this morning/);
  assert.match(red.focus, /^Take today easier/);
});

test('today: the session, its load increases and calibrations, held loads, and the cardio', () => {
  const planned = [
    { name: 'Incline DB Flyes', target: { change: 'up', load: 50, sets: [{ aim: 8, reps_min: 8 }] } },
    { name: 'Standing Lateral DB Raises', target: { change: 'up', load: 22.5, sets: [{ aim: 10 }] } },
    { name: 'Cable Ab Crunches', target: { change: 'up', load: 60, sets: [{ aim: 15 }] } },
    { name: 'Single Arm DB Rows', target: { calibration: true, sets: [] } },
  ];
  const cardio = { today: { minutes: 25, kind: 'stairs', hr: { lo: 126, hi: 156 }, optional: false, makeup: false } };
  assert.equal(todayLine({ day: push, planned, cardio }), 'Push #1: up on Incline DB Flyes 50 lb × 8, Standing Lateral DB Raises 22.5 lb × 10 +1 more; 1 to calibrate (log the weight you use). Cardio: 25 min stairs at 126–156 bpm.');
  assert.equal(todayLine({ day: push, planned: [], readiness: { status: 'amber' } }), 'Push #1: loads held.');
  assert.equal(todayLine({ day: { exercises: [] }, cardio: { today: { minutes: 20, kind: 'walk', optional: false } } }), 'Open day. Cardio: 20 min easy walk.');
});
