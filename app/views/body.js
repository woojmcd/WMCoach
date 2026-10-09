// Body tab (spec §4.3), top to bottom: mode switch, daily weight, Friday
// measurements + check-in, trend graph, "On plan today?".
import { h, icon, toast, openSheet, segmented, chips, stepper } from '../ui.js';
import { header, sectionLabel, healthChip } from './common.js';
import { remoteState, healthMissing } from '../remote.js';
import { getAll, getMeta, put } from '../db.js';
import { saveDaily, removeRecord, live } from '../records.js';
import { newId } from '../seed.js';
import { exportFlow } from '../import-flow.js';
import { trendChart } from '../chart.js';
import { trendFromEntries, rateOverDays, rateStatus } from '../../coach/trend.js';
import { SITES, siteAverages, navyBodyFat } from '../../coach/body.js';
import {
  MODES, MODE_LABEL, describeSwitch, requestModeChange, currentPhase, phaseStatus, checkinState, adherenceFromTaps, realPhases,
} from '../../coach/phase.js';
import {
  addDays, daysBetween, formatDayMonth, formatLong, isoWeekday, isoWeekId, WEEKDAYS,
} from '../../coach/time.js';

const RANGES = { '4w': 28, '12w': 84, all: null };
// Same values as the seeded model (brief §5); used only if the model record is missing.
const DEFAULT_BANDS = { cut: { target: [-0.75, -0.5], slow_limit: -0.4, cap: -1.0 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };
const BIO = [
  { key: 'hunger', label: 'Hunger', hint: '5 = in control' },
  { key: 'energy', label: 'Energy', hint: '5 = high' },
  { key: 'sleep', label: 'Sleep', hint: '5 = great' },
  { key: 'stress', label: 'Stress', hint: '5 = calm' },
  { key: 'digestion', label: 'Digestion', hint: '5 = great' },
];

// View state that survives re-renders while the app is open.
const ui = { weightDate: null, forceCheckin: false, focusCheckin: false, showTable: false, range: pref('wm.range', '12w'), overlay: pref('wm.overlay', 'none') };

// Called from the Week tab's check-in banner: open Body with the card open and in view.
export function focusCheckin() {
  ui.forceCheckin = true;
  ui.focusCheckin = true;
}

function pref(key, fallback) {
  try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

const dayText = (date, today) => {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${formatDayMonth(date)}`;
};
const signed = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

export async function render(screen, ctx) {
  const { db } = ctx;
  const s = ctx.settings;
  const today = ctx.today();
  const tz = ctx.tz();
  if (!ui.weightDate || ui.weightDate > today) ui.weightDate = today;

  const [wAll, phasesAll, mAll, cAll, tAll, model, lastExport, remote] = await Promise.all([
    getAll(db, 'weighins'), getAll(db, 'phases'), getAll(db, 'measurements'), getAll(db, 'checkins'), getAll(db, 'adherence'),
    getMeta(db, 'model'), getMeta(db, 'last_export'), remoteState(db),
  ]);
  const weighins = live(wAll);
  const phases = realPhases(phasesAll);
  const measurements = live(mAll).sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  const checkins = live(cAll);
  const taps = live(tAll);
  const series = trendFromEntries(weighins);
  const lastTrend = series[series.length - 1] || null;
  const rate = rateOverDays(series, today, 14);
  const bands = (model && model.rate_bands_pct_bw_per_wk) || DEFAULT_BANDS;
  const phase = currentPhase(phases);
  const status = phaseStatus(phase, { today, measurements, trendLb: lastTrend ? lastTrend.trend : null });
  const ci = checkinState(today, s.checkin_day, checkins);

  screen.append(header({ label: formatLong(today).replace(/ \d{4}$/, ''), title: 'Body' }));

  // ---- banners -------------------------------------------------------------------------
  const banners = h('div', { class: 'stack-sm', style: 'margin-bottom:16px' });
  if (status && status.met && !s.pending_mode) {
    const next = phase.kind === 'maintenance' ? null : 'maintenance';
    banners.append(h('div', { class: 'banner' },
      h('span', { class: 'grow' }, `${status.reason} ${next ? `Consider switching to ${MODE_LABEL[next]}.` : 'Pick the next phase below.'}`),
      next ? h('button', { type: 'button', class: 'btn small outline', onClick: () => confirmModeChange(ctx, next, { measurements }) }, 'Switch') : null));
  }
  const exportAge = lastExport ? daysBetween(lastExport.local_date, today) : Infinity;
  if (ci.done && ci.open && exportAge >= 6) {
    banners.append(h('div', { class: 'banner' },
      h('span', { class: 'accent' }, icon('share', { size: 20 })),
      h('span', { class: 'grow' }, 'Back up this week?'),
      h('button', { type: 'button', class: 'btn small primary', onClick: () => exportFlow(ctx) }, 'Export')));
  }
  if (banners.childElementCount) screen.append(banners);

  screen.append(
    modeCard(ctx, { phase, status, model, measurements }),
    sectionLabel('Weight'),
    ...(healthMissing(remote, today) ? [h('div', { class: 'chip-row' }, healthChip(), h('span', { class: 'muted xsmall' }, 'Today’s Health data isn’t in yet.'))] : []),
    weightCard(ctx, { weighins, today, tz, lastTrend }));

  // Entry point under Weight: a filled button while the check-in is due (Walter
  // asked for it to look like the weight Update button), a gold link otherwise.
  const openCheckin = () => { ui.forceCheckin = true; ui.focusCheckin = true; ctx.refresh(); };
  if (ui.forceCheckin) {
    screen.append(h('div', { id: 'checkin' }, sectionLabel(ci.late && !ci.done ? `Measurements & check-in · due ${dayText(ci.due, today)}` : 'Measurements & check-in')),
      checkinCard(ctx, { ci, today, tz, measurements, checkins, taps }));
  } else if (ci.open && !ci.done) {
    screen.append(h('div', { class: 'stack-sm', style: 'margin-top:16px' },
      h('button', { type: 'button', class: 'btn primary block', onClick: openCheckin }, icon('body', { size: 20 }), 'Log measurements & check-in'),
      h('p', { class: 'muted xsmall center', style: 'margin:0' }, ci.late ? `Was due ${dayText(ci.due, today)} · takes about 5 minutes` : 'Due today · fasted, after the weigh-in')));
  } else if (ci.done && ci.open) {
    screen.append(h('div', { id: 'checkin' }, sectionLabel('Measurements & check-in')), checkinSummary(ctx, ci.done, measurements));
  } else {
    screen.append(h('div', { class: 'center', style: 'margin-top:8px' },
      h('button', { type: 'button', class: 'link-btn', onClick: openCheckin },
        ci.done ? 'Edit this week’s measurements & check-in' : `Log measurements & check-in (due ${WEEKDAYS[s.checkin_day - 1]})`)));
  }

  screen.append(sectionLabel('Trend'), trendCard(ctx, { series, phases, measurements, rate, bands, today, lastTrend }));
  screen.append(sectionLabel('On plan today?'), onPlanCard(ctx, { taps, today, tz }));
  if (ui.focusCheckin) {
    ui.focusCheckin = false;
    setTimeout(scrollToCheckin, 60); // after the shell has placed this screen
  }
}

function scrollToCheckin() {
  const el = document.getElementById('checkin');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- 1. mode switch -------------------------------------------------------------------------

function modeCard(ctx, { phase, status, model, measurements }) {
  const s = ctx.settings;
  const seg = segmented(MODES.map((m) => ({ value: m, label: MODE_LABEL[m] })), s.mode, (to) => {
    if (to === s.mode && !s.pending_mode) return;
    confirmModeChange(ctx, to, { measurements });
  }, { label: 'Mode' });
  const lines = [];
  if (status) {
    lines.push(h('div', { class: 'item' }, h('span', { class: 'grow' }, `${MODE_LABEL[phase.kind] || 'Phase'} · week ${status.week}`), h('span', { class: 'value' }, `since ${formatDayMonth(phase.start)}`)));
    if (status.endText) lines.push(h('div', { class: 'item' }, h('span', { class: 'grow muted small' }, `Ends: ${status.endText}`)));
  }
  const obs = model && model.observe_only;
  if (obs && ctx.today() < addDays(obs.since, obs.min_days)) {
    lines.push(h('div', { class: 'item' }, h('span', { class: 'grow muted small' }, `Macros observe-only until ${formatDayMonth(addDays(obs.since, obs.min_days))} and ${obs.min_new_weighins} new weigh-ins`)));
  }
  if (s.pending_mode) {
    const p = s.pending_mode;
    lines.push(h('div', { class: 'item' },
      h('span', { class: 'grow accent' }, `${MODE_LABEL[p.to]} starts ${WEEKDAYS[isoWeekday(p.effective_date) - 1]} ${formatDayMonth(p.effective_date)}`),
      h('button', { type: 'button', class: 'link-btn', style: 'padding:0', onClick: () => confirmModeChange(ctx, s.mode, { measurements }) }, 'Undo')));
  }
  return h('div', { class: 'stack-sm' }, seg, lines.length ? h('div', { class: 'card flush list' }, lines) : null);
}

function confirmModeChange(ctx, to, { measurements }) {
  const s = ctx.settings;
  const today = ctx.today();
  const cancelling = to === s.mode;
  if (!cancelling && s.pending_mode && s.pending_mode.to === to) {
    toast(`${MODE_LABEL[to]} already starts ${formatDayMonth(s.pending_mode.effective_date)}`);
    ctx.refresh();
    return;
  }
  let targetWeight = null;
  let targetWaist = null;
  const body = h('div', { class: 'stack' });
  if (cancelling) {
    body.append(h('p', { class: 'muted body', style: 'margin:8px 0 0' }, `Cancel the switch to ${MODE_LABEL[s.pending_mode.to]}. Nothing changes.`));
  } else {
    const probe = requestModeChange(s, to, { now: new Date(), today, tz: ctx.tz(), id: 'probe' });
    const eff = probe.change.effective_date;
    body.append(
      h('p', { class: 'body', style: 'margin:8px 0 0' }, `Starts ${formatLong(eff).replace(/ \d{4}$/, '')}, when the next plan locks. This week’s food stays as prepped.`),
      h('p', { class: 'muted small', style: 'margin:0' }, describeSwitch(s.mode, to)));
    if (to === 'cut') {
      const lastWaist = [...measurements].reverse().find((m) => m.avg && m.avg.waist);
      body.append(
        h('p', { class: 'label', style: 'margin-top:16px' }, 'Optional end targets (else 8–16 weeks)'),
        h('span', { class: 'muted small' }, 'Target trend weight'),
        stepper({ value: null, step: ctx.settings.units === 'kg' ? 0.5 : 1, min: 50, max: 400, decimals: 1, unit: ctx.unitLabel(), compact: true, label: 'Target weight', placeholder: '', onChange: (v) => { targetWeight = v; } }),
        h('span', { class: 'muted small' }, 'Target waist'),
        stepper({ value: null, step: ctx.lengthUnit() === 'cm' ? 0.5 : 0.25, min: 10, max: 150, decimals: ctx.lengthUnit() === 'cm' ? 1 : 2, unit: ctx.lengthUnit(), compact: true, label: 'Target waist', placeholder: lastWaist ? ctx.fmtLength(lastWaist.avg.waist) : '', onChange: (v) => { targetWaist = v; } }));
    }
  }
  let done = false;
  openSheet({
    title: cancelling ? `Stay on ${MODE_LABEL[to]}?` : `Switch to ${MODE_LABEL[to]}?`,
    body,
    actions: [
      {
        label: cancelling ? `Stay on ${MODE_LABEL[to]}` : `Switch to ${MODE_LABEL[to]}`,
        kind: 'primary',
        onClick: async () => {
          done = true;
          const targets = to === 'cut' && (targetWeight || targetWaist)
            ? { weight_lb: targetWeight ? Math.round(ctx.toLb(targetWeight) * 10) / 10 : null, waist_in: targetWaist ? Math.round(ctx.toIn(targetWaist) * 100) / 100 : null }
            : null;
          const r = requestModeChange(ctx.settings, to, { now: new Date(), today, tz: ctx.tz(), id: newId('mode'), targets });
          if (r) {
            await put(ctx.db, 'mode_changes', r.change);
            await ctx.saveSettings(r.settings);
            toast(cancelling ? `Staying on ${MODE_LABEL[to]}` : `${MODE_LABEL[to]} starts ${formatDayMonth(r.change.effective_date)}`);
          }
          ctx.refresh();
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
    onClose: () => { if (!done) ctx.refresh(); },
  });
}

// ---- 2. daily weight ----------------------------------------------------------------------

function weightCard(ctx, { weighins, today, tz, lastTrend }) {
  const date = ui.weightDate;
  const forDate = weighins.filter((w) => w.local_date === date && w.source !== 'history');
  const existing = forDate.find((w) => w.tz === tz) || null;
  const latest = [...weighins].sort((a, b) => (a.local_date < b.local_date ? -1 : 1)).pop();
  let value = existing ? Number(ctx.fmtWeight(existing.weight_lb)) : null;
  const field = stepper({
    value, step: ctx.settings.units === 'kg' ? 0.1 : 0.2, min: 40, max: 400, decimals: 1, unit: ctx.unitLabel(),
    placeholder: latest ? ctx.fmtWeight(latest.weight_lb) : '', label: 'Weight', onChange: (v) => { value = v; },
  });
  const dateInput = h('input', { type: 'date', max: today, value: date, 'aria-label': 'Weigh-in date' });
  dateInput.addEventListener('change', () => {
    if (dateInput.value && dateInput.value <= today) { ui.weightDate = dateInput.value; ctx.refresh(); }
  });
  const card = h('div', { class: 'card stack' });
  const save = h('button', {
    type: 'button', class: 'btn primary block',
    onClick: async () => {
      const v = field.getValue();
      if (!(v > 0)) { toast('Enter a weight first'); return; }
      const lb = Math.round(ctx.toLb(v) * 10) / 10;
      const { edited } = await saveDaily(ctx.db, 'weighins', {
        localDate: date, tz, prefix: 'w', editable: (r) => r.source === 'app',
        fields: { weight_lb: lb, source: 'app', backdated: date !== today },
      });
      card.classList.add('confirm-pop');
      toast(`${edited ? 'Updated' : 'Logged'} ${ctx.fmtWeight(lb)} ${ctx.unitLabel()} · ${dayText(date, today)}`);
      ui.weightDate = today; // a backdated entry is a one-off; come back to today
      setTimeout(() => ctx.refresh(), 220);
    },
  }, existing ? 'Update' : 'Log weight');
  card.append(
    h('div', { class: 'row between' },
      h('label', { class: 'date-chip' }, icon('week', { size: 16 }), dayText(date, today), dateInput),
      lastTrend ? h('span', { class: 'muted xsmall num' }, `Trend ${ctx.fmtWeight(lastTrend.trend)} ${ctx.unitLabel()}`) : null),
    field,
    save,
    h('p', { class: 'muted xsmall', style: 'margin:0' }, existing
      ? `Logged ${ctx.fmtWeight(existing.weight_lb)} ${ctx.unitLabel()}${date === today ? ' this morning' : ''}. Change it and tap Update.`
      : 'Morning, fasted, after the bathroom. Missed a day? Tap the date to backdate.'));
  return card;
}

// ---- 3 + 4. measurements and check-in ------------------------------------------------------

function checkinCard(ctx, { ci, today, tz, measurements, checkins, taps }) {
  const lenUnit = ctx.lengthUnit();
  const editing = ui.forceCheckin && ci.done ? ci.done : null;
  const editingM = editing && editing.measurement_id ? measurements.find((m) => m.id === editing.measurement_id) : null;
  const prev = [...measurements].filter((m) => !editingM || m.id !== editingM.id).pop() || null;
  const readings = {};
  const avgEls = {};
  const rows = SITES.map((site) => {
    const init = editingM && editingM.readings[site.key] ? editingM.readings[site.key] : [null, null];
    readings[site.key] = [...init];
    const avgEl = h('span', { class: 'avg' }, '');
    avgEls[site.key] = avgEl;
    const input = (i) => {
      const el = h('input', {
        class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'next',
        'aria-label': `${site.label} reading ${i + 1}`,
        placeholder: prev && prev.avg && prev.avg[site.key] ? ctx.fmtLength(prev.avg[site.key]) : '',
        value: init[i] ? ctx.fmtLength(init[i]) : '',
      });
      el.addEventListener('input', () => {
        const n = Number(el.value.replace(',', '.'));
        readings[site.key][i] = el.value.trim() && n > 0 ? ctx.toIn(n) : null;
        updateAvg(site.key);
      });
      return el;
    };
    return h('div', { class: 'site-row' }, h('span', { class: 'site' }, site.label), input(0), input(1), avgEl, h('small', { class: 'landmark' }, site.landmark));
  });
  function updateAvg(key) {
    const a = siteAverages({ [key]: readings[key] })[key];
    avgEls[key].textContent = a ? ctx.fmtLength(a) : '';
  }
  for (const { key } of SITES) updateAvg(key);

  const auto = adherenceFromTaps(taps, today);
  let adherence = editing ? editing.adherence_pct : auto.pct;
  const adherenceField = stepper({ value: adherence, step: 5, min: 0, max: 100, unit: '%', compact: true, label: 'Adherence this week', placeholder: '90', onChange: (v) => { adherence = v; } });
  const bio = editing ? { ...editing.biofeedback } : {};
  const save = h('button', { type: 'button', class: 'btn primary block' }, editing ? 'Update check-in' : 'Save check-in');
  const ready = () => { save.disabled = BIO.some((b) => !bio[b.key]); };
  const bioRows = BIO.map((b) => h('div', { class: 'bio-row' },
    h('span', {}, h('div', {}, b.label), h('div', { class: 'faint xsmall' }, b.hint)),
    chips([1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), bio[b.key] || null, (v) => { bio[b.key] = v; ready(); }, { label: b.label })));
  const note = h('textarea', { class: 'input', placeholder: 'Note (optional)', 'aria-label': 'Check-in note', value: editing && editing.note ? editing.note : '' });
  ready();

  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true;
    const now = new Date();
    const avg = siteAverages(readings);
    const anyReading = Object.values(avg).some((v) => v !== null);
    let measurementId = editingM ? editingM.id : null;
    if (anyReading) {
      const fields = { readings: Object.fromEntries(SITES.map(({ key }) => [key, readings[key].map((v) => (v ? Math.round(v * 100) / 100 : null))])), avg, unit: 'in' };
      if (editingM) {
        await put(ctx.db, 'measurements', { ...editingM, ...fields, updated_utc: now.toISOString() });
      } else {
        const r = await saveDaily(ctx.db, 'measurements', { localDate: today, tz, now, prefix: 'meas', fields });
        measurementId = r.record.id;
      }
    }
    const fields = {
      week: isoWeekId(ci.due), due_date: ci.due,
      adherence_pct: adherence, adherence_auto_pct: auto.pct, adherence_taps: auto.tapped,
      biofeedback: { ...bio }, note: note.value.trim() || null, measurement_id: measurementId,
    };
    if (editing) await put(ctx.db, 'checkins', { ...editing, ...fields, updated_utc: now.toISOString() });
    else await saveDaily(ctx.db, 'checkins', { localDate: today, tz, now, prefix: 'ci', fields });
    ui.forceCheckin = false;
    toast(editing ? 'Check-in updated' : 'Check-in saved');
    ctx.refresh();
  });

  return h('div', { class: 'card stack' },
    h('p', { class: 'muted small', style: 'margin:0' }, 'Fasted, after the weigh-in, before training. Tape snug, not compressing. Two readings per site; the app averages them.'),
    h('div', {},
      h('p', { class: 'label', style: 'margin:0 0 4px; color: var(--text)' }, 'Tape measurements'),
      h('div', { class: 'site-row site-head' }, h('span', {}, `Site (${lenUnit})`), h('span', {}, '1st'), h('span', {}, '2nd'), h('span', {}, 'Avg')),
      rows),
    h('p', { class: 'label', style: 'margin:8px 0 0; color: var(--text)' }, 'Check-in'),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Adherence this week'),
      adherenceField,
      h('p', { class: 'muted xsmall', style: 'margin:8px 0 0' }, auto.tapped
        ? `From ${auto.tapped} of 7 daily “On plan” taps (${auto.pct} %). Edit if it’s off.`
        : 'No daily “On plan” taps this week: enter your estimate.')),
    h('div', {}, h('span', { class: 'label' }, 'Biofeedback · 1 = poor, 5 = great'), bioRows),
    note,
    save,
    h('button', { type: 'button', class: 'btn ghost block', onClick: () => { ui.forceCheckin = false; ctx.refresh(); } }, 'Cancel'));
}

function checkinSummary(ctx, done, measurements) {
  const m = done.measurement_id ? measurements.find((x) => x.id === done.measurement_id) : null;
  const b = done.biofeedback || {};
  const vals = Object.values(b).filter(Boolean);
  const avgBio = vals.length ? (vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(1) : '–';
  return h('div', { class: 'card flush list' },
    h('div', { class: 'item' }, h('span', { class: 'accent' }, icon('check', { size: 20 })), h('span', { class: 'grow' }, `Done · ${formatDayMonth(done.local_date)}`),
      h('button', { type: 'button', class: 'link-btn', style: 'padding:0', onClick: () => { ui.forceCheckin = true; ui.focusCheckin = true; ctx.refresh(); } }, 'Edit')),
    m && m.avg.waist ? h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Waist'), h('span', { class: 'value' }, `${ctx.fmtLength(m.avg.waist)} ${ctx.lengthUnit()}`)) : null,
    h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Adherence'), h('span', { class: 'value' }, done.adherence_pct === null ? '–' : `${done.adherence_pct} %`)),
    h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Biofeedback'), h('span', { class: 'value' }, `${avgBio} / 5`)));
}

// ---- 5. trend graph --------------------------------------------------------------------------

function trendCard(ctx, { series, phases, measurements, rate, bands, today, lastTrend }) {
  const s = ctx.settings;
  const kg = s.units === 'kg';
  const conv = (lb) => (kg ? lb * 0.45359237 : lb);
  const days = RANGES[ui.range];
  const first = series.length ? series[0].date : today;
  const domain = [days ? addDays(today, -(days - 1)) : first, today];
  const points = series.map((p) => ({ date: p.date, weight: conv(p.weight), trend: conv(p.trend) }));

  let overlay = null;
  if (ui.overlay === 'waist') {
    overlay = {
      label: 'Waist', short: 'waist', unit: ctx.lengthUnit(), decimals: 1, minSpan: 1,
      points: measurements.filter((m) => m.avg && m.avg.waist).map((m) => ({ date: m.local_date, value: Number(ctx.fmtLength(m.avg.waist)) })),
    };
  } else if (ui.overlay === 'bf') {
    overlay = {
      label: 'Body fat (est.)', short: 'body fat', unit: '%', decimals: 1, minSpan: 2,
      points: s.height_in ? measurements.map((m) => ({ date: m.local_date, value: navyBodyFat({ waist: m.avg.waist, neck: m.avg.neck, heightIn: s.height_in }) })).filter((p) => p.value !== null) : [],
    };
  }

  const st = rate ? rateStatus(s.mode, rate.pct_bw_per_wk, bands) : null;
  const band = bands[s.mode].target;
  const rateEl = rate
    ? h('div', { class: 'rate' },
      h('span', { class: `status ${st.tone}` }, st.word),
      h('span', { class: 'val' }, `${signed(rate.pct_bw_per_wk)} %BW/wk`),
      h('span', { class: 'band' }, `target ${signed(band[0], 2)} to ${signed(band[1], 2)} · ${signed(kg ? rate.lb_per_wk * 0.45359237 : rate.lb_per_wk)} ${ctx.unitLabel()}/wk`))
    : h('div', { class: 'rate' }, h('span', { class: 'band' }, 'Rate shows after'), h('span', { class: 'band' }, '2 weeks of weigh-ins'));

  const range = segmented([{ value: '4w', label: '4 wk' }, { value: '12w', label: '12 wk' }, { value: 'all', label: 'All' }], ui.range, (v) => {
    ui.range = v; setPref('wm.range', v); ctx.refresh();
  }, { label: 'Range' });
  const overlaySel = segmented([{ value: 'none', label: 'Weight' }, { value: 'waist', label: '+ Waist' }, { value: 'bf', label: '+ Body fat' }], ui.overlay, (v) => {
    ui.overlay = v; setPref('wm.overlay', v); ctx.refresh();
  }, { label: 'Overlay' });

  const card = h('div', { class: 'card' },
    h('div', { class: 'row between', style: 'align-items:flex-start' },
      h('div', {}, h('p', { class: 'label' }, 'Trend weight'),
        h('div', { class: 'hero' }, lastTrend ? ctx.fmtWeight(lastTrend.trend) : '–', h('small', {}, ctx.unitLabel()))),
      rateEl),
    h('div', { class: 'chart-controls' }, range),
    h('div', { class: 'chart-controls', style: 'margin-top:-8px' }, overlaySel),
    trendChart({ points, domain, phases, unit: ctx.unitLabel(), decimals: 1, overlay }),
    ui.overlay === 'bf' && !s.height_in ? h('p', { class: 'muted xsmall' }, 'Set your height in Settings for the body-fat estimate.') : null,
    ui.overlay === 'bf' ? h('p', { class: 'faint xsmall', style: 'margin:8px 0 0' }, 'US Navy estimate (waist, neck, height): a trend, ±3–4 %.') : null,
    h('button', { type: 'button', class: 'link-btn', onClick: () => { ui.showTable = !ui.showTable; ctx.refresh(); } }, ui.showTable ? 'Hide weigh-ins' : 'Show weigh-ins'));
  if (ui.showTable) card.append(weighinTable(ctx, { series, domain, today }));
  return card;
}

function weighinTable(ctx, { domain, today }) {
  const list = h('div', { class: 'list wtable' });
  const fill = async () => {
    const all = live(await getAll(ctx.db, 'weighins'))
      .filter((w) => w.local_date >= domain[0] && w.local_date <= domain[1])
      .sort((a, b) => (a.local_date === b.local_date ? ((a.utc || '') < (b.utc || '') ? 1 : -1) : a.local_date < b.local_date ? 1 : -1))
      .slice(0, 120);
    if (!all.length) { list.append(h('p', { class: 'muted small' }, 'No weigh-ins in this range.')); return; }
    for (const w of all) {
      const src = w.source === 'history' ? 'history' : w.source === 'health' ? 'Health' : w.backdated ? 'backdated' : '';
      const row = [h('span', { class: 'd num' }, w.local_date === today ? 'Today' : `${formatDayMonth(w.local_date)} ${w.local_date.slice(2, 4)}`),
        h('span', { class: 'grow num' }, `${ctx.fmtWeight(w.weight_lb)} ${ctx.unitLabel()}`), h('span', { class: 'src' }, src)];
      list.append(w.source === 'history'
        ? h('div', { class: 'item' }, row)
        : h('button', { type: 'button', class: 'item', onClick: () => editWeighin(ctx, w) }, row, icon('chevron', { size: 16 })));
    }
  };
  fill();
  return list;
}

function editWeighin(ctx, w) {
  let value = Number(ctx.fmtWeight(w.weight_lb));
  const field = stepper({ value, step: ctx.settings.units === 'kg' ? 0.1 : 0.2, min: 40, max: 400, decimals: 1, unit: ctx.unitLabel(), label: 'Weight', onChange: (v) => { value = v; } });
  openSheet({
    title: `Weigh-in · ${formatLong(w.local_date)}`,
    body: field,
    actions: [
      {
        label: 'Save', kind: 'primary',
        onClick: async () => {
          const v = field.getValue();
          if (!(v > 0)) return true;
          await put(ctx.db, 'weighins', { ...w, weight_lb: Math.round(ctx.toLb(v) * 10) / 10, updated_utc: new Date().toISOString() });
          toast('Weigh-in updated');
          ctx.refresh();
          return false;
        },
      },
      {
        label: 'Delete', kind: 'danger',
        onClick: async () => {
          await removeRecord(ctx.db, 'weighins', w.id);
          toast('Weigh-in deleted');
          ctx.refresh();
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
}

// ---- 6. on plan today ------------------------------------------------------------------------

function onPlanCard(ctx, { taps, today, tz }) {
  const mine = taps.filter((t) => t.local_date === today).sort((a, b) => ((a.updated_utc || '') < (b.updated_utc || '') ? 1 : -1));
  const current = mine.find((t) => t.tz === tz) || mine[0] || null;
  let kcal = current && current.kcal ? current.kcal : null;
  let picked = current ? current.status : null;
  const save = async (status) => {
    await saveDaily(ctx.db, 'adherence', { localDate: today, tz, prefix: 'plan', fields: { status, kcal: status === 'yes' ? null : kcal } });
  };
  const kcalField = stepper({
    value: kcal, step: 50, min: 0, max: 8000, unit: 'kcal', compact: true, label: 'Estimated kcal today', placeholder: '2400',
    onChange: async (v) => { kcal = v; if (picked) await save(picked); },
  });
  const kcalWrap = h('div', { class: 'stack-sm', style: picked && picked !== 'yes' ? '' : 'display:none' },
    h('span', { class: 'label' }, 'Estimated kcal (optional)'), kcalField);
  const seg = segmented([{ value: 'yes', label: 'Yes' }, { value: 'partial', label: 'Partial' }, { value: 'off', label: 'Off' }], picked, async (v) => {
    picked = v;
    await save(v);
    kcalWrap.style.display = v === 'yes' ? 'none' : '';
    toast(v === 'yes' ? 'On plan today' : v === 'partial' ? 'Partly on plan today' : 'Off plan today: not used for the TDEE estimate');
  }, { label: 'On plan today' });
  return h('div', { class: 'card stack' }, seg, kcalWrap,
    h('p', { class: 'muted xsmall', style: 'margin:0' }, 'Feeds the weekly adherence check: macros change only on weeks at 90 % or better.'));
}
