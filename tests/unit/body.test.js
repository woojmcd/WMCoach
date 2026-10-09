import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageReadings, siteAverages, navyBodyFat, SITES } from '../../coach/body.js';
import { ewmaTrend, rateOverDays, rateStatus } from '../../coach/trend.js';
import { addDays } from '../../coach/time.js';

const bands = { cut: { target: [-0.75, -0.5], slow_limit: -0.4, cap: -1.0 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };

test('two readings per site are averaged; one reading stands; none is null', () => {
  assert.equal(averageReadings([33.1, 33.3]), 33.2);
  assert.equal(averageReadings([33.1, null]), 33.1);
  assert.equal(averageReadings([]), null);
  assert.deepEqual(Object.keys(siteAverages({ waist: [33, 33.2] })), SITES.map((s) => s.key));
});

test('US Navy body fat (men)', () => {
  assert.equal(navyBodyFat({ waist: 34, neck: 15, heightIn: 70 }), 17.5);
  assert.equal(navyBodyFat({ waist: 32, neck: 15.5, heightIn: 70 }), 12.2);
  assert.equal(navyBodyFat({ waist: 34, neck: 15, heightIn: null }), null);
  assert.equal(navyBodyFat({ waist: 14, neck: 15, heightIn: 70 }), null);
});

test('rate over 14 days from the trend, as %BW/wk', () => {
  // steady +0.35 lb/wk at ~170 lb ≈ +0.21 %BW/wk
  const pts = Array.from({ length: 28 }, (_, i) => ({ date: addDays('2026-10-01', i), weight: 170 + (0.35 / 7) * i }));
  const series = ewmaTrend(pts);
  const r = rateOverDays(series, '2026-10-28');
  assert.ok(Math.abs(r.lb_per_wk - 0.35) < 0.05, `lb/wk ${r.lb_per_wk}`);
  assert.ok(Math.abs(r.pct_bw_per_wk - 0.2) < 0.03, `%BW ${r.pct_bw_per_wk}`);
  assert.equal(rateOverDays(series.slice(0, 3), '2026-10-03'), null, 'too few points');
  assert.equal(rateOverDays([{ date: '2026-10-01', trend: 1 }, { date: '2026-10-02', trend: 1 }, { date: '2026-10-03', trend: 1 }, { date: '2026-10-04', trend: 1 }], '2026-10-04'), null, 'span < 7 d');
});

test('rate status against the mode band', () => {
  assert.equal(rateStatus('bulk', 0.15, bands).key, 'on_target');
  assert.equal(rateStatus('bulk', 0.05, bands).key, 'slow');
  assert.equal(rateStatus('bulk', 0.3, bands).key, 'fast');
  assert.equal(rateStatus('bulk', 0.78, bands).key, 'too_fast');
  assert.equal(rateStatus('cut', -0.6, bands).key, 'on_target');
  assert.equal(rateStatus('cut', -0.3, bands).key, 'slow');
  assert.equal(rateStatus('cut', -0.9, bands).key, 'fast');
  assert.equal(rateStatus('cut', -1.1, bands).key, 'too_fast');
  assert.equal(rateStatus('maintenance', 0.05, bands).key, 'stable');
  assert.equal(rateStatus('maintenance', -0.2, bands).key, 'drifting_down');
  assert.equal(rateStatus('bulk', null, bands), null);
  for (const m of ['bulk', 'cut', 'maintenance']) for (const p of [-2, -0.5, 0, 0.15, 2]) assert.ok(rateStatus(m, p, bands).word);
});
