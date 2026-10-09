import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyMeans, ewmaTrend, trendFromEntries } from '../../coach/trend.js';

test('EWMA uses the time-aware half-life formula', () => {
  const t = ewmaTrend([{ date: '2026-01-01', weight: 170 }, { date: '2026-01-08', weight: 172 }]);
  assert.equal(t[0].trend, 170);
  assert.equal(t[1].trend, 171); // one half-life later: halfway
});

test('a long gap resets the trend toward the new weight', () => {
  const t = ewmaTrend([{ date: '2026-01-01', weight: 170 }, { date: '2026-06-01', weight: 160 }]);
  assert.ok(Math.abs(t[1].trend - 160) < 0.01);
});

test('same-date entries are averaged for the math, not merged in storage', () => {
  const means = dailyMeans([
    { local_date: '2026-10-10', weight_lb: 165 },
    { local_date: '2026-10-10', weight_lb: 166 },
    { local_date: '2026-10-09', weight_lb: 164 },
  ]);
  assert.deepEqual(means.map((m) => [m.date, m.weight, m.n]), [['2026-10-09', 164, 1], ['2026-10-10', 165.5, 2]]);
  assert.equal(trendFromEntries([]).length, 0);
});
