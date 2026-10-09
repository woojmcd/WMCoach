// Strava activities (spec §2, §6.3, §8.5). The daily routine fetches them with
// the Strava connector; this normalizes them into data/strava/ (one file per
// activity, never rewritten) and derives what the coach needs: cardio kcal,
// hard sessions before leg day, and endurance add-ons.
import { addDays } from './time.js';

export const STRAVA_SCHEMA = 1;
const CARDIO = new Set(['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'Run', 'TrailRun', 'VirtualRun', 'Swim', 'Hike', 'StairStepper', 'Elliptical', 'Rowing', 'NordicSki', 'BackcountrySki', 'AlpineSki', 'Snowboard', 'InlineSkate']);
const RIDES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide']);
const RUNS = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const LONG_RIDE_S = 2 * 3600; // spec §8.5: a ride > 2 h
export const LONG_RUN_S = 90 * 60; // "a long run": 90 min or more
export const HARD_S = 90 * 60; // spec §6.3: a hard session > 90 min

const round = (x, dp = 0) => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : null);
const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

// One activity from list_activities (+ optional get_activity_performance) → our summary.
export function normalizeActivity(raw, perf = null) {
  const s = raw.summary || raw;
  const start = raw.start_local || raw.start_date_local || null;
  if (!raw.id || !start) return null;
  const p = perf || {};
  return {
    schema_version: STRAVA_SCHEMA,
    id: String(raw.id),
    name: raw.name || null,
    type: raw.sport_type || raw.type || null,
    start_local: start.slice(0, 19),
    local_date: start.slice(0, 10),
    duration_s: num(s.moving_time),
    elapsed_s: num(s.elapsed_time),
    distance_km: round(num(s.distance) / 1000, 2),
    elevation_m: round(num(s.elevation_gain ?? s.total_elevation_gain), 0),
    avg_hr: round(num(p.average_heartrate ?? p.avg_heart_rate ?? p.average_heart_rate ?? s.average_heartrate), 0),
    max_hr: round(num(p.max_heartrate ?? p.max_heart_rate ?? s.max_heartrate), 0),
    hr_zones_s: Array.isArray(p.hr_zones_s) ? p.hr_zones_s : null,
    relative_effort: num(s.relative_effort ?? s.suffer_score),
    kcal: num(s.total_calories ?? s.calories ?? p.calories),
    location: raw.location_summary || null,
    source: 'strava',
  };
}

export const stravaPath = (a) => `data/strava/${a.local_date}-${a.id}.json`;

// The routine saves the connector's output as-is: { activities: [...], performance?: { id: {...} } },
// or a bare array of activities.
export function normalizeFetch(fetched) {
  const list = Array.isArray(fetched) ? fetched : (fetched && fetched.activities) || [];
  const perf = (fetched && fetched.performance) || {};
  return list.map((a) => normalizeActivity(a, perf[String(a.id)] || null)).filter(Boolean);
}

export const isCardio = (a) => CARDIO.has(a.type);

// Long endurance sessions that earn grab-and-go carbs (spec §8.5).
export function isEndurance(a) {
  if (RIDES.has(a.type)) return (a.duration_s || 0) > LONG_RIDE_S;
  if (RUNS.has(a.type)) return (a.duration_s || 0) >= LONG_RUN_S;
  return false;
}

// Relative effort in the top quartile of his own history (spec §6.3).
export function effortQuartile(activities) {
  const xs = activities.map((a) => a.relative_effort).filter(Number.isFinite).sort((x, y) => x - y);
  if (xs.length < 8) return null; // too little history to call a quartile
  return xs[Math.floor(0.75 * (xs.length - 1))];
}

export function isHard(a, q75) {
  if (!isCardio(a)) return false;
  return (a.duration_s || 0) > HARD_S || (q75 !== null && Number.isFinite(a.relative_effort) && a.relative_effort >= q75);
}

// Cardio kcal per local date (expenditure input, brief §5). Stairs taps on days
// without a Strava stair session use his watch rate (5.4 net MET).
export function cardioByDate(activities, stairsTaps = [], weightLb = 170, stairsMet = 5.4) {
  const out = new Map();
  const add = (d, k) => out.set(d, (out.get(d) || 0) + k);
  const stairDays = new Set();
  for (const a of activities) {
    if (!isCardio(a)) continue;
    let k = a.kcal;
    if (!Number.isFinite(k)) k = RUNS.has(a.type) && Number.isFinite(a.distance_km) ? 70 * a.distance_km : 0;
    add(a.local_date, k);
    if (a.type === 'StairStepper') stairDays.add(a.local_date);
  }
  const perMin = (stairsMet * 3.5 * (weightLb * 0.45359237)) / 200;
  for (const t of stairsTaps) {
    if (t.deleted || stairDays.has(t.local_date) || !Number.isFinite(t.minutes)) continue;
    add(t.local_date, t.minutes * perMin);
  }
  return out;
}

// Endurance add-on for `today` (spec §8.5): yesterday's long session that ended late
// (after 15:00 local) refuels today; ~50 % of its kcal as non-prep carbs.
export function enduranceAddons(activities, today) {
  const yesterday = addDays(today, -1);
  const out = [];
  for (const a of activities) {
    if (!isEndurance(a) || a.local_date !== yesterday) continue;
    const endHour = Number(a.start_local.slice(11, 13)) + (a.elapsed_s || a.duration_s || 0) / 3600;
    if (endHour < 15) continue;
    const kcal = Math.round(((a.kcal || 0) * 0.5) / 10) * 10;
    if (kcal < 100) continue;
    const carbs = Math.round(kcal / 4);
    out.push({
      local_date: today,
      activity_id: a.id,
      kcal,
      carbs_g: carbs,
      reason: `${a.name || a.type}: ${Math.round((a.duration_s || 0) / 60)} min, ${a.kcal || '?'} kcal, finished late yesterday`,
      ideas: grabAndGo(carbs),
    });
  }
  return out;
}

// Non-prep carbs (spec §8.5), roughly 25–55 g each.
function grabAndGo(carbs) {
  const menu = [['banana', 27], ['plain bagel', 50], ['2 rice cakes', 22], ['500 ml sports drink', 30], ['150 g extra cooked rice', 42]];
  const picks = [];
  let left = carbs;
  for (const [what, c] of menu) {
    if (left <= 10) break;
    if (c <= left + 10) { picks.push(what); left -= c; }
  }
  return picks.length ? picks : ['banana'];
}
