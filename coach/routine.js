// The daily run (spec §7, §2b), as one pure function: the repo in, the files to
// write out. scripts/daily.mjs does the disk I/O; the routine (ops/daily_prompt.md)
// fetches Strava, runs it, commits to main and sends the notifications.
//
// Writes only routine-owned paths (spec §2): data/strava/ (new files only),
// data/targets/, data/plan/ (the changelog is append-only), data/model/.
import { localDate, addDays, isoWeekday, daysBetween, HOME_TZ, WEEKDAYS_LONG } from './time.js';
import { parseWeightCsv, historyWeighins, historyPhases } from './seed.js';
import { trendFromEntries, rateOverDays } from './trend.js';
import { planDay, trainingCalendar } from './progression.js';
import { dayForWeekday } from './program.js';
import { readiness, normalizeHealth } from './readiness.js';
import { normalizeFetch, stravaPath, enduranceAddons, cardioByDate } from './strava.js';
import { estimateTdee, planKcalByDate, intakeByDate } from './tdee.js';
import {
  weeklyDecision, observeOnly, nextPlan, firstPlanForMode, planRecord, weeklyNotification, changeText,
} from './weekly.js';
import { mainLiftChanges } from './summary.js';
import { planWeekStart } from './meals.js';
import { adherenceFromTaps, MODE_LABEL } from './phase.js';

export const ROUTINE_SCHEMA = 1;
export const OWNED = ['data/strava/', 'data/targets/', 'data/plan/', 'data/model/'];
const LOG_STORES = ['weighins', 'mode_changes', 'measurements', 'checkins', 'adherence', 'sessions', 'stairs', 'plans', 'phases', 'exercise_prefs', 'foods'];
const json = (x) => `${JSON.stringify(x, null, 2)}\n`;
const live = (xs) => xs.filter((x) => x && !x.deleted);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// repo: { read(path) → string | null, list(prefix) → [path] }
export function readRepo(repo) {
  const J = (path) => {
    const t = repo.read(path);
    if (t === null || t === undefined) return null;
    try { return JSON.parse(t); } catch { return null; }
  };
  const log = {};
  for (const store of LOG_STORES) {
    const files = [...repo.list(`data/log/${store}/`), `data/log/${store}.json`];
    log[store] = files.flatMap((f) => { const d = J(f); return d && Array.isArray(d.records) ? d.records : []; });
  }
  const meta = (key) => { const d = J(`data/log/${key}.json`); return d ? d.value : null; };
  return { J, log, meta };
}

function healthByDate(repo, J, today, days = 10) {
  const out = {};
  for (let i = 0; i <= days; i += 1) {
    const d = addDays(today, -i);
    const h = normalizeHealth(J(`data/health/${d}.json`));
    if (h) out[d] = h;
  }
  return out;
}

function stravaActivities(repo, J, since) {
  return repo.list('data/strava/').filter((p) => p.slice(12, 22) >= since).map((p) => J(p)).filter(Boolean);
}

// What today's run will do, before any Strava fetch (for the routine's first step).
export function preflight({ repo, now = new Date() }) {
  const { J, meta } = readRepo(repo);
  const settings = meta('settings') || {};
  const tz = settings.tz_current || HOME_TZ;
  const today = localDate(now, tz);
  const state = J('data/model/state.json') || {};
  const done = state.last_daily_run_local_date === today;
  const rerun = done && state.health_missing_on === today && state.health_rerun_on !== today && Boolean(J(`data/health/${today}.json`));
  const since = state.last_daily_run_local_date ? addDays(state.last_daily_run_local_date, -1) : addDays(today, -14);
  return { today, tz, run: !done, rerun, strava_range_start: `${since}T00:00:00`, strava_range_end: `${today}T23:59:59` };
}

export function dailyRun({ repo, now = new Date(), stravaFetched = null }) {
  const { J, log, meta } = readRepo(repo);
  const nowUtc = now.toISOString();
  const settings = meta('settings') || {};
  const tz = settings.tz_current || HOME_TZ;
  const today = localDate(now, tz);
  const prepDow = settings.prep_day || 7;
  const checkinDow = settings.checkin_day || 5;
  const mode = settings.mode || 'bulk';
  const state0 = J('data/model/state.json') || { schema_version: 1 };
  const state = JSON.parse(JSON.stringify(state0));
  const writes = {};
  const notifications = [];
  const report = [];
  const health = healthByDate(repo, J, today);
  const subscribed = (() => { const s = meta('push_subscription'); return Boolean(s && s.endpoint && !s.revoked); })();

  // ---- idempotency (spec §2b) ----
  let kind = 'daily';
  if (state.last_daily_run_local_date === today) {
    if (state.health_missing_on === today && state.health_rerun_on !== today && health[today]) kind = 'health_rerun';
    else return { status: 'skip', today, tz, writes: {}, notifications: [], report: [`Already ran for ${today} (${tz}).`], commitMessage: null };
  }

  // ---- Strava → data/strava/ (new files only) ----
  const program = J('data/program.json');
  const existing = new Set(repo.list('data/strava/'));
  const fresh = kind === 'daily' && stravaFetched ? normalizeFetch(stravaFetched) : [];
  for (const a of fresh) {
    const path = stravaPath(a);
    if (!existing.has(path) && !writes[path]) writes[path] = json(a);
  }
  if (fresh.length) report.push(`Strava: ${fresh.length} activit${fresh.length === 1 ? 'y' : 'ies'} fetched, ${Object.keys(writes).length} new.`);
  const activities = [...stravaActivities(repo, J, addDays(today, -120)), ...fresh.filter((a) => !existing.has(stravaPath(a)))];

  // ---- weight trend ----
  const profile = J('data/metabolic_profile.json');
  const csv = repo.read('data/weight_daily.csv') || '';
  const appWeighins = live(log.weighins);
  // a Health-file weight fills a day with no app weigh-in (the trend only; the phone owns the log)
  const loggedDays = new Set(appWeighins.map((w) => w.local_date));
  const healthWeights = repo.list('data/health/').map((p) => normalizeHealth(J(p))).filter((h) => h && h.date && Number.isFinite(h.weight_lb) && !loggedDays.has(h.date))
    .map((h) => ({ id: `health-file-${h.date}`, local_date: h.date, weight_lb: h.weight_lb, source: 'health-file' }));
  const weighins = [...historyWeighins(parseWeightCsv(csv)), ...appWeighins, ...healthWeights];
  const series = trendFromEntries(weighins);
  const last = series[series.length - 1] || null;
  const rate = rateOverDays(series, today, 14);

  // ---- readiness + today's targets (spec §6.3, §6.2) ----
  const day = program ? dayForWeekday(program, isoWeekday(today)) : null;
  const cal = trainingCalendar(live(log.sessions), program, today);
  const r = readiness({ today, health, activities, dayName: day ? day.name : null, history: state.readiness_history || [], tzHistory: settings.tz_history || [], tz });
  const prefs = Object.fromEntries(live(log.exercise_prefs).map((p) => [p.id, p]));
  const planned = day && day.exercises.length ? planDay(day, cal.sessions, {
    mode, week: cal.week, deload: cal.deload.isDeload, liftedLess: Boolean(settings.lifted_less_since_may), prefs, readiness: r,
  }) : [];
  const addons = enduranceAddons(activities, today);
  writes['data/targets/today.json'] = json({
    schema_version: ROUTINE_SCHEMA,
    local_date: today,
    tz,
    generated_utc: nowUtc,
    readiness: r,
    day: day ? { dow: day.dow, name: day.name, rest_day: !day.exercises.length } : null,
    program_week: cal.week,
    deload: { active: cal.deload.isDeload, reason: cal.deload.reason },
    exercises: planned.map((p) => ({
      slot_id: p.ex.id, movement: p.movement, name: p.name, load: p.target.load, change: p.target.change,
      calibration: p.target.calibration, reason: p.target.reason,
      sets: p.target.sets.map((s) => ({ kind: s.kind, load: s.load, reps_min: s.reps_min, reps_max: s.reps_max, aim: s.aim, rir: s.rir, seconds: s.seconds })),
    })),
    addons,
  });
  report.push(`Readiness ${r.status}: ${r.reason}.${day && day.exercises.length ? ` ${day.name}, week ${cal.week}${cal.deload.isDeload ? ' (deload)' : ''}.` : ' Open day.'}`);
  for (const a of addons) report.push(`Add-on today: +${a.kcal} kcal carbs (${a.reason}).`);

  state.readiness_history = [...(state.readiness_history || []).filter((x) => x.local_date !== today), { local_date: today, status: r.status }].slice(-21);
  if (kind === 'health_rerun') {
    state.health_rerun_on = today;
    writes['data/model/state.json'] = json(state);
    return { status: 'rerun', today, tz, writes, notifications, report: [`Late Health data for ${today}: readiness and targets only.`, ...report], commitMessage: `daily ${today} (${tz}): readiness after late Health data` };
  }
  if (!health[today]) state.health_missing_on = today;

  // ---- model state (daily) ----
  state.trend = { ...(state.trend || {}), half_life_days: (state.trend && state.trend.half_life_days) || 7, last_local_date: last ? last.date : null, last_weight_lb: last ? Math.round(last.weight * 10) / 10 : null, trend_lb: last ? Math.round(last.trend * 10) / 10 : null, rate_14d_pct_bw_wk: rate ? Math.round(rate.pct_bw_per_wk * 100) / 100 : null };
  const phases = [...historyPhases(profile || { phases: [] }), ...live(log.phases).filter((p) => !p.superseded)];
  state.phase_history = phases.map(({ id, kind: k, label, start, end }) => ({ id, kind: k, label, start, end }));

  // ---- plans: the published ones and the phone's ----
  const published = { current: J('data/plan/current.json'), next: J('data/plan/next.json') };
  const phonePlans = live(log.plans);
  const allPlans = [...phonePlans.filter((p) => ![published.current, published.next].some((q) => q && q.week_start === p.week_start)), ...[published.current, published.next].filter(Boolean)]
    .sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const inForce = (d) => [...allPlans].reverse().find((p) => p.week_start <= d) || null;

  // ---- prep-day swap: next.json becomes current.json (spec §8.1) ----
  if (published.next && published.next.week_start <= today && (!published.current || published.current.week_start < published.next.week_start)) {
    writes['data/plan/current.json'] = json({ ...published.next, updated_utc: nowUtc });
    report.push(`Prep day: the plan for ${published.next.week_start} is now current.`);
  }

  // ---- weekly step (spec §2b): the day before prep day, or prep day if it was missed ----
  const prepEve = ((prepDow + 5) % 7) + 1;
  const isEve = isoWeekday(today) === prepEve;
  const isPrep = isoWeekday(today) === prepDow;
  const weekStart = isPrep ? today : planWeekStart(addDays(today, 7), prepDow);
  if ((isEve || isPrep) && state.last_weekly_run_week !== weekStart && (isEve || !published.next || published.next.week_start !== today)) {
    const current = inForce(today);
    if (!current) {
      report.push('Weekly step skipped: no plan on record yet (the phone seeds the first one).');
    } else {
      const plansJson = J('data/plans.json');
      const onboarding = meta('onboarding');
      const since = onboarding ? onboarding.completed_local_date : null;
      const appWeighins = live(log.weighins);
      const weekDays = new Set(appWeighins.filter((w) => w.local_date > addDays(today, -7) && w.local_date <= today).map((w) => w.local_date));
      const observe = observeOnly({ since, today, weighinsSince: new Set(appWeighins.filter((w) => since && w.local_date >= since).map((w) => w.local_date)).size });
      const checkins = live(log.checkins).filter((c) => c.local_date > addDays(today, -7) && c.local_date <= today).sort((a, b) => (a.local_date < b.local_date ? 1 : -1));
      const ci = checkins[0] || null;
      const taps = live(log.adherence);
      const adherencePct = ci && Number.isFinite(ci.adherence_pct) ? ci.adherence_pct : adherenceFromTaps(taps, today).pct;
      const bio = ci ? Object.values(ci.biofeedback || {}).filter(Number.isFinite) : [];
      const steps = Object.entries(health).filter(([d, h]) => d > addDays(today, -7) && Number.isFinite(h.steps)).map(([, h]) => h.steps);
      const washout = Boolean(current.changes && current.changes.changed && current.source !== 'carry' && daysBetween(current.week_start, today) < 7);
      const mainDown = mainLiftChanges(cal.sessions, program, { from: addDays(today, -6), to: today }).filter((l) => l.dir === 'down').length;
      const bands = state.rate_bands_pct_bw_per_wk || { cut: { target: [-0.75, -0.5], cap: -1 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };
      const foods = Object.fromEntries(live(log.foods).map((f) => [f.id, f]));

      // expenditure (weekly, brief §5)
      const intake = intakeByDate(planKcalByDate(allPlans, addDays(today, -27), today), taps);
      const cardio = cardioByDate(activities, live(log.stairs), last ? last.trend : 170);
      const tdee = estimateTdee({ today, weighins, intake, cardio, phases, prev: state.tdee && state.tdee.estimate_kcal && state.tdee.updated_local_date && daysBetween(state.tdee.updated_local_date, today) <= 14 ? state.tdee : null, priors: { base_kcal_per_lb: (state.priors && state.priors.base_kcal_per_lb) || 13.2, kcal_per_lb: (state.priors && state.priors.kcal_per_lb) || { loss: 3500, gain: 2750 } } });
      if (tdee) state.tdee = { ...tdee, updated_local_date: today };

      const pending = settings.pending_mode && settings.pending_mode.effective_date <= weekStart ? settings.pending_mode : null;
      const nextMode = pending ? pending.to : mode;
      let decision; let plan; let notes = []; let modeSwitch = null;
      if (pending && pending.to !== mode) {
        const first = firstPlanForMode({ to: pending.to, current, tdee, weightLb: last ? last.trend : 170, cardioKcal: tdee ? tdee.cardio_kcal : 0, plansJson });
        const swapped = nextPlan({ current: { plan: first.plan }, decision: { change: 0 }, flags: foods, foodDb: plansJson.food_db });
        plan = swapped.plan; notes = swapped.notes;
        modeSwitch = MODE_LABEL[pending.to];
        decision = { change: 0, stoppedAt: null, mode_switch: { from: mode, to: pending.to }, reason: first.why, checks: [] };
      } else {
        decision = weeklyDecision({
          mode, rate: rate ? rate.pct_bw_per_wk : null, prevRates: (state.weekly_history || []).map((h) => h.rate_pct).filter(Number.isFinite),
          bands, adherencePct, weighinsWeek: weekDays.size, observe, washout, mainLiftsDown: mainDown,
          bioAvg: mean(bio), stepsAvg: mean(steps), stepFloor: settings.step_floor || 8000,
        });
        const np = nextPlan({ current, decision, flags: foods, foodDb: plansJson.food_db });
        plan = np.plan; notes = np.notes;
        if (decision.change && !np.moved) decision = { ...decision, change: 0, reason: `${decision.reason} (no carb step left to take)` };
      }
      plan = { ...plan, id: `${nextMode.toUpperCase()}-${weekStart}`, start: weekStart };
      const record = planRecord({
        weekStart, mode: nextMode, plan, previous: current, decision, notes,
        reason: decision.change || modeSwitch ? `${cap(decision.reason)}.` : `No macro change: ${decision.reason}.`,
        nowUtc, localDate: today,
      });
      writes[isPrep ? 'data/plan/current.json' : 'data/plan/next.json'] = json(record);
      const changelog = J('data/plan/changelog.json') || { schema_version: 1, entries: [] };
      writes['data/plan/changelog.json'] = json({
        ...changelog,
        entries: [...changelog.entries, {
          week_start: weekStart, local_date: today, generated_utc: nowUtc, mode: nextMode, changed: record.changes.changed,
          kcal_from: record.changes.kcal.from, kcal_to: record.changes.kcal.to, delta: record.changes.kcal.delta,
          what: changeText(record.changes), reason: record.reason, stopped_at: decision.stoppedAt || null,
        }],
      });
      const n = weeklyNotification({ weekStart, changes: record.changes, decision, modeSwitch });
      notifications.push({ kind: 'weekly', ...n });
      state.last_weekly_run_week = weekStart;
      state.weekly_history = [{ week_start: weekStart, local_date: today, rate_pct: rate ? Math.round(rate.pct_bw_per_wk * 100) / 100 : null, change: decision.change, kcal: record.plan.weekly_avg.kcal, stopped_at: decision.stoppedAt || null }, ...(state.weekly_history || [])].slice(0, 26);
      if (record.changes.changed) state.last_change_week_start = weekStart;
      report.push(`Weekly step for ${weekStart}: ${n.body}`);
    }
  }

  // ---- check-in morning (Walter, 2026-10-09) ----
  if (isoWeekday(today) === checkinDow && !live(log.checkins).some((c) => c.local_date === today) && (state.notified || {}).checkin !== today) {
    notifications.push({ kind: 'checkin', title: 'Check-in today', body: `${WEEKDAYS_LONG[checkinDow - 1]} check-in: weigh in, tape your measurements, then the 2-minute check-in.`, url: './#/body', tag: `checkin-${today}` });
    state.notified = { ...(state.notified || {}), checkin: today };
  }

  // the very first run says hello, so Walter knows the whole chain works
  if (!state0.last_daily_run_local_date) {
    notifications.unshift({ kind: 'hello', title: 'WMCoach coach run is on', body: 'You’ll hear from it on check-in mornings and when next week’s plan is ready.', url: './#/week', tag: 'hello' });
  }
  state.last_daily_run_local_date = today;
  state.last_daily_run_utc = nowUtc;
  state.last_daily_run_tz = tz;
  writes['data/model/state.json'] = json(state);
  for (const n of notifications) report.push(`Notify (${n.kind}): ${n.title}${subscribed ? '' : ' [no push subscription yet: Week banner only]'}`);
  return { status: 'done', today, tz, writes, notifications: subscribed ? notifications : [], queued: notifications, report, commitMessage: `daily ${today} (${tz})` };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Paths the routine may write, and how (spec §2: one writer per path).
export function checkWrites(writes, exists) {
  const problems = [];
  for (const path of Object.keys(writes)) {
    if (!OWNED.some((p) => path.startsWith(p))) problems.push(`${path}: not a routine-owned path`);
    if (path.startsWith('data/strava/') && exists(path)) problems.push(`${path}: Strava entries are never rewritten`);
  }
  return problems;
}
