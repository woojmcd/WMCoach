// Meal plans (spec §4.4, §8): macros from the food DB, the §8.0 starting plan,
// carb steps, "What changed" diffs, the prep list and the grocery list.
// Plans use the plans.json format: { id, structure: 'single'|'carb_cycle',
// schedule?, days: { MP | MP1 | MP2: { meal: [{ food, name, qty, unit }] } } }.
import { addDays, isoWeekday } from './time.js';

export const TEMPLATE_ID = 'CUT26-V4';
export const MEAL_ORDER = ['M1', 'Pre-workout', 'Post-workout', 'M4', 'Snack'];

// Round like Python's round() so the numbers match plans.json (produced by the
// Python pipeline): only an exact binary half goes to the even digit; anything
// else rounds by its true value (215.05 is stored slightly above, so it rounds up).
function roundHalfEven(x, dp = 0) {
  const sign = x < 0 ? -1 : 1;
  const exact = Math.abs(x).toFixed(25); // the double's exact decimal expansion (to 25 places)
  const [int, frac] = exact.split('.');
  const tail = frac.slice(dp);
  if (tail[0] === '5' && /^0*$/.test(tail.slice(1))) {
    const digits = BigInt(int + frac.slice(0, dp));
    const even = digits % 2n === 0n ? digits : digits + 1n;
    return sign * Number(even) / 10 ** dp;
  }
  return sign * Number(Math.abs(x).toFixed(dp));
}
const r1 = (x) => roundHalfEven(x, 1);
const r0 = (x) => roundHalfEven(x, 0);
const kcalOf = (P, C, F) => 4 * P + 4 * C + 9 * F;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- macros ------------------------------------------------------------------------------

export function mealMacros(foodDb, foods) {
  let P = 0; let C = 0; let F = 0;
  for (const it of foods) {
    const f = foodDb[it.food];
    if (!f) throw new Error(`Unknown food ${it.food}`);
    P += f.protein_g * it.qty; C += f.carbs_g * it.qty; F += f.fat_g * it.qty;
  }
  return { P, C, F, kcal: kcalOf(P, C, F) };
}

export function dayMacros(foodDb, meals) {
  const per = {};
  let P = 0; let C = 0; let F = 0;
  for (const [meal, foods] of Object.entries(meals)) {
    const m = mealMacros(foodDb, foods);
    per[meal] = { P: r1(m.P), C: r1(m.C), F: r1(m.F), kcal: r0(m.kcal) };
    P += m.P; C += m.C; F += m.F;
  }
  return { P: r1(P), C: r1(C), F: r1(F), kcal: r0(kcalOf(P, C, F)), per_meal: per, _exact: { P, C, F } };
}

// How many days a week each day type runs.
export function dayCounts(plan) {
  if (plan.structure !== 'carb_cycle') return { MP: 7 };
  return { MP1: plan.schedule.mp1_days, MP2: plan.schedule.mp2_days };
}

export function withMacros(foodDb, plan) {
  const macros = {};
  for (const [dt, meals] of Object.entries(plan.days)) macros[dt] = dayMacros(foodDb, meals);
  // Weekly average from the rounded day values, the way plans.json computes it.
  const counts = dayCounts(plan);
  let P = 0; let C = 0; let F = 0; let K = 0; let n = 0;
  for (const [dt, k] of Object.entries(counts)) {
    const m = macros[dt];
    P += m.P * k; C += m.C * k; F += m.F * k; K += m.kcal * k; n += k;
  }
  for (const m of Object.values(macros)) delete m._exact;
  return { ...plan, macros, weekly_avg: { P: r1(P / n), C: r1(C / n), F: r1(F / n), kcal: r0(K / n) } };
}

// ---- carb steps (spec §8.0: carbs only, rice → sweet potato → rice cakes) -------------------
// One step ≈ +138 kcal. Odd steps: post-workout rice +70 g and +1 pre-workout rice
// cake (the spec's example: rice 270 → 340 g + 1 rice cake). Even steps: M4 sweet
// potato +100 g and +1 rice cake. Negative steps undo them in reverse.
const STEPS = [
  [['Post-workout', 'rice', 70], ['Pre-workout', 'rice_cake', 1]],
  [['M4', 'sweet_potato', 100], ['Pre-workout', 'rice_cake', 1]],
];

function bump(meals, meal, food, delta) {
  const it = (meals[meal] || []).find((x) => x.food === food);
  if (!it) return false;
  const next = Math.round((it.qty + delta) * 100) / 100;
  if (next < 0) return false;
  it.qty = next;
  return true;
}

// The carb step between positions j and j+1 (position 0 = the template).
const stepBetween = (j) => (j >= 0 ? STEPS[j % 2] : STEPS[(-j - 1) % 2]);

// One carb step up (+1) or down (−1) from the plan's current position (plan.carb_steps),
// keeping every other food as it is (swaps, flags). Spec §8.0 order: rice, then sweet potato.
export function nextCarbStep(plan, dir) {
  const out = clone(plan);
  const k = out.carb_steps || 0;
  const step = dir > 0 ? stepBetween(k) : stepBetween(k - 1);
  let moved = false;
  for (const meals of Object.values(out.days)) {
    for (const [meal, food, d] of step) if (bump(meals, meal, food, dir > 0 ? d : -d)) moved = true;
  }
  out.carb_steps = moved ? k + (dir > 0 ? 1 : -1) : k;
  return { plan: out, moved };
}

export function applyCarbSteps(plan, n) {
  const out = clone(plan);
  for (const meals of Object.values(out.days)) {
    if (n > 0) {
      for (let k = 0; k < n; k += 1) for (const [meal, food, d] of STEPS[k % 2]) bump(meals, meal, food, d);
    } else {
      for (let k = -n - 1; k >= 0; k -= 1) for (const [meal, food, d] of STEPS[k % 2]) bump(meals, meal, food, -d);
    }
  }
  return out;
}

// ---- the §8.0 starting plan -------------------------------------------------------------------
// CUT26-V4's high-carb day (MP2) every day, carb cycling off. If the first-launch
// weight is far from ~165 lb, rescale to (13.2 × weight + cardio) + 150–200 kcal by
// picking the nearest carb-step version.
export function startingPlan(plansJson, { weightLb = null, cardioKcal = 0, kcalPerLb = 13.2, surplus = [150, 200], weekStart, id } = {}) {
  const foodDb = plansJson.food_db;
  const tpl = plansJson.plans.find((p) => p.id === TEMPLATE_ID);
  if (!tpl) throw new Error(`${TEMPLATE_ID} missing from plans.json`);
  const base = { structure: 'single', days: { MP: clone(tpl.days.MP2) } };
  let steps = 0;
  let target = null;
  if (Number.isFinite(weightLb)) {
    target = kcalPerLb * weightLb + cardioKcal + (surplus[0] + surplus[1]) / 2;
    let best = Infinity;
    for (let n = -3; n <= 3; n += 1) {
      const k = withMacros(foodDb, applyCarbSteps(base, n)).weekly_avg.kcal;
      if (Math.abs(k - target) < best - 1e-9) { best = Math.abs(k - target); steps = n; }
    }
  }
  const plan = withMacros(foodDb, applyCarbSteps(base, steps));
  return {
    ...plan,
    id: id || `BULK-${weekStart || 'start'}`,
    phase: 'Bulk',
    start: weekStart || null,
    based_on: TEMPLATE_ID,
    carb_steps: steps,
    coach_note: steps === 0
      ? `Week 1 of the bulk: ${TEMPLATE_ID}'s high-carb day (MP2) every day. Carb cycling off.`
      : `Week 1 of the bulk: ${TEMPLATE_ID}'s high-carb day (MP2), ${steps > 0 ? '+' : ''}${steps} carb step${Math.abs(steps) === 1 ? '' : 's'} to fit ${Math.round(target)} kcal.`,
  };
}

// ---- "What changed" (spec §4.4) ------------------------------------------------------------

const DAY_LABEL = { MP: null, MP1: 'low days', MP2: 'high days' };

function pairsFor(prev, next) {
  const a = prev.structure === 'carb_cycle'; const b = next.structure === 'carb_cycle';
  if (!a && !b) return [['MP', 'MP', null]];
  if (a && !b) return [['MP1', 'MP', 'on your former low days'], ['MP2', 'MP', 'on your former high days']];
  if (!a && b) return [['MP', 'MP1', 'on low days'], ['MP', 'MP2', 'on high days']];
  return [['MP1', 'MP1', 'on low days'], ['MP2', 'MP2', 'on high days']];
}

export function diffPlans(prev, next) {
  const items = [];
  for (const [da, db, where] of pairsFor(prev, next)) {
    const A = prev.days[da] || {}; const B = next.days[db] || {};
    const meals = [...new Set([...MEAL_ORDER, ...Object.keys(A), ...Object.keys(B)])].filter((m) => A[m] || B[m]);
    for (const meal of meals) {
      const fa = A[meal] || []; const fb = B[meal] || [];
      const foods = [...new Set([...fa.map((x) => x.food), ...fb.map((x) => x.food)])];
      for (const food of foods) {
        const x = fa.find((i) => i.food === food); const y = fb.find((i) => i.food === food);
        const from = x ? x.qty : 0; const to = y ? y.qty : 0;
        if (from === to) continue;
        items.push({ where, meal, food, name: (y || x).name, unit: (y || x).unit, from, to });
      }
    }
  }
  let structure = null;
  if (prev.structure !== next.structure) {
    structure = next.structure === 'carb_cycle'
      ? `Carb cycling on: ${next.schedule.mp2_days} high days, ${next.schedule.mp1_days} low days.`
      : 'Carb cycling off: one plan every day.';
  }
  const kFrom = prev.weekly_avg ? prev.weekly_avg.kcal : null;
  const kTo = next.weekly_avg ? next.weekly_avg.kcal : null;
  return { structure, items, kcal: { from: kFrom, to: kTo, delta: kFrom !== null && kTo !== null ? kTo - kFrom : null }, changed: Boolean(structure || items.length) };
}

// ---- prep list and grocery list ----------------------------------------------------------------

export function prepList(plan) {
  const counts = dayCounts(plan);
  const totals = new Map();
  for (const [dt, meals] of Object.entries(plan.days)) {
    const days = counts[dt] || 0;
    for (const foods of Object.values(meals)) {
      for (const it of foods) {
        const t = totals.get(it.food) || { food: it.food, name: it.name, unit: it.unit, total: 0, by_day_type: {} };
        t.total += it.qty * days;
        t.by_day_type[dt] = (t.by_day_type[dt] || 0) + it.qty * days;
        totals.set(it.food, t);
      }
    }
  }
  return [...totals.values()].map((t) => ({ ...t, total: Math.round(t.total * 100) / 100 }));
}

// Store units. Cooked-weight foods convert to raw (meats lose ~25 % cooking; rice
// triples). Pack sizes are typical US packs: assumptions, shown with "≈".
const OZ_TO_G = 28.3495;
const G_TO_LB = 1 / 453.592;
export const GROCERY = {
  chicken: { group: 'Protein', label: 'Chicken breast, raw', raw: (cookedOz) => `${(cookedOz / 0.75 / 16).toFixed(1)} lb`, note: (q) => `${q} oz cooked` },
  lean_beef: { group: 'Protein', label: '93/7 ground beef or turkey, raw', raw: (cookedOz) => `${(cookedOz / 0.75 / 16).toFixed(1)} lb`, note: (q) => `${q} oz cooked` },
  egg: { group: 'Protein', label: 'Eggs', raw: (n) => `${n}`, note: (n) => `${Math.ceil(n / 12)} dozen` },
  egg_white: { group: 'Protein', label: 'Egg whites', raw: (n) => `${n}`, note: () => '' },
  whey_iso: { group: 'Protein', label: 'Whey isolate', raw: (n) => `${n} scoops`, note: () => '' },
  greek_yogurt: { group: 'Dairy', label: 'Greek yogurt, single-serve cups', raw: (n) => `${n}`, note: () => 'nonfat, ~150 g each' },
  rice: { group: 'Carbs', label: 'Jasmine rice, dry', raw: (cookedG) => `${Math.round(cookedG / 3 / 10) * 10} g`, note: (q) => `≈ ${(q / 3 / 185).toFixed(1)} cups dry · ${Math.round(q).toLocaleString('en-US')} g cooked` },
  sweet_potato: { group: 'Carbs', label: 'Sweet potatoes', raw: (g) => `${(g / 1000).toFixed(1)} kg`, note: (g) => `${(g * G_TO_LB).toFixed(1)} lb` },
  rice_cake: { group: 'Carbs', label: 'Flavored rice cakes', raw: (n) => `${n}`, note: (n) => `≈ ${Math.ceil(n / 14)} bags of ~14` },
  ezekiel: { group: 'Carbs', label: 'Ezekiel 4:9 bread', raw: (n) => `${n} slices`, note: (n) => `≈ ${Math.ceil(n / 20)} loaves of ~20` },
  granola: { group: 'Carbs', label: 'Granola', raw: (n) => `≈ ${Math.round(n * 23 / 10) * 10} g`, note: (n) => `${n} portions of ~23 g` },
  cream_rice: { group: 'Carbs', label: 'Cream of Rice, dry', raw: (g) => `${Math.round(g)} g`, note: () => '' },
  cheerios: { group: 'Carbs', label: 'Cheerios', raw: (g) => `${Math.round(g)} g`, note: () => '' },
  green_veg: { group: 'Veg and fruit', label: 'Green beans, broccoli or asparagus', raw: (g) => `${Math.round(g / 10) * 10} g`, note: (g) => `${(g * G_TO_LB).toFixed(1)} lb` },
  blueberries: { group: 'Veg and fruit', label: 'Blueberries', raw: (g) => `${Math.round(g / 10) * 10} g`, note: (g) => `≈ ${Math.ceil((g / 340) * 2) / 2} pints` },
  fruit: { group: 'Veg and fruit', label: 'Apples or bananas', raw: (n) => `${n}`, note: () => '' },
  nut_butter: { group: 'Pantry', label: 'Peanut or almond butter', raw: (g) => `${Math.round(g)} g`, note: (g) => `${Math.ceil(g / 454)} jar` },
};
export const GROCERY_GROUPS = ['Protein', 'Carbs', 'Veg and fruit', 'Dairy', 'Pantry', 'Other'];

export function groceryList(prep) {
  return prep.map((p) => {
    const g = GROCERY[p.food];
    if (!g) return { food: p.food, group: 'Other', label: p.name, amount: `${p.total} ${p.unit}`, note: '' };
    return { food: p.food, group: g.group, label: g.label, amount: g.raw(p.total), note: g.note(p.total) };
  });
}

export function ozToG(oz) {
  return Math.round(oz * OZ_TO_G);
}

// ---- plan weeks (spec §8.1: the plan locks on prep day for 7 days) ----------------------------

export function planWeekStart(date, prepDow) {
  return addDays(date, -((isoWeekday(date) - prepDow + 7) % 7));
}

// Bulk week number for a plan week: week 1 is the first full plan week of the
// phase; the partial week the phase started in is a lead-in (0).
export function phaseWeekOf(weekStart, phaseStart, prepDow) {
  const first = phaseStart === planWeekStart(phaseStart, prepDow) ? phaseStart : addDays(planWeekStart(phaseStart, prepDow), 7);
  if (weekStart < first) return 0;
  return Math.round((Date.parse(weekStart) - Date.parse(first)) / (7 * 86400000)) + 1;
}

// Coach swaps (brief §3) offered when a food is flagged for GI issues.
export const SWAPS = {
  chicken: ['Tuna (same weight)'],
  lean_beef: ['93/7 turkey', '96/4 beef', 'Steak', 'Salmon'],
  rice: ['Sweet potato: 1 g rice ≈ 1.6 g sweet potato'],
  sweet_potato: ['Jasmine rice: 1.6 g sweet potato ≈ 1 g rice'],
  cream_rice: ['Rice cakes: 70 g dry ≈ 5 flavored cakes'],
  rice_cake: ['Cream of Rice: 5 cakes ≈ 70 g dry'],
  almond_milk: ['Oat milk (more carbs)'],
  cheerios: ['Another cereal with 50–70 g carbs'],
};

export const DAY_TYPE_LABEL = DAY_LABEL;
