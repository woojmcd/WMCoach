// Mode switch timing (spec §8.3), phase length and end conditions (spec §10),
// check-in window and adherence from daily on-plan taps (spec §4.3).
import { addDays, daysBetween, isoWeekday, formatDayMonth } from './time.js';

export const MODES = ['cut', 'maintenance', 'bulk'];
export const MODE_LABEL = { cut: 'Cut', maintenance: 'Maintenance', bulk: 'Bulk' };

// End conditions (spec §10).
export const END_RULES = {
  bulk: { max_days: 182, waist_gain_in: 1.5 },
  cut: { min_weeks: 8, max_weeks: 16 },
  maintenance: { min_weeks: 4, max_weeks: 8 },
};

// First prep day strictly after `today` (the current week's food is already locked).
export function nextPrepDay(today, prepDow) {
  const delta = ((prepDow - isoWeekday(today) + 7) % 7) || 7;
  return addDays(today, delta);
}

// What a mode change means right now (shown in the confirm sheet).
export function describeSwitch(from, to) {
  if (to === 'cut') return 'About 300–500 kcal under your current maintenance estimate, carbs first. CUT26-V4’s carb cycle (MP1 low / MP2 high) is the template.';
  if (from === 'cut' && to === 'maintenance') return 'Cardio drops first, then +100–150 kcal a week toward maintenance (13.2 kcal/lb).';
  if (to === 'bulk') return 'Maintenance + 150–200 kcal, grown from the plan you already prep.';
  return 'Intake moves toward the maintenance estimate in steps of 100–150 kcal a week.';
}

// The change record (saved to the log) and the pending state in settings.
// Flipping back to the current mode cancels a pending switch.
export function requestModeChange(settings, to, { now, today, tz, id, targets = null }) {
  const utc = now.toISOString();
  const from = settings.mode;
  const cancelling = to === from;
  if (cancelling && !settings.pending_mode) return null;
  if (!cancelling && settings.pending_mode && settings.pending_mode.to === to) return null;
  const effective = cancelling ? null : nextPrepDay(today, settings.prep_day);
  const change = {
    id, utc, local_date: today, tz,
    from, to, kind: cancelling ? 'cancel' : 'switch',
    effective_date: effective,
    targets: cancelling ? null : targets,
    updated_utc: utc,
  };
  const next = {
    ...settings,
    pending_mode: cancelling ? null : { to, effective_date: effective, change_id: id, targets },
    updated_utc: utc,
  };
  return { change, settings: next };
}

// On-device: once the effective prep day arrives, the pending mode becomes the
// mode, the open phase closes the day before and a new phase opens.
export function applyPendingMode(settings, phases, today, now) {
  const p = settings.pending_mode;
  if (!p || today < p.effective_date) return null;
  const utc = now.toISOString();
  const updates = [];
  for (const ph of phases) {
    if (ph.end !== null) continue;
    // A phase replaced on its very first day never really ran: keep it, marked superseded.
    if (ph.start < p.effective_date) updates.push({ ...ph, end: addDays(p.effective_date, -1), updated_utc: utc });
    else updates.push({ ...ph, end: ph.start, superseded: true, updated_utc: utc });
  }
  updates.push({
    id: `${p.to}-${p.effective_date}`, kind: p.to, label: `${MODE_LABEL[p.to]} ${p.effective_date.slice(0, 4)}`,
    start: p.effective_date, end: null, source: 'app', targets: p.targets || null, updated_utc: utc,
  });
  return {
    settings: { ...settings, mode: p.to, mode_since: p.effective_date, pending_mode: null, updated_utc: utc },
    phases: updates,
  };
}

export const realPhases = (phases) => phases.filter((p) => !p.superseded);

export function currentPhase(phases) {
  return realPhases(phases).filter((p) => p.end === null).sort((a, b) => (a.start < b.start ? 1 : -1))[0] || null;
}

// First measured waist on or after the phase start, and the latest one.
function waistSpan(measurements, start) {
  const ms = measurements.filter((m) => m.local_date >= start && m.avg && m.avg.waist).sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  if (!ms.length) return null;
  return { start: ms[0].avg.waist, latest: ms[ms.length - 1].avg.waist };
}

// Phase length, its end condition in words, and whether it has been met.
export function phaseStatus(phase, { today, measurements = [], trendLb = null }) {
  if (!phase) return null;
  const days = daysBetween(phase.start, today) + 1;
  const week = Math.ceil(days / 7);
  const base = { kind: phase.kind, days, week, met: false, reason: null };
  if (phase.kind === 'bulk') {
    const rule = END_RULES.bulk;
    const until = addDays(phase.start, rule.max_days);
    const w = waistSpan(measurements, phase.start);
    const gain = w ? Math.round((w.latest - w.start) * 10) / 10 : null;
    const untilText = `${formatDayMonth(until)} ${until.slice(0, 4)}`;
    const endText = w
      ? `~6 months (to ${untilText}) or waist +${rule.waist_gain_in} in (now ${gain >= 0 ? '+' : ''}${gain} in)`
      : `~6 months (to ${untilText}) or waist +${rule.waist_gain_in} in over the start`;
    if (days > rule.max_days) return { ...base, endText, until, met: true, reason: 'The bulk has run ~6 months.' };
    if (gain !== null && gain >= rule.waist_gain_in) return { ...base, endText, until, met: true, reason: `Waist is +${gain} in since the bulk started.` };
    return { ...base, endText, until, waistGain: gain };
  }
  if (phase.kind === 'cut') {
    const rule = END_RULES.cut;
    const t = phase.targets || {};
    const targetText = [t.weight_lb ? `${t.weight_lb} lb` : null, t.waist_in ? `waist ${t.waist_in} in` : null].filter(Boolean).join(' or ');
    const endText = `${rule.min_weeks}–${rule.max_weeks} weeks${targetText ? `, or ${targetText}` : ''}`;
    if (week > rule.max_weeks) return { ...base, endText, met: true, reason: `The cut has run ${rule.max_weeks} weeks.` };
    if (t.weight_lb && trendLb !== null && trendLb <= t.weight_lb) return { ...base, endText, met: true, reason: `Trend weight reached the ${t.weight_lb} lb target.` };
    const w = waistSpan(measurements, phase.start);
    if (t.waist_in && w && w.latest <= t.waist_in) return { ...base, endText, met: true, reason: `Waist reached the ${t.waist_in} in target.` };
    return { ...base, endText };
  }
  if (phase.kind === 'maintenance') {
    const rule = END_RULES.maintenance;
    const endText = `${rule.min_weeks}–${rule.max_weeks} weeks between phases`;
    if (week > rule.max_weeks) return { ...base, endText, met: true, reason: `Maintenance has run ${rule.max_weeks} weeks.` };
    return { ...base, endText };
  }
  return { ...base, endText: '' };
}

export function suggestedNextMode(kind) {
  return kind === 'maintenance' ? null : 'maintenance';
}

// The check-in this week is due on the most recent check-in weekday (≤ today).
export function checkinDueDate(today, checkinDow) {
  return addDays(today, -((isoWeekday(today) - checkinDow + 7) % 7));
}

// Card shows from check-in day for 3 days (Fri–Sun by default) until done.
export function checkinState(today, checkinDow, checkins, { windowDays = 3 } = {}) {
  const due = checkinDueDate(today, checkinDow);
  const done = checkins.filter((c) => c.local_date >= due).sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0] || null;
  const open = daysBetween(due, today) < windowDays;
  return { due, done, open, late: open && today > due };
}

// Adherence from daily on-plan taps over the 7 days ending `end`: Yes 100, Partial 50, Off 0.
const TAP_SCORE = { yes: 100, partial: 50, off: 0 };
export function adherenceFromTaps(taps, end, days = 7) {
  const start = addDays(end, -(days - 1));
  const byDate = new Map();
  for (const t of taps) {
    if (t.local_date < start || t.local_date > end || !(t.status in TAP_SCORE)) continue;
    const prev = byDate.get(t.local_date);
    if (!prev || (t.updated_utc || '') > (prev.updated_utc || '')) byDate.set(t.local_date, t);
  }
  const scores = [...byDate.values()].map((t) => TAP_SCORE[t.status]);
  if (!scores.length) return { pct: null, tapped: 0, days };
  return { pct: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), tapped: scores.length, days };
}
