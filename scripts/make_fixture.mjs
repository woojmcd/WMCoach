// Regenerates tests/fixtures/backup-sample.json from seeded data plus a few
// records in every store (spec §12a). Older fixtures (backup-v1.json, …) are
// frozen on purpose: they prove an old phone's data still upgrades.
// Refresh from a real export when Walter provides one: copy the exported
// walter-coach-backup-*.json over the fixture instead of running this.
import 'fake-indexeddb/auto';
import { readFile, writeFile } from 'node:fs/promises';
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
    adherence: [
      { id: 'plan-fixture-1', ...at, local_date: '2026-10-08', status: 'yes', kcal: null },
      { id: 'plan-fixture-2', ...at, local_date: '2026-10-09', status: 'partial', kcal: 2600 },
    ],
  },
});
const backup = await buildBackup(db, { appVersion: APP_VERSION, now, tz, localDate: '2026-10-09' });
await writeFile(new URL('tests/fixtures/backup-sample.json', root), `${JSON.stringify(backup, null, 1)}\n`);
console.log('tests/fixtures/backup-sample.json:', Object.entries(backup.stores).map(([k, v]) => `${k} ${v.length}`).join(', '));
