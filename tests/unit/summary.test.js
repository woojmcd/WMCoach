import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weeklySummary, summaryVisibleUntil, activeSummaryCheckin, summaryPeriod } from '../../coach/summary.js';
import { addDays } from '../../coach/time.js';

const program = JSON.parse(readFileSync(new URL('../../data/program.json', import.meta.url), 'utf8'));
const bands = { cut: { target: [-0.75, -0.5], slow_limit: -0.4, cap: -1.0 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };
const CHECKIN = '2026-10-16'; // Friday

// Daily weigh-ins from `from` to `to`, gaining `pctPerWk` %BW per week from 165 lb.
function weighins(from, to, pctPerWk, { skip = () => false } = {}) {
  const out = [];
  let d = from; let i = 0;
  while (d <= to) {
    if (!skip(d)) out.push({ id: `w${i}`, local_date: d, weight_lb: 165 * (1 + (pctPerWk / 100) * (i / 7)) });
    d = addDays(d, 1); i += 1;
  }
  return out;
}

// Finished sessions for each program day in [from, to] (Mon–Fri), main lifts at `load` × `reps`.
function sessions(from, to, { load = (w) => 60 + w * 5, reps = () => 9, skipDates = [] } = {}) {
  const out = [];
  let d = from;
  while (d <= to) {
    const dow = ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const day = program.days.find((x) => x.dow === dow);
    if (day && day.exercises.length && !skipDates.includes(d)) {
      const week = Math.floor((Date.parse(d) - Date.parse(from)) / (7 * 86400000));
      out.push({
        id: `s-${d}`, local_date: d, status: 'finished', started_utc: `${d}T17:00:00Z`, week, deload: false,
        exercises: day.exercises.filter((e) => e.main_lift).map((e) => ({
          slot_id: e.id, movement: e.movement, name: e.name, change: week > 0 ? 'up' : null, calibration: week === 0,
          sets: [1, 2].map(() => ({ kind: e.type === 'top_backoff' ? 'top' : 'work', load: load(week), reps: reps(week), done: true })),
        })),
      });
    }
    d = addDays(d, 1);
  }
  return out;
}

const goodCheckin = {
  id: 'ci-1', local_date: CHECKIN, adherence_pct: 96, measurement_id: 'm2',
  biofeedback: { hunger: 4, energy: 4, sleep: 4, stress: 4, digestion: 5 },
};
const measurements = [
  { id: 'm1', local_date: '2026-10-09', avg: { waist: 32.4, arm: 14.5, thigh: 23.0, chest: 40.0 } },
  { id: 'm2', local_date: CHECKIN, avg: { waist: 32.5, arm: 14.7, thigh: 23.2, chest: 40.2 } },
];
const phase = { kind: 'bulk', start: '2026-10-04' };

function base(over = {}) {
  return {
    checkin: goodCheckin, weighins: weighins('2026-09-25', CHECKIN, 0.15), measurements,
    sessions: sessions('2026-10-05', '2026-10-16'), program, mode: 'bulk', phase, bands,
    today: CHECKIN, prepDow: 7, ...over,
  };
}

test('strong week: good tone, wins in the headline, every section present', () => {
  const s = weeklySummary(base());
  assert.equal(s.tone, 'good');
  assert.match(s.headline, /^Strong week: adherence 96 %, gaining at the right pace, \d main lifts? up\./);
  assert.deepEqual(s.points.map((p) => p.key), ['adherence', 'weight', 'training', 'body', 'recovery', 'plan']);
  const w = s.points.find((p) => p.key === 'weight');
  assert.equal(w.tone, 'good');
  assert.match(w.text, /inside the \+0\.10 to \+0\.20 bulk band/);
  const t = s.points.find((p) => p.key === 'training');
  assert.match(t.text, /^5 of 5 sessions\. Up: /);
  assert.match(s.points.find((p) => p.key === 'body').text, /Waist 32\.5 in \(\+0\.1 in vs last week, \+0\.1 in since the bulk began\)\. Arms, chest and thighs are growing faster/);
  assert.deepEqual(s.period, summaryPeriod(CHECKIN));
});

test('low adherence leads, blocks a macro change, and is never softened', () => {
  const s = weeklySummary(base({ checkin: { ...goodCheckin, adherence_pct: 70 } }));
  assert.equal(s.tone, 'bad');
  assert.match(s.headline, /^Adherence was 70 %, so the plan didn’t get a fair test\./);
  assert.match(s.focus, /6 of 7 days/);
  assert.match(s.points.find((p) => p.key === 'plan').text, /No macro change while adherence is under 90 %/);
  // the good news is still reported
  assert.match(s.headline, /On the plus side: .*main lifts? up/);
});

test('too few weigh-ins: the trend is called guesswork', () => {
  const skip = (d) => d >= '2026-10-10' && !['2026-10-12', '2026-10-14', '2026-10-16'].includes(d);
  const s = weeklySummary(base({ weighins: weighins('2026-09-25', CHECKIN, 0.15, { skip }) }));
  assert.equal(s.tone, 'warn');
  assert.match(s.headline, /^Only 3 weigh-ins, so the trend is guesswork\./);
  assert.match(s.points.find((p) => p.key === 'weight').text, /^3 weigh-ins this week; the trend needs 5\+/);
  assert.match(s.points.find((p) => p.key === 'plan').text, /No macro change on fewer than 5 weigh-ins/);
});

test('bulk gaining too fast is called fat gain', () => {
  const s = weeklySummary(base({ weighins: weighins('2026-09-25', CHECKIN, 0.6) }));
  assert.equal(s.tone, 'bad');
  assert.match(s.headline, /^Gaining too fast: a good share of it is fat\./);
  assert.match(s.points.find((p) => p.key === 'weight').text, /past the \+0\.35 cap/);
});

test('missed sessions and strength down on 3+ main lifts', () => {
  const ss = sessions('2026-10-05', '2026-10-16', { load: () => 70, reps: (w) => (w === 0 ? 10 : 7), skipDates: ['2026-10-15'] });
  const s = weeklySummary(base({ sessions: ss }));
  const t = s.points.find((p) => p.key === 'training');
  assert.equal(t.tone, 'bad');
  assert.match(t.text, /^4 of 5 sessions\. Missed Thu \(Upper Push #2\)\./);
  assert.match(t.text, /Down: .*70×10 → 70×7/);
  assert.match(s.headline, /Strength dropped on \d main lifts/);
});

test('calibration week: baselines, not progress', () => {
  const s = weeklySummary(base({ sessions: sessions('2026-10-12', '2026-10-16') }));
  assert.match(s.points.find((p) => p.key === 'training').text, /Baselines set on \d main lifts and \d+ calibration exercises\. Progress is measured from next week\./);
});

test('before the first logged session, nothing counts as missed', () => {
  const s = weeklySummary(base({ sessions: [] }));
  const t = s.points.find((p) => p.key === 'training');
  assert.equal(t.tone, 'info');
  assert.equal(t.text, 'Program not started yet: your first logged session sets the baselines.');
  assert.doesNotMatch(s.headline, /session|training/i);
  // a program that started on Wednesday: Mon and Tue weren't missed
  const late = weeklySummary(base({ sessions: sessions('2026-10-14', '2026-10-16') }));
  assert.match(late.points.find((p) => p.key === 'training').text, /^3 of 3 sessions\./);
});

test('no tape, low sleep, and kg units', () => {
  const s = weeklySummary(base({ checkin: { ...goodCheckin, measurement_id: null, biofeedback: { ...goodCheckin.biofeedback, sleep: 2 }, note: 'Long week at work' }, units: 'kg' }));
  assert.match(s.points.find((p) => p.key === 'body').text, /^No tape measurements this week/);
  const r = s.points.find((p) => p.key === 'recovery');
  assert.equal(r.tone, 'warn');
  assert.match(r.text, /Low: sleep\. Sleep is the cheapest performance fix there is\. Your note: “Long week at work”/);
  assert.match(s.points.find((p) => p.key === 'weight').text, /kg\/wk\).*Week average 7\d\.\d kg/);
});

test('plan section: a published change, or the same plan', () => {
  const next = { week_start: '2026-10-18', source: 'routine', changes: { changed: true, kcal: { from: 2353, to: 2491, delta: 138 } }, plan: { weekly_avg: { kcal: 2491 } } };
  const current = { week_start: '2026-10-11', source: 'carry', changes: { changed: false }, plan: { weekly_avg: { kcal: 2353 } } };
  let s = weeklySummary(base({ plans: { current, next } }));
  assert.equal(s.points.find((p) => p.key === 'plan').text, 'Changes Sun 18 Oct: +138 kcal a day (2,353 → 2,491). See Meals for the food changes.');
  s = weeklySummary(base({ plans: { current: { ...next, week_start: '2026-10-18' } }, today: '2026-10-19' }));
  assert.match(s.points.find((p) => p.key === 'plan').text, /^Changed Sun 18 Oct/);
  s = weeklySummary(base({ plans: { current } }));
  assert.equal(s.points.find((p) => p.key === 'plan').text, 'Same plan next week (2,353 kcal a day): prep as usual.');
});

test('the week after a plan change is observe-only for the rate', () => {
  const current = { week_start: '2026-10-11', source: 'seed', changes: { changed: true, kcal: { from: 2192, to: 2353, delta: 161 } }, plan: { weekly_avg: { kcal: 2353 } } };
  const s = weeklySummary(base({ plans: { current } }));
  assert.match(s.points.find((p) => p.key === 'weight').text, /First week after a plan change: part of this is water/);
});

test('visible from the check-in through the plan week it sets up; replaced by the next check-in', () => {
  assert.equal(summaryVisibleUntil('2026-10-16', 7), '2026-10-24');
  assert.equal(summaryVisibleUntil('2026-10-18', 7), '2026-10-31'); // a check-in on prep day covers the next plan week
  const c1 = { local_date: '2026-10-09' };
  const c2 = { local_date: '2026-10-16' };
  assert.equal(activeSummaryCheckin([c1], '2026-10-08', 7), null);
  assert.equal(activeSummaryCheckin([c1], '2026-10-09', 7), c1);
  assert.equal(activeSummaryCheckin([c1], '2026-10-17', 7), c1);
  assert.equal(activeSummaryCheckin([c1], '2026-10-18', 7), null);
  assert.equal(activeSummaryCheckin([c1, c2], '2026-10-16', 7), c2);
});
