# APP SPEC: Walter's coaching PWA

**For:** the agent building and running the app.
**Read with:**
- `claude/AGENT_BRIEF.md`: history, metabolism priors, and the TDEE/nutrition math (its §5).
- `claude/TRAINING_HISTORY.md` + `data/training_history.json`: the lifting programs from his previous coach. **Program C (`TRAIN-CUT26`) is the program this app runs.**

This spec covers the app, the automation, the training program and the coaching rules. Where documents overlap on **app behaviour, cadence or the training program**, this spec wins. For **energy-expenditure math and macro floors**, the brief and `data/metabolic_profile.json` win.

Status: decisions agreed with Walter on 2026-10-08 (revised the same evening: Program C split, bulk start from the CUT26-V4 meal template, timezone handling, dark minimal design). Items still open are in §13. Don't invent answers to them; use the stated defaults.

---

## 1. Goals in one paragraph

An installable iPhone PWA on GitHub Pages that works fully offline with no login. Walter logs sets/reps/RIR, daily weight, and weekly measurements. A Cut / Maintenance / Bulk switch drives the coaching; **the app starts in Bulk**. Every morning (in whatever timezone he's in), Claude pulls Strava and Apple Health data, sets that day's lift targets, and updates the trend. Macros change **at most once a week, on a fixed schedule tied to his meal-prep day**, and he is always told whether they changed. The look is **minimalist, high-end and dark**. Everything is backed up by git history and a weekly JSON export.

---

## 2. Architecture and data flow

```
iPhone PWA (offline-first, IndexedDB)
   │  sync when online: GitHub Contents API, fine-grained PAT (this repo only, contents: read/write),
   │  pasted once in Settings; no login screen
   ▼
GitHub repo ──► GitHub Pages (serves app + data)
   ▲        ▲
   │        └── iOS Shortcut, once a day on the first morning unlock (phone time, so it travels with him):
   │              1. reads Apple Health → commits data/health/YYYY-MM-DD.json
   │              2. POSTs the routine's API trigger to start the daily run
   │              (Health can't be read while the iPhone is locked, so it can't run at a fixed
   │               pre-dawn time; see §12)
   │
Claude Code routine "coach-daily" (cloud; fresh session that clones the repo each run)
   • Triggers: API fire from the Shortcut (primary) + two backup schedules (§2b)
   • Every run: Strava + Health + log → today's lift targets, trend, readiness
   • On the local day before prep day: also the weekly macro decision → next week's plan,
     grocery list, notification (§8)
```

Routine set-up notes (Claude Code routines):
- The prompt must tell Claude to **commit and push directly to `main`**. By default a routine pushes to `claude/`-prefixed branches, which GitHub Pages doesn't serve.
- Include only the Strava connector. On the first **Run now**, confirm the transcript actually shows Strava tools; a green run status does not prove the connector loaded.
- The API trigger's `text` payload arrives as untrusted data. The routine reads timezone, dates and everything else **from the repo**, not from the payload.

**One writer per path, so there are never merge conflicts:**

| Path | Written by | Contents |
|---|---|---|
| `data/log/` | PWA only | sets, weigh-ins, measurements, check-in form, mode switches, adherence, stairs taps, `settings.json` (incl. timezone history) |
| `data/health/` | iOS Shortcut only | overnight HRV, resting HR, sleep duration, steps, Health weight (if permission on) |
| `data/strava/` | daily routine only | normalized activity summaries (type, start, duration, distance, avg/max HR, time in HR zones, relative effort, kcal) |
| `data/targets/` | daily routine only | `today.json`: per-exercise targets + readiness status + reason strings, keyed by Walter's **local** date |
| `data/plan/` | daily routine (weekly step) only | `current.json` (locked week), `next.json` (published the day before prep), `changelog.json` |
| `data/model/` | daily routine only | `state.json`: TDEE estimate, trend, phase history, progression state, `last_daily_run_local_date`, `last_weekly_run_week` |

The PWA always works from its local copy. Sync is a background queue: local writes are applied immediately and pushed when there's signal. Remote files are pulled when online. If a sync fails, retry with backoff, and show a small "unsynced (n)" badge, never a blocking error.

Strava linking began mid-2026. Use Strava for cardio from that point on. Earlier cardio history comes from the Apple Health export already described in the brief.

### 2a. Seeding from history (first build)

The app must not start blank. On first build:
- **Weight history:** import `data/weight_daily.csv` (279 weigh-ins, 2024-12-28 → 2026-05-14) into the log as historical entries, so the trend graph starts with 17 months of data. Shade it by phase using the cut/bulk/break dates in `metabolic_profile.json` (breaks shown as their own neutral band).
- **Model priors:** seed `data/model/state.json` from `data/metabolic_profile.json`: base maintenance 13.2 kcal/lb (± 250) + cardio, the cardio model (stairs 5.4 net MET, runs ≈ 70 kcal/km), 3,500 / 2,750 kcal per lb, rate bands and macro floors. The adaptive TDEE estimate starts from this prior and moves toward observed data as weigh-ins accrue (brief §5).
- **Food DB and meal template:** seed from `data/plans.json`. **CUT26-V4 is the template all future plans grow from** (same meals, foods, cooked weights, swaps). The starting bulk plan is in §8.0.
- **Training program:** generate `data/program.json` from `TRAIN-CUT26` in `data/training_history.json` (§5). Keep A and B as read-only history.
- **Lift loads:** the coach history has no loads. If Strava holds recent strength workouts with sets/loads (Strava connector, strength workout details), seed starting targets from the most recent session per exercise; otherwise the first session of each exercise is a calibration session (§5).
- **The gap since 2026-05-14:** the package has no weigh-ins after that date, and Apple Health shows ~1 logged lift/wk and ~1 run/wk since then. So:
  - Ask for current weight on first launch. If Walter turns on Health read permission for Weight, import the 152 weigh-ins since 2026-05-10 first.
  - Start in **Bulk** with the §8.0 plan. Weeks 1–2 are **observe-only**: no macro changes until ≥ 10 new weigh-ins exist and 2 full weeks have passed, then the first real check-in.
  - If Walter confirms he has lifted less since May, run weeks 1–2 at target RIR + 1 with no load increases in week 1.

### 2b. Timezone (Walter travels a lot)

Everything that means "today", "this morning" or "Saturday" is in **Walter's current local time**, never a fixed server zone.

- **Settings → Timezone:** `Auto (follow iPhone)` by default, with a manual override (searchable IANA list, e.g. `Asia/Tokyo`). The PWA reads `Intl.DateTimeFormat().resolvedOptions().timeZone` on every launch; when it differs from the stored zone, it shows a one-line toast ("Now on Tokyo time") and appends `{tz, from_utc}` to `data/log/settings.json`.
- **Records:** store every entry as UTC timestamp + `local_date` + `tz` at the time of entry. Daily records (weigh-ins, sessions, on-plan taps) are keyed by `local_date`, so a flight never creates a missing or duplicated day. If a timezone jump makes a calendar day repeat or vanish, keep the entries as logged and never auto-merge them.
- **On-device clock (works offline):** today's workout, the week strip, rest timers, check-in/measurement prompts and the prep-day plan swap all use the phone's current local time. The Sunday `next.json → current.json` swap happens on-device at local midnight of prep day if the routine hasn't done it.
- **Daily routine timing:**
  - Primary: the iOS Shortcut fires the routine's API trigger right after its Health commit, on Walter's first unlocked use of the phone each morning (§12). Automations follow the phone's clock, so this happens in his morning wherever he is.
  - Backup: two schedule triggers (e.g. 10:07 and 18:07 in his home zone, America/Los_Angeles). These cover a day the Shortcut didn't run. They must not be earlier than his usual wake time, or they would claim the day before the Health data arrives.
  - Every run is **idempotent**: it reads the current zone from `settings.json`, computes Walter's local date, and exits early if `last_daily_run_local_date` already equals it. Backup runs do nothing on normal days.
  - Exception: if the day's run happened without `data/health/<local date>.json` and that file appears later, the next fire recomputes **readiness and today's targets only** (no plan or model changes), once.
- **Weekly step:** runs inside the daily run when the local weekday is the day before prep day (default Saturday) and `last_weekly_run_week` isn't this week. Missing Saturday entirely (e.g. no signal) → the first run on prep day does it, before the swap.
- **Readiness baselines** use nightly values regardless of zone. On the first 2 nights after a shift of ≥ 3 h, flag "travel" and cap readiness at Amber instead of Red: jet lag skews HRV and sleep, and the data isn't telling us about training fatigue.
- **Travel mode** (§4.4) is separate from the timezone and is still a manual toggle.

---

## 3. PWA requirements (iPhone)

- `manifest.webmanifest`: `name`, `short_name`, `start_url: "./"`, `scope: "./"`, `display: "standalone"`, `orientation: "portrait"`, `theme_color` and `background_color` both set to the app background (`#0A0A0B`), and 192 + 512 icons.
- `<head>`:
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  - `apple-mobile-web-app-capable` = `yes`
  - `apple-mobile-web-app-status-bar-style` = `black-translucent`
  - `apple-mobile-web-app-title`
  - `<meta name="color-scheme" content="dark">`
  - `<link rel="apple-touch-icon" href="icons/apple-touch-icon-180.png">` (180×180 PNG; iOS ignores manifest icons for the home screen)
- Pad the layout with `env(safe-area-inset-*)` so nothing sits under the notch or home indicator.
- **Service worker (small):**
  - App shell (HTML/CSS/JS/icons/fonts): cache-first. Version the cache name on every release and delete old caches on `activate`.
  - `data/plan/*`, `data/targets/*`: network-first with a short timeout, falling back to cache. This prevents a stale meal plan or stale targets.
  - Everything else under `data/`: stale-while-revalidate.
- Call `navigator.storage.persist()` on first run.
- Install instructions on first launch in a browser tab: Safari → Share → Add to Home Screen. Explain that Safari-tab data and home-screen-app data are stored separately, so log only in the installed app.
- **Mobile-first:** portrait, minimum width 320 pt, no horizontal scroll ever (tables become stacked cards; charts fit the container width), tap targets ≥ 44×44 pt, numeric inputs use `inputmode="decimal"`, steppers instead of the keyboard wherever possible.

### 3a. Visual design: minimalist, high-end, dark

Dark only (no light theme). The feel is a premium instrument: quiet, precise, lots of space, one accent used sparingly.

- **Palette** (define as CSS custom properties on `:root`):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0A0A0B` | app background, status bar |
| `--surface-1` | `#131315` | cards, tab bar |
| `--surface-2` | `#1B1B1E` | inputs, pressed states, sheets |
| `--hairline` | `rgba(255,255,255,0.07)` | 1 px dividers and card borders (no drop shadows) |
| `--text` | `#EDEDEF` | primary text and numbers |
| `--text-2` | `#8E8E93` | labels, secondary text |
| `--text-3` | `#5A5A60` | placeholders, disabled |
| `--accent` | `#D4B477` | the single accent (muted champagne): primary actions, trend line, active tab, ✓ |
| `--accent-dim` | `rgba(212,180,119,0.14)` | selected chip / segment fill |
| `--good` / `--warn` / `--bad` | `#7FB38A` / `#D9A441` / `#D46A5F` | readiness and status only; never decorative |
| Phase tints (chart bands) | Cut `rgba(110,150,200,0.08)`, Maintenance `rgba(255,255,255,0.04)`, Bulk `rgba(212,180,119,0.08)`, Break `rgba(255,255,255,0.02)` + hatching | |

  All text meets WCAG AA on its surface. Status colours always come with a word or icon, never colour alone.
- **Type:** the system stack (`-apple-system, "SF Pro Text", system-ui, sans-serif`), so it feels native and needs no font download. Numbers use `font-variant-numeric: tabular-nums` so weights and reps don't jitter. Hero numbers (today's weight, trend, target load) are large (34–44 pt) and light (weight 300). Section labels are small (12–13 pt), uppercase, letter-spacing 0.08 em, in `--text-2`. Body 15–17 pt. Two weights only: 300 for big numbers, 500–600 for labels and buttons.
- **Layout:** 8 pt spacing grid; 16–20 pt side gutters; cards with 16 pt radius and a hairline border; generous vertical space; one primary action per screen. No gradients, no heavy shadows, no emoji, no illustrations.
- **Icons:** thin-stroke (1.5 px) line icons, one consistent set, inline SVG.
- **Charts:** no gridline clutter: 3–4 faint horizontal guides at most, `--text-3` axis labels, raw weigh-ins as small 30 %-opacity dots, the trend as a 2 px `--accent` line, phase bands as the tints above.
- **Motion:** 150–200 ms ease-out for sheets and state changes; a short scale/opacity confirmation when a set is logged; nothing else animates. Respect `prefers-reduced-motion`.
- **Tab bar:** 5 line icons with small labels, translucent `--surface-1` with a backdrop blur, `--accent` for the active tab.
- **App icon:** a simple monogram on `--bg` in `--accent`; no gradients.

---

## 4. Screens (bottom tab bar, 5 tabs)

### 4.1 Week
- Mon–Sun strip for the current week in local time; today highlighted. Mon–Fri show the session name (Push #1, Pull #1, Legs and abs, Upper Push #2, Upper Pull #2); Sat/Sun show "Open: cardio / social" plus any Strava activity logged.
- Tap a day to open that day's workout (logging view for today; read-only for past days; preview of targets for future days).
- A banner area for plan notices (see §8.4).

### 4.2 Log (today's session)
For each exercise, in program order. Supersets are shown as a linked pair (A1 / A2) on one card:
```
FLAT DB BENCH                  Target 75 × 8–10 @ 1 RIR
Last: 70 × 10, 10 · backoff 50 × 12             ▲ +5 lb
Set 1        [ 75] [ 9 ]  RIR [1]   ✓
Set 2        [ 75] [ 8 ]  RIR [1]   ✓
Backoff      [ 55] [12 ]             ✓
```
- Inputs **prefilled with the target**. If he hit it, one tap on ✓ logs the set.
- Weight and reps change via ± steppers (weight step = the exercise's increment; reps ±1). Tapping the number opens the keypad as a fallback.
- RIR chips: 0 1 2 3 4+. AMRAP / "to failure" sets default to RIR 0 and hide the chips.
- Superset partner A2 is prefilled with A1's load (same-weight finishers) and only asks for reps.
- Timed items (planks, vacuums, Russian twists) show a single ✓ with the prescribed time; no load.
- The coach's technique cue (e.g. "SLOW, DEEP, stretch as far as possible") shows under the exercise name in `--text-2`.
- Logging a set starts a rest timer using the program's rest: **90 s** default, **15 s** between superset partners and where the program says 15 s; editable.
- If readiness modified a target, show a chip with the reason, e.g. "Held at 75: HRV low, 2 h ride yesterday."
- Quick actions: swap exercise (from a per-exercise alternates list), add/skip a set, note.
- "Finish session" saves the log, and the app immediately computes the baseline next-session targets on-device (§6.2), so progression works offline even if the daily run never comes.
- On weekend days, the Log tab shows a one-tap **"Stairs ✓ (__ min)"** fallback for sessions that don't reach Strava.
- Every day, a cardio card shows the coach's cardio for today with the lifts (§6.5).

### 4.3 Body
Top to bottom:
1. **Mode switch** (segmented): Cut | Maintenance | Bulk. **Starts on Bulk.** Changing it requires a confirm sheet. It is saved with a timestamp to `data/log/` and takes effect on the next prep day (§8.3). Shows the current phase length and its end condition.
2. **Daily weight** entry: one field defaulting to today (local date); can backdate for missed days; morning fasted, after the bathroom.
3. **Weekly measurements card** (appears on check-in day, Friday; collapses once logged): waist, neck, chest, arm, thigh (§9), each entered twice and averaged automatically. Placeholders show last week's values.
4. **Weekly check-in form** (Friday, same card): adherence this week (auto-filled from daily on-plan taps, editable), biofeedback 1–5 for hunger, energy, sleep, stress and digestion, and an optional note.
5. **Trend graph:**
   - Faint raw weigh-in dots with the EWMA trend line on top (half-life 7 d).
   - Background shaded by phase (§3a tints).
   - A rate badge (current %BW/wk) next to the target band for the current mode.
   - Range toggles: 4 wk / 12 wk / all.
   - An overlay selector: none / waist / body-fat estimate, plotted on a secondary axis.
6. A daily **"On plan today?"** tap: Yes / Partial / Off (optional kcal estimate). This feeds the adherence gate.

### 4.4 Meals
- **This week's plan** (`current.json`) in Walter's format (meals → foods → cooked weights), with daily and weekly macros. Carb-cycle mode shows MP1/MP2 by day.
- A **"What changed"** card at the top whenever this week differs from last week (food-weight diffs, e.g. "Post-workout rice 270 → 340 g").
- **Prep list:** total cooked weight per food for the week (× days, split by MP1/MP2 if cycling) plus a grocery list in raw/store units.
- **Endurance add-ons** (§8.5) appear here and on the Week tab on the days they apply, separate from prepped meals.
- **Travel mode** toggle: hides meals and shows targets only (P / kcal / cardio), as the previous coach did.
- Foods can be flagged for GI issues; the generator avoids flagged foods.

### 4.5 History
- Session list by date; tap for the full log.
- Per-exercise trend: estimated 1RM (Epley, from the best non-backoff set) and top-set load over time, with PR markers. AMRAP exercises chart total reps.
- Weekly volume (hard sets) per muscle group vs the 10–20 set band (Program C counts in `TRAINING_HISTORY.md`).
- Measurement history; phase timeline.
- **Settings** (gear icon): GitHub token, **timezone** (§2b), height (for body-fat estimate), prep day, check-in day, rest timer defaults, units, exercise alternates, **Export / Import** (§11).

---

## 5. Training program: Program C (current; stays fixed unless Walter changes it)

Source of truth: `TRAIN-CUT26` in `data/training_history.json` (full prescriptions, rest, groups, cues, alternates). Generate `data/program.json` from it. Walter's favourite split; he ran it through the 2026 cut and since. He'll ask when he wants it changed.

5 days, Mon–Fri. Sat/Sun are open: stairs by default, or runs, rides, swims and social sessions, all read from Strava. Rest 90 s unless stated; supersets have 15 s (or 0) between partners.

| Day | Exercise | Prescription | Type (§6.2) |
|---|---|---|---|
| **Mon Push #1** | Incline DB Flyes | 3 × 8–10 · *slow, deep stretch* | range |
| | Flat DB Bench | 2 × 8–10, then 1 × 12 at ~30 % less | top + backoff |
| | Chest Dips | 4 × AMRAP | amrap |
| | Single Cable Lateral Raise | 3 × 12–15 each side | range |
| | Standing Lateral DB Raises | 3 × 10–12 | range |
| | A1 Rope Tricep Extensions → A2 Rope Pushdowns | 3 × 10–12 → same weight AMRAP · 15 s | superset (same weight) |
| | B1 Cable Ab Crunches → B2 Ab Vacuum | 3 × 15 heavy → 15 s hold | range (fixed 15) + timed |
| **Tue Pull #1** | Assisted Pullups | 3 × 6+ (least assistance possible) | assisted |
| | Incline DB Rows (upper back) | 3 × 10 · *elbows far back* | fixed |
| | Hammer Pulldowns | 3 × 8–10 · *heavy, deep stretch* | range |
| | Cable Lat Pullovers | 3 × 10+ · *to 3–4 partials* | open range |
| | Reverse DB Flyes | 3 × 10–12 | range |
| | A1 Reverse Cable Curls → A2 Cable Bar Curls | 3 × 8–10 → same weight to failure · 15 s | superset (same weight) |
| **Wed Legs and abs** | Hamstring Hyperextensions | 3 × AMRAP | amrap |
| | Machine Adductors | 3 × 12–15 | range |
| | Single Leg Press | 3 × 10–12 each side | range |
| | BB Squats (Smith) | 2 × 8–10 | range |
| | Seated Hamstring Curls | 2 × 8–10, then 1 lighter × 12–15 · *huge squeeze* | top + backoff |
| | A1 Hanging Leg Raises → A2 Russian Twists | 3 × AMRAP → 30 s | amrap + timed |
| **Thu Upper Push #2** | Pec Deck Flyes (alt: cable / flat DB flyes) | 3 × 12–15 | range |
| | Incline DB Bench | 2 × 8–10, then 1 backoff ~30 % less AMRAP | top + backoff |
| | Flat Smith Machine Bench | 3 × 10–12 | range |
| | A1 Seated Lateral DB Raises → A2 Standing Lateral DB Raises | 4 × 10 → same weight to failure (5+ partials) · 15 s | superset (same weight) |
| | Single Arm Cable Pushdowns | 3 × 10–12 each side · 15 s rest | range |
| | Incline DB Skullcrushers | 3 × 12–15 · 15 s rest | range |
| **Fri Upper Pull #2** | Reverse Pec Deck Flyes (alt: reverse cable / DB) | 3 × 10–12 | range |
| | Cable Lat Pullovers | 3 × 12–15 | range |
| | Single Arm DB Rows | 3 × 8–10 | range |
| | Single Arm Cable Pulldowns | 3 × 10 · *heavy, big stretch, elbow to side* | fixed |
| | Incline DB Curls | 3 × 8–10 · *to failure, heavy* | range |
| | Hammer Rope Curls | 3 × 12–15 | range |
| | A1 Cable Ab Crunches → A2 Ab Plank | 3 × 15 → 30 s | range (fixed 15) + timed |

**Target RIR** (the coach trained close to failure; keep that): the first/heaviest exercise of each day and top sets at **1**; other isolation work **0–1**; AMRAP, "to failure" and same-weight finishers **0**.

Store per exercise in `program.json`: day, order, sets, rep scheme, type, target RIR, rest, superset group, cue, load increment, alternates. Walter may swap exercises; progression state carries over only when the movement is the same.

Starting loads: see §2a (Strava seed if available, else the first session is calibration: he logs a working weight and progression starts from there).

---

## 6. Progression

### 6.1 Increments
Dumbbells: next DB (+5 lb/hand), so use reps first · Smith machine: +5 lb upper, +10 lb lower · Machines/cables: next pin/plate · Assisted pullups: one pin **less** assistance · Dips/pullups at bodyweight: +reps, then +5 lb on a belt.

### 6.2 Progression by exercise type (computed on-device after each session, re-checked by the daily run)
- **range** (e.g. 8–10): double progression. If **all** working sets reach the top of the range with logged RIR no more than 1 below target, next session = load + increment, reps reset to the bottom. Otherwise keep the load and aim for +1 rep on the sets below the top.
- **fixed** (e.g. 3 × 10): when all sets hit the number at target RIR, add load next session.
- **open range** ("10+", "6+"): treat as bottom to bottom + 4 (10+ → 10–14), then as **range**.
- **top + backoff:** progress the top sets as **range**. Backoff load = top load × 0.70, rounded to the nearest available DB/pin; backoff reps are logged and charted but never gate progression.
- **amrap:** target = beat last session's total reps. When every set reaches 15+ (dips, hyperextensions) suggest +5–10 lb added load. Hanging leg raises: reps only.
- **superset (same weight):** A1 drives the load (as **range**); A2 uses the same load and logs reps only.
- **assisted:** when all sets reach 8 reps, remove one pin of assistance. At zero assistance, switch to bodyweight pullups (amrap), then belt load.
- **timed** (plank, vacuum, Russian twists): ✓ only; no progression.
- **Stalls:** if reps fall below the bottom of the range on 2 consecutive sessions at the same load, hold. A 3rd time, reduce load ~5 % and rebuild.
- **In Cut mode:** the goal is to keep loads. Require the top of the range on all sets for 2 consecutive sessions before adding load. A rep drop of 1–2 on the last set is expected and not a fatigue flag on its own.
- **In Bulk mode (current):** standard rules above.

### 6.3 Readiness (daily run; light touch, performance always wins)
Inputs: overnight HRV vs 7-day rolling baseline, resting HR vs 7-day baseline, sleep duration, and Strava load in the previous 24–36 h.

| Status | Rule | Effect on today's targets |
|---|---|---|
| Green | no flags | normal progression |
| Amber | any one: HRV < baseline − 1 SD · resting HR ≥ baseline + 5 bpm · sleep < 6 h · hard session > 90 min (or relative effort in his top quartile) within 24 h before **Wed Legs and abs** | **hold**: no load increase; sets unchanged |
| Red | ≥ 2 amber flags, or amber 3 days running | drop 1 set per exercise, keep load |

- If he beats a held target, that counts as progress.
- Heart rate *during* lifting is not used for progression.
- If Health data is missing for the night, readiness = Green, with a reason string "no recovery data".
- Travel: see §2b (capped at Amber for 2 nights after a ≥ 3 h timezone shift).

### 6.4 Deload
Every 6th week, or earlier when ≥ 3 main lifts (Flat DB Bench, Incline DB Bench, Hammer Pulldowns, Single Arm DB Rows, Smith Squat, Single Leg Press) show 2 consecutive sessions of rep drops. The deload halves the sets, keeps the loads, sets RIR ≥ 3, and turns failure finishers into RIR 2. The app announces it on the Week tab the Friday before.

### 6.5 Cardio prescription (Walter, 2026-10-09)
The coach prescribes cardio as part of each day's workout. Strava and the Stairs ✓ tap record what he did. All of it is pure code in `coach/cardio.js`, shared by the routine and the phone.
- **Weekly dose**, locked with the meal plan (`plans[].cardio`, set by the weekly step, §8.1):

  | Mode | Dose |
  |---|---|
  | Bulk | 2 × 25 min stairs (Tue, Thu) |
  | Maintenance | 3 × 30 (Mon, Tue, Thu) |
  | Cut | 4 × 30 (Mon, Tue, Thu, Fri), up a ladder to 5 × 30 (+Sat) and 6 × 30 (+Sun, his 2026 cut) |

  - Never on Wednesday (legs).
  - A Mon–Sun week uses the plan in force on its Monday.
  - Older plans without `cardio` fall back to the mode's base dose.
- **The cut lever** (one lever a week, §10 step 6). In a cut, a "slower than target" decision adds a cardio session before food comes down; "faster than the limit" removes one.
  - Food only moves when cardio is at the top or bottom of the ladder.
  - Gates (adherence, data, recovery, diet break) leave cardio alone.
  - A mode switch starts the new mode's base dose.
  - The weekly notification and the changelog say what changed ("More cardio from Sunday · no macro change").
- **Intensity:** easy Zone 2 stairs.
  - The heart-rate range is Strava's zone 2 from `get_athlete_zones` (kept in `data/model/state.json` → `hr_zones`).
  - Without Strava zones, it's 60–70 % of his highest recent Strava heart rate.
  - kcal estimate: 5.4 net MET × trend weight.
- **Today** (`targets/today.json` → `cardio`, also computed on the phone):
  - The session on scheduled days.
  - Optional once the weekly target is met.
  - Days are flexible: optional when he's ahead (an extra or moved session earlier in the week) until the days left equal the sessions owed. Cardio on any day counts.
  - A make-up on the next free non-Wednesday when he's behind.
  - Readiness amber: same session, keep it easy.
  - Readiness red: a 20-min easy walk instead.
  - After a long endurance session (§8.5 add-on): 20 min, optional.
- **What counts:**
  - Strava cardio activities ≥ 15 min (rides, runs, swims, stairs, …).
  - Stairs ✓ taps ≥ 15 min. A tap on a day with a Strava StairStepper session is the same session.
- **Where it shows:**
  - Log tab: a cardio card under the exercises, with the dose, heart rate, readiness note, Stairs ✓ with the prescribed minutes, the week's tracker and "Why this cardio".
  - Open days: the cardio card is the main card.
  - Week tab: each day's row and preview, plus a "Cardio this week" card.

---

## 7. Daily routine (`coach-daily`, each morning via the Shortcut; see §2b)

1. Pull the repo. Read `data/log/settings.json` for the current timezone and compute Walter's local date. If `last_daily_run_local_date` equals it, exit without committing.
2. Read `data/log/`, `data/health/<local date>.json`, and Strava activities since the last run via the Strava connector (summary, HR zones, relative effort). Normalize the Strava data into `data/strava/`.
3. Update the trend (EWMA) and the model state. Exclude days with adherence = Off from TDEE learning, as with breaks.
4. Compute readiness (§6.3) and today's targets (§6.2) → `data/targets/today.json`, with a one-line reason per modified exercise, plus today's cardio (§6.5).
5. If yesterday had an endurance session > 2 h, write the same-/next-day add-on (§8.5).
6. If it's the local day before prep day (or prep day and the weekly step was missed): run the weekly macro step (§8).
7. Outside step 6, **never change the meal plan.** Commit to `main` with message `daily YYYY-MM-DD (<tz>)` and push.

---

## 8. Macros: meal-prep-locked weekly cycle

Walter preps food **once a week**. A plan that moves mid-week is useless to him.

### 8.0 Starting plan: Bulk, grown from CUT26-V4

He continues from his most recent coach plan (CUT26-V4, carb cycle, weekly avg 2,192 kcal). That plan sits at about base maintenance at ~165 lb (brief §6), and his history says a bulk should start at maintenance + 150–200 kcal, not the 2,500 that drove +1.34 lb/wk in Oct 2025 (2,299 held flat; 2,388 gained +0.53 lb/wk).

**Week 1 plan = CUT26-V4's high-carb day (MP2) every day: 2,353 kcal · P 189 · C 282 · F 52.**
- That's +161 kcal over his last weekly average, using foods and amounts he already preps. Carb cycling is off at the start (one plan, simpler prep).
- Daily foods: M1 3 eggs + 3 slices Ezekiel · Pre-workout 5 rice cakes + 19 g nut butter + 1 scoop whey isolate · Post-workout 5 oz chicken + 270 g cooked rice + 65 g green veg · M4 6 oz 93/7 beef/turkey + 300 g sweet potato + 65 g green veg · Snack 0 % Greek yogurt + 1 granola portion + 70 g blueberries.
- Protein 189 g (≈ 1.15 g/lb) and fat 52 g stay fixed through the bulk. Every later step is carbs, in this order: post-workout rice, M4 sweet potato, pre-workout rice cakes (e.g. one +138 kcal step = rice 270 → 340 g + 1 rice cake).
- If his first-launch weight is far from ~165 lb, the generator rescales to (13.2 × weight + logged cardio) + 150–200 kcal and picks the nearest food-weight version.
- Weeks 1–2 are observe-only (§2a); the first possible change is week 3.

### 8.1 Cadence (defaults; editable in Settings; all times local)
- **Fri morning:** check-in (weigh-in, measurements, check-in form).
- **Sat (daily run):** weekly step decides on macros and publishes `data/plan/next.json` plus the prep/grocery list.
- **Sat:** one notification, always, whether or not anything changed:
  - Changed: "Plan changes Sunday: +138 kcal. Post-workout rice 270 → 340 g, +1 rice cake. Reason: rate +0.05 %BW/wk for 2 wks, adherence 96 %."
  - Unchanged: "No macro change this week. Rate on target (+0.15 %BW/wk). Prep as last week."
- **Sun (prep day, default):** `next.json` becomes `current.json` and is **locked for 7 days**.

### 8.2 Weekly decision rules
Follow the check-in order in §10. Additionally:
- At most **one** change per week, ≤ 150 kcal, carbs first, expressed as food-weight changes in his staple foods (brief §5).
- After any change, the following week is "observe only" for judging the rate (glycogen washout, 5–7 d), unless the rate is beyond a hard limit.
- Respect the floors: protein ≥ 1.0 g/lb (cut), fat ≥ ~50 g.

### 8.3 Mode switch timing
Flipping the switch mid-week does **not** change the current week's food. The app shows "Cut starts Sunday" and the weekly step builds the first plan for the new mode:
- **Cut → Maintenance:** drop/reduce cardio first; +100–150 kcal per week toward 13.2 kcal/lb.
- **Maintenance → Bulk:** maintenance + 150–200 kcal.
- **→ Cut:** ~300–500 kcal under the current maintenance estimate, carbs first; CUT26-V4's carb cycle (MP1 low / MP2 high) is the template.

Phase boundaries are saved with dates for the model.

### 8.4 How he's told
Three channels, all for the same event:
1. **Web Push** to the installed PWA (iOS 16.4+; ask permission once, from a button, after install). The routine sends it with a VAPID key stored as a routine API credential; the cloud environment's network access must allow Apple's push endpoint (`web.push.apple.com`). Verify during setup; if push can't be delivered, channels 2–3 still carry the message.
2. A Week-tab banner from Saturday until Sunday ("New plan Sunday: see changes").
3. The "What changed" card on the Meals tab.

### 8.5 Endurance add-ons (the only exception, and they never touch prepped meals)
On a day with a ride > 2 h or a long run (or the day after, if it was late): add carbs ≈ 50 % of the logged session kcal, as **non-prep, grab-and-go items** (banana, bagel, rice cakes, sports drink, extra cooked rice if already on hand). Shown on the Week and Meals tabs for that day only.

---

## 9. Measurements (weekly, Friday)

| Site | Landmark |
|---|---|
| Waist (primary) | at the navel, relaxed, after a normal exhale |
| Neck | just below the larynx |
| Chest | nipple line, arms down, relaxed |
| Arm | mid upper arm, relaxed, same side each week |
| Thigh | midway between hip crease and top of kneecap, same side |

**Protocol:** Friday morning, fasted, after the weigh-in, before training. Tape snug, not compressing. Two readings per site, averaged by the app.

**Body-fat estimate:** US Navy circumference formula (men: waist, neck, height). Display it as a trend only (±3–4 % absolute error). Smart-scale body-fat readings from Health are also trend-only and never trigger a change.

**Interpretation:**
- Bulk: arm/thigh/chest rising while the waist rises slowly = good. Waist rising at the same pace as everything else = surplus too high.
- Cut: waist falling while arm/thigh hold = good. Arm/thigh falling with a fast rate = slow the cut.

---

## 10. Coaching framework (weekly check-in order)

Nutrition decisions follow the Muscle & Strength Pyramid hierarchy (adherence > energy balance > macros > micronutrients > timing). Training follows evidence-based hypertrophy practice (RIR autoregulation, double progression, 10–20 hard sets/muscle/wk, planned and reactive deloads). Walter is a natural lifter and doesn't compete.

Stop at the first failing step:
1. **Adherence < 90 %** → no macro change. The notification says so plainly.
2. **Data sufficiency:** fewer than 5 weigh-ins this week, or still in the 2-week calibration → no change.
3. **Trend rate vs the mode's target band** (brief §5 table), judged over 2–3 weeks.
4. **Waist, strength trend, biofeedback** (§9, §6). In a cut, falling strength on ≥ 3 main lifts or biofeedback averaging ≤ 2 → slow the cut, or offer a 1–2 wk diet break at maintenance.
5. **Activity:** steps vs a step floor of 8,000/day (adjustable), cardio from Strava/stairs taps.
6. **Then adjust:** one lever, ≤ 150 kcal, with a one-line reason.

Safety rails are in code, not prompts: the weekly delta is capped at 150 kcal, the floors are fixed, and there is no change on a data-poor or low-adherence week.

**Phase planning and end conditions** (instead of fixed 6-month blocks):
- Bulk: ~6 months, or until the waist is +1.5 in over the phase start.
- Cut: 8–16 weeks, or a target weight/waist set at phase start.
- Maintenance: 4–8 weeks between phases. Maintenance replaces unlogged "breaks", so logging continues and the maintenance estimate improves.

When an end condition is met, the Body tab shows a banner suggesting the switch. Walter flips it.

---

## 11. Backup

- Settings → **Export**: a single JSON (`walter-coach-backup-YYYY-MM-DD.json`) containing `schema_version`, `exported_at`, and every local store. Delivered through the iOS share sheet (`navigator.share({files})`) so he can "Save to Files" → iCloud Drive. Fall back to a download link if share isn't available.
- **Weekly reminder** banner on Friday after check-in: "Back up this week?"
- **Import**: validate `schema_version`, migrate older versions, preview counts, then merge (by record id) or replace (confirm).
- The git history of `data/` is the second, automatic backup.

---

## 12. iOS Shortcut (Health → repo → routine), set up once on the phone

**Constraint:** iOS blocks Health reads while the iPhone is locked (Shortcuts fails with "Protected health data is inaccessible"). A fixed pre-dawn time automation would fail every night. The Shortcut must run while the phone is unlocked, so it runs once per morning on first use.

**One Shortcut, "WMCoach Health":**
0. Compute today's local date. `GET .../contents/data/health/<date>.json`; if it already exists, stop (makes every trigger below safe to fire many times a day).
1. Find Health Samples: HRV (SDNN) from last night, resting heart rate today, sleep analysis (asleep) last night, steps yesterday, body mass today (if logged).
2. Build JSON `{date (local), tz, hrv_ms, resting_hr, sleep_h, steps, weight_lb?}`.
3. Get Contents of URL: `PUT https://api.github.com/repos/<owner>/<repo>/contents/data/health/<date>.json` with the GitHub token header and a base64 body.
4. Get Contents of URL: `POST` the routine's `/fire` URL with `Authorization: Bearer <routine token>`, the `anthropic-beta` and `anthropic-version` headers from the routine's API-trigger modal, and body `{"text": "daily run"}`.

**Triggers** (Personal Automations, all set to Run Immediately, all calling the same Shortcut; step 0 makes repeats harmless):
- **App is opened**, for 1–3 apps Walter opens every morning (he picks them; e.g. Messages, Strava, Mail). The phone is unlocked by definition, so this is the reliable one.
- **Time of Day** in his usual post-wake window (e.g. 07:15), as a second chance. It works only if the phone happens to be unlocked; failures are harmless.
- **Manual:** the PWA's Log and Body tabs show a "Sync Health" chip when today's health file is missing. It opens `shortcuts://run-shortcut?name=WMCoach%20Health`.

The build agent ships a step-by-step guide in `docs/shortcut.md`, since a cloud task can't reach Health data on the phone directly. Both tokens live only in the Shortcut and the PWA's settings, never in the repo.

---

## 12a. Development and safe updates (Walter will keep iterating)

Walter fixes and changes the app over time in Claude Code. **No update may ever lose or corrupt his data.** Build these in from the first commit:

- **Repo layout:** app code in `app/` (or root), coaching logic in `coach/` (pure functions: trend, TDEE, progression, readiness, plan generator), routine scripts in `scripts/`, tests in `tests/`, data in `data/`. Put the coaching math in tested code; the routine runs the scripts and only uses judgment for Strava fetching and the one-line reasons.
- **`CLAUDE.md` at the repo root** with these rules for every future session:
  - Never edit, rewrite, move or delete anything under `data/log/`, `data/health/`, or past entries in `data/strava/`, `data/plan/changelog.json`. Code changes only.
  - Work on a branch and open a PR; never force-push `main`.
  - Run `npm test` (or equivalent) and the migration test before every PR.
  - Bump `APP_VERSION` and the service-worker cache name on every release.
- **Routine prompt lives in the repo** (`ops/daily_prompt.md`). The routine's saved prompt is one line: "Follow ops/daily_prompt.md." Changing the daily behaviour is then a normal reviewed code change.
- **IndexedDB schema versioning:** every store change is a numbered migration in `onupgradeneeded`. Migrations are **additive only** (add stores/fields; never drop or rename in place; copy-then-switch if a rename is unavoidable). Older app code must still read newer data, so a rollback never breaks.
- **Migration test:** `tests/fixtures/backup-sample.json` (generated from seeded data; refresh from a real export when Walter provides one). The test imports it into a fresh DB, runs all migrations, and checks every record survives.
- **Updates on the phone:** the new service worker installs in the background but **does not take over until Walter taps "Update available, reload"**. Never auto-reload, and hide the banner while a session is in progress. Before applying an update, the app auto-saves a local export snapshot (keep the last 3).
- **Restore from repo:** if the app starts with empty storage but a valid token, it offers "Restore from GitHub" and rebuilds IndexedDB from `data/log/`. Combined with Import (§11), a wiped phone loses nothing that was synced.
- **Rollback:** `git revert` the release commit; Pages redeploys the previous version. Data is untouched.
- **Testing:** unit tests for the coach logic (including a back-test against brief §1b), and an end-to-end run at 375 × 812 in a headless browser (log a set, add a weigh-in, export/import, update flow) with screenshots attached to the PR.

---

## 13. Open items (use the defaults until Walter answers)

| Item | Default |
|---|---|
| Meal-prep day | Sunday (so the plan publishes Saturday) |
| Check-in / measurement day | Friday |
| Current body weight | ask on first launch (or import Health weigh-ins) |
| Carb cycling during the bulk | off (MP2 every day); Walter can turn MP1/MP2 back on and pick high days |
| Program C leg volume during a bulk | keep as is (legs once a week, ~5 quad sets, no calves); raise with Walter before changing anything |
| Recent lift loads in Strava | check on first build; else calibration sessions |
| Exercise swaps for his gym/equipment | program as in §5 |
| Height (for the body-fat estimate) | ask on first launch |
| Apple Health read permission for Weight / Body Fat | ask Walter to enable; Shortcut works either way |
| Stair-stepper workouts reaching Strava | verify in the first week; the "Stairs ✓" tap is the fallback |
| Step floor | 8,000/day |
| Home timezone for backup schedules | America/Los_Angeles |
| GitHub repo + fine-grained token, routine API token | created during setup |
