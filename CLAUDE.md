# WMCoach: rules for every Claude session in this repo

Walter's personal coaching PWA (iPhone, GitHub Pages). Before building or changing anything, read:
1. `claude/APP_SPEC.md`: what to build, how it behaves, and how updates must work (§12a). It wins on app behaviour, cadence and the training program.
2. `claude/AGENT_BRIEF.md`: history, metabolism priors, TDEE and nutrition math. It wins on energy-expenditure math and macro floors.
3. `claude/TRAINING_HISTORY.md` + `data/training_history.json`: Program C (`TRAIN-CUT26`) is the program the app runs.

Data available in `data/`: `weight_daily.csv`, `plans.json`, `metabolic_profile.json`, `training_history.json`. The other files listed in the brief's §0 (daily_timeline.csv, health_daily.csv, workouts.csv, the scripts, the .xlsx) are **not** in this repo; don't assume them. Their findings are already summarized in the brief and `metabolic_profile.json`.

## Data safety (never break these)
- Never edit, rewrite, move or delete anything under `data/log/` or `data/health/`, or existing entries in `data/strava/` and `data/plan/changelog.json`. Code changes only.
- The seed files above are read-only history. Don't modify them.
- Work on a branch and open a PR; never force-push `main`.
- IndexedDB migrations are additive only (spec §12a). Older app code must still read newer data.
- Run the tests and the migration test before every PR. Bump `APP_VERSION` and the service-worker cache name on every release.
- Never commit tokens or secrets.

## Working with Walter
- Build in the stages Walter asks for; open a PR per stage and stop for him to test on his iPhone.
- Ask only when the spec doesn't answer something; otherwise use the defaults in spec §13.

## Decisions Walter has made (don't re-ask)
- **The repo stays public** (2026-10-09), so GitHub Pages works on a free account. Synced data under `data/` (`log/`, `health/`, `strava/`, …) is publicly readable; Walter accepted that. Still never commit tokens or secrets.

## Repo layout (spec §12a)
| Path | What |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | PWA shell at the repo root, so the app lives at `https://woojmcd.github.io/WMCoach/`. Never move it: the URL is where the phone keeps its data. |
| `app/` | Browser code (plain ES modules, no build step). `app/views/` = one module per screen. |
| `coach/` | Pure coaching functions (time/timezone, trend, seeding, model, program; later progression, readiness, TDEE, plan generator). No DOM or storage APIs (a test enforces this). Shared by the app and the Node scripts. |
| `scripts/` | Node scripts (generators, the dev server, later the daily routine's scripts). |
| `tests/unit/`, `tests/migration/`, `tests/e2e/`, `tests/fixtures/` | Tests. |
| `data/` | Seed history (read-only), generated `program.json`, routine-owned `model/`, and later `log/`, `health/`, `strava/`, `targets/`, `plan/` (one writer per path, spec §2). |
| `docs/` | Guides for Walter, plus PR screenshots in `docs/screenshots/<stage>/`. |

## Commands
- `npm install`: dev dependencies only (`fake-indexeddb`, `playwright`). The app itself has no dependencies.
- `npm test`: unit + migration tests. `npm run test:migration`: migration test only.
- `npm run e2e`: headless Chromium at 375 × 812 covering every stage so far (install, onboarding, tabs, Body flows, timezone, export/import, offline, update flow, upgrade from an older database). Each screenshot is tagged with the stage it documents; a run writes only `$E2E_STAGE`'s (default: the newest stage) to `docs/screenshots/<stage>/`. When you add a stage, bump the default and tag its new shots. In Claude Code cloud sessions Chromium is preinstalled; don't run `playwright install`.
- `npm run serve`: the app at `http://localhost:8080/WMCoach/`, the same path as GitHub Pages.
- `npm run build:program`: regenerate `data/program.json` from `training_history.json` (a test fails if it's stale).
- `npm run fixture`: regenerate `tests/fixtures/backup-sample.json` (current schema, with records in every store). Prefer a real export from Walter when he provides one. Older fixtures (`backup-v1.json`, …) are **frozen**: they prove an old phone's data still upgrades. Never regenerate or delete them.

## Releasing (every PR that changes the app)
1. Bump the version in **three** places: `app/version.js` (`APP_VERSION`), `sw.js` (`CACHE_VERSION`), `package.json` (`version`). A test checks they match.
2. A new file under `app/`, `coach/` or `icons/` must be added to `SHELL_FILES` in `sw.js`, or it won't work offline (a test checks this).
3. Schema change: append a migration to `MIGRATIONS` in `app/db.js`. Add stores or fields only. If records need defaults, add `migrateRecord` (it runs on stored data and on imported older backups). Then freeze the old sample (`cp tests/fixtures/backup-sample.json tests/fixtures/backup-v<old>.json`), run `npm run fixture` (add sample records for the new stores in `scripts/make_fixture.mjs`) and `npm run test:migration`.
4. `npm test` and `npm run e2e` pass. Attach the e2e screenshots to the PR.
5. Rollback = `git revert` the release commit. Pages redeploys the previous version; the data is untouched.

## How updates reach the phone
The new service worker installs in the background and waits. Walter sees "Update available" and taps Reload. The app first saves a local snapshot (last 3 kept, Settings → Local snapshots), then the new version takes over. Never call `skipWaiting()` automatically and never auto-reload. The banner stays hidden while a workout session is in progress (`ctx.sessionInProgress()`).

## Records
- Daily records (weigh-ins, measurements, check-ins, on-plan taps) are written with `saveDaily()` in `app/records.js`: saving again for a date edits that day's entry made in the same zone.
- Nothing is hard-deleted in the app. `removeRecord()` leaves a tombstone (`deleted: true`, `deleted_utc`) so sync and a newer-wins merge can't resurrect it. Read with `live()`.
- Mode switches never change the current week: they're saved to `mode_changes` and `settings.pending_mode`, and `applyPendingMode()` (`coach/phase.js`) makes them take effect on-device on the next prep day.

## Timezone
Walter travels. "Today" always means his current local date in the zone from `settings.tz_current`. It follows the iPhone by default (Settings → Timezone); `coach/time.js` has the helpers. Every stored entry carries `utc`, `local_date` and `tz`. Daily records are keyed by `local_date` and never auto-merged when a date repeats after a date-line crossing.
