// Trend weight (brief §5): time-aware EWMA, half-life 7 days.
//   trend += (1 - 0.5^(Δdays / halfLife)) × (weight - trend)
// Several weigh-ins on one local date (e.g. a repeated day after crossing the
// date line) are kept as logged in storage; here they are averaged for the math.
import { daysBetween } from './time.js';

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
