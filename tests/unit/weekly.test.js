import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  weeklyDecision, observeOnly, nextPlan, avoidFlagged, firstPlanForMode, changeText, weeklyNotification, planRecord, MAX_WEEKLY_KCAL,
} from '../../coach/weekly.js';
import { startingPlan, withMacros, nextCarbStep, applyCarbSteps } from '../../coach/meals.js';

const plansJson = JSON.parse(readFileSync(new URL('../../data/plans.json', import.meta.url), 'utf8'));
const foodDb = plansJson.food_db;
const bands = { cut: { target: [-0.75, -0.5], slow_limit: -0.4, cap: -1.0 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };
const base = { mode: 'bulk', bands, adherencePct: 96, weighinsWeek: 7, observe: { active: false }, washout: false };

test('§10 order: adherence first, then data, then the rate; the first failing step stops it', () => {
  let d = weeklyDecision({ ...base, adherencePct: 84, rate: 0.02, prevRates: [0.03] });
  assert.deepEqual([d.change, d.stoppedAt, d.reason], [0, 'adherence', 'adherence 84 % (under 90 %)']);
  d = weeklyDecision({ ...base, adherencePct: null, rate: 0.02 });
  assert.equal(d.reason, 'adherence not logged');
  d = weeklyDecision({ ...base, weighinsWeek: 4, rate: 0.02, prevRates: [0.03] });
  assert.deepEqual([d.change, d.stoppedAt, d.reason], [0, 'data', '4 weigh-ins this week (need 5)']);
  d = weeklyDecision({ ...base, rate: 0.02, prevRates: [0.03], observe: { active: true, reason: 'observe-only start: 6 more days and 3 more weigh-ins before the first change' } });
  assert.equal(d.stoppedAt, 'data');
});

test('bulk: slow 2 weeks → +1 step; one slow week waits; over the cap → −1 at once', () => {
  let d = weeklyDecision({ ...base, rate: 0.05, prevRates: [0.04] });
  assert.equal(d.change, +1);
  assert.equal(d.reason, 'rate +0.05 %BW/wk for 2 wks, under +0.10, adherence 96 %');
  d = weeklyDecision({ ...base, rate: 0.05, prevRates: [0.15] });
  assert.equal(d.change, 0);
  assert.match(d.reason, /one more week to confirm/);
  d = weeklyDecision({ ...base, rate: 0.41, prevRates: [] });
  assert.equal(d.change, -1);
  d = weeklyDecision({ ...base, rate: 0.15, prevRates: [0.05] });
  assert.equal(d.change, 0);
  assert.match(d.reason, /^rate on target \(\+0\.15 %BW\/wk\)/);
});

test('the week after a change is observe-only, unless the rate is past a hard limit', () => {
  assert.equal(weeklyDecision({ ...base, rate: 0.05, prevRates: [0.04], washout: true }).change, 0);
  assert.equal(weeklyDecision({ ...base, rate: 0.5, prevRates: [], washout: true }).change, -1);
});

test('cut: too slow 2 weeks → −1, but steps under the floor come first; too fast → +1; strength or biofeedback → slow the cut', () => {
  const cut = { ...base, mode: 'cut' };
  assert.equal(weeklyDecision({ ...cut, rate: -0.3, prevRates: [-0.35], stepsAvg: 9500, stepFloor: 8000 }).change, -1);
  const walk = weeklyDecision({ ...cut, rate: -0.3, prevRates: [-0.35], stepsAvg: 6200, stepFloor: 8000 });
  assert.deepEqual([walk.change, walk.stoppedAt], [0, 'activity']);
  assert.match(walk.reason, /steps 6,200\/day are under the 8,000 floor: walk first/);
  assert.equal(weeklyDecision({ ...cut, rate: -1.2, prevRates: [] }).change, +1);
  const tired = weeklyDecision({ ...cut, rate: -0.6, prevRates: [-0.6], bioAvg: 1.8 });
  assert.deepEqual([tired.change, tired.stoppedAt, tired.dietBreak], [1, 'recovery', true]);
});

test('carb steps one at a time, in the spec order, never over 150 kcal a week', () => {
  const start = startingPlan(plansJson, { weekStart: '2026-10-04' });
  const up1 = withMacros(foodDb, nextCarbStep(start, 1).plan);
  assert.equal(up1.carb_steps, 1);
  assert.ok(Math.abs(up1.weekly_avg.kcal - start.weekly_avg.kcal - 138) <= 1, 'spec §8.0: ≈ +138 kcal = rice 270 → 340 g + 1 rice cake');
  const up2 = withMacros(foodDb, nextCarbStep(up1, 1).plan);
  assert.deepEqual(up2.days.MP.M4.find((f) => f.food === 'sweet_potato').qty, 400);
  assert.deepEqual(withMacros(foodDb, applyCarbSteps({ structure: 'single', days: { MP: start.days.MP } }, 2)).weekly_avg, up2.weekly_avg, 'same as stepping from the template');
  const down = withMacros(foodDb, nextCarbStep(up2, -1).plan);
  assert.deepEqual(down.weekly_avg, up1.weekly_avg);
  const current = { id: '2026-10-11', plan: up1 };
  const np = nextPlan({ current, decision: { change: 1 }, flags: {}, foodDb });
  assert.ok(np.moved && np.plan.weekly_avg.kcal - up1.weekly_avg.kcal <= MAX_WEEKLY_KCAL);
  assert.equal(changeText(planRecord({ weekStart: '2026-10-18', mode: 'bulk', plan: np.plan, previous: current }).changes), 'M4 sweet potato 300 → 400 g, +1 rice cake');
});

test('GI flags: rice ↔ sweet potato and rice cakes ↔ Cream of Rice swap in the plan; others name the coach swap', () => {
  const start = startingPlan(plansJson, { weekStart: '2026-10-04' });
  const r = avoidFlagged(start, { rice: { gi_flag: true }, lean_beef: { gi_flag: true } }, foodDb);
  const post = r.plan.days.MP['Post-workout'];
  assert.ok(!post.some((f) => f.food === 'rice'));
  assert.equal(post.find((f) => f.food === 'sweet_potato').qty, 430); // 270 g rice × 1.6
  assert.ok(r.notes.includes('Post-workout: rice → sweet potato (1 g rice ≈ 1.6 g) (GI flag)'), r.notes.join(' | '));
  assert.ok(r.notes.includes('M4: beef/turkey is GI-flagged; swap for 93/7 turkey, 96/4 beef, steak or salmon'), r.notes.join(' | '));
  assert.equal(avoidFlagged(start, {}, foodDb).notes.length, 0);
});

test('mode switch (spec §8.3): cut ~400 under maintenance on the CUT26-V4 carb cycle; bulk = maintenance + 150–200', () => {
  const start = startingPlan(plansJson, { weekStart: '2026-10-04' });
  const current = { plan: start };
  const tdee = { estimate_kcal: 2600 };
  const cut = firstPlanForMode({ to: 'cut', current, tdee, weightLb: 175, plansJson });
  assert.equal(cut.plan.structure, 'carb_cycle');
  assert.ok(Math.abs(cut.plan.weekly_avg.kcal - 2200) <= 80, `${cut.plan.weekly_avg.kcal}`);
  const bulk = firstPlanForMode({ to: 'bulk', current, tdee, weightLb: 175, plansJson });
  assert.ok(Math.abs(bulk.plan.weekly_avg.kcal - 2775) <= 80, `${bulk.plan.weekly_avg.kcal}`);
  const maint = firstPlanForMode({ to: 'maintenance', current: { plan: cut.plan }, tdee, weightLb: 175, plansJson });
  assert.equal(maint.plan.weekly_avg.kcal > cut.plan.weekly_avg.kcal, true, 'out of a cut: +1 step toward maintenance');
});

test('observe-only start (spec §2a) and the Saturday notification (spec §8.1)', () => {
  assert.equal(observeOnly({ since: '2026-10-09', today: '2026-10-17', weighinsSince: 9 }).active, true);
  assert.equal(observeOnly({ since: '2026-10-09', today: '2026-10-24', weighinsSince: 12 }).active, false);
  const start = startingPlan(plansJson, { weekStart: '2026-10-04' });
  const next = withMacros(foodDb, nextCarbStep(start, 1).plan);
  const rec = planRecord({ weekStart: '2026-10-18', mode: 'bulk', plan: next, previous: { id: 'x', plan: start } });
  const n = weeklyNotification({ weekStart: '2026-10-18', changes: rec.changes, decision: { reason: 'rate +0.05 %BW/wk for 2 wks, under +0.10, adherence 96 %' } });
  assert.equal(n.body, 'Plan changes Sunday: +139 kcal. Post-workout rice 270 → 340 g, +1 rice cake. Reason: rate +0.05 %BW/wk for 2 wks, under +0.10, adherence 96 %.');
  const same = planRecord({ weekStart: '2026-10-18', mode: 'bulk', plan: start, previous: { id: 'x', plan: start } });
  assert.equal(weeklyNotification({ weekStart: '2026-10-18', changes: same.changes, decision: { reason: 'rate on target (+0.15 %BW/wk), adherence 96 %' } }).body,
    'No macro change this week. Rate on target (+0.15 %BW/wk), adherence 96 %. Prep as last week.');
});
