// The daily coach run (spec §7). Called by the routine (ops/daily_prompt.md):
//
//   node scripts/daily.mjs --preflight              what today's run will do (JSON), incl. the Strava date range
//   node scripts/daily.mjs [--strava .coach/strava.json] [--now <ISO>] [--dry-run]
//
// Writes only routine-owned paths, checks that before writing, and leaves
// .coach/run.json (not committed) for scripts/send_push.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diskRepo } from './lib/repo.mjs';
import { dailyRun, preflight, checkWrites } from '../coach/routine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const now = opt('--now') ? new Date(opt('--now')) : new Date();
const repo = diskRepo(root);

if (args.includes('--preflight')) {
  console.log(JSON.stringify(preflight({ repo, now }), null, 2));
  process.exit(0);
}

let stravaFetched = null;
if (opt('--strava')) {
  try {
    stravaFetched = JSON.parse(readFileSync(opt('--strava'), 'utf8'));
  } catch (err) {
    console.error(`Can't read ${opt('--strava')}: ${err.message}. Running without new Strava data.`);
  }
}

const result = dailyRun({ repo, now, stravaFetched });
const problems = checkWrites(result.writes, (p) => repo.exists(p));
// The plan changelog is append-only: every earlier entry must come through unchanged.
if (result.writes['data/plan/changelog.json'] && repo.exists('data/plan/changelog.json')) {
  const before = JSON.parse(repo.read('data/plan/changelog.json')).entries || [];
  const after = JSON.parse(result.writes['data/plan/changelog.json']).entries || [];
  if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) problems.push('data/plan/changelog.json: existing entries changed');
}
if (problems.length) {
  console.error(`Refusing to write:\n- ${problems.join('\n- ')}`);
  process.exit(2);
}

for (const line of result.report) console.log(line);
if (result.status === 'skip') {
  console.log('SKIP: nothing to commit.');
} else if (args.includes('--dry-run')) {
  console.log(`DRY RUN: would write ${Object.keys(result.writes).length} files:\n${Object.keys(result.writes).map((p) => `  ${p}`).join('\n')}`);
} else {
  for (const [path, content] of Object.entries(result.writes)) repo.write(path, content);
  console.log(`Wrote ${Object.keys(result.writes).length} files. COMMIT: ${result.commitMessage}`);
}
mkdirSync(`${root}.coach`, { recursive: true });
writeFileSync(`${root}.coach/run.json`, `${JSON.stringify({ ...result, writes: Object.keys(result.writes) }, null, 2)}\n`);
// exactly what to stage: git add --pathspec-from-file=.coach/files.txt
writeFileSync(`${root}.coach/files.txt`, args.includes('--dry-run') || result.status === 'skip' ? '' : `${Object.keys(result.writes).join('\n')}\n`);
