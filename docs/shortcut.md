# The Health Shortcut: "WMCoach Health" (set up once, about 15 minutes)

Each morning this Shortcut does two things:
1. It copies last night's recovery data from Apple Health into the repo, as `data/health/<date>.json`.
2. It starts the daily coach run.

It runs on your **first unlocked use of the phone**, not at a fixed early time. iOS blocks Health reads while the iPhone is locked ("Protected health data is inaccessible"), so a 04:30 automation would fail every night (spec §12).

**Before you start, have these ready:**
- **A GitHub token** with *Contents: Read and write* on WMCoach only. The one you made for the app works (`docs/github-sync.md`). A second one named `WMCoach Shortcut` is fine too.
- **The coach run's API URL and token**, from `docs/routine.md` step 3.

The tokens live only in this Shortcut and in the app's settings, never in the repo.

## Build the Shortcut
Shortcuts app → **+** → name it exactly **`WMCoach Health`**. The app's **Sync Health** chip opens it by that name.

**0. Stop if today is already done.** This makes every trigger safe to fire many times a day.
1. **Format Date**: Current Date, Date Format *Custom* `yyyy-MM-dd`. Rename the result **Today**.
2. **Format Date**: Current Date, Custom `VV` (gives your time zone, e.g. `America/Los_Angeles`). Rename it **Zone**.
3. **Get Contents of URL**:
   - URL: `https://api.github.com/repos/woojmcd/WMCoach/contents/data/health/`**Today**`.json`
   - Method **GET**.
   - Headers: `Authorization` = `Bearer <your GitHub token>`, `Accept` = `application/vnd.github+json`.
4. **Get Dictionary Value**: *Value* for key `sha` in Contents of URL.
5. **If** Dictionary Value *has any value* → **Stop This Shortcut**. End If.

**1. Read Health.** Allow each type when iOS asks the first time.

6. **Find Health Samples** where *Type is Heart Rate Variability* and *Start Date is in the last 12 hours*.
   - Then **Calculate Statistics**: *Average* of Health Samples. Rename it **HRV**.
7. **Find Health Samples** where *Type is Resting Heart Rate* and *Start Date is today*.
   - Sort by Start Date, Latest First, Limit 1. Rename it **RHR**.
8. **Find Health Samples** where *Type is Sleep Analysis*, *Start Date is in the last 1 day*, and *Value is Asleep*.
   - Then **Get Details of Health Samples**: *Duration*.
   - Then **Calculate Statistics**: *Sum*.
   - Then **Calculate**: Sum ÷ 3600. Rename it **Sleep**.
   - If the result is a large number, Shortcuts already gave minutes: divide by 60 instead.
9. **Find Health Samples** where *Type is Steps* and *Start Date is yesterday*.
   - Then **Calculate Statistics**: *Sum*. Rename it **Steps**.
10. **Find Health Samples** where *Type is Weight* and *Start Date is today*, Latest First, Limit 1. Rename it **Weight**.
   - Optional. The app's weigh-in is still the main one; this only fills a day you forgot.

**2. Build the file.**

11. **Dictionary** with these keys. Set each value's type to **Number**, except `date` and `tz` (Text):
    - `date` = Today
    - `tz` = Zone
    - `hrv_ms` = HRV
    - `resting_hr` = RHR
    - `sleep_h` = Sleep
    - `steps` = Steps
    - `weight_lb` = Weight

    A value that's missing on some morning is fine: the coach treats it as "no data".
12. **Base64 Encode** the Dictionary (Line Breaks: *None*).

**3. Commit it to GitHub.**

13. **Get Contents of URL**:
    - URL: the same address as step 3.
    - Method **PUT**.
    - Headers: the same as step 3.
    - Request Body **JSON**:
      - `message` (Text) = `health ` + Today
      - `content` (Text) = Base64 Encoded
      - `branch` (Text) = `main`

**4. Start the coach run.**

14. **Get Contents of URL**:
    - URL: the routine's `…/fire` URL.
    - Method **POST**.
    - Headers:
      - `Authorization` = `Bearer <routine token>`
      - `anthropic-beta` = `experimental-cc-routine-2026-04-01`
      - `anthropic-version` = `2023-06-01`
      - `Content-Type` = `application/json`
    - Request Body **JSON**: `text` (Text) = `daily run`.

Tap ▶︎ once to test. Then check two things:
- `data/health/<today>.json` appears in the repo.
- A new `coach-daily` run starts at claude.ai/code/routines.

A second tap should stop at step 5.

## Triggers
Shortcuts → **Automation** → **+** → **Create Personal Automation**. Set every automation to **Run Immediately** and turn **Notify When Run** off.

| Trigger | Set up | Why |
|---|---|---|
| **App → Is Opened** | Pick 1–3 apps you open every morning (e.g. Messages, Mail, Strava). | The phone is unlocked by definition, so this is the reliable one. Step 0 makes repeats harmless. |
| **Time of Day** | Daily, about 07:15 (just after you're usually up). | A second chance. It works only if the phone happens to be unlocked; when it fails, nothing breaks. |
| **Manual** | Nothing to set up. | When today's file is missing, the app's Log and Body tabs show a **Sync Health** chip that runs this Shortcut. |

## When something's off
- **The Sync Health chip stays:** open the Shortcut and run it. If step 13 fails, the GitHub token has expired (make a new one and paste it in steps 3 and 13).
- **"Protected health data is inaccessible":** the phone was locked. The App-opened trigger covers it.
- **Travel:** nothing to change. The Shortcut uses the phone's clock and zone, so it runs in your morning wherever you are.
