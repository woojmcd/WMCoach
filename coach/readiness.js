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
// A Health file only counts once it carries last night's recovery data: an early sync
// can arrive before Oura has written the night (Walter, 2026-10-13).
export const hasRecovery = (h) => Boolean(h && [h.hrv_ms, h.resting_hr, h.sleep_h].some(Number.isFinite));

// More sleep than this from one overnight window isn't a real night: a sync that ran while
// Oura was still writing counted the night twice (14.3 h for 7.2 h on 2026-10-17). It's
// dropped and kept as sleep_unsettled, so the night counts as not in yet and the phone
// shows the Sync Health chip; the re-sync's real number then reruns the day (spec §2b).
export const MAX_SLEEP_H = 12;

// ---- raw samples from the Shortcut (Walter, 2026-10-20) --------------------------------------
// Oura rewrites a night in Apple Health several times, so the same stretch can sit there as
// two or three overlapping samples, and sums inside the Shortcut came out double (14.3 h for
// a 7.2 h night) while "lowest heart rate" picked up daytime readings. The Shortcut now sends
// the samples themselves, one per line, and the coach does the maths:
//   sleep_samples: "<start ISO>|<end ISO>|<value>"   (value: In Bed, Core, Deep, REM, Awake…)
//   hr_samples:    "<start ISO>|<bpm>"
// Sleep = time covered by an asleep stage and by no Awake sample, inside the main In Bed
// window (overlaps count once). Resting HR = the lowest heart rate inside that window, which
// is Oura's "lowest heart rate".
const rowsOf = (text) => String(text || '').split(/\r?\n|\\n/).map((l) => l.split(/\s*[|;\t]\s*/).map((x) => x.trim())).filter((r) => r.length >= 2 && r[0]);
const ms = (x) => { const t = Date.parse(x); return Number.isFinite(t) ? t : null; };
const kindOf = (v) => {
  const t = String(v || '').toLowerCase();
  if (t.includes('awake')) return 'awake';
  if (t.includes('bed')) return 'bed';
  if (/core|deep|rem|asleep|unspecified|light/.test(t)) return 'asleep';
  return null;
};
function union(list) {
  const xs = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const total = (u) => u.reduce((t, [a, b]) => t + (b - a), 0);
function intersect(u, v) {
  const out = [];
  let i = 0; let j = 0;
  while (i < u.length && j < v.length) {
    const a = Math.max(u[i][0], v[j][0]); const b = Math.min(u[i][1], v[j][1]);
    if (a < b) out.push([a, b]);
    if (u[i][1] < v[j][1]) i += 1; else j += 1;
  }
  return out;
}

// → { sleep_h, window: [startMs, endMs] } or null when the text holds no night.
export function sleepFromSamples(text) {
  const iv = { bed: [], asleep: [], awake: [] };
  for (const [a, b, v] of rowsOf(text)) {
    const k = kindOf(v); const s0 = ms(a); const s1 = ms(b);
    if (k && s0 !== null && s1 !== null && s1 > s0) iv[k].push([s0, s1]);
  }
  const asleep = union(iv.asleep);
  if (!asleep.length) return null;
  // the main night: the longest In Bed stretch (joined if Oura split it), else the asleep span
  const beds = union(iv.bed).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  const window = beds.length ? beds[0] : [asleep[0][0], asleep[asleep.length - 1][1]];
  const inWin = intersect(asleep, [window]);
  const asleepMs = total(inWin) - total(intersect(inWin, union(iv.awake)));
  if (!(asleepMs > 0)) return null;
  return { sleep_h: Math.round((asleepMs / 3600000) * 100) / 100, window };
}

export function restingFromSamples(text, window) {
  if (!window) return null;
  let low = null;
  for (const [a, v] of rowsOf(text)) {
    const t = ms(a); const bpm = Number(String(v).replace(',', '.').match(/[\d.]+/)?.[0]);
    if (t === null || !(bpm > 25 && bpm < 220) || t < window[0] || t > window[1]) continue;
    if (low === null || bpm < low) low = bpm;
  }
  return low === null ? null : Math.round(low);
}

export function normalizeHealth(h) {
  if (!h || typeof h !== 'object') return null;
  let sleep = num(h.sleep_h);
  let rhr = num(h.resting_hr);
  const fromSamples = Boolean(h.sleep_samples);
  if (fromSamples) {
    const night = sleepFromSamples(h.sleep_samples);
    sleep = night ? night.sleep_h : null;
    if (h.hr_samples) rhr = night ? restingFromSamples(h.hr_samples, night.window) : null;
  }
  const out = { ...h, hrv_ms: num(h.hrv_ms), resting_hr: rhr, sleep_h: sleep, steps: num(h.steps), weight_lb: num(h.weight_lb) };
  delete out.sleep_samples; delete out.hr_samples;
  if (sleep !== null && sleep > MAX_SLEEP_H) { out.sleep_h = null; out.sleep_unsettled = sleep; }
  // No sleep at all means Oura hasn't sent the night to Health yet (it does when its app
  // opens). The "lowest heart rate" is then a daytime reading (87 for 58 on 2026-10-18), so
  // it waits for the night too.
  if (out.sleep_h === null && !out.sleep_unsettled && out.resting_hr !== null && !Number.isFinite(out.hrv_ms)) {
    out.resting_hr_unsettled = out.resting_hr;
    out.resting_hr = null;
  }
  return out;
}

// Today's Health file is settled: it has recovery data and no implausible sleep.
export const healthSettled = (h) => hasRecovery(h) && Number.isFinite(h.sleep_h) && !h.sleep_unsettled;

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
