// Energy expenditure (brief §5): an adaptive estimate in the style of MacroFactor.
//   prior    = 13.2 kcal/lb × trend weight (± 250) + cardio kcal
//   observed = mean intake − trend slope (lb/day) × K   (K 3,500 losing / 2,750 gaining)
//   estimate = blend(prior, observed), weight on observed = min(0.85, weigh-ins / 30),
//              clamped to ±150 kcal of last week's estimate.
// Intake is "plan as written" (brief §2): the plan's kcal on days on plan, the
// logged estimate on Partial days, and Off days and breaks are left out.
import { addDays, daysBetween } from './time.js';
import { dailyMeans, trendFromEntries } from './trend.js';

// Least-squares slope of { x, y } points (y per unit x); null if under 2 points.
export function olsSlope(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0; let den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : null;
}

// Brief §1a/§1b: rate = OLS slope of daily weights in the window;
// est. maintenance = plan kcal − rate × 3,500 / 7; base = est. − cardio.
export function blockMaintenance({ weighins, from, to, planKcal, cardioKcal = 0, K = 3500 }) {
  const days = dailyMeans(weighins).filter((d) => d.date >= from && d.date <= to);
  const slope = olsSlope(days.map((d) => ({ x: daysBetween(from, d.date), y: d.weight })));
  if (slope === null) return null;
  const rateWk = slope * 7;
  const est = planKcal - (rateWk * K) / 7;
  const avg = days.reduce((a, d) => a + d.weight, 0) / days.length;
  return { n: days.length, rate_lb_wk: rateWk, rate_pct_bw_wk: (rateWk / avg) * 100, avg_lb: avg, est_maint: est, base: est - cardioKcal, base_per_lb: (est - cardioKcal) / avg };
}

// The plan kcal in force on each date: plan records { week_start, week_end, plan: { weekly_avg } }.
export function planKcalByDate(plans, from, to) {
  const out = new Map();
  const sorted = [...plans].filter((p) => !p.deleted && p.plan && p.plan.weekly_avg).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const p = [...sorted].reverse().find((x) => x.week_start <= d);
    if (p) out.set(d, p.plan.weekly_avg.kcal);
  }
  return out;
}

// Intake per date: plan kcal unless an on-plan tap says otherwise.
// taps: adherence records { local_date, status: yes|partial|off, kcal }.
export function intakeByDate(planKcal, taps) {
  const out = new Map(planKcal);
  const latest = new Map();
  for (const t of taps) {
    if (t.deleted) continue;
    const prev = latest.get(t.local_date);
    if (!prev || (t.updated_utc || '') > (prev.updated_utc || '')) latest.set(t.local_date, t);
  }
  for (const [d, t] of latest) {
    if (t.status === 'off') out.set(d, null); // excluded from learning (spec §7 step 3)
    else if (t.status === 'partial' && Number.isFinite(t.kcal)) out.set(d, t.kcal);
  }
  return out;
}

export function inBreak(date, phases) {
  return phases.some((p) => p.kind === 'break' && !p.deleted && p.start <= date && (!p.end || date <= p.end));
}

export function estimateTdee({
  today, weighins, intake = new Map(), cardio = new Map(), phases = [], prev = null,
  priors = { base_kcal_per_lb: 13.2, kcal_per_lb: { loss: 3500, gain: 2750 } },
  windowDays = 28, minWeighins = 8, maxChange = 150,
}) {
  const from = addDays(today, -(windowDays - 1));
  const series = trendFromEntries(weighins.filter((w) => !w.deleted));
  const upto = series.filter((p) => p.date <= today);
  const last = upto[upto.length - 1] || null;
  if (!last) return null;
  const inWindow = upto.filter((p) => p.date >= from && !inBreak(p.date, phases) && intake.get(p.date) !== null);
  const dates = [];
  for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);
  const learn = dates.filter((d) => !inBreak(d, phases) && Number.isFinite(intake.get(d)));
  const cardioMean = dates.reduce((a, d) => a + (cardio.get(d) || 0), 0) / dates.length;
  const prior = priors.base_kcal_per_lb * last.trend + cardioMean;
  let observed = null;
  let slope = null;
  const n = inWindow.length;
  if (n >= minWeighins && learn.length >= 14) {
    slope = olsSlope(inWindow.map((p) => ({ x: daysBetween(from, p.date), y: p.trend })));
    const K = slope < 0 ? priors.kcal_per_lb.loss : priors.kcal_per_lb.gain;
    const intakeMean = learn.reduce((a, d) => a + intake.get(d), 0) / learn.length;
    observed = intakeMean - slope * K;
  }
  const w = observed === null ? 0 : Math.min(0.85, n / 30);
  let estimate = observed === null ? prior : prior * (1 - w) + observed * w;
  let clamped = false;
  if (prev && Number.isFinite(prev.estimate_kcal) && Math.abs(estimate - prev.estimate_kcal) > maxChange) {
    estimate = prev.estimate_kcal + Math.sign(estimate - prev.estimate_kcal) * maxChange;
    clamped = true;
  }
  return {
    method: observed === null ? 'prior' : 'blend',
    local_date: today,
    trend_lb: Math.round(last.trend * 10) / 10,
    prior_kcal: Math.round(prior),
    observed_kcal: observed === null ? null : Math.round(observed),
    weight_on_observed: Math.round(w * 100) / 100,
    estimate_kcal: Math.round(estimate),
    base_kcal: Math.round(priors.base_kcal_per_lb * last.trend),
    cardio_kcal: Math.round(cardioMean),
    weighins_in_window: n,
    days_learned: learn.length,
    rate_lb_wk: slope === null ? null : Math.round(slope * 7 * 100) / 100,
    clamped,
  };
}
