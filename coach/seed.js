// Seeding from history (spec §2a). Pure functions shared by the PWA and the
// Node scripts/tests. Inputs are the read-only files in data/.
import { addDays, isDateString, localDate, HOME_TZ } from './time.js';

// ---- weight history -------------------------------------------------------

export function parseWeightCsv(text) {
  const rows = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [date, w] = line.split(',').map((s) => s.trim());
    if (date === 'date') continue;
    const weight = Number(w);
    if (!isDateString(date) || !Number.isFinite(weight)) {
      throw new Error(`weight_daily.csv: bad row "${line}"`);
    }
    rows.push({ date, weight_lb: weight });
  }
  return rows;
}

// Historical weigh-ins become log entries with deterministic ids, so re-seeding
// or importing a backup merges instead of duplicating. Time of day and zone
// weren't recorded, so utc/tz stay null rather than invented.
export function historyWeighins(rows) {
  return rows.map((r) => ({
    id: `hist-${r.date}`,
    local_date: r.date,
    weight_lb: r.weight_lb,
    utc: null,
    tz: null,
    source: 'history',
  }));
}

// ---- Health weigh-ins (one-time CSV from an iOS Shortcut) --------------------
// Accepts lines like "2026-05-10T07:12:00-07:00,165.2[,lb|kg]" or "2026-05-10,165.2".
// The local date is the date part as written (the phone's local time at sampling).
export function parseHealthWeightCsv(text) {
  const out = [];
  const errors = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cols = line.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(cols[0] || '');
    if (!m) {
      if (i === 0) return; // header row
      errors.push(`line ${i + 1}: "${line}"`);
      return;
    }
    let weight = Number(String(cols[1] || '').replace(/[^\d.]/g, ''));
    const unit = (cols[2] || (/kg/i.test(cols[1] || '') ? 'kg' : 'lb')).toLowerCase();
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`line ${i + 1}: "${line}"`);
      return;
    }
    if (unit.startsWith('kg')) weight = weight / 0.45359237;
    weight = Math.round(weight * 10) / 10;
    let utc = null;
    if (m[2] && m[3]) {
      const t = Date.parse(`${m[1]}T${m[2]}${m[3].length === 5 ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3]}`);
      if (Number.isFinite(t)) utc = new Date(t).toISOString();
    }
    out.push({
      id: `health-${m[1]}${m[2] ? `T${m[2].slice(0, 5).replace(':', '')}` : ''}`,
      local_date: m[1],
      weight_lb: weight,
      utc,
      tz: null,
      source: 'health',
    });
  });
  // Same sample exported twice -> same id; keep the last one.
  const byId = new Map(out.map((r) => [r.id, r]));
  return { records: [...byId.values()], errors };
}

// ---- phases ---------------------------------------------------------------
// Cut / bulk / break bands from metabolic_profile.json. Breaks come from
// `breaks`; the on-plan segments between them are classified from
// `history_summary_kcal` (by explicit dates when given, else by year).

export function historyPhases(profile) {
  const first = profile.data_span.first_weigh_in;
  const last = profile.data_span.last_weigh_in;
  const breaks = [...profile.breaks].sort((a, b) => (a.start < b.start ? -1 : 1));
  const segments = [];
  let cursor = first;
  for (const b of breaks) {
    if (b.start > cursor) segments.push({ start: cursor, end: addDays(b.start, -1) });
    cursor = addDays(b.end, 1);
  }
  if (cursor <= last) segments.push({ start: cursor, end: last });

  const summary = Object.entries(profile.history_summary_kcal || {})
    .filter(([, v]) => !/break/i.test(v.status || ''))
    .map(([key, v]) => ({ key, kind: key.split('_')[0], year: key.split('_')[1], dates: v.dates }));

  const phases = segments.map((seg) => {
    let match = summary.find((s) => s.dates && s.dates[0] <= seg.end && s.dates[1] >= seg.start);
    if (!match) match = summary.find((s) => !s.dates && s.year === seg.end.slice(0, 4));
    if (!match) throw new Error(`No phase kind for ${seg.start}..${seg.end}`);
    const kind = match.kind === 'cut' ? 'cut' : match.kind === 'bulk' ? 'bulk' : 'maintenance';
    return { id: `${kind}-${seg.start}`, kind, label: `${cap(kind)} ${match.year}`, start: seg.start, end: seg.end, source: 'history' };
  });
  for (const b of breaks) {
    const christmas = `${b.start.slice(0, 4)}-12-25`;
    const holiday = b.start <= christmas && christmas <= b.end;
    phases.push({
      id: `break-${b.start}`, kind: 'break', label: holiday ? 'Holiday break' : 'Break',
      start: b.start, end: b.end, source: 'history',
    });
  }
  return phases.sort((a, b) => (a.start < b.start ? -1 : 1));
}

// Phases created on first launch: the unlogged gap since the last weigh-in
// (Walter: any gap in the data is a break) and the new Bulk, starting today.
export function firstLaunchPhases(profile, startDate) {
  const gapStart = addDays(profile.data_span.last_weigh_in, 1);
  const out = [];
  if (gapStart < startDate) {
    out.push({ id: `break-${gapStart}`, kind: 'break', label: 'Unlogged', start: gapStart, end: addDays(startDate, -1), source: 'app' });
  }
  out.push({ id: `bulk-${startDate}`, kind: 'bulk', label: `Bulk ${startDate.slice(0, 4)}`, start: startDate, end: null, source: 'app' });
  return out;
}

// ---- settings ---------------------------------------------------------------

export function defaultSettings({ now, tz, heightIn = null, liftedLess = null }) {
  const utc = now.toISOString();
  return {
    tz_mode: 'auto',
    tz_manual: null,
    tz_current: tz,
    tz_history: [{ tz, from_utc: utc }],
    home_tz: HOME_TZ,
    height_in: heightIn,
    units: 'lb',
    prep_day: 7, // ISO weekday: Sunday
    checkin_day: 5, // Friday
    rest_default_s: 90,
    rest_superset_s: 15,
    step_floor: 8000,
    mode: 'bulk',
    mode_since: localDate(now, tz),
    carb_cycling: false,
    lifted_less_since_may: liftedLess,
    created_utc: utc,
    updated_utc: utc,
  };
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
