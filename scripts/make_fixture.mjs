// Regenerates tests/fixtures/backup-sample.json from seeded data (spec §12a).
// Refresh it from a real export when Walter provides one: copy the exported
// walter-coach-backup-*.json over the fixture instead of running this.
import 'fake-indexeddb/auto';
import { readFile, writeFile } from 'node:fs/promises';
import { openDB } from '../app/db.js';
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
const backup = await buildBackup(db, { appVersion: APP_VERSION, now, tz, localDate: '2026-10-09' });
await writeFile(new URL('tests/fixtures/backup-sample.json', root), `${JSON.stringify(backup, null, 1)}\n`);
console.log('tests/fixtures/backup-sample.json:', Object.entries(backup.stores).map(([k, v]) => `${k} ${v.length}`).join(', '));
