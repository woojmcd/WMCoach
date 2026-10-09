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
- Never commit tokens or secrets. That includes the VAPID private key (`scripts/vapid_keys.mjs` writes it to a file outside the repo; it belongs only in the daily routine's credentials).

## Working with Walter
- Build in the stages Walter asks for; open a PR per stage and stop for him to test on his iPhone.
- Ask only when the spec doesn't answer something; otherwise use the defaults in spec §13.

## Decisions Walter has made (don't re-ask)
- **The repo stays public** (2026-10-09), so GitHub Pages works on a free account. Synced data under `data/` (`log/`, `health/`, `strava/`, …) is publicly readable; Walter accepted that. Still never commit tokens or secrets.
- **Check-in prompts** (2026-10-09). On check-in day the Body tab shows a filled "Log measurements & check-in" button under Weight (a gold link on other days), and the Week tab shows a banner. Walter also wants a **push notification on the morning of check-in day**. iOS home-screen web apps can't schedule local notifications, so it is sent by the daily routine via Web Push (spec §8.4). Stage 5 (done): Settings → Notifications asks permission from a button in the installed app and syncs the subscription to `data/log/push_subscription.json`. Stage 6: `ops/daily_prompt.md` sends it on the morning run of check-in day. Until then Walter can use a one-line iOS Shortcut reminder.
- **Week in review** (2026-10-09). After each weekly check-in the Week tab shows an executive summary of the past 7 days and the plan change: blunt, but encouraging, never downplaying the numbers. It stays up through the plan week that follows (until the next check-in replaces it).

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

## Training (stage 3)
- Progression is pure code in `coach/progression.js` (`targetFor`, `planDay`, `deloadStatus`, `programWeek`), covering every spec §6.2 type, stalls, the cut rule, deloads (§6.4) and the "lifted less since May" easing (§2a). The daily routine must reuse it, not re-implement it.
- One `sessions` record per workout with its sets nested. The Log tab shows a draft built from `planDay()`. The first logged set saves it (`in_progress`, update banner hidden). "Finish session" marks it `finished` and shows next targets. A session left open past its day is auto-finished at the next launch.
- History for a slot is keyed by slot id + movement, so a swapped exercise starts with a calibration (spec §5). Deload sessions never count toward progression.
- Program weeks: week 1 is the first Mon–Sun week of training; a first session on Fri–Sun is a lead-in week 0. Deloads fall every 6th week, or early after rep drops on 3 main lifts.
- Training loads are always in lb (gym equipment); the units setting only changes body weight and lengths.

## Meals (stage 4)
- Macro math is pure code in `coach/meals.js`: kcal = round(4P + 4C + 9F) per day, Python half-even rounding (`roundHalfEven`), and the weekly average comes from the rounded day values. This reproduces every plan in `data/plans.json` exactly (a test checks it). Carb steps follow spec §8.0 (odd steps: post-workout rice +70 g and +1 rice cake; even steps: M4 sweet potato +100 g and +1 rice cake). The routine must reuse these functions.
- The §8.0 starting plan is CUT26-V4 MP2 every day; `startingPlan()` picks the carb step nearest the target from `data/plans.json`.
- One `plans` record per prep week (`week_start` = prep day, locked 7 days). `ensurePlans()` (`app/meal-plans.js`) seeds the first one and, if no plan covers today, carries the latest forward on the phone. A published plan from the weekly run (stage 6) supersedes the carried one.
- Every plan stores `changes` from `diffPlans(previous, next)`; the Meals tab shows them as "What changed", and the Week tab shows a banner from the day before the new week starts.
- GI flags live in the `foods` store (`gi_flag: true`). The plan generator (stage 6) must avoid flagged foods and offer the `SWAPS`.
- Grocery amounts are raw or store units (meat ≈ cooked ÷ 0.75, dry rice ≈ cooked ÷ 3). Ticks are a per-phone convenience in `localStorage` (`wm.grocery.<week_start>`), not synced.

## Week in review (weekly executive summary)
- `weeklySummary()` in `coach/summary.js` (pure; the weekly routine reuses it and adds its macro decision). It reviews the 7 days ending on the check-in, in spec §10 order: adherence, weigh-ins, rate vs the mode's band, training (sessions, main lifts by best-set e1RM, increases, resets), waist vs limbs, biofeedback, then the plan. The headline names the first problem in that order, then the wins; "Focus" is one action.
- Tone: state the number and what it means. Don't soften a miss (adherence 50 % is "too low to judge anything"), and always report what went well. Days before the first logged session are never "missed".
- Shown from the check-in through the plan week after it (`summaryVisibleUntil`). Open on check-in day and the day after, folded to the headline later.

## GitHub sync and notifications (stage 5)
- `app/sync.js` (engine, works in Node) and `app/sync-ui.js` (queue, badge, Settings, Restore). The phone is the only writer of `data/log/`: monthly files per store (`data/log/<store>/YYYY-MM.json`), single files for phases, exercise prefs, foods and the synced meta (`settings.json`, `onboarding.json`, `push_subscription.json`). Seeded history (`source: "history"`) is not copied; Restore re-seeds it.
- One commit per sync through the Git Data API (`log YYYY-MM-DD (<tz>): n records`). Each file is merged with the repo's copy (newer `updated_utc` wins, repo-only records kept), so a wiped phone can't erase history. A non-fast-forward (the routine pushed meanwhile) rebuilds on the new head.
- Triggers: 8 s after a write (`onWrite` in `app/db.js`), on launch, when signal returns, and when the app is hidden. Held while a workout is in progress (one commit per session, which also keeps Pages under ~10 builds/hour once it serves `main`). Failures back off 15 s → 30 min; a bad token or missing access pauses until Settings. Never a blocking error: just the "Unsynced (n)" / "Sync paused" badge in the header.
- The token and sync state are meta keys `github` and `sync` (`PRIVATE_META`): never exported, synced, or overwritten by an import.
- Restore from GitHub: onboarding rebuilds an empty phone (`seedFromRemote`); Settings merges (never Replace: the repo doesn't hold the seeded history).
- Push: `app/push.js`, public key in `app/push-config.js`. The service worker shows `{ title, body, url, tag }` payloads and opens only URLs inside the app's scope. Walter's guide: `docs/github-sync.md`.
- Pulling routine outputs (`data/plan/`, `data/targets/`) into the phone comes with stage 6, together with their formats.

## Timezone
Walter travels. "Today" always means his current local date in the zone from `settings.tz_current`. It follows the iPhone by default (Settings → Timezone); `coach/time.js` has the helpers. Every stored entry carries `utc`, `local_date` and `tz`. Daily records are keyed by `local_date` and never auto-merged when a date repeats after a date-line crossing.
