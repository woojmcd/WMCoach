# GitHub sync: set up once on the iPhone

The app copies everything you log to `data/log/` in the WMCoach repo, a few seconds after each change (a workout once you finish it). The daily coach run reads it from there, and it doubles as a second backup. If a sync fails (no signal), the app keeps working and retries on its own; a small **Unsynced (n)** badge shows next to the date until it catches up.

## 1. Make a token (about 2 minutes, on github.com)

1. Profile photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `WMCoach phone`.
3. **Expiration:** the longest it offers. When it runs out, the app shows **Sync paused**; make a new one and use **Change token** (step 2 below).
4. **Repository access:** *Only select repositories* → `woojmcd/WMCoach`.
5. **Permissions → Repository permissions → Contents:** *Read and write*. (Metadata: read-only is added automatically.) Nothing else.
6. **Generate token** and copy it (it starts with `github_pat_`). Save it in your password manager too: the Health Shortcut (stage 6) can use the same token.

## 2. Connect the app

History → ⚙︎ Settings → **GitHub sync** → **Connect GitHub** → paste the token → **Connect**. Repository `woojmcd/WMCoach` and branch `main` are filled in.

If the repo already has a log (a new phone), the app offers to bring it onto the phone first. That's a merge: nothing on the phone is replaced by an older entry.

## What goes where

| File | What |
|---|---|
| `data/log/weighins/YYYY-MM.json` | weigh-ins logged on the phone (the seeded history stays in `data/weight_daily.csv`) |
| `data/log/sessions/YYYY-MM.json` | workouts, sets nested |
| `data/log/measurements/`, `checkins/`, `adherence/`, `stairs/`, `mode_changes/` | by month |
| `data/log/plans/YYYY-MM.json` | the meal plan the phone used each prep week |
| `data/log/phases.json`, `exercise_prefs.json`, `foods.json` | phases, exercise swaps and increments, GI flags |
| `data/log/settings.json`, `onboarding.json` | settings (including timezone history) |
| `data/log/push_subscription.json` | where to send notifications (useless without the private key, which is never in the repo) |

Each sync is **one commit** (`log 2026-10-16 (America/Los_Angeles): 3 records`). Deleted entries stay as tombstones (`"deleted": true`), so they can't come back.

**Privacy.** The repo is public, so everything in `data/` is readable by anyone with the link. The token never leaves the phone: it isn't synced, and it isn't in exported backups (after restoring from a backup file, paste it again).

## Restore on a new or wiped phone

Open the app → on the setup screen tap **Restore from GitHub** → paste the token → **Restore**. Your history is re-seeded, and everything from `data/log/` comes back.

On a phone that's already set up, Settings → GitHub sync → **Restore from GitHub** merges the repo's log into the phone (the newer entry wins).

## Notifications

Settings → **Notifications** → **Turn on notifications**, and allow when iOS asks. This works only in the home-screen app (iOS 16.4 or later). **Send a test** checks it right away. The daily coach run (stage 6) sends one on the morning of check-in day and one when next week's plan is ready.
