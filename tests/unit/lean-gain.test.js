// The lean-gain plan (claude/NUTRITION_PLAN.md rev 4, 2026-11-14) as the app carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withMacros, foodDbOf, prepList, groceryList, optionStock, mealMacros, nextCarbStep, MEAL_ORDER, EXTRA_FOODS,
} from '../../coach/meals.js';
import { nextPlan } from '../../coach/weekly.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const plansJson = read('data/plans.json');
const db = foodDbOf(plansJson);
const cp = read('data/coach/plans/2026-11-15.json');
const plan = withMacros(db, cp.plan);

test('the food DB keeps every plans.json food and adds the new ones', () => {
  for (const k of Object.keys(plansJson.food_db)) assert.deepEqual(db[k], plansJson.food_db[k]);
  for (const k of ['daves_bread', 'banana', 'applesauce', 'instant_oatmeal', 'granola_g']) assert.ok(EXTRA_FOODS[k] && db[k]);
  assert.deepEqual([db.daves_bread.protein_g, db.daves_bread.carbs_g, db.daves_bread.fat_g], [6, 22, 1.5], 'Dave’s label, 45 g slice');
});

test('Mon–Fri day matches NUTRITION_PLAN.md: ~2,375 kcal, 184 P / 287 C / 55 F, meal by meal', () => {
  assert.deepEqual(Object.keys(plan.days.MP), ['M1', 'Lunch', 'Pre-workout', 'Post-workout', 'Evening']);
  for (const m of Object.keys(plan.days.MP)) assert.ok(MEAL_ORDER.includes(m), `${m} has a place in the order`);
  const pm = plan.macros.MP.per_meal;
  assert.deepEqual(Object.fromEntries(Object.entries(pm).map(([k, v]) => [k, v.kcal])), { M1: 461, Lunch: 650, 'Pre-workout': 382, 'Post-workout': 509, Evening: 371 });
  const { P, C, F, kcal } = plan.weekly_avg;
  assert.ok(Math.abs(kcal - 2375) <= 5, `${kcal}`);
  assert.ok(Math.abs(P - 184) <= 1 && Math.abs(C - 287) <= 1 && Math.abs(F - 55) <= 1, `${P}/${C}/${F}`);
  assert.ok(Object.values(pm).every((m) => m.kcal <= 650), 'no meal over ~650 kcal');
});

test('pre-workout options A/B/C: ~65 g carbs each; A ~385, B ~+55, C ~+90 kcal', () => {
  const opts = cp.plan.options['Pre-workout'];
  assert.deepEqual(opts.map((o) => o.key), ['A', 'B', 'C']);
  const m = opts.map((o) => mealMacros(db, o.foods));
  for (const x of m) assert.ok(Math.abs(x.C - 65) <= 2, `${x.C} g carbs`);
  const k = m.map((x) => Math.round(x.kcal));
  assert.ok(Math.abs(k[0] - 385) <= 5 && Math.abs(k[1] - k[0] - 55) <= 10 && Math.abs(k[2] - k[0] - 90) <= 10, k.join(' / '));
  assert.deepEqual(plan.days.MP['Pre-workout'], opts[0].foods, 'day totals use option A');
  // whey is in all three, so it's prepped; the rest is per-day stock
  assert.deepEqual(optionStock(plan)[0].options.map((o) => o.foods.map((f) => f.food)), [['banana', 'applesauce'], ['instant_oatmeal'], ['cheerios', 'skim_milk']]);
});

test('weekly prep (Mon–Fri) is the list in NUTRITION_PLAN.md', () => {
  const prep = Object.fromEntries(prepList(plan).map((p) => [p.food, p.total]));
  assert.deepEqual(prep, {
    egg: 15, daves_bread: 10, lean_beef: 30, rice: 1250, green_veg: 650, whey_iso: 5, chicken: 25, sweet_potato: 1500, greek_yogurt: 5, granola_g: 200, nut_butter: 80,
  });
  const g = Object.fromEntries(groceryList(prepList(plan)).map((x) => [x.food, x.amount]));
  assert.deepEqual([g.lean_beef, g.chicken, g.rice], ['2.5 lb', '2.1 lb', '420 g'], 'raw meat ≈ cooked ÷ 0.75, dry rice ≈ cooked ÷ 3');
});

test('weekly changes move lunch rice ±90 g (≈ ±100 kcal), never the CUT26 rice cakes', () => {
  const down = withMacros(db, nextCarbStep(plan, -1).plan);
  const up = withMacros(db, nextCarbStep(plan, 1).plan);
  assert.deepEqual([down.days.MP.Lunch[1].qty, up.days.MP.Lunch[1].qty], [160, 340], 'rice 250 → 160 / 340 g');
  for (const p of [down, up]) {
    const d = p.weekly_avg.kcal - plan.weekly_avg.kcal;
    assert.ok(Math.abs(d) >= 90 && Math.abs(d) <= 150, `${d}`);
  }
});

test('a plan’s own note isn’t carried into the next week (BULK-2026-11-08 kept "+1 carb step to fit 2488 kcal" under a −1 decision)', () => {
  const current = { plan: { ...plan, coach_note: 'Week 1 of the bulk: +1 carb step to fit 2488 kcal.' } };
  const r = nextPlan({ current, decision: { change: -1 }, flags: {}, foodDb: db });
  assert.equal(r.plan.coach_note, undefined);
  assert.equal(r.plan.days.MP.Lunch[1].qty, 160);
  assert.deepEqual(r.plan.options, plan.options, 'options and the rest of the plan carry');
});
