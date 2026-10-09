// Cardio prescription (spec §6.5): the weekly dose by mode, the cut lever, today's
// session with readiness and make-ups, what counts as done, heart-rate zone 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseCardio, cardioText, nextCardio, rxForWeek, cardioItems, cardioForDay, parseHrZones, zone2, CUT_LADDER, itemText,
} from '../../coach/cardio.js';

test('base dose by mode: bulk 2 × 25 (Tue, Thu), maintenance 3 × 30, cut 4 × 30', () => {
  assert.equal(cardioText(baseCardio('bulk')), '2 × 25 min stairs (Tue, Thu)');
  assert.equal(cardioText(baseCardio('maintenance')), '3 × 30 min stairs (Mon, Tue, Thu)');
  assert.equal(cardioText(baseCardio('cut')), '4 × 30 min stairs (Mon, Tue, Thu, Fri)');
  assert.equal(baseCardio('bulk').weekly_min, 50);
  assert.equal(baseCardio('nonsense').mode, 'bulk');
  for (const m of ['bulk', 'maintenance', 'cut']) assert.equal(baseCardio(m).days.includes(3), false, `${m}: never on Wednesday legs`);
});

test('weekly step: bulk and maintenance hold the dose; the food decision is untouched', () => {
  const d = { change: 1, stoppedAt: null, reason: 'rate +0.05 %BW/wk for 2 wks' };
  const r = nextCardio({ mode: 'bulk', current: baseCardio('bulk'), decision: d });
  assert.equal(r.cardio.change, null);
  assert.deepEqual(r.decision, d);
  assert.equal(r.lever, 'food');
  assert.equal(nextCardio({ mode: 'maintenance', current: null, decision: { change: 0, stoppedAt: 'data', reason: 'x' } }).cardio.sessions, 3);
});

test('cut: a stall adds a cardio session first (food unchanged), down again when loss is too fast, food once at the top', () => {
  const stall = { change: -1, stoppedAt: null, reason: 'rate −0.30 %BW/wk for 2 wks, slower than −0.50' };
  const up = nextCardio({ mode: 'cut', current: baseCardio('cut'), decision: stall });
  assert.equal(up.lever, 'cardio');
  assert.equal(up.decision.change, 0, 'one lever a week: no carb step this week');
  assert.match(up.decision.reason, /one more cardio session, food unchanged$/);
  assert.equal(up.cardio.sessions, 5);
  assert.deepEqual(up.cardio.change, { from: '4 × 30 min stairs (Mon, Tue, Thu, Fri)', to: '5 × 30 min stairs (Mon, Tue, Thu, Fri, Sat)', sessions_delta: 1, min_delta: 30 });
  const top = { ...baseCardio('cut'), days: CUT_LADDER[2].days, sessions: 6, weekly_min: 180 };
  const atTop = nextCardio({ mode: 'cut', current: top, decision: stall });
  assert.equal(atTop.lever, 'food');
  assert.equal(atTop.decision.change, -1, 'cardio at his 6 × 30 cap: the carbs come down');
  const fast = nextCardio({ mode: 'cut', current: up.cardio, decision: { change: 1, stoppedAt: null, reason: 'rate −1.10 %BW/wk, past the −1.00 limit' } });
  assert.equal(fast.cardio.sessions, 4);
  assert.equal(fast.decision.change, 0);
  // gates (adherence, data, recovery, steps) leave cardio alone
  assert.equal(nextCardio({ mode: 'cut', current: up.cardio, decision: { change: 0, stoppedAt: 'adherence', reason: 'x' } }).cardio.sessions, 5);
  assert.equal(nextCardio({ mode: 'cut', current: up.cardio, decision: { change: 1, stoppedAt: 'recovery', dietBreak: true, reason: 'x' } }).cardio.sessions, 5);
});

test('mode switch: the new mode starts at its base dose and says what changed', () => {
  const r = nextCardio({ mode: 'bulk', current: baseCardio('bulk'), decision: { change: 0 }, modeSwitch: { to: 'cut' } });
  assert.equal(r.cardio.mode, 'cut');
  assert.equal(r.cardio.change.to, '4 × 30 min stairs (Mon, Tue, Thu, Fri)');
});

test('the week\'s prescription is the plan in force on its Monday (plans start on prep day)', () => {
  const cut5 = { ...baseCardio('cut'), sessions: 5, days: CUT_LADDER[1].days, weekly_min: 150 };
  const plans = [{ week_start: '2026-10-11', cardio: baseCardio('cut') }, { week_start: '2026-10-18', cardio: cut5 }];
  assert.equal(rxForWeek(plans, '2026-10-17', 'cut').sessions, 4);
  assert.equal(rxForWeek(plans, '2026-10-18', 'cut').sessions, 4, 'Sunday still belongs to the Mon 12th week');
  assert.equal(rxForWeek(plans, '2026-10-19', 'cut').sessions, 5);
  assert.equal(rxForWeek([{ week_start: '2026-10-11', plan: {} }], '2026-10-14', 'bulk').sessions, 2, 'older plans without cardio → base dose');
});

test('what counts: Strava cardio ≥ 15 min, Stairs ✓ taps (not twice on a Strava stairs day), no lifting', () => {
  const items = cardioItems({
    activities: [
      { id: 1, local_date: '2026-10-13', type: 'StairStepper', duration_s: 1620, name: 'Stairs', avg_hr: 131 },
      { id: 2, local_date: '2026-10-13', type: 'WeightTraining', duration_s: 3600 },
      { id: 3, local_date: '2026-10-14', type: 'Run', duration_s: 600 },
      { id: 4, local_date: '2026-10-17', type: 'Ride', duration_s: 7200, name: 'Saturday ride' },
      { id: 4, local_date: '2026-10-17', type: 'Ride', duration_s: 7200 },
    ],
    stairs: [{ local_date: '2026-10-13', minutes: 25 }, { local_date: '2026-10-15', minutes: 30 }, { local_date: '2026-10-16', minutes: 10 }],
  });
  assert.deepEqual(items.map((i) => [i.local_date, i.minutes, i.source]), [['2026-10-13', 27, 'strava'], ['2026-10-15', 30, 'tap'], ['2026-10-17', 120, 'strava']]);
  assert.equal(itemText(items[0]), '27 min stairs (Strava)');
  // items summarized by an earlier run (minutes, no duration_s) work as input too
  assert.equal(cardioItems({ activities: items.filter((i) => i.source === 'strava') }).length, 2);
});

test('today: scheduled days, done status, readiness, a long ride yesterday, target met', () => {
  const rx = baseCardio('bulk');
  const tue = cardioForDay({ rx, date: '2026-10-13', weightLb: 175, hr: { lo: 118, hi: 136, source: 'strava' } });
  assert.deepEqual([tue.today.minutes, tue.today.kind, tue.today.status, tue.today.makeup], [25, 'stairs', 'todo', false]);
  assert.equal(tue.today.kcal, 190, '5.4 MET at 175 lb ≈ 7.5 kcal/min');
  assert.deepEqual(tue.today.hr, { lo: 118, hi: 136, source: 'strava' });
  assert.equal(cardioForDay({ rx, date: '2026-10-12' }).today, null, 'Monday is not a cardio day in a bulk');
  assert.equal(cardioForDay({ rx, date: '2026-10-14' }).today, null, 'never on Wednesday legs, even when behind');
  const done = cardioForDay({ rx, date: '2026-10-13', items: [{ local_date: '2026-10-13', minutes: 26, type: 'StairStepper', source: 'tap' }] });
  assert.equal(done.today.status, 'done');
  assert.deepEqual([done.week.done_sessions, done.week.done_min, done.week.target_sessions], [1, 26, 2]);
  const amber = cardioForDay({ rx, date: '2026-10-13', readiness: { status: 'amber', reason: '5.0 h sleep' } });
  assert.match(amber.today.note, /^Readiness amber \(5\.0 h sleep\): keep it truly easy/);
  assert.equal(amber.today.minutes, 25);
  const red = cardioForDay({ rx, date: '2026-10-13', readiness: { status: 'red', reason: 'HRV low, 4.8 h sleep' }, weightLb: 175 });
  assert.deepEqual([red.today.kind, red.today.minutes, red.today.kcal], ['walk', 20, null]);
  const ride = cardioForDay({ rx, date: '2026-10-13', addons: [{ kcal: 600 }] });
  assert.deepEqual([ride.today.minutes, ride.today.optional], [20, true]);
  const met = cardioForDay({ rx, date: '2026-10-15', items: [{ local_date: '2026-10-12', minutes: 40, type: 'Run' }, { local_date: '2026-10-13', minutes: 25, type: 'StairStepper' }] });
  assert.equal(met.today.optional, true);
  assert.match(met.today.note, /target already met/);
  const extra = cardioForDay({ rx, date: '2026-10-12', items: [{ local_date: '2026-10-12', minutes: 40, type: 'Run' }] });
  assert.equal(extra.today, null);
  assert.equal(extra.extra.length, 1, 'cardio on an unplanned day still shows and counts');
});

test('a missed session moves to the next free day (not Wednesday), e.g. Friday after a missed Tuesday', () => {
  const rx = baseCardio('bulk');
  const thu = [{ local_date: '2026-10-15', minutes: 25, type: 'StairStepper' }];
  const fri = cardioForDay({ rx, date: '2026-10-16', items: thu });
  assert.equal(fri.today.makeup, true);
  assert.match(fri.today.note, /^Make-up: 1 session behind this week\./);
  assert.equal(cardioForDay({ rx, date: '2026-10-16', items: [...thu, { local_date: '2026-10-13', minutes: 25, type: 'StairStepper' }] }).today, null);
});

test('heart rate: Strava zone 2 from get_athlete_zones, else 60–70 % of his highest Strava heart rate', () => {
  const raw = { heart_rate: { custom_zones: false, zones: [{ min: 0, max: 118 }, { min: 118, max: 147 }, { min: 147, max: 162 }, { min: 162, max: 176 }, { min: 176, max: -1 }] }, power: { zones: [{ min: 0, max: 1 }, { min: 1, max: 2 }, { min: 2, max: 3 }, { min: 3, max: 4 }] } };
  const zones = parseHrZones(raw);
  assert.equal(zones.length, 5);
  assert.deepEqual(zone2({ zones }), { lo: 118, hi: 147, source: 'strava' });
  assert.equal(parseHrZones({ nothing: true }), null);
  // the Strava connector's shape (get_athlete_zones, 2026-10): top zone has no max, run/power zones alongside
  const mcp = { heart_rate_zones: [{ min: 0, max: 125 }, { min: 126, max: 156 }, { min: 157, max: 172 }, { min: 173, max: 187 }, { min: 188 }], heart_rate_zone_source: 'MaxHeartRateFromAge', power_zones: [{ min: 0, max: 94 }, { min: 95, max: 128 }, { min: 129, max: 154 }, { min: 155, max: 180 }, { min: 181, max: 205 }, { min: 206, max: 257 }, { min: 258 }], run_zones: [{ min: 0, max: 2.784 }, { min: 2.784, max: 3.234 }, { min: 3.234, max: 3.602 }, { min: 3.602, max: 3.848 }, { min: 3.848 }] };
  assert.deepEqual(parseHrZones(mcp)[4], { min: 188, max: -1 });
  assert.deepEqual(zone2({ zones: parseHrZones(mcp) }), { lo: 126, hi: 156, source: 'strava' });
  assert.equal(parseHrZones({ run_zones: mcp.run_zones, power_zones: mcp.power_zones }), null, 'never mistakes pace or power zones for heart rate');
  assert.deepEqual(zone2({ activities: [{ max_hr: 181 }, { max_hr: 176 }, { max_hr: 170 }] }), { lo: 109, hi: 127, source: 'estimate', max_hr: 181 });
  assert.equal(zone2({ activities: [{ max_hr: 181 }] }), null, 'too few sessions to estimate');
});
