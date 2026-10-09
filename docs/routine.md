# Set up the daily coach run (once, about 20 minutes)

The daily run (spec §7) is a Claude Code **routine**: a cloud session that wakes each morning, reads what your phone and the Health Shortcut pushed, and does these things:
- works out readiness and today's targets;
- on Saturdays, decides next week's plan;
- commits all of it to `main`;
- sends your notifications.

The steps follow in order. Afterwards, set up the Health Shortcut in [`docs/shortcut.md`](shortcut.md); it is what starts the run each morning.

## 1. GitHub Pages serves `main`
GitHub → WMCoach → **Settings** → **Pages** → **Branch: `main`**, folder `/ (root)` → Save.

`main` is where the app's releases, the coach run and your phone's sync all land. Pages was on the build branch only while the stages were being built. The app's address stays the same (`https://woojmcd.github.io/WMCoach/`), so the phone keeps all its data.

## 2. A cloud environment for the routine
At [claude.ai/code](https://claude.ai/code), make a new cloud environment named **WMCoach coach**. A separate one keeps the key below out of your other sessions.
- **Network access → Custom.**
  - In **Allowed domains**, add `web.push.apple.com` (where notifications go).
  - Tick **Also include default list of common package managers**.
  - GitHub and the Strava connector work without being listed.
- **Environment variables**: one line, using the private key from the `wmcoach-vapid-keys.txt` file I sent you:
  ```
  VAPID_PRIVATE_KEY=<the VAPID_PRIVATE_KEY value from that file>
  ```
  Don't use **Network secrets** for this one. The run signs notifications with the key itself, so it has to be readable in the session; a network secret is only added to outgoing requests. Anyone who uses this environment can read it, which is why it's separate.
- Setup script: none needed (Node is preinstalled; the scripts have no dependencies).

## 3. The routine
At [claude.ai/code/routines](https://claude.ai/code/routines) → **New routine**:
- **Name:** `coach-daily`
- **Prompt:** `Follow ops/daily_prompt.md.` (one line: the real instructions live in the repo, so changing them is a normal reviewed change)
- **Repository:** `woojmcd/WMCoach`
- **Environment:** WMCoach coach
- **Trigger: Schedule**. Two daily schedules in Los Angeles time, at **10:07** and **18:07**. These are backups for days the Shortcut doesn't fire. They do nothing on a normal day, because the morning run already happened. Keep them after your usual wake time, or a backup could run before your Health data is in.
- **Connectors:** remove everything except **Strava**.
- **Create**.

Then add the API trigger the Shortcut calls: open the routine → menu next to its name → **Edit** → **Select a trigger** → **Add another trigger** → **API**.
1. Copy the **URL**. It looks like `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`.
2. Click **Generate token** and copy the token straight into the Shortcut (step 4 of `docs/shortcut.md`) or your password manager. It is shown once.
3. The Shortcut sends these headers: `Authorization: Bearer <token>`, `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`. If the modal's sample curl shows a newer `anthropic-beta` value, use that one.

## 4. First run
On the routine's page click **Run now**, then open the run and read it (a green status only means it didn't crash). In order, you should see:
1. The Strava tools in use. If the transcript says they aren't available, check the routine's connectors.
2. A commit on `main` named `daily YYYY-MM-DD (America/Los_Angeles)`, with `data/targets/today.json` and `data/model/state.json`.
3. On your phone: a notification, **"WMCoach coach run is on"** (needs Settings → Notifications turned on in the app).
4. In the app, a minute later: Log shows today's readiness. If today's Health file is missing, a **Sync Health** chip shows.

If the notification doesn't come, the run's last lines say why: the key is missing, `web.push.apple.com` isn't allowed, or the phone has no subscription.

## What it does each day
| When (your local time) | What |
|---|---|
| Every morning, via the Shortcut | Readiness from overnight HRV, resting HR and sleep, plus Strava load before leg day. Today's targets with a one-line reason per held exercise (`data/targets/today.json`). Refuel carbs after a long, late ride or run. |
| Check-in day (yours: Monday) | A morning notification: "Check-in today". |
| The day before prep day (Saturday) | The weekly macro step: adherence, weigh-ins, rate, strength, waist and recovery, in the check-in order (spec §10). At most one change of ≤ 150 kcal, carbs first. It publishes `data/plan/next.json`, adds a changelog entry and sends a notification, changed or not. |
| Prep day (Sunday) | Next week's plan becomes `data/plan/current.json` (the phone swaps on its own too). |
| A late Health file | If the morning run had no Health data and it arrives later, the next fire redoes readiness and targets only, once. |

Weeks 1–2 of the bulk are observe-only. The first possible change is the Saturday after you have 2 full weeks and 10 weigh-ins since setup.

## Changing it later
- **What the run does:** edit `ops/daily_prompt.md` or the scripts in a normal pull request. The routine reads them from `main` on every run.
- **Pause it:** the on/off switch on the routine's page.
- **New notification keys:** run `node scripts/vapid_keys.mjs <file outside the repo>`, put the new public key in `app/push-config.js` (release), replace `VAPID_PRIVATE_KEY` in the environment, then tap **Turn on notifications** again on the phone.
