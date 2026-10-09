// Training state on the phone: sessions, the plan for a day, logging sets,
// finishing (which immediately yields next-session targets, spec §4.2).
import { getAll, put } from './db.js';
import { live } from './records.js';
import { newId } from './seed.js';
import { planDay, trainingCalendar, roundToIncrement } from '../coach/progression.js';
import { dayForWeekday } from '../coach/program.js';
import { isoWeekday, stamp } from '../coach/time.js';
import { remoteState, todaysTargets, weekTargets, healthMissing } from './remote.js';
import { cardioForDay, cardioItems, rxForWeek } from '../coach/cardio.js';
import { weekDates } from '../coach/time.js';

export async function loadTraining(ctx) {
  const [sAll, prefsAll, stairsAll, plansAll, weighins] = await Promise.all([
    getAll(ctx.db, 'sessions'), getAll(ctx.db, 'exercise_prefs'), getAll(ctx.db, 'stairs'), getAll(ctx.db, 'plans'), getAll(ctx.db, 'weighins'),
  ]);
  const prefs = Object.fromEntries(prefsAll.map((p) => [p.id, p]));
  const today = ctx.today();
  const { sessions, programStart, week, deload } = trainingCalendar(live(sAll), ctx.program, today);
  // today's readiness from the daily run (spec §6.3), if it has run today
  const remote = await remoteState(ctx.db);
  const targets = todaysTargets(remote, today);
  const stairs = live(stairsAll);
  const readiness = targets ? targets.readiness : null;
  const addons = targets ? targets.addons || [] : [];
  return {
    sessions, prefs, stairs, today, programStart, week, deload,
    readiness, addons, healthMissing: healthMissing(remote, today),
    cardio: cardioOnPhone(ctx, { today, remote, targets, stairs, plans: live(plansAll), weighins: live(weighins), readiness, addons }),
  };
}

// Today's cardio (spec §6.5), worked out on the phone so it works offline and before
// the morning run: the week's prescription, Strava sessions the routine has seen this
// week, and Stairs ✓ taps (which count at once).
export function cardioOnPhone(ctx, { today, remote, targets, stairs, plans, weighins, readiness, addons }) {
  const wk = weekTargets(remote, today);
  const latest = remote && remote.targets && remote.targets.cardio ? remote.targets.cardio : null;
  const rx = (targets && targets.cardio && targets.cardio.rx) || rxForWeek(plans, today, ctx.settings.mode);
  const days = weekDates(today);
  const strava = wk && wk.cardio && wk.cardio.week ? wk.cardio.week.items.filter((i) => i.source === 'strava') : [];
  const lastW = [...weighins].sort((a, b) => (a.local_date < b.local_date ? -1 : 1)).pop();
  return cardioForDay({
    rx,
    date: today,
    items: cardioItems({ activities: strava, stairs, from: days[0], to: days[6] }),
    readiness,
    addons,
    weightLb: (latest && latest.weight_lb) || (lastW ? lastW.weight_lb : null),
    hr: latest ? latest.hr : null,
  });
}

export function planOptions(ctx, training) {
  return {
    mode: ctx.settings.mode,
    week: training.week,
    deload: training.deload.isDeload,
    liftedLess: Boolean(ctx.settings.lifted_less_since_may),
    readiness: training.readiness,
    prefs: training.prefs,
  };
}

// Today's plan for a program day, from finished sessions only.
export function planFor(ctx, training, day, { excludeId = null } = {}) {
  const sessions = training.sessions.filter((s) => s.id !== excludeId);
  return planDay(day, sessions, planOptions(ctx, training));
}

function defaultRir(planned) {
  if (!planned.rir || planned.kind === 'amrap' || planned.kind === 'timed') return planned.rir ? planned.rir[1] : null;
  return planned.rir[1];
}

export function setFromPlan(planned) {
  return {
    kind: planned.kind,
    target: {
      load: planned.load, reps_min: planned.reps_min, reps_max: planned.reps_max, aim: planned.aim,
      rir: planned.rir, seconds: planned.seconds, amrap: Boolean(planned.amrap),
    },
    load: planned.load,
    reps: planned.aim ?? planned.reps_min ?? null,
    rir: defaultRir(planned),
    seconds: planned.seconds,
    done: false,
    skipped: false,
    utc: null,
  };
}

export function exerciseFromPlan(p) {
  return {
    slot_id: p.ex.id, movement: p.movement, name: p.name, swapped_from: p.swapped_from,
    label: p.ex.label, group: p.ex.group, type: p.ex.type,
    reason: p.target.reason, change: p.target.change, delta_lb: p.target.delta_lb, calibration: p.target.calibration, last: p.target.last,
    skipped: false, note: null,
    sets: p.target.sets.map(setFromPlan),
  };
}

// An unsaved session for a day; the first logged set saves it (status in_progress).
export function draftSession(ctx, training, day, now = new Date()) {
  const at = stamp(now, ctx.tz());
  return {
    id: newId('sess'), local_date: at.local_date, tz: at.tz, utc: at.utc,
    started_utc: null, finished_utc: null, status: 'draft',
    day_dow: day.dow, day_name: day.name, program_id: ctx.program.id,
    week: training.week, deload: training.deload.isDeload,
    exercises: planFor(ctx, training, day).map(exerciseFromPlan),
    note: null, updated_utc: at.utc,
  };
}

export async function saveSession(db, session, now = new Date()) {
  const utc = now.toISOString();
  const next = { ...session, updated_utc: utc };
  if (next.status === 'draft') { next.status = 'in_progress'; next.started_utc = utc; next.utc = utc; }
  await put(db, 'sessions', next);
  return next;
}

// Log set j of exercise i. Later sets of the same kind follow a changed load
// (a calibration weight carries forward); backoff follows the top load; a
// same-weight partner (A2) takes A1's load for the matching set.
export function logSet(session, i, j, { load, reps, rir, seconds }, { now = new Date(), increment = 5 } = {}) {
  const exs = session.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s })) }));
  const ex = exs[i];
  const set = ex.sets[j];
  Object.assign(set, { load, reps, rir, seconds: seconds ?? set.seconds, done: true, skipped: false, utc: now.toISOString() });
  for (let k = 0; k < ex.sets.length; k += 1) {
    const s = ex.sets[k];
    if (k === j || s.done) continue;
    // later sets follow a changed load; earlier sets only get one if still empty (calibration)
    if (s.kind === set.kind && load !== null && load !== undefined && (k > j || s.load === null || s.load === undefined)) s.load = load;
    if (k < j) continue;
    if (set.kind === 'top' && s.kind === 'backoff' && load) {
      const factor = s.target.load && set.target.load ? s.target.load / set.target.load : 0.7;
      s.load = roundToIncrement(load * factor, increment);
    }
  }
  if (ex.type === 'superset_lead') {
    const partner = exs.find((e) => e.group === ex.group && e !== ex && e.type === 'superset_same_weight');
    if (partner) for (let k = j; k < partner.sets.length; k += 1) if (!partner.sets[k].done) partner.sets[k].load = load;
  }
  return { ...session, exercises: exs };
}

export function updateExercise(session, i, patch) {
  const exs = session.exercises.map((e, k) => (k === i ? { ...e, ...patch } : e));
  return { ...session, exercises: exs };
}

export function progressCount(session) {
  let done = 0; let total = 0;
  for (const e of session.exercises) {
    if (e.skipped) continue;
    for (const s of e.sets) { if (s.skipped) continue; total += 1; if (s.done) done += 1; }
  }
  return { done, total };
}

export async function finishSession(db, session, now = new Date()) {
  const next = { ...session, status: 'finished', finished_utc: now.toISOString(), updated_utc: now.toISOString() };
  await put(db, 'sessions', next);
  return next;
}

// Sessions left open on an earlier day count as finished (at their last logged set).
export async function finishStaleSessions(db, today) {
  const stale = live(await getAll(db, 'sessions')).filter((s) => s.status === 'in_progress' && s.local_date < today);
  for (const s of stale) {
    const last = s.exercises.flatMap((e) => e.sets).map((x) => x.utc).filter(Boolean).sort().pop() || s.updated_utc;
    await put(db, 'sessions', { ...s, status: 'finished', finished_utc: last, auto_finished: true, updated_utc: new Date().toISOString() });
  }
  return stale.length;
}

export function sessionForDate(training, date) {
  return [...training.sessions].reverse().find((s) => s.local_date === date) || null;
}

export function programDayFor(ctx, date) {
  return ctx.program ? dayForWeekday(ctx.program, isoWeekday(date)) : null;
}

// Rest after a logged set (spec §4.2): the program's rest, with the user's
// defaults standing in for the standard 90 s and 15 s.
export function restAfter(ex, programEx, settings) {
  const r = programEx ? programEx.rest_s : 90;
  if (r === 90) return settings.rest_default_s ?? 90;
  if (r === 15) return settings.rest_superset_s ?? 15;
  return r;
}
