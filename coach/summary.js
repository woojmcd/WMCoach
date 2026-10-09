// Weekly executive summary (Walter, 2026-10-09): shown on the Week tab after each
// check-in, until the next one replaces it. Blunt but encouraging: the numbers
// first, no softening, and what to do about them. Pure, so the weekly routine
// can reuse it and add its macro decision.
//
// Order follows the check-in framework (spec §10): adherence, data, rate,
// strength / waist / biofeedback, then the plan.
import { addDays, daysBetween, isoWeekday, formatDayMonth, WEEKDAYS } from './time.js';
import { dailyMeans, trendFromEntries, rateOverDays, rateStatus } from './trend.js';
import { historyFor, workingSets } from './progression.js';
import { dayForWeekday } from './program.js';

export const ADHERENCE_MIN = 90; // spec §10 step 1
export const WEIGHINS_MIN = 5; // spec §10 step 2
const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const TONE_RANK = { good: 0, info: 0, warn: 1, bad: 2 };
const BIO_LABEL = { hunger: 'hunger', energy: 'energy', sleep: 'sleep', stress: 'stress', digestion: 'digestion' };
const MODE_WORD = { bulk: 'bulk', cut: 'cut', maintenance: 'maintenance' };

const sgn = (v, d) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const bandText = ([lo, hi]) => `${sgn(lo, 2)} to ${sgn(hi, 2)}`;

// Estimated 1RM of the best working set (Epley), for comparing sessions.
function bestE1rm(entry) {
  let best = null;
  for (const s of workingSets(entry)) {
    if (!Number.isFinite(s.load) || s.load <= 0) continue;
    const e = s.load * (1 + s.reps / 30);
    if (!best || e > best.e1rm) best = { e1rm: e, load: s.load, reps: s.reps };
  }
  return best;
}

// The window a check-in reviews: the 7 days ending on its date.
export function summaryPeriod(checkinDate) {
  return { from: addDays(checkinDate, -6), to: checkinDate };
}

// How long a summary stays up: through the plan week that starts after the
// check-in (it is replaced as soon as the next check-in is saved).
export function summaryVisibleUntil(checkinDate, prepDow) {
  const nextPrep = addDays(checkinDate, ((prepDow - isoWeekday(checkinDate) + 7) % 7) || 7);
  return addDays(nextPrep, 6);
}

// The check-in whose summary the Week tab shows today, or null.
export function activeSummaryCheckin(checkins, today, prepDow) {
  const latest = checkins.filter((c) => c.local_date <= today).sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0];
  if (!latest) return null;
  return today <= summaryVisibleUntil(latest.local_date, prepDow) ? latest : null;
}

function adherencePoint(pct) {
  if (pct === null || pct === undefined) {
    return { key: 'adherence', tone: 'warn', title: 'Adherence', text: 'Not logged. Without it nothing else can be judged: tap “On plan” every day.' };
  }
  if (pct >= 95) return { key: 'adherence', tone: 'good', title: 'Adherence', text: `${pct} %. That’s the foundation, so the numbers below are a fair test of the plan.` };
  if (pct >= ADHERENCE_MIN) return { key: 'adherence', tone: 'good', title: 'Adherence', text: `${pct} %. Over the ${ADHERENCE_MIN} % bar, so the plan got a fair test.` };
  if (pct >= 75) return { key: 'adherence', tone: 'warn', title: 'Adherence', text: `${pct} %, under the ${ADHERENCE_MIN} % bar. The plan wasn’t really tested, so the scale can’t tell us much and macros won’t change this week.` };
  return { key: 'adherence', tone: 'bad', title: 'Adherence', text: `${pct} %. Too low to judge anything. This is the one thing to fix; changing the plan won’t help until it’s followed.` };
}

function weightPoint({ weighins, period, mode, bands, units, observeOnly }) {
  const days = dailyMeans(weighins);
  const inWeek = days.filter((d) => d.date >= period.from && d.date <= period.to);
  const prevWeek = days.filter((d) => d.date >= addDays(period.from, -7) && d.date < period.from);
  const series = trendFromEntries(weighins);
  const rate = rateOverDays(series, period.to, 14);
  const st = rate ? rateStatus(mode, rate.pct_bw_per_wk, bands) : null;
  const kg = units === 'kg';
  const w = (lb) => (kg ? lb * LB_TO_KG : lb);
  const u = kg ? 'kg' : 'lb';
  const avg = inWeek.length ? mean(inWeek.map((d) => d.weight)) : null;
  const prevAvg = prevWeek.length ? mean(prevWeek.map((d) => d.weight)) : null;
  const avgText = avg === null ? '' : ` Week average ${w(avg).toFixed(1)} ${u}${prevAvg !== null ? ` (${sgn(w(avg - prevAvg), 1)} ${u} vs last week)` : ''}.`;
  const count = { n: inWeek.length, enough: inWeek.length >= WEIGHINS_MIN };
  if (!count.enough) {
    return {
      count, rate, status: st,
      point: { key: 'weight', tone: 'warn', title: 'Weight', text: `${inWeek.length} weigh-in${inWeek.length === 1 ? '' : 's'} this week; the trend needs ${WEIGHINS_MIN}+. With gaps the scale is guesswork, so weigh in every morning after the bathroom, before food.${avgText}` },
    };
  }
  if (!rate || !st) {
    return { count, rate, status: st, point: { key: 'weight', tone: 'info', title: 'Weight', text: `Not enough history yet for a 2-week trend.${avgText}` } };
  }
  const pct = rate.pct_bw_per_wk;
  const rateText = `Trend ${sgn(pct, 2)} %BW/wk (${sgn(w(rate.lb_per_wk), 2)} ${u}/wk)`;
  const band = mode === 'maintenance' ? bands.maintenance.target : mode === 'cut' ? [bands.cut.target[0], bands.cut.target[1]] : bands[mode].target;
  const washout = observeOnly ? ' First week after a plan change: part of this is water, so judge it next week.' : '';
  const msg = {
    bulk: {
      on_target: ['good', `${rateText}, inside the ${bandText(band)} bulk band. That’s the pace for lean gain.`],
      fast: ['warn', `${rateText}, above the ${bandText(band)} band. Faster than muscle can be built, so some of it is fat. If it holds another week, carbs come down.`],
      too_fast: ['bad', `${rateText}, past the ${sgn(bands.bulk.cap, 2)} cap. At this pace it’s mostly fat, not muscle. Carbs come down at the weekly step.`],
      slow: ['warn', `${rateText}, under the ${bandText(band)} band. You’re eating at about maintenance. If it holds 2 weeks, carbs go up.`],
    },
    cut: {
      on_target: ['good', `${rateText}, inside the ${bandText(band)} cut band. Fat is coming off at a pace that keeps muscle.`],
      fast: ['warn', `${rateText}, faster than the ${bandText(band)} band. Losing this fast risks muscle; watch strength closely.`],
      too_fast: ['bad', `${rateText}, past the ${sgn(bands.cut.cap, 2)} limit. That’s too fast to keep muscle; the cut has to slow.`],
      slow: ['warn', `${rateText}, slower than the ${bandText(band)} band. Check adherence before blaming the plan.`],
    },
    maintenance: {
      stable: ['good', `${rateText}, stable within ${bandText(band)}. Maintenance is doing its job.`],
      drifting_up: ['warn', `${rateText}, drifting up past ${sgn(band[1], 2)}. Intake is creeping above maintenance.`],
      drifting_down: ['warn', `${rateText}, drifting down past ${sgn(band[0], 2)}. You’re under-eating for maintenance.`],
    },
  }[mode][st.key];
  return { count, rate, status: st, point: { key: 'weight', tone: msg[0], title: 'Weight', text: `${msg[1]}${avgText}${washout}` } };
}

function trainingPoint({ sessions, program, period, today }) {
  if (!program) return { point: null, lifts: [] };
  const inWeek = sessions.filter((s) => s.status === 'finished' && !s.deleted && s.local_date >= period.from && s.local_date <= period.to);
  const deload = inWeek.some((s) => s.deload);
  // the program starts with the first logged session; days before it aren't "missed"
  const logged = sessions.filter((s) => !s.deleted && s.status !== 'draft').map((s) => s.local_date).sort();
  if (!logged.length) {
    return { point: { key: 'training', tone: 'info', title: 'Training', text: 'Program not started yet: your first logged session sets the baselines.' }, lifts: [], doneCount: null };
  }
  const programStart = logged[0];
  // planned training days in the window that have passed (today's counts once logged)
  const planned = [];
  for (let d = period.from > programStart ? period.from : programStart; d <= period.to; d = addDays(d, 1)) {
    const day = dayForWeekday(program, isoWeekday(d));
    if (!day || !day.exercises.length) continue;
    const done = sessions.some((s) => s.local_date === d && !s.deleted && s.status !== 'draft');
    if (d < today || done) planned.push({ date: d, day, done });
  }
  const missed = planned.filter((p) => !p.done);
  const doneCount = inWeek.length;
  // main lifts: the latest session in the window vs the one before it
  const lifts = [];
  for (const day of program.days) {
    for (const ex of day.exercises) {
      if (!ex.main_lift) continue;
      const hist = historyFor(sessions, ex.id, ex.movement).filter((e) => !e.deload);
      const latestIdx = hist.map((e) => e.local_date >= period.from && e.local_date <= period.to).lastIndexOf(true);
      if (latestIdx < 0) continue;
      const cur = bestE1rm(hist[latestIdx]);
      const prev = latestIdx > 0 ? bestE1rm(hist[latestIdx - 1]) : null;
      if (!cur) continue;
      if (!prev) { lifts.push({ name: ex.name, dir: 'baseline', cur }); continue; }
      const change = (cur.e1rm - prev.e1rm) / prev.e1rm;
      lifts.push({ name: ex.name, dir: change > 0.01 ? 'up' : change < -0.01 ? 'down' : 'flat', cur, prev });
    }
  }
  const up = lifts.filter((l) => l.dir === 'up');
  const down = lifts.filter((l) => l.dir === 'down');
  const flat = lifts.filter((l) => l.dir === 'flat');
  const base = lifts.filter((l) => l.dir === 'baseline');
  const exChanges = inWeek.flatMap((s) => s.exercises.filter((e) => !e.skipped));
  const raised = exChanges.filter((e) => e.change === 'up').length;
  const resets = exChanges.filter((e) => e.change === 'down').map((e) => e.name);
  const calib = exChanges.filter((e) => e.calibration).length;

  const parts = [];
  const plannedN = planned.length;
  if (!plannedN && !doneCount) return { point: null, lifts };
  const of = Math.max(plannedN, doneCount);
  parts.push(`${doneCount} of ${of} session${of === 1 ? '' : 's'}.`);
  if (missed.length) parts.push(`Missed ${missed.map((m) => `${WEEKDAYS[isoWeekday(m.date) - 1]} (${m.day.name})`).join(', ')}. Every missed session is progress you don’t get back.`);
  const fmt = (l) => `${l.name} ${l.prev.load}×${l.prev.reps} → ${l.cur.load}×${l.cur.reps}`;
  if (deload) parts.push('Deload week: lighter on purpose, so strength isn’t judged.');
  else if (base.length && !up.length && !down.length && !flat.length) parts.push(`Baselines set on ${base.length} main lift${base.length === 1 ? '' : 's'}${calib ? ` and ${calib} calibration exercise${calib === 1 ? '' : 's'}` : ''}. Progress is measured from next week.`);
  else {
    if (up.length) parts.push(`Up: ${up.map(fmt).join('; ')}.`);
    if (down.length) parts.push(`Down: ${down.map(fmt).join('; ')}.`);
    if (flat.length) parts.push(`Flat: ${flat.map((l) => l.name).join(', ')}.`);
  }
  if (raised) parts.push(`${raised} load increase${raised === 1 ? '' : 's'} earned.`);
  if (resets.length) parts.push(`Reset after stalling: ${resets.join(', ')}.`);

  let tone = 'good';
  if (!doneCount) tone = 'bad';
  else if (!deload && down.length >= 3) tone = 'bad';
  else if (missed.length || (!deload && down.length > up.length)) tone = 'warn';
  if (!doneCount) parts.splice(0, parts.length, plannedN ? `No sessions logged out of ${plannedN} planned. Unlogged training can’t drive progression, so log every set, even on a bad day.` : 'No sessions logged.');
  return { point: { key: 'training', tone, title: 'Training', text: parts.join(' ') }, lifts, up, down, missed, doneCount, deload };
}

function bodyPoint({ measurements, checkin, phase, mode, units }) {
  const cm = units === 'kg';
  const L = (inches, d = 2) => (cm ? `${(inches * IN_TO_CM).toFixed(1)} cm` : `${inches.toFixed(d).replace(/0$/, '')} in`);
  const dL = (inches) => (cm ? `${sgn(inches * IN_TO_CM, 1)} cm` : `${sgn(inches, 2).replace(/0$/, '')} in`);
  const m = checkin.measurement_id ? measurements.find((x) => x.id === checkin.measurement_id) : null;
  if (!m || !m.avg || !m.avg.waist) {
    return { key: 'body', tone: 'warn', title: 'Measurements', text: `No tape measurements this week. The waist is the best check on ${mode === 'cut' ? 'whether the weight lost is fat' : 'whether the weight gained is fat'}; tape it every Friday.` };
  }
  const earlier = measurements.filter((x) => x.local_date < m.local_date && x.avg && x.avg.waist).sort((a, b) => (a.local_date < b.local_date ? 1 : -1));
  const prev = earlier[0] || null;
  const start = phase ? measurements.filter((x) => x.local_date >= phase.start && x.avg && x.avg.waist).sort((a, b) => (a.local_date < b.local_date ? -1 : 1))[0] : null;
  const parts = [`Waist ${L(m.avg.waist)}`];
  const wk = prev ? m.avg.waist - prev.avg.waist : null;
  if (wk !== null) parts[0] += ` (${dL(wk)} vs last week${start && start.id !== m.id ? `, ${dL(m.avg.waist - start.avg.waist)} since the ${MODE_WORD[phase.kind] || 'phase'} began` : ''})`;
  parts[0] += '.';
  let tone = 'info';
  if (prev) {
    const limbs = ['arm', 'thigh', 'chest'].map((k) => (m.avg[k] && prev.avg[k] ? m.avg[k] - prev.avg[k] : null)).filter((v) => v !== null);
    const limbAvg = limbs.length ? mean(limbs) : null;
    if (mode === 'bulk') {
      const sinceStart = start ? m.avg.waist - start.avg.waist : 0;
      if (sinceStart >= 1.5) { tone = 'bad'; parts.push('That’s the +1.5 in limit for this bulk: time to plan maintenance.'); } else if (wk > 0.25) { tone = 'warn'; parts.push('Rising fast for one week. One reading can be noise, but two like this means the surplus is too big.'); } else if (limbAvg !== null && wk > 0 && wk >= limbAvg) { tone = 'warn'; parts.push('Waist rising as fast as arms, chest and thighs: the surplus may be too high.'); } else if (limbAvg !== null && limbAvg > 0) { tone = 'good'; parts.push('Arms, chest and thighs are growing faster than the waist: the gain is going to the right places.'); } else { tone = 'good'; parts.push('Waist under control.'); }
    } else if (mode === 'cut') {
      if (wk < 0 && (limbAvg === null || limbAvg >= -0.1)) { tone = 'good'; parts.push('Waist down while arms and thighs hold: that’s fat, not muscle.'); } else if (wk >= 0) { tone = 'warn'; parts.push('Waist not moving. One week can be water; two means the deficit isn’t real.'); } else { tone = 'warn'; parts.push('Arms and thighs are shrinking too. If strength drops as well, the cut is too fast.'); }
    } else if (Math.abs(wk) <= 0.25) { tone = 'good'; parts.push('Holding steady.'); } else { tone = 'warn'; parts.push('Moving more than maintenance should.'); }
  } else {
    parts.push('First measurement: the baseline everything after is judged against.');
  }
  return { key: 'body', tone, title: 'Measurements', text: parts.join(' ') };
}

function recoveryPoint(checkin, previous) {
  const b = checkin.biofeedback || {};
  const vals = Object.values(b).filter(Number.isFinite);
  if (!vals.length) return null;
  const avg = mean(vals);
  const prevVals = previous ? Object.values(previous.biofeedback || {}).filter(Number.isFinite) : [];
  const prevAvg = prevVals.length ? mean(prevVals) : null;
  const low = Object.entries(b).filter(([, v]) => v <= 2).map(([k]) => BIO_LABEL[k] || k);
  const parts = [`${avg.toFixed(1)} / 5${prevAvg !== null ? ` (${prevAvg.toFixed(1)} last week)` : ''}.`];
  let tone = 'good';
  if (avg <= 2) { tone = 'bad'; parts.push('You’re running down. Recovery is now the limiting factor, not food or effort.'); } else if (low.length) { tone = 'warn'; parts.push(`Low: ${low.join(', ')}. ${low.includes('sleep') ? 'Sleep is the cheapest performance fix there is.' : 'Worth fixing before it shows up in the logbook.'}`); } else if (avg >= 4) parts.push('Recovering well.');
  else parts.push('Holding up.');
  if (checkin.note) parts.push(`Your note: “${checkin.note}”`);
  return { key: 'recovery', tone, title: 'Recovery', text: parts.join(' ') };
}

function planPoint({ plans, adherenceOk, dataOk, checkinDate, today }) {
  const upcoming = plans ? [plans.next, plans.current].find((p) => p && p.week_start > checkinDate) || null : null;
  const shown = upcoming || (plans && plans.current) || null;
  const started = upcoming && today >= upcoming.week_start;
  if (upcoming && upcoming.changes && upcoming.changes.changed && upcoming.source !== 'carry') {
    const k = upcoming.changes.kcal;
    const when = `${WEEKDAYS[isoWeekday(upcoming.week_start) - 1]} ${formatDayMonth(upcoming.week_start)}`;
    return { key: 'plan', tone: 'info', title: 'Plan', text: `${started ? 'Changed' : 'Changes'} ${when}: ${k.delta > 0 ? '+' : ''}${k.delta} kcal a day (${k.from.toLocaleString('en-US')} → ${k.to.toLocaleString('en-US')}). See Meals for the food changes.` };
  }
  const kcal = shown && shown.plan && shown.plan.weekly_avg ? Math.round(shown.plan.weekly_avg.kcal) : null;
  const same = `Same plan ${started ? 'this' : 'next'} week${kcal ? ` (${kcal.toLocaleString('en-US')} kcal a day)` : ''}: prep as usual.`;
  if (!adherenceOk) return { key: 'plan', tone: 'info', title: 'Plan', text: `${same} No macro change while adherence is under ${ADHERENCE_MIN} %: follow the plan before changing it.` };
  if (!dataOk) return { key: 'plan', tone: 'info', title: 'Plan', text: `${same} No macro change on fewer than ${WEIGHINS_MIN} weigh-ins.` };
  return { key: 'plan', tone: 'info', title: 'Plan', text: same };
}

// Headline and focus: the first problem in §10 order, then the best news.
function verdict({ adh, weight, training, body, recovery, mode }) {
  const pct = adh.pct;
  const issues = [];
  if (pct === null || pct === undefined) issues.push({ tone: 'warn', head: 'Adherence wasn’t logged, so this week can’t be judged properly.', focus: 'Tap “On plan” every day so the coach can tell a bad plan from a missed one.' });
  else if (pct < ADHERENCE_MIN) issues.push({ tone: pct < 75 ? 'bad' : 'warn', head: `Adherence was ${pct} %, so the plan didn’t get a fair test.`, focus: 'Hit the plan at least 6 of 7 days. Nothing else matters until that’s true.' });
  if (!weight.count.enough) issues.push({ tone: 'warn', head: `Only ${weight.count.n} weigh-in${weight.count.n === 1 ? '' : 's'}, so the trend is guesswork.`, focus: 'Weigh in every morning: after the bathroom, before food.' });
  const st = weight.status;
  if (weight.count.enough && st && st.tone !== 'good') {
    const fx = {
      bulk: { too_fast: ['Gaining too fast: a good share of it is fat.', 'Eat exactly the plan, no extras. Carbs come down at the weekly step.'], fast: ['Gaining a bit fast for a lean bulk.', 'Stick to the plan exactly; if the rate holds, carbs come down.'], slow: ['The scale isn’t moving: you’re eating at maintenance.', 'Eat every gram on the plan. If it holds, carbs go up.'] },
      cut: { too_fast: ['Losing too fast: muscle is at risk.', 'Eat the full plan; the cut needs to slow down.'], fast: ['Losing faster than planned.', 'Eat the full plan and keep training hard to protect muscle.'], slow: ['Fat loss has stalled.', 'Tighten adherence first: weigh portions, no untracked bites.'] },
      maintenance: { drifting_up: ['Weight is drifting up.', 'Stick to the plan; weekends are usually where it slips.'], drifting_down: ['Weight is drifting down.', 'Eat the whole plan; maintenance means holding steady.'] },
    }[mode][st.key];
    if (fx) issues.push({ tone: st.tone === 'bad' ? 'bad' : 'warn', head: fx[0], focus: fx[1] });
  }
  if (training.point && training.point.tone !== 'good' && training.doneCount !== null) {
    if (!training.doneCount) issues.push({ tone: 'bad', head: 'No training logged this week.', focus: 'Log every session: progression runs on the logbook.' });
    else if (training.down && training.down.length >= 3) issues.push({ tone: 'bad', head: `Strength dropped on ${training.down.length} main lifts.`, focus: 'Recovery first: 7+ h sleep, keep RIR honest, don’t add volume.' });
    else if (training.missed && training.missed.length) issues.push({ tone: 'warn', head: `Missed ${training.missed.length} session${training.missed.length === 1 ? '' : 's'}.`, focus: 'Get all 5 in. If a day can’t happen, move it rather than skip it.' });
    else if (training.down && training.down.length) issues.push({ tone: 'warn', head: 'More lifts went down than up.', focus: 'Check sleep and stress before blaming the program.' });
  }
  if (body && body.tone === 'bad') issues.push({ tone: 'bad', head: 'The waist says this phase has run its course.', focus: 'Plan the switch to maintenance.' });
  else if (body && body.tone === 'warn' && body.text.startsWith('No tape')) issues.push({ tone: 'warn', head: 'No measurements this week.', focus: 'Tape the waist every Friday: it’s the honest check on the scale.' });
  else if (body && body.tone === 'warn') issues.push({ tone: 'warn', head: 'The waist is moving the wrong way.', focus: 'Stick to the plan exactly and re-measure next Friday.' });
  if (recovery && recovery.tone === 'bad') issues.push({ tone: 'bad', head: 'Recovery is poor.', focus: 'Sleep and stress first this week; the plan can’t out-work them.' });

  const wins = [];
  if (pct >= 95) wins.push(`adherence ${pct} %`);
  if (weight.count.enough && st && st.tone === 'good') wins.push(mode === 'cut' ? 'fat loss on pace' : mode === 'bulk' ? 'gaining at the right pace' : 'weight stable');
  if (training.up && training.up.length) wins.push(`${training.up.length} main lift${training.up.length === 1 ? '' : 's'} up`);
  if (training.doneCount && !(training.missed && training.missed.length)) wins.push(training.doneCount === 1 ? 'every planned session done' : `all ${training.doneCount} sessions done`);
  if (body && body.tone === 'good') wins.push(mode === 'cut' ? 'waist coming down' : 'waist under control');

  const winText = wins.length ? `${wins.slice(0, 3).join(', ')}` : '';
  if (!issues.length) {
    return { tone: 'good', headline: wins.length ? `Strong week: ${winText}. Keep it boring and repeat it.` : 'Solid week. Nothing to fix; repeat it.', focus: 'Same again: hit the plan, beat the logbook.' };
  }
  const top = issues[0];
  const tone = issues.reduce((t, i) => (TONE_RANK[i.tone] > TONE_RANK[t] ? i.tone : t), 'good');
  const also = issues.slice(1).map((i) => i.head.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()));
  const headline = `${top.head}${also.length ? ` Also: ${also.join('; ')}.` : ''}${winText ? ` On the plus side: ${winText}.` : ''}`;
  return { tone, headline, focus: top.focus };
}

export function weeklySummary({
  checkin, previousCheckin = null, weighins = [], measurements = [], sessions = [], program = null,
  mode = 'bulk', phase = null, bands, plans = null, today, prepDow = 7, units = 'lb', observeOnly = null,
}) {
  const period = summaryPeriod(checkin.local_date);
  // spec §8.2: the week after a plan change is "observe only" for the rate (glycogen washout)
  if (observeOnly === null) {
    const inForce = plans ? [plans.current, plans.previous].find((p) => p && p.week_start <= checkin.local_date) : null;
    observeOnly = Boolean(inForce && inForce.changes && inForce.changes.changed && inForce.source !== 'carry' && daysBetween(inForce.week_start, checkin.local_date) < 7);
  }
  const adh = { pct: checkin.adherence_pct ?? null };
  const adhPoint = adherencePoint(adh.pct);
  const weight = weightPoint({ weighins, period, mode, bands, units, observeOnly });
  const training = trainingPoint({ sessions, program, period, today: today || checkin.local_date });
  const body = bodyPoint({ measurements, checkin, phase, mode, units });
  const recovery = recoveryPoint(checkin, previousCheckin);
  const adherenceOk = adh.pct !== null && adh.pct >= ADHERENCE_MIN;
  const plan = planPoint({ plans, adherenceOk, dataOk: weight.count.enough, checkinDate: checkin.local_date, today: today || checkin.local_date });
  const v = verdict({ adh, weight, training, body, recovery, mode });
  return {
    checkin_id: checkin.id,
    week_of: checkin.local_date,
    period,
    visible_until: summaryVisibleUntil(checkin.local_date, prepDow),
    tone: v.tone,
    headline: v.headline,
    focus: v.focus,
    points: [adhPoint, weight.point, training.point, body, recovery, plan].filter(Boolean),
    days_since: today ? daysBetween(checkin.local_date, today) : 0,
  };
}
