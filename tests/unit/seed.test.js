import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseWeightCsv, historyWeighins, historyPhases, firstLaunchPhases, parseHealthWeightCsv, defaultSettings,
} from '../../coach/seed.js';
import { seedModelState } from '../../coach/model.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const profile = JSON.parse(read('data/metabolic_profile.json'));
const rows = parseWeightCsv(read('data/weight_daily.csv'));

test('weight history: 279 weigh-ins, 2024-12-28 → 2026-05-14', () => {
  assert.equal(rows.length, 279);
  assert.equal(rows[0].date, '2024-12-28');
  assert.equal(rows.at(-1).date, '2026-05-14');
  assert.equal(rows.at(-1).weight_lb, 163.4);
  const w = historyWeighins(rows);
  assert.equal(new Set(w.map((r) => r.id)).size, 279, 'ids are unique and deterministic');
  assert.equal(w[0].id, 'hist-2024-12-28');
  assert.equal(w[0].source, 'history');
});

test('phase bands match the brief timeline (breaks as their own band)', () => {
  const phases = historyPhases(profile).map((p) => [p.kind, p.label, p.start, p.end]);
  assert.deepEqual(phases, [
    ['cut', 'Cut 2025', '2024-12-28', '2025-04-23'],
    ['break', 'Break', '2025-04-24', '2025-07-19'],
    ['bulk', 'Bulk 2025', '2025-07-20', '2025-12-20'],
    ['break', 'Holiday break', '2025-12-21', '2026-01-31'],
    ['cut', 'Cut 2026', '2026-02-01', '2026-05-14'],
  ]);
});

test('first launch adds the unlogged gap and starts Bulk today', () => {
  const p = firstLaunchPhases(profile, '2026-10-09');
  assert.deepEqual(p.map((x) => [x.kind, x.start, x.end]), [
    ['break', '2026-05-15', '2026-10-08'],
    ['bulk', '2026-10-09', null],
  ]);
});

test('model prior: 13.2 kcal/lb × trend, rate bands and floors from the profile', () => {
  const weighins = historyWeighins(rows);
  const m = seedModelState(profile, { weighins, phases: historyPhases(profile), generatedUtc: 'x' });
  assert.equal(m.priors.base_kcal_per_lb, 13.2);
  assert.equal(m.priors.base_sd_kcal, 250);
  assert.deepEqual(m.priors.kcal_per_lb, { loss: 3500, gain: 2750 });
  assert.equal(m.priors.cardio.stairs_net_met, 5.4);
  assert.equal(m.priors.cardio.run_kcal_per_km, 70);
  assert.deepEqual(m.rate_bands_pct_bw_per_wk.bulk, { target: [0.1, 0.2], cap: 0.35 });
  assert.equal(m.trend.last_local_date, '2026-05-14');
  assert.ok(m.trend.trend_lb > 163 && m.trend.trend_lb < 168);
  // brief §6: ≈ 2,180 base at ~165 lb
  assert.ok(Math.abs(m.tdee.base_kcal - 2180) < 60, `base ${m.tdee.base_kcal}`);
  assert.equal(m.last_daily_run_local_date, null);
  assert.equal(m.last_weekly_run_week, null);
});

test('committed data/model/state.json matches the seed (minus timestamp)', () => {
  const committed = JSON.parse(read('data/model/state.json'));
  const fresh = seedModelState(profile, { weighins: historyWeighins(rows), phases: historyPhases(profile), generatedUtc: committed.generated_utc });
  assert.deepEqual(committed, JSON.parse(JSON.stringify(fresh)));
});

test('Health weigh-in CSV: ISO datetimes with offsets, kg, headers, duplicates', () => {
  const { records, errors } = parseHealthWeightCsv([
    'Date,Weight',
    '2026-05-10T07:12:00-07:00,165.2',
    '2026-05-11T06:58:00-07:00,165.0 lb',
    '2026-05-11T06:58:00-07:00,165.0',
    '2026-05-12,75.0,kg',
    'garbage',
  ].join('\n'));
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    id: 'health-2026-05-10T0712', local_date: '2026-05-10', weight_lb: 165.2,
    utc: '2026-05-10T14:12:00.000Z', tz: null, source: 'health',
  });
  assert.equal(records[2].weight_lb, 165.3);
  assert.equal(errors.length, 1);
});

test('default settings: Bulk, Sunday prep, Friday check-in, auto timezone', () => {
  const s = defaultSettings({ now: new Date('2026-10-09T08:00:00Z'), tz: 'Europe/Berlin' });
  assert.equal(s.mode, 'bulk');
  assert.equal(s.prep_day, 7);
  assert.equal(s.checkin_day, 5);
  assert.equal(s.tz_mode, 'auto');
  assert.deepEqual(s.tz_history, [{ tz: 'Europe/Berlin', from_utc: '2026-10-09T08:00:00.000Z' }]);
  assert.equal(s.home_tz, 'America/Los_Angeles');
  assert.equal(s.step_floor, 8000);
  assert.equal(s.carb_cycling, false);
});
