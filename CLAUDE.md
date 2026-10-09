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
