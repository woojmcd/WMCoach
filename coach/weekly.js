// The weekly macro step (spec §8.1–§8.3, §10), run by the daily routine on the
// day before prep day. Stop at the first failing check; then at most one change,
// ≤ 150 kcal, carbs first, as food-weight changes in his staple foods.
import { rateStatus } from './trend.js';
import { withMacros, nextCarbStep, applyCarbSteps, diffPlans, TEMPLATE_ID } from './meals.js';
import { addDays, daysBetween, formatDayMonth, WEEKDAYS, isoWeekday } from './time.js';
import { cardioText } from './cardio.js';

export const MAX_WEEKLY_KCAL = 150; // spec §10: safety rail in code
export const ADHERENCE_GATE = 90;
export const MIN_WEIGHINS = 5;
const clone = (x) => JSON.parse(JSON.stringify(x));
const sgn = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;

// Weeks 1–2 of a new bulk are observe-only (spec §2a): no change until ≥ 10 new
// weigh-ins and 2 full weeks since onboarding.
export function observeOnly({ since, today, weighinsSince, minWeighins = 10, minDays = 14 }) {
  if (!since) return { active: false };
  const days = daysBetween(since, today);
  if (days >= minDays && weighinsSince >= minWeighins) return { active: false };
  return {
    active: true,
    reason: `observe-only start: ${Math.max(0, minDays - days)} more day${minDays - days === 1 ? '' : 's'} and ${Math.max(0, minWeighins - weighinsSince)} more weigh-in${minWeighins - weighinsSince === 1 ? '' : 's'} before the first change`,
  };
}

// input: { mode, rate (pct/wk or null), prevRates: [pct, …] newest first (earlier weekly steps),
//          bands, adherencePct, weighinsWeek, observe: {active, reason}, washout (bool),
//          mainLiftsDown, bioAvg, stepsAvg, stepFloor }
// → { change: −1 | 0 | +1, stoppedAt, reason, checks: [{ key, ok, text }] }
export function weeklyDecision(input) {
  const { mode, rate, prevRates = [], bands, adherencePct, weighinsWeek, observe = { active: false }, washout = false } = input;
  const checks = [];
  const stop = (key, text) => { checks.push({ key, ok: false, text }); return { change: 0, stoppedAt: key, reason: text, checks }; };

  // 1. Adherence (during the observe-only start that's said too: it's the bigger reason)
  const also = observe.active ? `; ${observe.reason}` : '';
  if (adherencePct === null || adherencePct === undefined) return stop('adherence', `adherence not logged${also}`);
  if (adherencePct < ADHERENCE_GATE) return stop('adherence', `adherence ${adherencePct} % (under ${ADHERENCE_GATE} %)${also}`);
  checks.push({ key: 'adherence', ok: true, text: `adherence ${adherencePct} %` });

  // 2. Data sufficiency
  if (weighinsWeek < MIN_WEIGHINS) return stop('data', `${weighinsWeek} weigh-in${weighinsWeek === 1 ? '' : 's'} this week (need ${MIN_WEIGHINS})`);
  if (observe.active) return stop('data', observe.reason);
  if (rate === null || rate === undefined) return stop('data', 'not enough weigh-ins for a 2-week trend');
  checks.push({ key: 'data', ok: true, text: `${weighinsWeek} weigh-ins` });

  // 3. Rate vs the mode's band, judged over 2 weekly steps (one is enough past a hard limit)
  const st = rateStatus(mode, rate, bands);
  const prev = prevRates.length ? rateStatus(mode, prevRates[0], bands) : null;
  const twice = (key) => prev && prev.key === key;
  const rateText = `rate ${sgn(rate)} %BW/wk`;
  let change = 0;
  let why = `${rateText}, ${st.word.toLowerCase()}`;
  const hardLimit = st.key === 'too_fast';
  if (washout && !hardLimit) return stop('rate', `${rateText}: first week after a change, observe only (glycogen)`);
  if (mode === 'bulk') {
    if (st.key === 'too_fast') { change = -1; why = `${rateText}, over the ${sgn(bands.bulk.cap)} cap`; }
    else if (st.key === 'fast' && twice('fast')) { change = -1; why = `${rateText} for 2 wks, above ${sgn(bands.bulk.target[1])}`; }
    else if (st.key === 'slow' && twice('slow')) { change = +1; why = `${rateText} for 2 wks, under ${sgn(bands.bulk.target[0])}`; }
    else if (st.key !== 'on_target') why = `${rateText}, ${st.word.toLowerCase()}: one more week to confirm`;
    else why = `rate on target (${sgn(rate)} %BW/wk)`;
  } else if (mode === 'cut') {
    if (st.key === 'too_fast') { change = +1; why = `${rateText}, past the ${sgn(bands.cut.cap)} limit: protect muscle`; }
    else if (st.key === 'slow' && twice('slow')) { change = -1; why = `${rateText} for 2 wks, slower than ${sgn(bands.cut.target[1])}`; }
    else if (st.key !== 'on_target') why = `${rateText}, ${st.word.toLowerCase()}: one more week to confirm`;
    else why = `rate on target (${sgn(rate)} %BW/wk)`;
  } else {
    if (st.key === 'drifting_up' && twice('drifting_up')) { change = -1; why = `${rateText} for 2 wks, drifting up`; }
    else if (st.key === 'drifting_down' && twice('drifting_down')) { change = +1; why = `${rateText} for 2 wks, drifting down`; }
    else if (st.key !== 'stable') why = `${rateText}, ${st.word.toLowerCase()}: one more week to confirm`;
    else why = `weight stable (${sgn(rate)} %BW/wk)`;
  }
  checks.push({ key: 'rate', ok: true, text: why });

  // 4. Strength and biofeedback (in a cut: slow it down rather than push on)
  if (mode === 'cut' && ((input.mainLiftsDown || 0) >= 3 || (Number.isFinite(input.bioAvg) && input.bioAvg <= 2))) {
    const what = (input.mainLiftsDown || 0) >= 3 ? `strength down on ${input.mainLiftsDown} main lifts` : `biofeedback ${input.bioAvg.toFixed(1)} / 5`;
    checks.push({ key: 'recovery', ok: false, text: what });
    return { change: change < 0 ? 0 : Math.max(change, 1), stoppedAt: 'recovery', reason: `${what}: slow the cut (or take a 1–2 wk diet break at maintenance)`, checks, dietBreak: true };
  }
  // 5. Activity: in a cut, steps before food
  if (mode === 'cut' && change < 0 && Number.isFinite(input.stepsAvg) && input.stepsAvg < (input.stepFloor || 8000)) {
    return stop('activity', `${why}, but steps ${Math.round(input.stepsAvg).toLocaleString('en-US')}/day are under the ${(input.stepFloor || 8000).toLocaleString('en-US')} floor: walk first`);
  }
  // 6. Adjust: one lever
  return { change, stoppedAt: null, reason: `${why}, ${checks[0].text}`, checks };
}

// ---- food changes ----------------------------------------------------------------------------

const SHORT = { rice: 'rice', sweet_potato: 'sweet potato', rice_cake: 'rice cake', cream_rice: 'Cream of Rice', chicken: 'chicken', lean_beef: 'beef/turkey' };

// GI flags (brief §3): swap within the food DB where the coach allowed it; otherwise keep
// the food and name the swap (tuna for chicken, turkey/steak/salmon for beef, …).
const IN_DB_SWAPS = {
  rice: { to: 'sweet_potato', qty: (q) => Math.round((q * 1.6) / 10) * 10, text: 'sweet potato (1 g rice ≈ 1.6 g)' },
  sweet_potato: { to: 'rice', qty: (q) => Math.round(q / 1.6 / 10) * 10, text: 'jasmine rice (1.6 g sweet potato ≈ 1 g)' },
  rice_cake: { to: 'cream_rice', qty: (q) => Math.round(q * 14), text: 'Cream of Rice (5 cakes ≈ 70 g dry)' },
  cream_rice: { to: 'rice_cake', qty: (q) => Math.max(1, Math.round(q / 14)), text: 'rice cakes (70 g dry ≈ 5 cakes)' },
};
const NAMED_SWAPS = { chicken: 'tuna (same weight)', lean_beef: '93/7 turkey, 96/4 beef, steak or salmon', almond_milk: 'oat milk', cheerios: 'another cereal with 50–70 g carbs' };

export function avoidFlagged(plan, flags, foodDb) {
  const out = clone(plan);
  const notes = [];
  const flagged = new Set(Object.entries(flags || {}).filter(([, f]) => f && f.gi_flag && !f.deleted).map(([id]) => id));
  if (!flagged.size) return { plan: out, notes };
  for (const meals of Object.values(out.days)) {
    for (const [meal, foods] of Object.entries(meals)) {
      for (const it of [...foods]) {
        if (!flagged.has(it.food)) continue;
        const sw = IN_DB_SWAPS[it.food];
        if (sw && foodDb[sw.to] && !flagged.has(sw.to)) {
          const qty = sw.qty(it.qty);
          const same = foods.find((x) => x.food === sw.to);
          if (same) same.qty = Math.round((same.qty + qty) * 100) / 100;
          else foods.splice(foods.indexOf(it), 0, { food: sw.to, name: foodDb[sw.to].name, qty, unit: foodDb[sw.to].unit });
          foods.splice(foods.indexOf(it), 1);
          notes.push(`${meal}: ${SHORT[it.food] || it.name} → ${sw.text} (GI flag)`);
        } else if (NAMED_SWAPS[it.food]) {
          notes.push(`${meal}: ${SHORT[it.food] || it.name} is GI-flagged; swap for ${NAMED_SWAPS[it.food]}`);
        }
      }
    }
  }
  return { plan: out, notes: [...new Set(notes)] };
}

// Nearest carb-step version of `plan` to `target` kcal, searching ±range steps.
export function nearestSteps(plan, target, foodDb, range = 4) {
  let best = { plan: withMacros(foodDb, clone(plan)), diff: Infinity, steps: 0 };
  for (const dir of [1, -1]) {
    let cur = clone(plan);
    for (let i = 0; i <= range; i += 1) {
      if (i > 0) {
        const r = nextCarbStep(cur, dir);
        if (!r.moved) break;
        cur = r.plan;
      }
      const m = withMacros(foodDb, cur);
      const d = Math.abs(m.weekly_avg.kcal - target);
      if (d < best.diff - 1e-9) best = { plan: m, diff: d, steps: i * dir };
    }
  }
  return best;
}

// First plan for a new mode (spec §8.3).
export function firstPlanForMode({ to, current, tdee, weightLb, cardioKcal = 0, plansJson }) {
  const foodDb = plansJson.food_db;
  const maint = tdee && Number.isFinite(tdee.estimate_kcal) ? tdee.estimate_kcal : 13.2 * weightLb + cardioKcal;
  if (to === 'cut') {
    // ~300–500 under maintenance, carbs first; CUT26-V4's carb cycle is the template
    const tpl = plansJson.plans.find((p) => p.id === TEMPLATE_ID);
    const base = { structure: tpl.structure, schedule: tpl.schedule, days: clone(tpl.days), carb_steps: 0 };
    const r = nearestSteps(base, maint - 400, foodDb, 4);
    return { plan: { ...r.plan, based_on: TEMPLATE_ID, phase: 'Cut' }, target: Math.round(maint - 400), why: `cut start: ~400 under maintenance (${Math.round(maint).toLocaleString('en-US')})` };
  }
  if (to === 'bulk') {
    const base = current && current.plan.structure === 'single' ? current.plan : { structure: 'single', days: { MP: clone(plansJson.plans.find((p) => p.id === TEMPLATE_ID).days.MP2) }, carb_steps: 0 };
    const r = nearestSteps(base, maint + 175, foodDb, 4);
    return { plan: { ...r.plan, phase: 'Bulk' }, target: Math.round(maint + 175), why: `bulk start: maintenance (${Math.round(maint).toLocaleString('en-US')}) + 150–200` };
  }
  // maintenance: from a cut, +1 step a week toward 13.2 kcal/lb (cardio first); from a bulk, back to maintenance
  const kcal = current.plan.weekly_avg.kcal;
  if (kcal < maint - 75) {
    const r = nextCarbStep(current.plan, 1);
    return { plan: { ...withMacros(foodDb, r.plan), phase: 'Maintenance' }, target: Math.round(maint), why: `maintenance: +1 carb step a week toward ${Math.round(maint).toLocaleString('en-US')} (drop or cut cardio first)` };
  }
  const r = nearestSteps(current.plan, maint, foodDb, 4);
  return { plan: { ...r.plan, phase: 'Maintenance' }, target: Math.round(maint), why: `maintenance at ~${Math.round(maint).toLocaleString('en-US')}` };
}

// Apply a weekly decision to this week's plan → next week's plan (+ GI swaps).
export function nextPlan({ current, decision, flags, foodDb }) {
  let plan = clone(current.plan);
  let moved = false;
  if (decision.change) {
    const r = nextCarbStep(plan, decision.change);
    plan = r.plan;
    moved = r.moved;
  }
  const swapped = avoidFlagged(plan, flags, foodDb);
  plan = withMacros(foodDb, swapped.plan);
  // safety rail: never more than 150 kcal in a week
  const delta = plan.weekly_avg.kcal - current.plan.weekly_avg.kcal;
  if (Math.abs(delta) > MAX_WEEKLY_KCAL && decision.change) {
    plan = withMacros(foodDb, avoidFlagged(clone(current.plan), flags, foodDb).plan);
    moved = false;
  }
  return { plan, moved, notes: swapped.notes };
}

// "Post-workout rice 270 → 340 g, +1 rice cake"
export function changeText(changes, max = 3) {
  if (!changes || !changes.items) return '';
  const seen = new Set();
  const parts = [];
  const counted = (c) => c.unit === 'each' || c.unit === 'slice' || c.unit === 'scoop' || c.unit === 'cup';
  // food weights first ("Post-workout rice 270 → 340 g"), then counts ("+1 rice cake")
  const items = [...changes.items].sort((a, b) => Number(counted(a)) - Number(counted(b)));
  for (const c of items) {
    const key = `${c.meal}|${c.food}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const what = SHORT[c.food] || c.name.toLowerCase();
    if (counted(c)) {
      const d = c.to - c.from;
      parts.push(`${d > 0 ? '+' : '−'}${Math.abs(d)} ${what}${Math.abs(d) === 1 ? '' : 's'}`);
    } else {
      parts.push(`${c.meal} ${what} ${c.from} → ${c.to} ${c.unit}`);
    }
  }
  return parts.slice(0, max).join(', ');
}

// The Saturday notification (spec §8.1): always sent, changed or not. With `cardio`
// (spec §6.5) it also says next week's cardio, and leads with it when cardio was the lever.
export function weeklyNotification({ weekStart, changes, decision, modeSwitch = null, cardio = null }) {
  const day = WEEKDAYS[isoWeekday(weekStart) - 1];
  const longDay = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[day];
  const cardioLine = cardio ? ` Cardio: ${cardioText(cardio)}.` : '';
  if (changes && changes.changed) {
    const d = changes.kcal.delta;
    const head = modeSwitch ? `${modeSwitch} starts ${longDay}: ${d > 0 ? '+' : ''}${d} kcal.` : `Plan changes ${longDay}: ${d > 0 ? '+' : ''}${d} kcal.`;
    return { title: modeSwitch ? `${modeSwitch} starts ${longDay}` : `New plan ${longDay}`, body: `${head} ${changeText(changes)}. Reason: ${decision.reason}.${cardioLine}`.replace(/\.\./g, '.'), url: './#/meals', tag: `plan-${weekStart}` };
  }
  if (cardio && cardio.change && !modeSwitch) {
    const more = cardio.change.sessions_delta > 0 || cardio.change.min_delta > 0;
    return {
      title: `${more ? 'More' : 'Less'} cardio from ${longDay}`,
      body: `No macro change. Cardio goes to ${cardio.change.to} (was ${cardio.change.from}). Reason: ${decision.reason}.`.replace(/\.\./g, '.'),
      url: './#/week', tag: `plan-${weekStart}`,
    };
  }
  return { title: 'No macro change this week', body: `No macro change this week. ${cap(decision.reason)}. Prep as last week.${cardioLine}`, url: './#/meals', tag: `plan-${weekStart}` };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The record published as data/plan/next.json (and later current.json): the same
// shape as the phone's plan records, so the app uses it as is.
export function planRecord({ weekStart, mode, plan, previous, source = 'routine', decision, notes = [], reason, nowUtc, localDate, cardio = null }) {
  return {
    schema_version: 1,
    id: weekStart,
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    mode,
    plan,
    source,
    based_on: previous ? previous.id : null,
    changes: diffPlans(previous ? previous.plan : plan, plan),
    decision,
    notes,
    reason,
    ...(cardio ? { cardio } : {}),
    generated_utc: nowUtc,
    generated_local_date: localDate,
    created_utc: nowUtc,
    updated_utc: nowUtc,
  };
}

export const weekLabel = (weekStart) => `${WEEKDAYS[isoWeekday(weekStart) - 1]} ${formatDayMonth(weekStart)}`;
export { applyCarbSteps };
