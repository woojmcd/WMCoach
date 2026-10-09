// Regenerates tests/fixtures/backup-sample.json from seeded data plus a few
// records in every store (spec §12a). Older fixtures (backup-v1.json, …) are
// frozen on purpose: they prove an old phone's data still upgrades.
// Refresh from a real export when Walter provides one: copy the exported
// walter-coach-backup-*.json over the fixture instead of running this.
import 'fake-indexeddb/auto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { startingPlan, withMacros, diffPlans } from '../coach/meals.js';
import { openDB, writeAtomic } from '../app/db.js';
import { seedFirstLaunch } from '../app/seed.js';
import { buildBackup } from '../app/backup.js';
import { APP_VERSION } from '../app/version.js';

const root = new URL('../', import.meta.url);
const now = new Date('2026-10-09T07:30:00Z');
const tz = 'Europe/Berlin';
let n = 0;
const db = await openDB({ name: 'fixture' });
await seedFirstLaunch(db, {
  weightCsv: await readFile(new URL('data/weight_daily.csv', root), 'utf8'),
  profile: JSON.parse(await readFile(new URL('data/metabolic_profile.json', root), 'utf8')),
  answers: { weight_lb: 168.4, height_in: 70, lifted_less: true },
  now, tz, appVersion: APP_VERSION,
  makeId: (prefix) => `${prefix}-fixture-${++n}`,
});
// Stage 2 records: a pending mode switch, a measurement, a check-in and daily taps.
const utc = now.toISOString();
const at = { utc, tz, updated_utc: utc };
await writeAtomic(db, {
  writes: {
    mode_changes: [{ id: 'mode-fixture-1', ...at, local_date: '2026-10-09', from: 'bulk', to: 'maintenance', kind: 'switch', effective_date: '2026-10-11', targets: null }],
    measurements: [{
      id: 'meas-fixture-1', ...at, local_date: '2026-10-09', unit: 'in',
      readings: { waist: [32.1, 32.3], neck: [15.2, 15.2], chest: [40, 40.2], arm: [14.1, 14.1], thigh: [22.5, 22.7] },
      avg: { waist: 32.2, neck: 15.2, chest: 40.1, arm: 14.1, thigh: 22.6 },
    }],
    checkins: [{
      id: 'ci-fixture-1', ...at, local_date: '2026-10-09', week: '2026-W41', due_date: '2026-10-09',
      adherence_pct: 95, adherence_auto_pct: 93, adherence_taps: 6,
      biofeedback: { hunger: 4, energy: 4, sleep: 3, stress: 4, digestion: 5 }, note: 'fixture', measurement_id: 'meas-fixture-1',
    }],
    sessions: [{
      id: 'sess-fixture-1', ...at, local_date: '2026-10-09', started_utc: utc, finished_utc: utc, status: 'finished',
      day_dow: 5, day_name: 'Upper Pull #2', program_id: 'TRAIN-CUT26', week: 0, deload: false, note: null,
      exercises: [
        {
          slot_id: 'fri-single-arm-db-rows', movement: 'single-arm-db-rows', name: 'Single Arm DB Rows', swapped_from: null, label: null, group: null, type: 'range',
          reason: 'Calibration', change: null, delta_lb: 0, calibration: true, last: null, skipped: false, note: null,
          sets: [9, 8, 8].map((reps) => ({ kind: 'work', target: { load: null, reps_min: 8, reps_max: 10, aim: null, rir: [0, 1], seconds: null, amrap: false }, load: 60, reps, rir: 1, seconds: null, done: true, skipped: false, utc })),
        },
        {
          slot_id: 'fri-ab-plank', movement: 'ab-plank', name: 'Ab Plank', swapped_from: null, label: 'A2', group: 'Fri-A', type: 'timed',
          reason: null, change: null, delta_lb: 0, calibration: false, last: null, skipped: false, note: null,
          sets: [{ kind: 'timed', target: { load: null, reps_min: null, reps_max: null, aim: null, rir: null, seconds: 30, amrap: false }, load: null, reps: null, rir: null, seconds: 30, done: true, skipped: false, utc }],
        },
      ],
    }],
    stairs: [{ id: 'stairs-fixture-1', ...at, local_date: '2026-10-10', minutes: 30 }],
    plans: [(() => {
      const plansJson = JSON.parse(readFileSync(new URL('data/plans.json', root), 'utf8'));
      const plan = startingPlan(plansJson, { weightLb: 168.4, weekStart: '2026-10-04', id: 'BULK-2026-10-04' });
      const tpl = withMacros(plansJson.food_db, plansJson.plans.find((p) => p.id === 'CUT26-V4'));
      return {
        id: '2026-10-04', week_start: '2026-10-04', week_end: '2026-10-10', mode: 'bulk', plan, source: 'seed', based_on: 'CUT26-V4',
        changes: diffPlans(tpl, plan), reason: 'Starting plan (spec §8.0)', created_utc: utc, updated_utc: utc,
      };
    })()],
    foods: [{ id: 'lean_beef', gi_flag: true, updated_utc: utc }],
    exercise_prefs: [{ id: 'thu-pec-deck-flyes', increment_lb: 7.5, alternates: ['Machine Flyes'], swap: null, updated_utc: utc }],
    adherence: [
      { id: 'plan-fixture-1', ...at, local_date: '2026-10-08', status: 'yes', kcal: null },
      { id: 'plan-fixture-2', ...at, local_date: '2026-10-09', status: 'partial', kcal: 2600 },
    ],
  },
});
const backup = await buildBackup(db, { appVersion: APP_VERSION, now, tz, localDate: '2026-10-09' });
await writeFile(new URL('tests/fixtures/backup-sample.json', root), `${JSON.stringify(backup, null, 1)}\n`);
console.log('tests/fixtures/backup-sample.json:', Object.entries(backup.stores).map(([k, v]) => `${k} ${v.length}`).join(', '));
