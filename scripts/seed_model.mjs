// Seeds data/model/state.json from data/metabolic_profile.json + data/weight_daily.csv (spec §2a).
// Run once on the first build. After that the daily routine owns data/model/ (spec §2).
// Usage: npm run seed:model [-- --force]
import { access, readFile, writeFile } from 'node:fs/promises';
import { parseWeightCsv, historyWeighins, historyPhases } from '../coach/seed.js';
import { seedModelState } from '../coach/model.js';

const root = new URL('../', import.meta.url);
const target = new URL('data/model/state.json', root);
const force = process.argv.includes('--force');
if (!force) {
  try {
    await access(target);
    console.error('data/model/state.json already exists; the daily routine owns it now. Use --force to reseed.');
    process.exit(1);
  } catch { /* not there yet: seed it */ }
}
const profile = JSON.parse(await readFile(new URL('data/metabolic_profile.json', root), 'utf8'));
const weighins = historyWeighins(parseWeightCsv(await readFile(new URL('data/weight_daily.csv', root), 'utf8')));
const state = seedModelState(profile, { weighins, phases: historyPhases(profile), generatedUtc: new Date().toISOString() });
await writeFile(target, `${JSON.stringify(state, null, 2)}\n`);
console.log(`data/model/state.json: trend ${state.trend.trend_lb} lb on ${state.trend.last_local_date}, base ${state.tdee.base_kcal} kcal`);
