// This week's meal plan on the phone (spec §4.4, §8.1). The plan locks on prep
// day for 7 days. Until the weekly run publishes plans (stage 6), the phone seeds
// the §8.0 starting plan and carries the latest plan into each new prep week at
// local midnight of prep day, so it never goes without one, even offline.
import { getAll, put } from './db.js';
import { live } from './records.js';
import { startingPlan, withMacros, diffPlans, planWeekStart, phaseWeekOf, TEMPLATE_ID } from '../coach/meals.js';
import { addDays } from '../coach/time.js';
import { currentPhase, realPhases } from '../coach/phase.js';

let plansJsonCache = null;
export async function loadPlansJson() {
  if (plansJsonCache) return plansJsonCache;
  const res = await fetch('data/plans.json');
  if (!res.ok) throw new Error(`data/plans.json: HTTP ${res.status}`);
  plansJsonCache = await res.json();
  return plansJsonCache;
}

const byWeek = (a, b) => (a.week_start < b.week_start ? -1 : 1);

function firstLaunchWeight(weighins, since) {
  const app = live(weighins).filter((w) => w.source !== 'history' && (!since || w.local_date >= since))
    .sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  if (app.length) return app[0].weight_lb;
  const any = live(weighins).sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  return any.length ? any[any.length - 1].weight_lb : null;
}

export async function ensurePlans(ctx, { now = new Date() } = {}) {
  const { db, settings } = ctx;
  const today = ctx.today();
  const prepDow = settings.prep_day || 7;
  const weekStart = planWeekStart(today, prepDow);
  const plansJson = await loadPlansJson();
  const utc = now.toISOString();
  const [plansAll, phasesAll, weighins, foodsAll] = await Promise.all([
    getAll(db, 'plans'), getAll(db, 'phases'), getAll(db, 'weighins'), getAll(db, 'foods'),
  ]);
  const phase = currentPhase(realPhases(phasesAll));
  let records = live(plansAll).sort(byWeek);

  if (!records.length) {
    const plan = startingPlan(plansJson, { weightLb: firstLaunchWeight(weighins, phase && phase.start), weekStart, id: `BULK-${weekStart}` });
    const template = withMacros(plansJson.food_db, plansJson.plans.find((p) => p.id === TEMPLATE_ID));
    const rec = {
      id: weekStart, week_start: weekStart, week_end: addDays(weekStart, 6), mode: settings.mode,
      plan, source: 'seed', based_on: TEMPLATE_ID, changes: diffPlans(template, plan),
      reason: 'Starting plan (spec §8.0): your last coach plan’s high-carb day, every day.',
      created_utc: utc, updated_utc: utc,
    };
    await put(db, 'plans', rec);
    records = [rec];
  }

  // On-device prep-day swap: no plan covers today → carry the latest one forward.
  let current = records.find((r) => r.week_start <= today && today <= r.week_end) || null;
  if (!current) {
    const prev = records.filter((r) => r.week_start < weekStart).pop() || records[records.length - 1];
    current = {
      id: weekStart, week_start: weekStart, week_end: addDays(weekStart, 6), mode: settings.mode,
      plan: { ...prev.plan, id: `${(settings.mode || 'bulk').toUpperCase()}-${weekStart}`, start: weekStart },
      source: 'carry', based_on: prev.id, changes: diffPlans(prev.plan, prev.plan),
      // the cardio dose carries too (spec §6.5), unless the mode changed (then its base dose)
      ...(prev.cardio && prev.cardio.mode === settings.mode ? { cardio: { ...prev.cardio, change: null } } : {}),
      reason: 'No change: the plan carries over until the weekly check-in changes it.',
      created_utc: utc, updated_utc: utc,
    };
    await put(db, 'plans', current);
    records = [...records, current].sort(byWeek);
  }
  const previous = records.filter((r) => r.week_start < current.week_start).pop() || null;
  const next = records.find((r) => r.week_start > current.week_start) || null;
  const flags = Object.fromEntries(live(foodsAll).map((f) => [f.id, f]));
  const week = phase ? phaseWeekOf(current.week_start, phase.start, prepDow) : null;
  return { current, previous, next, foodDb: plansJson.food_db, flags, week, phase, today };
}

// Week-tab banner from the day before prep day until prep day (spec §8.4, channel 2).
export function planNotice({ next, today }) {
  if (!next || !next.changes || !next.changes.changed) return null;
  const eve = addDays(next.week_start, -1);
  if (today < eve || today > next.week_start) return null;
  return { week_start: next.week_start, delta: next.changes.kcal.delta };
}

export { planWeekStart };
