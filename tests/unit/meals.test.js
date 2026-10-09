import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withMacros, startingPlan, applyCarbSteps, diffPlans, prepList, groceryList, planWeekStart, phaseWeekOf, dayMacros,
} from '../../coach/meals.js';

const plansJson = JSON.parse(readFileSync(new URL('../../data/plans.json', import.meta.url), 'utf8'));
const db = plansJson.food_db;
const v4 = plansJson.plans.find((p) => p.id === 'CUT26-V4');

test('macros reproduce every coach plan in plans.json exactly', () => {
  for (const p of plansJson.plans) {
    const m = withMacros(db, p);
    for (const dt of Object.keys(p.days)) {
      assert.equal(m.macros[dt].kcal, p.macros[dt].kcal, `${p.id} ${dt}`);
      assert.equal(m.macros[dt].P, p.macros[dt].P, `${p.id} ${dt} P`);
    }
    assert.deepEqual(m.weekly_avg, p.weekly_avg, `${p.id} weekly`);
  }
});

test('§8.0 starting plan: CUT26-V4 high-carb day every day, 2,353 kcal · P 189 · C 282 · F 52', () => {
  const p = startingPlan(plansJson, { weightLb: 168.4, weekStart: '2026-10-04' });
  assert.equal(p.structure, 'single');
  assert.equal(p.carb_steps, 0);
  assert.deepEqual(p.macros.MP, { ...p.macros.MP, kcal: 2353, P: 189.2, C: 281.8, F: 52.2 });
  assert.deepEqual(p.days.MP, v4.days.MP2);
  assert.equal(p.weekly_avg.kcal, 2353);
  assert.equal(p.based_on, 'CUT26-V4');
});

test('carb steps: step 1 is the spec example (+138 kcal: rice 270 → 340 g + 1 rice cake)', () => {
  const base = { structure: 'single', days: { MP: v4.days.MP2 } };
  const s1 = withMacros(db, applyCarbSteps(base, 1));
  assert.equal(s1.days.MP['Post-workout'].find((x) => x.food === 'rice').qty, 340);
  assert.equal(s1.days.MP['Pre-workout'].find((x) => x.food === 'rice_cake').qty, 6);
  assert.ok(Math.abs(s1.macros.MP.kcal - 2353 - 138) <= 1, `step ${s1.macros.MP.kcal - 2353}`); // 138.3 exact
  const s2 = withMacros(db, applyCarbSteps(base, 2));
  assert.equal(s2.days.MP.M4.find((x) => x.food === 'sweet_potato').qty, 400);
  assert.ok(s2.macros.MP.kcal - s1.macros.MP.kcal <= 150);
  // carb foods carry trace protein/fat: two steps add ~5 g P and < 1 g F
  assert.ok(s2.macros.MP.P - 189.2 < 6 && s2.macros.MP.F - 52.2 < 1, 'protein and fat stay put');
  const down = withMacros(db, applyCarbSteps(base, -1));
  assert.equal(down.days.MP['Post-workout'].find((x) => x.food === 'rice').qty, 200);
  assert.deepEqual(applyCarbSteps(applyCarbSteps(base, 2), -2).days, base.days);
});

test('rescale only when the weight is far from ~165 lb (13.2 × weight + 150–200)', () => {
  assert.equal(startingPlan(plansJson, { weightLb: 165 }).carb_steps, 0);
  assert.equal(startingPlan(plansJson, { weightLb: 169 }).carb_steps, 0);
  assert.equal(startingPlan(plansJson, { weightLb: 175 }).carb_steps, 1);
  assert.equal(startingPlan(plansJson, { weightLb: 158 }).carb_steps, -1);
  assert.match(startingPlan(plansJson, { weightLb: 175 }).coach_note, /\+1 carb step/);
});

test('What changed: CUT26-V4 carb cycle → week 1 (MP2 every day)', () => {
  const p = startingPlan(plansJson, { weightLb: 168 });
  const d = diffPlans(withMacros(db, v4), p);
  assert.equal(d.changed, true);
  assert.equal(d.structure, 'Carb cycling off: one plan every day.');
  assert.deepEqual(d.kcal, { from: 2192, to: 2353, delta: 161 });
  const low = d.items.filter((i) => i.where === 'on your former low days').map((i) => [i.meal, i.food, i.from, i.to]);
  assert.deepEqual(low, [['Pre-workout', 'rice_cake', 4, 5], ['Post-workout', 'rice', 200, 270], ['M4', 'sweet_potato', 200, 300]]);
  assert.equal(d.items.filter((i) => i.where === 'on your former high days').length, 0, 'high days unchanged');
  assert.equal(diffPlans(p, p).changed, false);
  const step = withMacros(db, applyCarbSteps(p, 1));
  assert.deepEqual(diffPlans(p, step).items.map((i) => `${i.meal} ${i.food} ${i.from} → ${i.to}`), ['Pre-workout rice_cake 5 → 6', 'Post-workout rice 270 → 340']);
});

test('prep list: week totals in cooked weights; carb cycles split by day type', () => {
  const p = startingPlan(plansJson, { weightLb: 168 });
  const prep = Object.fromEntries(prepList(p).map((x) => [x.food, x]));
  assert.equal(prep.chicken.total, 35);
  assert.equal(prep.rice.total, 1890);
  assert.equal(prep.green_veg.total, 910);
  assert.equal(prep.egg.total, 21);
  assert.equal(prep.rice_cake.total, 35);
  const cyc = Object.fromEntries(prepList(v4).map((x) => [x.food, x]));
  assert.equal(cyc.rice.total, 5 * 200 + 2 * 270);
  assert.deepEqual(cyc.rice.by_day_type, { MP1: 1000, MP2: 540 });
});

test('grocery list: raw/store units', () => {
  const g = Object.fromEntries(groceryList(prepList(startingPlan(plansJson, { weightLb: 168 }))).map((x) => [x.food, x]));
  assert.equal(g.chicken.amount, '2.9 lb');
  assert.equal(g.lean_beef.amount, '3.5 lb');
  assert.equal(g.rice.amount, '630 g');
  assert.equal(g.egg.note, '2 dozen');
  assert.equal(g.ezekiel.note, '≈ 2 loaves of ~20');
  assert.equal(g.rice_cake.note, '≈ 3 bags of ~14');
  assert.equal(g.blueberries.note, '≈ 1.5 pints');
  assert.equal(g.chicken.group, 'Protein');
});

test('plan weeks start on prep day; the bulk\'s partial first week is a lead-in', () => {
  assert.equal(planWeekStart('2026-10-09', 7), '2026-10-04');
  assert.equal(planWeekStart('2026-10-11', 7), '2026-10-11');
  assert.equal(phaseWeekOf('2026-10-04', '2026-10-09', 7), 0);
  assert.equal(phaseWeekOf('2026-10-11', '2026-10-09', 7), 1);
  assert.equal(phaseWeekOf('2026-10-25', '2026-10-09', 7), 3);
  assert.equal(phaseWeekOf('2026-10-11', '2026-10-11', 7), 1);
});

test('day macros carry per-meal numbers', () => {
  const m = dayMacros(db, v4.days.MP2);
  assert.equal(m.per_meal['Post-workout'].kcal, 587);
});

test('Week banner: "New plan Sunday" from the day before prep day until prep day, only when it changes', async () => {
  const { planNotice } = await import('../../app/meal-plans.js');
  const next = { week_start: '2026-10-25', changes: { changed: true, kcal: { delta: 138 } } };
  assert.equal(planNotice({ next, today: '2026-10-23' }), null);
  assert.deepEqual(planNotice({ next, today: '2026-10-24' }), { week_start: '2026-10-25', delta: 138 });
  assert.deepEqual(planNotice({ next, today: '2026-10-25' }), { week_start: '2026-10-25', delta: 138 });
  assert.equal(planNotice({ next: { ...next, changes: { changed: false } }, today: '2026-10-24' }), null);
  assert.equal(planNotice({ next: null, today: '2026-10-24' }), null);
});
