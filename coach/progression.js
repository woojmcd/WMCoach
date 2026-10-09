// On-device progression (spec §6.1–§6.2, §6.4) and the session plan built from it.
// Pure functions: the PWA runs them after "Finish session" (so progression works
// offline) and the daily routine re-checks them (stage 6).
//
// Vocabulary
//   exercise  a program.json slot (id, type, scheme, sets, rir, increment_lb, …)
//   entry     what was done for one slot in one finished session:
//             { local_date, deload, sets: [{ kind, load, reps, rir, seconds, done }] }
//   history   entries for one slot + movement, oldest first
//   target    { calibration, load, sets: [planned set], change, delta_lb, reason, last }
import { addDays, daysBetween, isoWeekday, weekStart } from './time.js';

export const RIR_CHIPS = [0, 1, 2, 3, 4];
export const DELOAD_EVERY_WEEKS = 6;
const WORK_KINDS = new Set(['work', 'top']);

// ---- helpers ------------------------------------------------------------------------------

export function roundToIncrement(load, inc) {
  if (!inc) return Math.round(load * 10) / 10;
  return Math.max(0, Math.round(load / inc) * inc);
}

export function workingSets(entry) {
  return (entry ? entry.sets : []).filter((s) => s.done && WORK_KINDS.has(s.kind) && Number.isFinite(s.reps));
}

function doneSets(entry, kind) {
  return (entry ? entry.sets : []).filter((s) => s.done && s.kind === kind && Number.isFinite(s.reps));
}

export function totalReps(sets) {
  return sets.reduce((a, s) => a + (s.reps || 0), 0);
}

function mainLoad(sets) {
  // the load most working sets used (ties → heavier)
  const counts = new Map();
  for (const s of sets) if (Number.isFinite(s.load)) counts.set(s.load, (counts.get(s.load) || 0) + 1);
  let best = null;
  for (const [load, n] of counts) if (best === null || n > counts.get(best) || (n === counts.get(best) && load > best)) best = load;
  return best;
}

// Rep range a slot works in, from its scheme.
export function repRange(ex) {
  const sc = ex.scheme;
  if (sc.kind === 'range' || sc.kind === 'top_backoff') return [sc.min, sc.max];
  if (sc.kind === 'fixed') return [sc.reps, sc.reps];
  if (sc.kind === 'assisted') return [sc.min, sc.progress_at];
  return [null, null];
}

// "logged RIR no more than 1 below target"
function rirOk(set, rir) {
  if (!rir || set.rir === null || set.rir === undefined) return true;
  return set.rir >= rir[0] - 1;
}

function fmtLoad(load, ex) {
  if (load === null || load === undefined) return '?';
  if (ex.load_kind === 'bodyweight') return load ? `BW+${load}` : 'BW';
  if (ex.load_kind === 'assistance') return `${load} assist`;
  return String(load);
}

// "70 × 10, 10 · backoff 50 × 12"
export function describeEntry(entry, ex) {
  if (!entry) return null;
  const parts = [];
  const groups = [['work', ''], ['top', ''], ['amrap', ''], ['backoff', 'backoff '], ['timed', '']];
  for (const [kind, prefix] of groups) {
    const sets = entry.sets.filter((s) => s.done && s.kind === kind);
    if (!sets.length) continue;
    if (kind === 'timed') { parts.push(`${sets.length} × ${sets[0].seconds} s`); continue; }
    const byLoad = new Map();
    for (const s of sets) {
      const key = fmtLoad(s.load, ex);
      byLoad.set(key, [...(byLoad.get(key) || []), s.reps]);
    }
    parts.push([...byLoad.entries()].map(([l, reps]) => `${prefix}${l === '?' ? '' : `${l} × `}${reps.join(', ')}`).join(' · '));
  }
  return parts.join(' · ') || null;
}

// ---- training calendar: program weeks and deloads (spec §2a, §6.4) -------------------------

// Week 1 is the first Mon–Sun week of training. A first session on Fri–Sun is a
// lead-in (week 0), so "week 1" is never just a weekend.
export function programWeek(today, programStart) {
  if (!programStart) return isoWeekday(today) >= 5 ? 0 : 1;
  const anchor = isoWeekday(programStart) >= 5 ? addDays(weekStart(programStart), 7) : weekStart(programStart);
  return Math.floor(daysBetween(anchor, weekStart(today)) / 7) + 1;
}

// A session's rep drop vs the one before it: same-or-heavier load, fewer working reps.
function repDrop(prev, cur) {
  const a = workingSets(prev); const b = workingSets(cur);
  if (!a.length || !b.length) return false;
  return (mainLoad(b) ?? 0) >= (mainLoad(a) ?? 0) && totalReps(b) < totalReps(a);
}

// Is the week containing `today` a deload week, and should the Week tab announce one?
// mainHistories: { slotId: history } for the main lifts (spec §6.4), each oldest first,
// already excluding deload sessions; entries carry `week` (program week number).
export function deloadStatus({ today, programStart, deloadWeeks = [], mainHistories = {} }) {
  const week = programWeek(today, programStart);
  const lastDeload = deloadWeeks.length ? Math.max(...deloadWeeks) : 0;
  const scheduled = week - lastDeload >= DELOAD_EVERY_WEEKS;
  // Reactive: ≥ 3 main lifts with 2 consecutive sessions of rep drops, counting only
  // sessions after the last deload and before this week.
  let dropping = 0;
  for (const hist of Object.values(mainHistories)) {
    const h = hist.filter((e) => e.week > lastDeload && e.week < week).slice(-3);
    if (h.length === 3 && repDrop(h[0], h[1]) && repDrop(h[1], h[2])) dropping += 1;
  }
  const reactive = dropping >= 3 && week > lastDeload;
  const isDeload = scheduled || reactive;
  // Announce on the Friday before a scheduled deload (and as soon as a reactive one is due).
  const nextWeek = week + 1;
  const fridayBefore = isoWeekday(today) >= 5;
  const announceNext = !isDeload && nextWeek - lastDeload >= DELOAD_EVERY_WEEKS && fridayBefore;
  return {
    week,
    isDeload,
    reason: reactive && !scheduled ? `Rep drops on ${dropping} main lifts for 2 sessions` : scheduled ? `Week ${week}: every ${DELOAD_EVERY_WEEKS}th week` : null,
    announceNext,
    nextDeloadWeekStart: announceNext ? addDays(weekStart(today), 7) : null,
  };
}

// ---- targets (spec §6.2) ---------------------------------------------------------------------

function plannedSet(kind, fields) {
  return { kind, load: null, reps_min: null, reps_max: null, aim: null, rir: null, seconds: null, ...fields };
}

function adjustRir(rir, { deload, rirBump }, failure) {
  if (!rir) return rir;
  if (deload) return failure ? [2, 2] : [Math.max(3, rir[0]), Math.max(3, rir[1])];
  if (rirBump) return [rir[0] + rirBump, rir[1] + rirBump];
  return rir;
}

function halve(n, deload) {
  return deload ? Math.max(1, Math.ceil(n / 2)) : n;
}

// ctx: { mode: 'bulk'|'cut'|'maintenance', deload, rirBump (0|1), noIncrease (bool),
//        leadLoad (A1's load this session, for same-weight partners), increment (override) }
export function targetFor(ex, history, ctx = {}) {
  const inc = ctx.increment ?? ex.increment_lb;
  const hist = history.filter((e) => !e.deload);
  const last = hist[hist.length - 1] || null;
  const lastText = describeEntry(last, ex);
  const failure = ex.rir && ex.rir[1] === 0;
  const rir = adjustRir(ex.rir, ctx, failure);
  const base = { calibration: false, load: null, sets: [], change: null, delta_lb: 0, reason: null, last: lastText, rir };
  const sets = (n) => halve(n, ctx.deload);

  // timed: ✓ only, no progression
  if (ex.type === 'timed') {
    return { ...base, sets: Array.from({ length: sets(ex.sets) }, () => plannedSet('timed', { seconds: ex.scheme.seconds })) };
  }

  // same-weight finisher: A1's load, reps only, beat last reps
  if (ex.type === 'superset_same_weight') {
    const prev = doneSets(last, 'amrap');
    const load = ctx.leadLoad ?? (prev.length ? prev[0].load : null);
    return {
      ...base, load,
      sets: Array.from({ length: sets(ex.sets) }, (_, i) => plannedSet('amrap', { load, aim: prev[i] ? prev[i].reps : null, rir })),
      reason: prev.length ? `Same weight as the first exercise; beat ${totalReps(prev)} reps` : 'Same weight as the first exercise, to failure',
    };
  }

  // AMRAP: beat last session's total; bodyweight sets at 15+ everywhere → suggest added load
  if (ex.type === 'amrap') {
    const prev = doneSets(last, 'amrap');
    let load = prev.length ? prev[0].load ?? 0 : (ex.load_kind === 'bodyweight' ? 0 : null);
    let change = null; let delta = 0;
    let reason = prev.length ? `Beat ${totalReps(prev)} total reps` : 'As many reps as possible';
    const threshold = ex.scheme.add_load_at;
    if (threshold && !ex.scheme.reps_only && prev.length && prev.every((s) => s.reps >= threshold) && !ctx.deload && !ctx.noIncrease) {
      load = (load || 0) + inc; change = 'up'; delta = inc;
      reason = `Every set ${threshold}+: add ${inc} lb (belt or plate)`;
    }
    return {
      ...base, load, change, delta_lb: delta, reason,
      sets: Array.from({ length: sets(ex.sets) }, (_, i) => plannedSet('amrap', { load, aim: change ? null : prev[i] ? prev[i].reps : null, rir })),
    };
  }

  // load-progressed types: range, open range, fixed, top + backoff, superset lead, assisted
  const [min, max] = repRange(ex);
  const isTopBackoff = ex.type === 'top_backoff';
  const nWork = isTopBackoff ? ex.scheme.top_sets : ex.sets;
  const workKind = isTopBackoff ? 'top' : 'work';
  const ws = workingSets(last);

  const build = (load, aims, extra = {}) => {
    const out = Array.from({ length: sets(nWork) }, (_, i) => plannedSet(workKind, {
      load, reps_min: min, reps_max: max, aim: aims ? aims[i] ?? aims[aims.length - 1] : null, rir,
    }));
    if (isTopBackoff) {
      const b = ex.scheme.backoff;
      const bLoad = load === null ? null : roundToIncrement(load * b.load_factor, inc);
      for (let i = 0; i < sets(b.sets); i += 1) {
        out.push(plannedSet('backoff', {
          load: bLoad, reps_min: b.amrap ? null : b.min, reps_max: b.amrap ? null : b.max, rir: adjustRir(b.rir, ctx, Boolean(b.amrap)), amrap: Boolean(b.amrap),
        }));
      }
    }
    return { ...base, load, sets: out, ...extra };
  };

  if (!ws.length) {
    const what = ex.load_kind === 'assistance' ? 'the least assistance' : 'a weight';
    const rirText = rir ? ` at RIR ${rir[0] === rir[1] ? rir[0] : `${rir[0]}–${rir[1]}`}` : '';
    return build(null, null, { calibration: true, reason: `Calibration: pick ${what} for ${min === max ? min : `${min}–${max}`} reps${rirText}` });
  }

  const load = mainLoad(ws);
  const aimsUp = Array(nWork).fill(min);
  const aimsMore = Array.from({ length: nWork }, (_, i) => {
    const r = ws[i] ? ws[i].reps : ws[ws.length - 1].reps;
    return Math.max(min, Math.min(max, r + 1));
  });

  // assisted pull-ups: progress = one pin less assistance when every set reaches 8
  if (ex.type === 'assisted') {
    const allAt = ws.length >= nWork && ws.every((s) => s.reps >= max);
    if (allAt && !ctx.deload && !ctx.noIncrease && load > 0) {
      const next = Math.max(0, load - inc);
      return build(next, aimsUp, { change: 'up', delta_lb: -inc, reason: next === 0 ? `All sets ${max}+: try unassisted` : `All sets ${max}+: one pin less assistance (${load} → ${next})` });
    }
    return build(load, aimsMore, { change: 'hold', reason: load === 0 ? 'Unassisted: as many as you can' : `Aim for ${max} on every set, then one pin less` });
  }

  const hitTop = (e) => {
    const s = workingSets(e);
    return s.length >= nWork && s.every((x) => x.reps >= max && rirOk(x, ex.rir));
  };
  const sameLoad = (e) => mainLoad(workingSets(e)) === load;
  // Cut mode: top of the range on all sets for 2 consecutive sessions at this load (spec §6.2)
  const needed = ctx.mode === 'cut' ? 2 : 1;
  const recent = hist.slice(-needed);
  const ready = recent.length === needed && recent.every((e) => sameLoad(e) && hitTop(e));

  if (ready && !ctx.deload && !ctx.noIncrease) {
    const next = load + inc;
    return build(next, aimsUp, {
      change: 'up', delta_lb: inc,
      reason: `All sets hit ${max}${needed === 2 ? ' twice' : ''}: +${inc} lb, back to ${min}`,
    });
  }

  // Stalls: below the bottom of the range at the same load — twice → hold, three times → −5 %
  let below = 0;
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const e = hist[i];
    if (!sameLoad(e)) break;
    if (workingSets(e).some((x) => x.reps < min)) below += 1;
    else break;
  }
  if (below >= 3 && !ctx.deload) {
    const down = Math.min(load - inc, roundToIncrement(load * 0.95, inc));
    const next = Math.max(0, down);
    return build(next, aimsUp, { change: 'down', delta_lb: next - load, reason: `Below ${min} three times at ${load}: −5 % to ${next} and rebuild` });
  }

  let reason;
  if (ctx.deload) reason = 'Deload: same load, half the sets, easy reps';
  else if (ready && ctx.noIncrease) reason = ctx.holdReason || 'Week 1 back: hold the load';
  else if (below === 2) reason = `Below ${min} twice at ${load}: hold`;
  else if (ctx.mode === 'cut' && hitTop(last)) reason = `Top of the range once at ${load}: once more to add load (cut)`;
  else reason = max > min ? `Aim +1 rep where below ${max}` : `Aim for ${max} on every set`;
  return build(load, ctx.deload ? aimsUp : aimsMore, { change: 'hold', reason });
}

// ---- building a session plan --------------------------------------------------------------

// The history for one slot (+ movement, so a swapped exercise starts fresh).
export function historyFor(sessions, slotId, movement) {
  const out = [];
  const sorted = [...sessions].filter((s) => s.status === 'finished' && !s.deleted)
    .sort((a, b) => (a.local_date === b.local_date ? ((a.started_utc || '') < (b.started_utc || '') ? -1 : 1) : a.local_date < b.local_date ? -1 : 1));
  for (const s of sorted) {
    const e = s.exercises.find((x) => x.slot_id === slotId && x.movement === movement && !x.skipped);
    if (e) out.push({ local_date: s.local_date, week: s.week, deload: Boolean(s.deload), sets: e.sets });
  }
  return out;
}

// Readiness (spec §6.3): Amber holds every load; Red also drops one set per exercise.
function dropOneSet(t) {
  const main = t.sets.filter((x) => x.kind !== 'backoff');
  if (main.length <= 1) return t;
  const kind = main[main.length - 1].kind;
  const idx = t.sets.map((x) => x.kind).lastIndexOf(kind);
  return { ...t, sets: t.sets.filter((_, i) => i !== idx) };
}

// Planned exercises for a program day: targets per slot with superset partners following their lead.
// opts: { mode, week, deload, liftedLess, prefs: { slotId: { increment_lb, swap: {name, movement} } },
//         readiness: { status: 'green'|'amber'|'red', reason } }
export function planDay(day, sessions, opts = {}) {
  // "Lifted less since May" (spec §2a): weeks 1–2 at target RIR + 1, no load increases in week 1.
  const rirBump = opts.liftedLess && opts.week <= 2 && !opts.deload ? 1 : 0;
  const r = opts.readiness && !opts.deload && (opts.readiness.status === 'amber' || opts.readiness.status === 'red') ? opts.readiness : null;
  const noIncrease = Boolean((opts.liftedLess && opts.week <= 1) || r);
  const holdReason = r ? `Held: ${r.reason}` : null;
  const leadLoads = {};
  return day.exercises.map((ex) => {
    const pref = (opts.prefs && opts.prefs[ex.id]) || {};
    const movement = pref.swap ? pref.swap.movement : ex.movement;
    const hist = historyFor(sessions, ex.id, movement);
    let t = targetFor(ex, hist, {
      mode: opts.mode, deload: Boolean(opts.deload), rirBump, noIncrease, holdReason,
      increment: pref.increment_lb, leadLoad: ex.same_load_as ? leadLoads[ex.same_load_as] : undefined,
    });
    if (ex.type === 'superset_lead') leadLoads[ex.id] = t.load;
    if (r && r.status === 'red' && !t.calibration) {
      const before = t.sets.length;
      t = dropOneSet(t);
      if (t.sets.length < before) t = { ...t, reason: `${t.reason ? `${t.reason} · ` : ''}one set fewer today (readiness red)` };
    }
    let reason = t.reason;
    // timed holds have no RIR, so "easing back" doesn't apply to them
    if (rirBump && !t.calibration && ex.type !== 'timed') reason = reason ? `${reason} · easing back: RIR +1` : 'Easing back: RIR +1';
    return { ex, movement, name: pref.swap ? pref.swap.name : ex.name, swapped_from: pref.swap ? ex.name : null, target: { ...t, reason } };
  });
}

// The training calendar from the logged sessions (shared by the phone and the daily run):
// program start, program week, and this week's deload status (§6.4).
const byStart = (a, b) => (a.local_date === b.local_date ? ((a.started_utc || '') < (b.started_utc || '') ? -1 : 1) : a.local_date < b.local_date ? -1 : 1);
export function trainingCalendar(sessions, program, today) {
  const live = sessions.filter((s) => !s.deleted).sort(byStart);
  const programStart = live.length ? live[0].local_date : null;
  const week = programWeek(today, programStart || today);
  const deloadWeeks = [...new Set(live.filter((s) => s.deload).map((s) => s.week))];
  const mainHistories = {};
  if (program) {
    for (const d of program.days) {
      for (const ex of d.exercises) if (ex.main_lift) mainHistories[ex.id] = historyFor(live, ex.id, ex.movement).filter((e) => !e.deload);
    }
  }
  const deload = deloadStatus({ today, programStart: programStart || today, deloadWeeks, mainHistories });
  return { sessions: live, programStart, week, deload };
}
