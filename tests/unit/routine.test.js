// The daily run (spec §7) end to end against an in-memory repo: day by day,
// with the phone's data/log as the input and the routine's files as the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dailyRun, preflight, checkWrites } from '../../coach/routine.js';
import { startingPlan } from '../../coach/meals.js';
import { addDays } from '../../coach/time.js';

const disk = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const plansJson = JSON.parse(disk('data/plans.json'));
const ONBOARD = '2026-10-09';

function memRepo(files) {
  return {
    files,
    read: (p) => (p in files ? files[p] : null),
    list: (prefix) => Object.keys(files).filter((p) => p.startsWith(prefix)).sort(),
    exists: (p) => p in files,
  };
}
const doc = (store, records) => `${JSON.stringify({ schema_version: 4, store, records }, null, 2)}\n`;
const metaDoc = (key, value) => `${JSON.stringify({ schema_version: 4, key, updated_utc: '2026-10-09T16:00:00Z', value }, null, 2)}\n`;
const at = (date) => new Date(`${date}T15:00:00Z`); // 08:00 in Los Angeles

function phone({ settings = {}, weight = () => 175, until = '2026-11-08' } = {}) {
  const files = {};
  for (const p of ['data/program.json', 'data/plans.json', 'data/weight_daily.csv', 'data/metabolic_profile.json', 'data/model/state.json']) files[p] = disk(p);
  files['data/log/settings.json'] = metaDoc('settings', {
    tz_mode: 'auto', tz_current: 'America/Los_Angeles', tz_history: [{ tz: 'America/Los_Angeles', from_utc: '2026-10-09T16:00:00Z' }],
    prep_day: 7, checkin_day: 1, mode: 'bulk', mode_since: ONBOARD, lifted_less_since_may: false, step_floor: 8000, units: 'lb', ...settings,
  });
  files['data/log/onboarding.json'] = metaDoc('onboarding', { completed_local_date: ONBOARD, tz: 'America/Los_Angeles' });
  files['data/log/push_subscription.json'] = metaDoc('push_subscription', { endpoint: 'https://web.push.apple.com/Q1', keys: { p256dh: 'x', auth: 'y' } });
  const seed = startingPlan(plansJson, { weightLb: 175, weekStart: '2026-10-04', id: 'BULK-2026-10-04' });
  files['data/log/plans/2026-10.json'] = doc('plans', [{ id: '2026-10-04', week_start: '2026-10-04', week_end: '2026-10-10', mode: 'bulk', plan: seed, source: 'seed', changes: { changed: true, items: [], kcal: { from: 2192, to: seed.weekly_avg.kcal, delta: 1 } } }]);
  const byMonth = {};
  const taps = {};
  const checkins = {};
  for (let d = ONBOARD, i = 0; d <= until; d = addDays(d, 1), i += 1) {
    (byMonth[d.slice(0, 7)] ||= []).push({ id: `w-${d}`, local_date: d, tz: 'America/Los_Angeles', weight_lb: weight(i), source: 'app', updated_utc: `${d}T15:00:00Z` });
    (taps[d.slice(0, 7)] ||= []).push({ id: `plan-${d}`, local_date: d, status: 'yes', updated_utc: `${d}T20:00:00Z` });
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) (checkins[d.slice(0, 7)] ||= []).push({ id: `ci-${d}`, local_date: d, adherence_pct: 96, biofeedback: { hunger: 4, energy: 4, sleep: 4, stress: 4, digestion: 4 } });
  }
  for (const [m, rs] of Object.entries(byMonth)) files[`data/log/weighins/${m}.json`] = doc('weighins', rs);
  for (const [m, rs] of Object.entries(taps)) files[`data/log/adherence/${m}.json`] = doc('adherence', rs);
  for (const [m, rs] of Object.entries(checkins)) files[`data/log/checkins/${m}.json`] = doc('checkins', rs);
  return memRepo(files);
}

// Only what the phone had logged by `date` is visible to that day's run.
function asOf(repo, date) {
  const files = {};
  for (const [p, t] of Object.entries(repo.files)) {
    if (/^data\/log\/(weighins|adherence|checkins)\//.test(p)) {
      const d = JSON.parse(t);
      // the 08:00 run comes before that morning's check-in
      files[p] = doc(d.store, d.records.filter((r) => (d.store === 'checkins' ? r.local_date < date : r.local_date <= date)));
    } else files[p] = t;
  }
  return memRepo(files);
}

function run(repo, date, extra = {}) {
  const view = asOf(repo, date);
  const r = dailyRun({ repo: view, now: at(date), ...extra });
  assert.deepEqual(checkWrites(r.writes, (p) => p in repo.files), [], 'routine-owned paths only');
  for (const [p, t] of Object.entries(r.writes)) repo.files[p] = t; // commit
  return r;
}
const J = (repo, p) => JSON.parse(repo.files[p]);

test('first run: today\'s targets and readiness, the check-in notification on check-in day, then idempotent', () => {
  const repo = phone();
  assert.deepEqual(preflight({ repo, now: at('2026-10-12') }), { today: '2026-10-12', tz: 'America/Los_Angeles', run: true, rerun: false, strava_range_start: '2026-09-28T00:00:00', strava_range_end: '2026-10-12T23:59:59' });
  const r = run(repo, '2026-10-12');
  assert.equal(r.status, 'done');
  assert.equal(r.commitMessage, 'daily 2026-10-12 (America/Los_Angeles)');
  const t = J(repo, 'data/targets/today.json');
  assert.equal(t.local_date, '2026-10-12');
  assert.equal(t.day.name, 'Push #1');
  assert.deepEqual([t.readiness.status, t.readiness.reason], ['green', 'no recovery data']);
  assert.ok(t.exercises.filter((e) => e.calibration).length >= 5 && !t.exercises.some((e) => e.change === 'up'), 'first sessions are calibrations');
  assert.deepEqual(r.notifications.map((n) => [n.kind, n.title, n.url]), [['hello', 'WMCoach coach run is on', './#/week'], ['checkin', 'Check-in today', './#/body']]);
  assert.equal(J(repo, 'data/model/state.json').last_daily_run_local_date, '2026-10-12');
  assert.equal(J(repo, 'data/model/state.json').trend.trend_lb, 175);
  // once the check-in is logged, a check-in-day run doesn't remind again
  const done = phone();
  const view = asOf(done, '2026-10-12');
  view.files['data/log/checkins/2026-10.json'] = doc('checkins', [{ id: 'ci-x', local_date: '2026-10-12', adherence_pct: 96, biofeedback: {} }]);
  assert.equal(dailyRun({ repo: view, now: at('2026-10-12') }).notifications.some((n) => n.kind === 'checkin'), false);
  const again = run(repo, '2026-10-12');
  assert.equal(again.status, 'skip');
  assert.deepEqual(again.writes, {});
});

test('late Health data: the next fire recomputes readiness and targets only, once (spec §2b)', () => {
  const repo = phone();
  run(repo, '2026-10-14');
  assert.equal(J(repo, 'data/model/state.json').health_missing_on, '2026-10-14');
  for (let i = 1; i <= 7; i += 1) repo.files[`data/health/${addDays('2026-10-14', -i)}.json`] = JSON.stringify({ hrv_ms: 62, resting_hr: 52, sleep_h: 7.5 });
  repo.files['data/health/2026-10-14.json'] = JSON.stringify({ hrv_ms: 48, resting_hr: 52, sleep_h: 7.2, steps: 9000 });
  assert.equal(preflight({ repo, now: at('2026-10-14') }).rerun, true);
  const r = run(repo, '2026-10-14');
  assert.equal(r.status, 'rerun');
  assert.deepEqual(Object.keys(r.writes).sort(), ['data/model/state.json', 'data/targets/today.json']);
  assert.equal(J(repo, 'data/targets/today.json').readiness.status, 'amber');
  assert.match(J(repo, 'data/targets/today.json').readiness.reason, /HRV low/);
  assert.equal(run(repo, '2026-10-14').status, 'skip');
});

test('weekly step on Saturday, swap on Sunday; observe-only start, then the first change, then a washout week', () => {
  const repo = phone(); // flat at 175 lb: a slow bulk
  const days = [];
  for (let d = '2026-10-10'; d <= '2026-11-01'; d = addDays(d, 1)) days.push(d);
  const weekly = {};
  for (const d of days) {
    const r = run(repo, d);
    if (r.notifications.some((n) => n.kind === 'weekly')) weekly[d] = { next: J(repo, 'data/plan/next.json'), n: r.notifications.find((n) => n.kind === 'weekly') };
  }
  assert.deepEqual(Object.keys(weekly), ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'], 'every Saturday, always (spec §8.1)');
  assert.equal(weekly['2026-10-10'].next.decision.stoppedAt, 'data');
  assert.match(weekly['2026-10-17'].n.body, /^No macro change this week\. Observe-only start: 6 more days/);
  const first = weekly['2026-10-24'];
  assert.equal(first.next.week_start, '2026-10-25');
  assert.equal(first.next.decision.change, 1, 'flat for 2 weeks in a bulk → +1 carb step');
  assert.ok(first.next.changes.kcal.delta > 0 && first.next.changes.kcal.delta <= 150);
  assert.match(first.n.body, /^Plan changes Sunday: \+\d+ kcal\. M4 sweet potato 300 → 400 g, \+1 rice cake\. Reason: rate [+−±]0\.\d\d %BW\/wk for 2 wks/);
  assert.match(weekly['2026-10-31'].next.decision.reason, /first week after a change, observe only/);
  // Sunday: next → current
  assert.equal(J(repo, 'data/plan/current.json').week_start, '2026-11-01');
  const log = J(repo, 'data/plan/changelog.json').entries;
  assert.deepEqual(log.map((e) => [e.week_start, e.changed]), [['2026-10-11', false], ['2026-10-18', false], ['2026-10-25', true], ['2026-11-01', false]]);
  const st = J(repo, 'data/model/state.json');
  assert.equal(st.last_weekly_run_week, '2026-11-01');
  assert.equal(st.tdee.method, 'blend');
  assert.ok(st.tdee.estimate_kcal > 2100 && st.tdee.estimate_kcal < 2900, `${st.tdee.estimate_kcal}`);
});

test('a missed Saturday: the first run on prep day does the weekly step before the swap', () => {
  const repo = phone();
  run(repo, '2026-10-16');
  const r = run(repo, '2026-10-18'); // no run on Saturday 17th
  assert.ok(r.notifications.some((n) => n.kind === 'weekly'));
  assert.equal(J(repo, 'data/plan/current.json').week_start, '2026-10-18');
  assert.equal('data/plan/next.json' in repo.files, false);
});

test('mode switch: the weekly step before the effective prep day builds the first cut plan (spec §8.3)', () => {
  const repo = phone({ settings: { pending_mode: { to: 'cut', effective_date: '2026-10-18', change_id: 'mc-1' } } });
  run(repo, '2026-10-17');
  const next = J(repo, 'data/plan/next.json');
  assert.equal(next.mode, 'cut');
  assert.equal(next.plan.structure, 'carb_cycle');
  assert.ok(next.plan.weekly_avg.kcal < 2400);
  assert.equal(next.decision.mode_switch.to, 'cut');
});

test('Strava: new activities become files once, never rewritten; a late long ride earns a carb add-on', () => {
  const repo = phone();
  const fetched = { activities: [{ id: '777', name: 'Long Ride', sport_type: 'Ride', start_local: '2026-10-16T14:00:00', summary: { distance: 90000, moving_time: 3 * 3600 + 600, elapsed_time: 4 * 3600, relative_effort: 140, total_calories: 1900 } }] };
  run(repo, '2026-10-17', { stravaFetched: fetched });
  assert.ok('data/strava/2026-10-16-777.json' in repo.files);
  const [addon] = J(repo, 'data/targets/today.json').addons;
  assert.equal(addon.kcal, 950);
  const r = run(repo, '2026-10-18', { stravaFetched: fetched });
  assert.equal('data/strava/2026-10-16-777.json' in r.writes, false, 'existing Strava entries are never rewritten');
});

test('write guard: the routine may never write the phone\'s or the Shortcut\'s paths', () => {
  assert.deepEqual(checkWrites({ 'data/log/settings.json': '{}', 'data/health/2026-10-10.json': '{}', 'data/targets/today.json': '{}' }, () => false), [
    'data/log/settings.json: not a routine-owned path',
    'data/health/2026-10-10.json: not a routine-owned path',
  ]);
  assert.deepEqual(checkWrites({ 'data/strava/2026-10-16-777.json': '{}' }, () => true), ['data/strava/2026-10-16-777.json: Strava entries are never rewritten']);
});
