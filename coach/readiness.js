// Readiness (spec §6.3): a light touch, performance always wins.
// Green: normal progression. Amber (any one flag): hold every load. Red (≥ 2 flags,
// or Amber 3 days running): also one set fewer per exercise. No recovery data →
// Green. After a timezone shift of ≥ 3 h, the first 2 nights cap at Amber (§2b).
import { addDays, tzOffsetMinutes, localDate } from './time.js';
import { isHard, effortQuartile } from './strava.js';

const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const typeWord = (t) => String(t || 'session').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

// A Health file as the Shortcut writes it: numbers may arrive as strings ("62.5",
// "62,5"), empty strings or not at all; anything not a number is treated as missing.
const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x !== 'string' || !x.trim()) return null;
  const v = Number(x.trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
export function normalizeHealth(h) {
  if (!h || typeof h !== 'object') return null;
  return { ...h, hrv_ms: num(h.hrv_ms), resting_hr: num(h.resting_hr), sleep_h: num(h.sleep_h), steps: num(h.steps), weight_lb: num(h.weight_lb) };
}

// healthByDate: { 'YYYY-MM-DD': { hrv_ms, resting_hr, sleep_h, steps } } (data/health/)
export function baselines(healthByDate, today, days = 7) {
  const hrv = []; const rhr = [];
  for (let i = 1; i <= days; i += 1) {
    const h = healthByDate[addDays(today, -i)];
    if (!h) continue;
    if (Number.isFinite(h.hrv_ms)) hrv.push(h.hrv_ms);
    if (Number.isFinite(h.resting_hr)) rhr.push(h.resting_hr);
  }
  return {
    hrv: hrv.length >= 3 ? { mean: mean(hrv), sd: sd(hrv), n: hrv.length } : null,
    rhr: rhr.length >= 3 ? { mean: mean(rhr), n: rhr.length } : null,
  };
}

// The first 2 nights after a zone change of ≥ 3 h (settings.tz_history).
export function travelShift(tzHistory = [], today, tz) {
  if (tzHistory.length < 2) return null;
  const last = tzHistory[tzHistory.length - 1];
  const prev = tzHistory[tzHistory.length - 2];
  const at = new Date(last.from_utc);
  const hours = Math.abs(tzOffsetMinutes(at, last.tz) - tzOffsetMinutes(at, prev.tz)) / 60;
  if (hours < 3) return null;
  const arrived = localDate(at, tz || last.tz);
  const nights = Math.round((Date.parse(today) - Date.parse(arrived)) / 86400000);
  return nights >= 0 && nights <= 2 ? { hours: Math.round(hours), from: prev.tz, to: last.tz, nights } : null;
}

// history: [{ local_date, status }] from earlier runs (model state).
export function readiness({ today, health = {}, activities = [], dayName = null, history = [], tzHistory = [], tz = null }) {
  const h = health[today];
  if (!h || ![h.hrv_ms, h.resting_hr, h.sleep_h].some(Number.isFinite)) {
    return { status: 'green', flags: [], reason: 'no recovery data', missing: true, travel: null };
  }
  const base = baselines(health, today);
  const flags = [];
  if (base.hrv && Number.isFinite(h.hrv_ms) && h.hrv_ms < base.hrv.mean - base.hrv.sd) {
    flags.push({ key: 'hrv', text: `HRV low (${Math.round(h.hrv_ms)} vs ${Math.round(base.hrv.mean)} ms)` });
  }
  if (base.rhr && Number.isFinite(h.resting_hr) && h.resting_hr >= base.rhr.mean + 5) {
    flags.push({ key: 'rhr', text: `resting HR up (${Math.round(h.resting_hr)} vs ${Math.round(base.rhr.mean)})` });
  }
  if (Number.isFinite(h.sleep_h) && h.sleep_h < 6) flags.push({ key: 'sleep', text: `${h.sleep_h.toFixed(1)} h sleep` });
  // A hard session in the 24 h before Wednesday's legs (spec §6.3)
  if (dayName && /leg/i.test(dayName)) {
    const q75 = effortQuartile(activities);
    const hard = activities.find((a) => a.local_date === addDays(today, -1) && isHard(a, q75));
    if (hard) flags.push({ key: 'load', text: `${fmtMins(Math.round((hard.duration_s || 0) / 60))} ${typeWord(hard.type)} yesterday` });
  }
  const travel = travelShift(tzHistory, today, tz);
  const recent = history.filter((x) => x.local_date < today).sort((a, b) => (a.local_date < b.local_date ? 1 : -1));
  const amberRun = flags.length && [1, 2].every((i) => {
    const d = recent.find((x) => x.local_date === addDays(today, -i));
    return d && (d.status === 'amber' || d.status === 'red');
  });
  let status = flags.length >= 2 || amberRun ? 'red' : flags.length ? 'amber' : 'green';
  if (status === 'red' && travel) status = 'amber';
  const parts = flags.map((f) => f.text);
  if (amberRun && flags.length < 2) parts.push('amber 3 days running');
  if (travel && flags.length) parts.push(`travel (${travel.hours} h shift)`);
  return {
    status,
    flags,
    reason: parts.length ? parts.join(', ') : 'recovery normal',
    missing: false,
    travel,
    hrv_ms: h.hrv_ms ?? null, resting_hr: h.resting_hr ?? null, sleep_h: h.sleep_h ?? null,
    baseline: { hrv_ms: base.hrv ? Math.round(base.hrv.mean) : null, resting_hr: base.rhr ? Math.round(base.rhr.mean) : null },
  };
}
