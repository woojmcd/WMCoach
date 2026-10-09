// Trend weight (brief §5): time-aware EWMA, half-life 7 days.
//   trend += (1 - 0.5^(Δdays / halfLife)) × (weight - trend)
// Several weigh-ins on one local date (e.g. a repeated day after crossing the
// date line) are kept as logged in storage; here they are averaged for the math.
import { addDays, daysBetween } from './time.js';

export const HALF_LIFE_DAYS = 7;

export function dailyMeans(entries) {
  const byDate = new Map();
  for (const e of entries) {
    if (!e || !e.local_date || !Number.isFinite(e.weight_lb)) continue;
    const acc = byDate.get(e.local_date) || { sum: 0, n: 0 };
    acc.sum += e.weight_lb;
    acc.n += 1;
    byDate.set(e.local_date, acc);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { sum, n }]) => ({ date, weight: sum / n, n }));
}

export function ewmaTrend(points, halfLife = HALF_LIFE_DAYS) {
  const out = [];
  let trend = null;
  let prev = null;
  for (const p of points) {
    if (trend === null) {
      trend = p.weight;
    } else {
      const dt = daysBetween(prev, p.date);
      const alpha = 1 - Math.pow(0.5, dt / halfLife);
      trend += alpha * (p.weight - trend);
    }
    prev = p.date;
    out.push({ date: p.date, weight: p.weight, trend });
  }
  return out;
}

export function trendFromEntries(entries, halfLife = HALF_LIFE_DAYS) {
  return ewmaTrend(dailyMeans(entries), halfLife);
}

export function round1(x) {
  return Math.round(x * 10) / 10;
}

// Rate of change of the trend over the last `days` days ending `endDate`
// (brief §5: rate_2wk = trend slope over the last 14 d, as %BW/wk).
// Least-squares slope of the trend values; null when the data can't support it.
export function rateOverDays(series, endDate, days = 14, { minPoints = 4, minSpanDays = 7 } = {}) {
  const startDate = addDays(endDate, -(days - 1));
  const pts = series.filter((p) => p.date >= startDate && p.date <= endDate);
  if (pts.length < minPoints) return null;
  const xs = pts.map((p) => daysBetween(startDate, p.date));
  if (xs[xs.length - 1] - xs[0] < minSpanDays) return null;
  const ys = pts.map((p) => p.trend);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const lbPerDay = num / den;
  const ref = pts[pts.length - 1].trend;
  return { lb_per_wk: lbPerDay * 7, pct_bw_per_wk: (lbPerDay * 7 / ref) * 100, n, span_days: xs[xs.length - 1] - xs[0] };
}

// Where a rate sits against the mode's target band (model rate_bands_pct_bw_per_wk).
export function rateStatus(mode, pct, bands) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  if (mode === 'bulk') {
    const { target: [lo, hi], cap } = bands.bulk;
    if (pct > cap) return { key: 'too_fast', word: 'Too fast', tone: 'bad' };
    if (pct > hi) return { key: 'fast', word: 'Fast', tone: 'warn' };
    if (pct >= lo) return { key: 'on_target', word: 'On target', tone: 'good' };
    return { key: 'slow', word: 'Slow', tone: 'warn' };
  }
  if (mode === 'cut') {
    const { target: [lo, hi], cap } = bands.cut; // lo = -0.75 (faster), hi = -0.5
    if (pct < cap) return { key: 'too_fast', word: 'Too fast', tone: 'bad' };
    if (pct < lo) return { key: 'fast', word: 'Fast', tone: 'warn' };
    if (pct <= hi) return { key: 'on_target', word: 'On target', tone: 'good' };
    return { key: 'slow', word: 'Slow', tone: 'warn' };
  }
  const [lo, hi] = bands.maintenance.target;
  if (pct > hi) return { key: 'drifting_up', word: 'Drifting up', tone: 'warn' };
  if (pct < lo) return { key: 'drifting_down', word: 'Drifting down', tone: 'warn' };
  return { key: 'stable', word: 'Stable', tone: 'good' };
}
