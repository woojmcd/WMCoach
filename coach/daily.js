// Daily executive summary (Walter, 2026-10-13): each morning, how yesterday went and
// what to focus on today. Same voice as the weekly review (coach/summary.js): the
// numbers first, no softening, always what went well, then one thing to do.
//
// Yesterday = the local day before the run. Its training, cardio, food tap and
// weigh-in come from the phone's log and Strava; "last night" (sleep, resting HR)
// and yesterday's steps come from this morning's Health file. Pure: the daily run
// computes it into data/targets/today.json and the phone shows it on the Week tab.
import { addDays, isoWeekday, weekDates, formatDayMonth, WEEKDAYS } from './time.js';
import { historyFor } from './progression.js';
import { dayForWeekday } from './program.js';
import { cardioItems, cardioForDay, itemText, runBaseline, runPaceToday } from './cardio.js';
import { planKcalByDate } from './tdee.js';

export const DAILY_SCHEMA = 1;
const LB_TO_KG = 0.45359237;
const TONE_RANK = { good: 0, info: 0, warn: 1, bad: 2 };
const SLEEP_SHORT_H = 6; // spec §6.3
const SLEEP_GOOD_H = 7;
const WEIGHINS_MIN = 5;
const live = (xs) => (xs || []).filter((x) => x && !x.deleted);
const sgn = (v, d) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const kcalText = (k) => `${Math.round(k).toLocaleString('en-US')} kcal`;
const dayLabel = (d) => `${WEEKDAYS[isoWeekday(d) - 1]} ${formatDayMonth(d)}`;

// Best set by how the load works: external load by estimated 1RM; assistance by the
// least help (then reps); bodyweight-only by total reps. → { score, load, reps } or null.
const JUDGED = new Set(['work', 'top', 'amrap']);
function bestSet(entry, loadKind) {
  const sets = (entry ? entry.sets : []).filter((x) => x.done && JUDGED.has(x.kind) && Number.isFinite(x.reps));
  if (!sets.length) return null;
  if (loadKind === 'assistance') {
    const b = [...sets].filter((x) => Number.isFinite(x.load)).sort((a, c) => a.load - c.load || c.reps - a.reps)[0];
    return b ? { score: -b.load * 1000 + b.reps, load: b.load, reps: b.reps, assist: true } : null;
  }
  const loaded = e1rm({ sets });
  if (loaded) return { score: loaded.e1rm, load: loaded.load, reps: loaded.reps };
  const reps = sets.reduce((a, x) => a + (x.reps || 0), 0);
  return { score: reps, load: null, reps, total: true };
}

function e1rm(entry) {
  let best = null;
  for (const s of entry.sets) {
    if (!Number.isFinite(s.load) || s.load <= 0) continue;
    const e = s.load * (1 + s.reps / 30);
    if (!best || e > best.e1rm) best = { e1rm: e, load: s.load, reps: s.reps };
  }
  return best;
}

// ---- training ------------------------------------------------------------------------------

export function trainingDay({ date, program, sessions, activities = [], programStart = null }) {
  if (!program) return null;
  const day = dayForWeekday(program, isoWeekday(date));
  const logged = live(sessions).filter((s) => s.local_date === date && s.status !== 'draft');
  const stravaLift = activities.find((a) => a.local_date === date && a.type === 'WeightTraining') || null;
  if (!logged.length) {
    if (!day || !day.exercises.length) return null; // open day: nothing to judge
    if (!programStart || date < programStart) return null; // before the first logged session
    if (stravaLift) {
      const min = Math.round((stravaLift.duration_s || 0) / 60);
      return {
        state: 'unlogged', day,
        point: { key: 'training', tone: 'bad', title: 'Training', text: `${day.name}: Strava shows a ${min}-min lift, but no sets were logged in the app, so it can’t count toward progression. Next ${WEEKDAYS[isoWeekday(date) - 1]} starts from the same targets.` },
      };
    }
    return {
      state: 'missed', day,
      point: { key: 'training', tone: 'bad', title: 'Training', text: `${day.name} wasn’t logged. If you trained, it doesn’t count until it’s in the app; if you skipped it, move it to the weekend rather than lose it.` },
    };
  }
  const s = logged[logged.length - 1];
  const slots = Object.fromEntries(program.days.flatMap((d) => d.exercises).map((x) => [x.id, x]));
  let done = 0; let total = 0;
  const up = []; const down = []; const base = [];
  for (const e of s.exercises) {
    if (e.skipped) continue;
    for (const x of e.sets) { if (x.skipped) continue; total += 1; if (x.done) done += 1; }
    if (e.type === 'timed' || !e.sets.some((x) => x.done)) continue;
    const hist = historyFor(sessions, e.slot_id, e.movement);
    const idx = hist.map((h) => h.local_date === date).lastIndexOf(true);
    if (idx < 0) continue;
    const kind = (slots[e.slot_id] || {}).load_kind;
    const cur = bestSet(hist[idx], kind);
    const prevEntry = [...hist.slice(0, idx)].reverse().find((h) => !h.deload) || null;
    const prev = prevEntry ? bestSet(prevEntry, kind) : null;
    if (!cur) continue;
    if (!prev) { base.push(e.name); continue; }
    // e1RM moves ±1 % before it counts; assistance and rep totals count any change
    const ch = cur.assist || cur.total || prev.total ? Math.sign(cur.score - prev.score) : (cur.score - prev.score) / prev.score;
    if (ch > 0.01 || ((cur.assist || cur.total) && ch > 0)) up.push({ name: e.name, cur, prev });
    else if (ch < -0.01 || ((cur.assist || cur.total) && ch < 0)) down.push({ name: e.name, cur, prev });
  }
  const missingSets = total - done;
  const one = (x) => (x.total ? `${x.reps} reps` : x.assist ? `${x.load} assist × ${x.reps}` : `${x.load}×${x.reps}`);
  const fmt = (l) => `${l.name} ${one(l.cur)} (was ${one(l.prev)})`;
  const parts = [`${s.day_name}: ${done} of ${plural(total, 'set')} logged${s.auto_finished ? ' (closed automatically the next morning)' : ''}.`];
  if (s.deload) parts.push('Deload: lighter on purpose, so it isn’t judged on strength.');
  else {
    if (up.length) parts.push(`Beat last time on ${up.length}: ${up.slice(0, 3).map(fmt).join('; ')}${up.length > 3 ? `; and ${up.length - 3} more` : ''}.`);
    if (down.length) parts.push(`Below last time: ${down.map((l) => l.name).join(', ')}.`);
    if (base.length) parts.push(`${plural(base.length, 'baseline')} set (first time logged): next time they get real targets.`);
  }
  if (missingSets) parts.push(`${plural(missingSets, 'set')} not logged: ${missingSets === total ? 'nothing' : 'those'} can’t drive the next targets.`);
  let tone = 'good';
  if (!done) tone = 'bad';
  else if (missingSets / total > 0.2 || (!s.deload && down.length > up.length)) tone = 'warn';
  return {
    state: done ? 'logged' : 'empty', day, session: s, done, total, missingSets, up, down, base,
    point: { key: 'training', tone, title: 'Training', text: parts.join(' ') },
  };
}

// ---- cardio --------------------------------------------------------------------------------

function hrNote(item, hr) {
  if (!hr || !Number.isFinite(item.avg_hr)) return '';
  if (item.avg_hr > hr.hi) return ` Average HR ${item.avg_hr}: above your Zone 2 (${hr.lo}–${hr.hi}), so a hard session rather than easy cardio.`;
  if (item.avg_hr >= hr.lo) return ` Average HR ${item.avg_hr}: in Zone 2.`;
  return ` Average HR ${item.avg_hr}: easy.`;
}

export function cardioDay({ date, rx, activities = [], stairs = [], hr = null }) {
  if (!rx) return null;
  const wk = weekDates(date);
  const items = cardioItems({ activities, stairs, from: wk[0], to: wk[6] });
  const c = cardioForDay({ rx, date, items, hr });
  const todays = items.filter((i) => i.local_date === date);
  const week = `Week so far: ${c.week.done_sessions} of ${c.week.target_sessions} sessions.`;
  const did = todays.map((i) => `${itemText(i)}.${hrNote(i, hr)}`).join(' ');
  const t = c.today;
  if (t && t.status === 'done') return { state: 'done', point: { key: 'cardio', tone: 'good', title: 'Cardio', text: `Prescribed ${t.minutes} min${t.makeup ? ' make-up' : ''} cardio: done. ${did} ${week}` } };
  if (t && !t.optional) {
    const short = c.week.target_sessions - c.week.done_sessions;
    const next = isoWeekday(date) === 7 ? `The week ended ${plural(short, 'session')} short.` : 'It moves to the next free day.';
    return { state: 'missed', minutes: t.minutes, point: { key: 'cardio', tone: 'warn', title: 'Cardio', text: `Prescribed ${t.minutes} min easy stairs: not done${todays.length ? ` (only ${todays.map(itemText).join(', ')})` : ''}. ${week} ${next}` } };
  }
  if (todays.length) return { state: 'extra', point: { key: 'cardio', tone: 'good', title: 'Cardio', text: `Extra: ${did} ${week}` } };
  return null;
}

// ---- food, weight, recovery ----------------------------------------------------------------

export function foodDay({ date, taps = [], plans = [] }) {
  const tap = live(taps).filter((t) => t.local_date === date).sort((a, b) => ((a.updated_utc || '') < (b.updated_utc || '') ? -1 : 1)).pop() || null;
  const kcal = planKcalByDate(plans, date, date).get(date) ?? null;
  const planText = kcal ? ` (${kcalText(kcal)})` : '';
  if (!tap) return { state: 'none', point: { key: 'food', tone: 'warn', title: 'Food', text: 'Not logged. Tap “On plan” on the Body tab every day; without it the coach can’t tell a plan that isn’t working from a plan that wasn’t followed.' } };
  if (tap.status === 'yes') return { state: 'yes', point: { key: 'food', tone: 'good', title: 'Food', text: `On plan${planText}.` } };
  if (tap.status === 'partial') return { state: 'partial', point: { key: 'food', tone: 'warn', title: 'Food', text: `Partly on plan${Number.isFinite(tap.kcal) ? `: about ${kcalText(tap.kcal)}${kcal ? ` vs ${kcalText(kcal)} planned` : ''}` : planText}.` } };
  return { state: 'off', point: { key: 'food', tone: 'warn', title: 'Food', text: 'Off plan. That day is left out of the expenditure estimate, so the macros learn nothing from it. If you meant to tap something else, change it on the Body tab.' } };
}

export function weightDay({ date, weighins = [], series = [], units = 'lb' }) {
  const kg = units === 'kg';
  const w = (lb) => (kg ? lb * LB_TO_KG : lb);
  const u = kg ? 'kg' : 'lb';
  const days = new Set(live(weighins).filter((x) => x.local_date > addDays(date, -7) && x.local_date <= date).map((x) => x.local_date));
  const entry = live(weighins).filter((x) => x.local_date === date).pop() || null;
  if (!entry) {
    return { state: 'none', count: days.size, point: { key: 'weight', tone: 'warn', title: 'Weight', text: `No weigh-in (${days.size} of the last 7 days). The trend needs ${WEIGHINS_MIN}+ a week: every morning, after the bathroom, before food.` } };
  }
  const t = series.find((x) => x.date === date);
  const t7 = series.filter((x) => x.date <= addDays(date, -7)).pop();
  const trend = t ? ` Trend ${w(t.trend).toFixed(1)} ${u}${t7 && t7.date >= addDays(date, -10) ? ` (${sgn(w(t.trend - t7.trend), 1)} ${u} in a week)` : ''}.` : '';
  const few = days.size < WEIGHINS_MIN ? ` ${days.size} of the last 7 days: keep going daily.` : '';
  return { state: 'yes', count: days.size, point: { key: 'weight', tone: 'good', title: 'Weight', text: `${w(entry.weight_lb).toFixed(1)} ${u}.${trend}${few}` } };
}

export function recoveryNight({ health = null, readiness = null, mode = 'bulk', stepFloor = 8000 }) {
  const h = health;
  const has = h && [h.sleep_h, h.resting_hr, h.hrv_ms].some(Number.isFinite);
  if (!has) return { state: 'none', point: { key: 'recovery', tone: 'warn', title: 'Recovery', text: 'No recovery data from this morning’s Health sync. If the chip shows on the Log tab, tap Sync Health.' } };
  const parts = [];
  let tone = 'good';
  if (Number.isFinite(h.sleep_h)) {
    const short = h.sleep_h < SLEEP_SHORT_H;
    if (short) tone = 'warn';
    parts.push(`${h.sleep_h.toFixed(1)} h sleep${short ? ', under 6 h' : h.sleep_h >= SLEEP_GOOD_H ? '' : ', a bit short of 7'}.`);
  } else if (Number.isFinite(h.sleep_unsettled)) {
    tone = 'warn';
    parts.push(`Sleep read ${h.sleep_unsettled.toFixed(1)} h, which means the sync ran while Oura was still writing the night: run WMCoach Health Resync.`);
  }
  if (Number.isFinite(h.resting_hr)) {
    const b = readiness && readiness.baseline ? readiness.baseline.resting_hr : null;
    if (b) {
      const d = Math.round(h.resting_hr - b);
      if (d >= 5) tone = 'warn';
      parts.push(`Resting HR ${Math.round(h.resting_hr)} (${d === 0 ? 'right on' : `${sgn(d, 0)} vs`} your ${b} average${d >= 5 ? ': a sign of fatigue or something coming on' : ''}).`);
    } else parts.push(`Resting HR ${Math.round(h.resting_hr)} (your average builds over the first few nights).`);
  }
  if (Number.isFinite(h.hrv_ms)) parts.push(`HRV ${Math.round(h.hrv_ms)} ms.`);
  if (Number.isFinite(h.steps)) {
    const under = mode === 'cut' && h.steps < stepFloor;
    if (under) tone = 'warn';
    parts.push(`${Math.round(h.steps).toLocaleString('en-US')} steps yesterday${under ? `, under the ${stepFloor.toLocaleString('en-US')} floor` : ''}.`);
  }
  if (readiness && !readiness.missing) {
    if (readiness.status === 'red') tone = 'bad';
    else if (readiness.status === 'amber' && tone === 'good') tone = 'warn';
    parts.push(`Readiness ${readiness.status}${readiness.status === 'green' ? '' : ` (${readiness.reason})`}.`);
  }
  return { state: 'ok', sleep: h.sleep_h, point: { key: 'recovery', tone, title: 'Last night', text: parts.join(' ') } };
}

// ---- today ---------------------------------------------------------------------------------

// One line on today's plan: the session, its headline targets, and the cardio.
export function todayLine({ day = null, planned = [], deload = false, readiness = null, cardio = null }) {
  const parts = [];
  if (day && day.exercises.length) {
    const ups = planned.filter((p) => p.target.change === 'up' && !p.target.calibration);
    const calib = planned.filter((p) => p.target.calibration).length;
    let s = `${day.name}${deload ? ' (deload)' : ''}`;
    const bits = [];
    if (ups.length) {
      bits.push(`up on ${ups.slice(0, 2).map((p) => { const f = p.target.sets[0] || {}; return `${p.name} ${p.target.load} lb × ${f.aim ?? f.reps_min}`; }).join(', ')}${ups.length > 2 ? ` +${ups.length - 2} more` : ''}`);
    }
    if (calib) bits.push(`${calib} to calibrate (log the weight you use)`);
    if (readiness && (readiness.status === 'amber' || readiness.status === 'red')) bits.push(readiness.status === 'red' ? 'loads held, one set fewer' : 'loads held');
    if (bits.length) s += `: ${bits.join('; ')}`;
    parts.push(`${s}.`);
  } else parts.push('Open day.');
  const t = cardio && cardio.today;
  if (t) {
    const hr = t.hr ? ` at ${t.hr.lo}–${t.hr.hi} bpm` : '';
    parts.push(`Cardio: ${t.minutes} min ${t.kind === 'walk' ? 'easy walk' : 'stairs'}${hr}${t.makeup ? ' (make-up)' : ''}${t.optional ? ', optional' : ''}.`);
  }
  return parts.join(' ');
}

// ---- headline and focus --------------------------------------------------------------------

function verdict({ training, cardio, food, weight, recovery, readiness, todayCardio }) {
  const issues = [];
  if (readiness && readiness.status === 'red') issues.push({ tone: 'bad', head: `Recovery is red this morning (${readiness.reason}).`, focus: 'Take today easier: loads are held with one set fewer, cardio is an easy walk, and get to bed early tonight.' });
  if (training && training.state === 'missed') issues.push({ tone: 'bad', head: `${training.day.name} wasn’t logged.`, focus: 'Log every set today as you go: the next targets come only from the logbook.' });
  if (training && (training.state === 'unlogged' || training.state === 'empty')) issues.push({ tone: 'bad', head: 'Yesterday’s lift wasn’t logged.', focus: 'Log every set today as you go: unlogged sessions don’t move your targets.' });
  if (training && training.state === 'logged' && training.missingSets / training.total > 0.2) issues.push({ tone: 'warn', head: `Only ${training.done} of ${training.total} sets were logged.`, focus: 'Log each set right after you finish it: the targets come from the logbook.' });
  if (food && food.state === 'none') issues.push({ tone: 'warn', head: 'Food wasn’t logged.', focus: 'Eat the plan and tap “On plan” before bed.' });
  if (food && food.state === 'off') issues.push({ tone: 'warn', head: 'You were off plan.', focus: 'Back on the prepped meals today, and tap “On plan” before bed.' });
  if (food && food.state === 'partial') issues.push({ tone: 'warn', head: 'You were only partly on plan.', focus: 'Eat every prepped meal today; no extras.' });
  if (weight && weight.state === 'none') issues.push({ tone: 'warn', head: 'No weigh-in.', focus: 'Weigh in this morning: after the bathroom, before food.' });
  if (recovery && recovery.state === 'ok' && Number.isFinite(recovery.sleep) && recovery.sleep < SLEEP_SHORT_H) issues.push({ tone: 'warn', head: `Short night (${recovery.sleep.toFixed(1)} h).`, focus: 'Lights out early tonight: 7+ hours is the cheapest recovery there is.' });
  if (cardio && cardio.state === 'missed') issues.push({ tone: 'warn', head: 'The prescribed cardio was missed.', focus: todayCardio && todayCardio.today ? `Get today’s ${todayCardio.today.minutes} min in after lifting.` : 'Fit it in on the next free day.' });
  const sleepOnly = readiness && (readiness.flags || []).length && readiness.flags.every((f) => f.key === 'sleep');
  const saidSleep = issues.some((i) => i.head.startsWith('Short night'));
  if (readiness && readiness.status === 'amber' && !(sleepOnly && saidSleep)) issues.push({ tone: 'warn', head: `Readiness is amber (${readiness.reason}).`, focus: 'Loads are held today: beat the reps, not the weight, and keep cardio truly easy.' });

  const wins = [];
  if (training && training.state === 'logged' && !training.missingSets) wins.push('every set logged');
  if (training && training.up && training.up.length) wins.push(`${plural(training.up.length, 'lift')} beat last time`);
  if (cardio && (cardio.state === 'done' || cardio.state === 'extra')) wins.push('cardio done');
  if (food && food.state === 'yes') wins.push('on plan');
  if (weight && weight.state === 'yes') wins.push('weighed in');
  if (recovery && recovery.state === 'ok' && Number.isFinite(recovery.sleep) && recovery.sleep >= SLEEP_GOOD_H) wins.push(`${recovery.sleep.toFixed(1)} h sleep`);
  const winText = wins.slice(0, 3).join(', ');
  if (!issues.length) {
    return { tone: 'good', headline: winText ? `Good day: ${winText}.` : 'Nothing to fix.', focus: 'Same again today: hit the plan and beat the logbook.' };
  }
  const tone = issues.reduce((t, i) => (TONE_RANK[i.tone] > TONE_RANK[t] ? i.tone : t), 'good');
  const also = issues.slice(1, 3).map((i) => i.head.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()));
  const headline = `${issues[0].head}${also.length ? ` Also: ${also.join('; ')}.` : ''}${winText ? ` Good: ${winText}.` : ''}`;
  return { tone, headline, focus: issues[0].focus };
}

// The whole summary. `date` is yesterday; health is { date: normalized Health file }.
export function dailySummary({
  date, today = addDays(date, 1), program = null, sessions = [], programStart = null, activities = [], stairs = [],
  health = {}, readiness = null, weighins = [], series = [], taps = [], plans = [], rx = null, hr = null,
  runZones = null, mode = 'bulk', units = 'lb', stepFloor = 8000, todayPlan = {},
}) {
  const training = trainingDay({ date, program, sessions, activities, programStart });
  const cardio = cardioDay({ date, rx, activities, stairs, hr });
  // today's 3-mile pace from his baseline and this morning's readiness (Walter, 2026-10-13)
  const pace = runPaceToday({ baseline: runBaseline({ activities, runZones, date }), readiness, hr });
  const cardioPoint = cardio
    ? { ...cardio.point, text: `${cardio.point.text} ${pace.text}` }
    : { key: 'cardio', tone: 'info', title: 'Cardio', text: `Nothing prescribed or done. ${pace.text}` };
  const food = foodDay({ date, taps, plans });
  const weight = weightDay({ date, weighins, series, units });
  const recovery = recoveryNight({ health: health[today] || null, readiness, mode, stepFloor });
  const v = verdict({ training, cardio, food, weight, recovery, readiness, todayCardio: todayPlan.cardio });
  return {
    schema_version: DAILY_SCHEMA,
    date,
    label: dayLabel(date),
    tone: v.tone,
    headline: v.headline,
    focus: v.focus,
    today: todayLine({ ...todayPlan, readiness }),
    // order (Walter, 2026-10-13): last night first, then weight, training, cardio, food
    points: [recovery.point, weight.point, training && training.point, cardioPoint, food.point].filter(Boolean),
    pace: { kind: pace.kind, lo: pace.lo, hi: pace.hi },
  };
}
