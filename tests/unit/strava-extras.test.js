// Strava additions (Walter, 2026-11-14): minutes per heart-rate zone from the HR stream,
// running best efforts for the 3-mile baseline, and relative effort in the Yesterday summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneSeconds, normalizeFetch, parseBestEfforts } from '../../coach/strava.js';
import { runBaseline, parseHrZones } from '../../coach/cardio.js';
import { cardioDay } from '../../coach/daily.js';

const zones = parseHrZones({ heart_rate: { zones: [{ min: 0, max: 118 }, { min: 118, max: 147 }, { min: 147, max: 162 }, { min: 162, max: 176 }, { min: 176, max: -1 }] } });
// the Thu 12 Nov run's stream as get_activity_streams returns it (resolution 20)
const runStream = { heart_rate: [90, 163, 177, 180, 174, 171, 172, 176, 173, 173, 137, 175, 178, 170, 172, 157, 170, 176, 174, 170], time: [0, 83, 166, 249, 332, 414, 497, 580, 663, 746, 870, 912, 995, 1069, 1161, 1243, 1326, 1409, 1492, 1575] };

test('zoneSeconds: time between samples, by the zone of the sample, the top zone open-ended', () => {
  const z = zoneSeconds(runStream, zones);
  assert.equal(z.reduce((a, b) => a + b, 0), 1575);
  assert.deepEqual(z, [83, 42, 83, 961, 406]);
  assert.equal(zoneSeconds({ time: [0, 60], heart_rate: [130] }, zones), null, 'mismatched arrays');
  // his real Strava zones: inclusive maxes with gaps (0–125, 126–156, 157–172, 173–187, 188+)
  const real = parseHrZones({ heart_rate_zones: [{ min: 0, max: 125 }, { min: 126, max: 156 }, { min: 157, max: 172 }, { min: 173, max: 187 }, { min: 188 }], run_zones: [{ min: 0, max: 2.784 }] });
  assert.deepEqual(zoneSeconds({ time: [0, 60, 120, 180, 240], heart_rate: [125, 156, 157, 188, 100] }, real), [60, 60, 60, 0, 60], '125 → zone 1, 156 → zone 2, 157 → zone 3, 188 → zone 5');
  assert.equal(zoneSeconds(runStream, null), null);
});

test('normalizeFetch: streams become hr_zones_s on the activity; relative effort is kept', () => {
  const fetched = {
    activities: [{ id: '20965385928', name: 'Afternoon Run', sport_type: 'Run', start_local: '2026-11-12T13:59:06', summary: { distance: 4839.3, moving_time: 1424, elapsed_time: 1576, relative_effort: 64, total_calories: 364 } }],
    streams: { 20965385928: runStream },
  };
  const [a] = normalizeFetch(fetched, { hrZones: zones });
  assert.deepEqual([a.relative_effort, a.hr_zones_s[3]], [64, 961]);
  assert.equal(normalizeFetch(fetched)[0].hr_zones_s, null, 'no zones known: no split');
});

test('best efforts: the 5K best (+40 s/mi) is the 3-mile baseline when there is no recent 3-mile run', () => {
  const raw = { sports: ['Run'], efforts: [
    { sport: 'Run', best_effort_type: 'FastestMile', value: 409, unit: 'seconds', year: 2026, date: '2026-06-06' },
    { sport: 'Run', best_effort_type: 'Fastest2Mile', value: 857, unit: 'seconds', year: 2026, date: '2026-06-24' },
    { sport: 'Run', best_effort_type: 'Fastest5k', value: 1347, unit: 'seconds', year: 2026, date: '2026-06-24' },
    { sport: 'Run', best_effort_type: 'Fastest5k', value: 1429, unit: 'seconds', year: 2026, date: '2026-04-15' },
  ] };
  const be = parseBestEfforts(raw);
  assert.equal(be.length, 4);
  const b = runBaseline({ date: '2026-11-15', bestEfforts: be });
  assert.deepEqual([b.source, b.s_per_mi, b.text], ['best_effort', 474, 'your 5K best (22:27) + 40 s/mi']);
  // a recent 3-mile run still wins
  const runs = [{ type: 'Run', local_date: '2026-11-12', distance_km: 4.84, duration_s: 1424 }];
  assert.equal(runBaseline({ date: '2026-11-15', activities: runs, bestEfforts: be }).source, 'runs');
  // a best from over a year ago doesn't count
  assert.equal(runBaseline({ date: '2027-08-01', bestEfforts: be }), null);
});

const rx = { mode: 'bulk', modality: 'stairs', zone: 2, days: [2, 4], sessions: 2, minutes: 25, weekly_min: 50 };
const stairs = (id, date, zs, re) => ({ id, type: 'StairStepper', name: 'Stairs', local_date: date, duration_s: 1500, avg_hr: 140, hr_zones_s: zs, relative_effort: re });

test('Yesterday: minutes in Zone 2 from the stream, a warning when easy cardio ran hot, relative effort vs his own sessions', () => {
  const easy = cardioDay({ date: '2026-11-17', rx, activities: [stairs('s1', '2026-11-17', [120, 1260, 120, 0, 0], 18)] });
  assert.match(easy.point.text, /25 min stairs \(Strava\)\. 21 of 25 min in Zone 2, 2 above\. Relative effort 18\./);
  const hot = cardioDay({ date: '2026-11-17', rx, activities: [stairs('s2', '2026-11-17', [60, 540, 600, 300, 0], 40)] });
  assert.match(hot.point.text, /15 of 25 min above Zone 2: easier next time, so it stays recovery cardio\./);
  // 8+ cardio sessions give a top quarter: 64 is in it
  const history = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, type: 'Run', local_date: `2026-10-${String(10 + i).padStart(2, '0')}`, duration_s: 1500, relative_effort: 15 + i * 3 }));
  const hard = cardioDay({ date: '2026-11-17', rx, activities: [...history, { ...stairs('s3', '2026-11-17', null, 64), type: 'Run', hr_zones_s: [83, 42, 82, 829, 539] }] });
  assert.match(hard.point.text, /1 of 26 min in Zone 2, 24 above\. Relative effort 64: top quarter of your sessions, a hard one\./);
});
