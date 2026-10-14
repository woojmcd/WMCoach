// Cardio prescription (spec §6.5, Walter 2026-10-09): the coach says what cardio to
// do, as part of each day's workout; Strava and the Stairs ✓ tap record what he did.
//
// - Weekly: set with the meal plan by the weekly step and locked for the prep week
//   (spec §8.1), so it never moves mid-week. Bulk and maintenance hold a fixed dose;
//   in a cut it is a lever next to food (one lever a week, spec §10).
// - Daily: today's session from the week's days, adjusted for readiness (spec §6.3)
//   and yesterday's long sessions; a missed session moves to the next free day.
// Pure functions, shared by the daily routine and the phone (offline).
import { isoWeekday, weekDates, WEEKDAYS } from './time.js';
import { isCardio } from './strava.js';

export const CARDIO_SCHEMA = 1;
export const MIN_SESSION_MIN = 15; // shorter sessions don't count toward the week
export const STAIRS_NET_MET = 5.4; // his Apple Watch stairs rate (brief §1)
const LEG_DAY = 3; // Wednesday: no make-up cardio on leg day

// Cut: the weekly cardio ladder. Up a rung when loss stalls (before cutting food),
// down a rung when it's too fast; the top is his 2026 cut (6 × 30 min).
export const CUT_LADDER = [
  { days: [1, 2, 4, 5], minutes: 30 },
  { days: [1, 2, 4, 5, 6], minutes: 30 },
  { days: [1, 2, 4, 5, 6, 7], minutes: 30 },
];
const BASE = {
  bulk: { days: [2, 4], minutes: 25 },
  maintenance: { days: [1, 2, 4], minutes: 30 },
  cut: CUT_LADDER[0],
};
const WHY = {
  bulk: 'Bulk: two easy sessions a week for heart health, recovery and appetite. Their calories count in your expenditure, so the food covers them and you keep gaining.',
  maintenance: 'Maintenance: three easy sessions keep your fitness and the habit for the next cut. Counted in your calories.',
  cut: 'Cut: cardio is part of your deficit, together with food. Easy pace, so lifting recovery doesn’t suffer.',
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round10 = (x) => Math.round(x / 10) * 10;

export function stairsKcalPerMin(weightLb) {
  return (STAIRS_NET_MET * 3.5 * (weightLb * 0.45359237)) / 200;
}

function make(mode, { days, minutes }, reason = WHY[mode] || WHY.bulk) {
  const d = [...days].sort((a, b) => a - b);
  return { schema_version: CARDIO_SCHEMA, mode, modality: 'stairs', zone: 2, days: d, sessions: d.length, minutes, weekly_min: d.length * minutes, reason, change: null };
}

export function baseCardio(mode = 'bulk') {
  return make(BASE[mode] ? mode : 'bulk', BASE[mode] || BASE.bulk);
}

export const daysText = (days) => days.map((d) => WEEKDAYS[d - 1]).join(', ');
// "2 × 25 min stairs (Tue, Thu)"
export function cardioText(rx) {
  if (!rx) return '';
  return `${rx.sessions} × ${rx.minutes} min stairs (${daysText(rx.days)})`;
}

function withChange(next, prev) {
  const changed = prev && (prev.sessions !== next.sessions || prev.minutes !== next.minutes || prev.days.join() !== next.days.join());
  return { ...next, change: changed ? { from: cardioText(prev), to: cardioText(next), sessions_delta: next.sessions - prev.sessions, min_delta: next.weekly_min - prev.weekly_min } : null };
}

function ladderIndex(rx) {
  const i = CUT_LADDER.findIndex((r) => r.days.length === rx.sessions && r.minutes === rx.minutes);
  if (i >= 0) return i;
  return Math.max(0, Math.min(CUT_LADDER.length - 1, rx.sessions - CUT_LADDER[0].days.length));
}

// The weekly step (spec §10, step 6: one lever a week).
// decision: weeklyDecision()'s output; current: this week's prescription (or null).
// → { cardio, decision, lever: 'cardio' | 'food' | null }
export function nextCardio({ mode, current = null, decision, modeSwitch = null }) {
  if (modeSwitch) return { cardio: withChange(baseCardio(modeSwitch.to), current), decision, lever: null };
  const cur = current && current.mode === mode ? { ...current, reason: WHY[mode] || current.reason } : baseCardio(mode);
  const same = { ...cur, change: null };
  if (mode !== 'cut' || decision.stoppedAt || decision.dietBreak) return { cardio: same, decision, lever: decision.change ? 'food' : null };
  const i = ladderIndex(cur);
  if (decision.change === -1 && i < CUT_LADDER.length - 1) {
    return {
      cardio: withChange(make('cut', CUT_LADDER[i + 1]), cur),
      decision: { ...decision, change: 0, lever: 'cardio', reason: `${decision.reason}: one more cardio session, food unchanged` },
      lever: 'cardio',
    };
  }
  if (decision.change === 1 && i > 0) {
    return {
      cardio: withChange(make('cut', CUT_LADDER[i - 1]), cur),
      decision: { ...decision, change: 0, lever: 'cardio', reason: `${decision.reason}: one cardio session fewer, food unchanged` },
      lever: 'cardio',
    };
  }
  return { cardio: same, decision, lever: decision.change ? 'food' : null };
}

// The prescription in force for the Mon–Sun week of `date`: the plan in force on that
// Monday (plans start on prep day), else the mode's base dose.
export function rxForWeek(plans, date, mode) {
  const monday = weekDates(date)[0];
  const plan = [...(plans || [])].filter((p) => p && !p.deleted && p.week_start <= monday).sort((a, b) => (a.week_start < b.week_start ? -1 : 1)).pop();
  return plan && plan.cardio ? plan.cardio : baseCardio(mode);
}

// ---- heart rate -----------------------------------------------------------------------------

// Strava's get_athlete_zones (the connector's shape may vary): the first list of
// { min, max } zones, preferring heart-rate keys.
export function parseHrZones(x) {
  let found = null;
  const isZone = (z) => z && typeof z === 'object' && Number.isFinite(Number(z.min));
  const walk = (v) => {
    if (found || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      // 5 HR zones; the top one is open-ended (no max, or max -1)
      if (v.length >= 4 && v.every(isZone) && v.slice(0, -1).every((z) => Number.isFinite(Number(z.max)))) {
        found = v.map((z) => ({ min: Number(z.min), max: Number.isFinite(Number(z.max)) && z.max !== null ? Number(z.max) : -1 }));
        return;
      }
      v.forEach(walk);
      return;
    }
    const keys = Object.keys(v).sort((a, b) => Number(/heart|hr/i.test(b)) - Number(/heart|hr/i.test(a)));
    for (const k of keys) { if (/power|run|pace/i.test(k)) continue; walk(v[k]); }
  };
  walk(x);
  return found;
}

// Zone 2 (easy, conversational): Strava's zone 2 if known, else 60–70 % of the highest
// heart rate in his recent Strava sessions.
export function zone2({ zones = null, activities = [] } = {}) {
  if (zones && zones.length >= 2 && zones[1].max > zones[1].min) return { lo: Math.round(zones[1].min), hi: Math.round(zones[1].max), source: 'strava' };
  const maxes = activities.map((a) => a && a.max_hr).filter((v) => Number.isFinite(v) && v > 120 && v < 230).sort((a, b) => b - a);
  if (maxes.length >= 3) return { lo: Math.round(maxes[0] * 0.6), hi: Math.round(maxes[0] * 0.7), source: 'estimate', max_hr: maxes[0] };
  return null;
}

// ---- what he did ----------------------------------------------------------------------------

// Cardio sessions from Strava (normalized activities, or items already summarized by an
// earlier run) and Stairs ✓ taps; a tap on a day with a Strava stair session is the same session.
export function cardioItems({ activities = [], stairs = [], from = '0000-00-00', to = '9999-99-99' } = {}) {
  const items = [];
  const stairDays = new Set();
  const seen = new Set();
  for (const a of activities) {
    if (!a || !a.local_date || a.local_date < from || a.local_date > to || !isCardio(a)) continue;
    const minutes = Number.isFinite(a.minutes) ? a.minutes : Math.round((a.duration_s || 0) / 60);
    if (minutes < MIN_SESSION_MIN) continue;
    const id = a.id ? String(a.id) : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    items.push({ local_date: a.local_date, minutes, type: a.type, name: a.name || null, avg_hr: a.avg_hr ?? null, source: 'strava', id });
    if (a.type === 'StairStepper') stairDays.add(a.local_date);
  }
  for (const t of stairs) {
    if (!t || t.deleted || !Number.isFinite(t.minutes) || t.minutes < MIN_SESSION_MIN) continue;
    if (t.local_date < from || t.local_date > to || stairDays.has(t.local_date)) continue;
    items.push({ local_date: t.local_date, minutes: t.minutes, type: 'StairStepper', name: 'Stairs', avg_hr: null, source: 'tap', id: t.id || null });
  }
  return items.sort((a, b) => (a.local_date < b.local_date ? -1 : a.local_date > b.local_date ? 1 : 0));
}

const typeWord = (t) => ({ StairStepper: 'stairs', VirtualRide: 'ride', VirtualRun: 'run', TrailRun: 'trail run', MountainBikeRide: 'ride', GravelRide: 'ride', EBikeRide: 'e-bike ride' }[t] || String(t || 'cardio').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
export const itemText = (i) => `${i.minutes} min ${typeWord(i.type)}${i.source === 'strava' ? ' (Strava)' : ''}`;

// ---- today ----------------------------------------------------------------------------------

// rx: the week's prescription; items: cardioItems() covering at least this Mon–Sun week;
// readiness: today's (spec §6.3) or null; addons: today's endurance add-ons (spec §8.5).
export function cardioForDay({ rx, date, items = [], readiness = null, addons = [], weightLb = null, hr = null }) {
  const dates = weekDates(date);
  const from = dates[0];
  const to = dates[6];
  const dow = isoWeekday(date);
  const week = items.filter((i) => i.local_date >= from && i.local_date <= to);
  const before = week.filter((i) => i.local_date < date);
  const todays = week.filter((i) => i.local_date === date);
  const doneToday = sum(todays.map((i) => i.minutes));
  const scheduled = rx.days.includes(dow);
  const slots = (scheduled ? 1 : 0) + rx.days.filter((d) => d > dow).length;
  const owed = Math.max(0, rx.sessions - before.length);

  let today = null;
  // ahead of plan (an extra or moved session earlier this week): today is one of the
  // remaining slots, so it's optional until the slots left equal the sessions owed
  const later = rx.days.filter((d) => d > dow);
  if (scheduled && owed > 0 && owed < slots) today = { minutes: rx.minutes, makeup: false, optional: true, note: `Ahead of plan: ${owed} more this week, today or ${daysText(later)}.` };
  else if (scheduled && owed > 0) today = { minutes: rx.minutes, makeup: false };
  else if (scheduled) today = { minutes: rx.minutes, makeup: false, optional: true, note: 'Weekly target already met: today’s is optional.' };
  else if (owed > slots && dow !== LEG_DAY) today = { minutes: rx.minutes, makeup: true, note: `Make-up: ${owed - slots} session${owed - slots === 1 ? '' : 's'} behind this week.` };

  if (today) {
    const notes = today.note ? [today.note] : [];
    let kind = 'stairs';
    let zone = rx.zone || 2;
    if (readiness && readiness.status === 'red') {
      kind = 'walk'; zone = 1; today.minutes = 20;
      notes.unshift(`Readiness red (${readiness.reason}): swap it for an easy 20-min walk. It still counts.`);
    } else if (readiness && readiness.status === 'amber') {
      notes.unshift(`Readiness amber (${readiness.reason}): keep it truly easy, Zone 2 or below. Easy cardio helps you recover.`);
    }
    if (addons && addons.length && kind !== 'walk') {
      today.minutes = Math.min(today.minutes, 20);
      today.optional = true;
      notes.push('Long session yesterday: an easy 20 min, or skip it.');
    }
    const kcal = weightLb && kind === 'stairs' ? round10(stairsKcalPerMin(weightLb) * today.minutes) : null;
    today = {
      ...today, kind, zone, hr: zone === 2 ? hr : null, kcal,
      optional: Boolean(today.optional),
      note: notes.join(' ') || null,
      status: doneToday >= MIN_SESSION_MIN ? 'done' : 'todo',
      done_min: doneToday,
      done: todays,
    };
  }
  return {
    schema_version: CARDIO_SCHEMA,
    date,
    rx,
    today,
    extra: !today && todays.length ? todays : null,
    hr,
    weight_lb: weightLb,
    week: {
      from, to,
      target_sessions: rx.sessions, target_min: rx.weekly_min,
      done_sessions: week.length, done_min: sum(week.map((i) => i.minutes)),
      days: rx.days,
      items: week,
    },
  };
}

// Is a date one of the week's cardio days (for the Week tab preview)?
export function plannedOn(rx, date) {
  return Boolean(rx && rx.days.includes(isoWeekday(date)));
}


// ---- 3-mile pace (Walter, 2026-10-13) ------------------------------------------------------
// A daily baseline for a 3-mile run, set from his own recent 3-mile Strava runs (road first),
// else Strava's run pace zones, then adjusted for this morning's readiness:
// green → steady at baseline · amber → easy (60–90 s/mi slower, Zone 2 HR) · red → walk.
export const MILE_KM = 1.609344;
export const PACE_MILES = 3;
const ROAD_RUNS = new Set(['Run', 'VirtualRun']);
const RUNS = new Set(['Run', 'VirtualRun', 'TrailRun']);

// Strava's get_athlete_zones run pace zones ({ min, max } in m/s, the top one open).
export function parseRunZones(x) {
  const z = x && (x.run_zones || (x.running && x.running.zones) || null);
  if (!Array.isArray(z) || z.length < 4 || !z.every((r) => r && Number.isFinite(Number(r.min)))) return null;
  return z.map((r) => ({ min: Number(r.min), max: Number.isFinite(Number(r.max)) && r.max !== null ? Number(r.max) : -1 }));
}

const secPerMile = (a) => (a.duration_s || 0) / ((a.distance_km || 0) / MILE_KM);
export const paceText = (s) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const timeText = (s) => paceText(s * PACE_MILES);
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// → { s_per_mi, source: 'runs' | 'zones', n, text } or null
export function runBaseline({ activities = [], runZones = null, date = '9999-12-31', days = 90 } = {}) {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const threeMile = activities.filter((a) => a && RUNS.has(a.type) && a.local_date >= from && a.local_date <= date
    && a.distance_km >= 2.5 * MILE_KM && a.distance_km <= 3.5 * MILE_KM && a.duration_s > 0)
    .sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  const road = threeMile.filter((a) => ROAD_RUNS.has(a.type));
  const use = (road.length ? road : threeMile).slice(-5);
  if (use.length) {
    const s = median(use.map(secPerMile));
    return { s_per_mi: Math.round(s), source: 'runs', n: use.length, text: `your last ${use.length === 1 ? '3-mile run' : `${use.length} 3-mile runs`}${road.length ? '' : ' (trail)'}` };
  }
  if (runZones && runZones.length >= 3 && runZones[2].max > runZones[2].min) {
    // Strava's tempo zone (zone 3) midpoint, from its pace estimate
    const mps = (runZones[2].min + runZones[2].max) / 2;
    return { s_per_mi: Math.round((MILE_KM * 1000) / mps), source: 'zones', n: 0, text: 'your Strava pace zones' };
  }
  return null;
}

// Today's 3-mile recommendation. → { kind: 'steady' | 'easy' | 'walk' | null, lo, hi, text }
export function runPaceToday({ baseline = null, readiness = null, hr = null } = {}) {
  const status = readiness && !readiness.missing ? readiness.status : 'green';
  if (status === 'red') {
    return { kind: 'walk', lo: null, hi: null, text: `3-mile run: not today. Readiness red${readiness.reason ? ` (${readiness.reason})` : ''}: an easy 20–30 min walk instead.` };
  }
  if (!baseline) {
    return { kind: null, lo: null, hi: null, text: '3-mile pace: no baseline yet. Record a 3-mile run on Strava and it sets one.' };
  }
  const b = baseline.s_per_mi;
  const from = `Baseline ${paceText(b)}/mi from ${baseline.text}.`;
  if (status === 'amber') {
    const lo = b + 60; const hi = b + 90;
    const hrText = hr ? `, heart rate ${hr.lo}–${hr.hi}` : '';
    return { kind: 'easy', lo, hi, text: `3-mile pace today: easy, ${paceText(lo)}–${paceText(hi)}/mi (about ${timeText((lo + hi) / 2)})${hrText}. Readiness amber${readiness.reason ? ` (${readiness.reason})` : ''}. ${from}` };
  }
  const lo = b - 10; const hi = b + 10;
  return { kind: 'steady', lo, hi, text: `3-mile pace today: steady, ${paceText(lo)}–${paceText(hi)}/mi (about ${timeText(b)}). Readiness ${readiness && !readiness.missing ? 'green' : 'not in yet'}. ${from}` };
}
