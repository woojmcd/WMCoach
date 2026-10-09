import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWeightCsv, historyWeighins } from '../../coach/seed.js';
import { blockMaintenance, estimateTdee, intakeByDate, planKcalByDate, olsSlope } from '../../coach/tdee.js';
import { addDays } from '../../coach/time.js';

const weighins = historyWeighins(parseWeightCsv(readFileSync(new URL('../../data/weight_daily.csv', import.meta.url), 'utf8')));

// Brief §1b, every merged block: [label, from, to, plan kcal, stairs + logged cardio, base maint.]
const BLOCKS = [
  ['2025 cut V1', '2025-02-11', '2025-03-24', 2343, 260 + 58, 2470],
  ['2025 cut V2–V4', '2025-03-25', '2025-04-23', 2119, 252 + 29, 2629],
  ['Bulk ramp V1–V4', '2025-07-20', '2025-09-03', 2127, 13, 1972],
  ['Bulk V5', '2025-09-04', '2025-10-08', 2388, 16, 2106],
  ['Bulk V6', '2025-10-09', '2025-11-14', 2501, 63, 1767],
  ['Bulk V7', '2025-11-15', '2025-12-20', 2539, 103, 2266],
  ['2026 cut V1–V3', '2026-02-01', '2026-03-04', 2332, 196 + 92, 2321],
  ['2026 cut V4 Mar', '2026-03-05', '2026-04-01', 2192, 193 + 420, 1947],
  ['2026 cut V4 Apr–May', '2026-04-02', '2026-05-14', 2195, 187 + 366, 2273],
];

test('back-test (spec §12a): the block maths reproduces brief §1b base maintenance', () => {
  for (const [label, from, to, kcal, cardio, base] of BLOCKS) {
    const r = blockMaintenance({ weighins, from, to, planKcal: kcal, cardioKcal: cardio });
    assert.ok(Math.abs(r.base - base) <= 5, `${label}: ${Math.round(r.base)} vs ${base}`);
  }
  // the high-confidence blocks (brief §2.1: anomalies excluded) sit in the 12.4–14.1 kcal/lb prior range
  for (const [label, from, to, kcal, cardio] of BLOCKS.filter(([l]) => !/ramp|V6|V2–V4|Mar$/.test(l))) {
    const r = blockMaintenance({ weighins, from, to, planKcal: kcal, cardioKcal: cardio });
    assert.ok(r.base_per_lb >= 12.3 && r.base_per_lb <= 14.2, `${label}: ${r.base_per_lb.toFixed(1)} kcal/lb`);
  }
});

test('back-test: replaying the adaptive estimator over the high-confidence blocks lands within ±150 of §1b', () => {
  for (const [label, from, to, kcal, cardio, base] of BLOCKS.filter(([l]) => !/ramp|V6|V2–V4|Mar$/.test(l))) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    const intake = new Map(); const cardioMap = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) { intake.set(d, kcal); cardioMap.set(d, cardio); }
    const r = estimateTdee({ today: to, weighins: weighins.filter((w) => w.local_date <= to), intake, cardio: cardioMap, windowDays: days });
    assert.equal(r.method, 'blend', label);
    const observedBase = r.observed_kcal - cardio;
    assert.ok(Math.abs(observedBase - base) <= 150, `${label}: observed base ${observedBase} vs ${base}`);
  }
});

test('estimator: prior only until 8 weigh-ins; then blended (weight min(0.85, n/30)) and clamped to ±150 of last week', () => {
  const today = '2026-10-31';
  const ws = Array.from({ length: 28 }, (_, i) => ({ local_date: addDays(today, -27 + i), weight_lb: 175 + i * 0.04 }));
  const intake = new Map(ws.map((w) => [w.local_date, 2492]));
  const few = estimateTdee({ today, weighins: ws.slice(-5), intake });
  assert.equal(few.method, 'prior');
  assert.equal(few.estimate_kcal, Math.round(13.2 * few.trend_lb));
  const r = estimateTdee({ today, weighins: ws, intake });
  assert.equal(r.method, 'blend');
  assert.equal(r.weight_on_observed, 0.85, 'min(0.85, 28 / 30)');
  assert.ok(r.observed_kcal < 2492, 'gaining: maintenance below intake');
  const clamped = estimateTdee({ today, weighins: ws, intake, prev: { estimate_kcal: r.estimate_kcal - 400 } });
  assert.equal(clamped.estimate_kcal, r.estimate_kcal - 400 + 150);
  assert.equal(clamped.clamped, true);
});

test('intake: plan kcal by week; Partial with kcal uses it; Off days are left out of learning', () => {
  const plans = [{ week_start: '2026-10-04', plan: { weekly_avg: { kcal: 2492 } } }, { week_start: '2026-10-11', plan: { weekly_avg: { kcal: 2630 } } }];
  const pk = planKcalByDate(plans, '2026-10-09', '2026-10-12');
  assert.deepEqual([...pk.values()], [2492, 2492, 2630, 2630]);
  const intake = intakeByDate(pk, [{ local_date: '2026-10-09', status: 'partial', kcal: 2800 }, { local_date: '2026-10-10', status: 'off' }, { local_date: '2026-10-11', status: 'yes' }]);
  assert.deepEqual([...intake.values()], [2800, null, 2630, 2630]);
  assert.equal(olsSlope([{ x: 0, y: 1 }, { x: 2, y: 2 }]), 0.5);
});
