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

Oura writes sleep and overnight heart rate to Apple Health, but not HRV or resting heart rate (checked 2026-10-13). So resting HR is your lowest overnight heart rate (Oura's own definition), and HRV stays blank, which the coach treats as "no data".

The **"in the last 1 day"** filter counts from midnight at the start of *yesterday*, not 24 hours, so it would mix in the night before. Every step below uses a fixed window instead.

6. **Windows.**
   - **Date**: Current Date.
   - **Adjust Date**: *Get Start of Day* (today at midnight).
   - **Adjust Date**: *Subtract 6 hours* from that. Rename it **Sleep Window** (yesterday at 6 PM).
   - **Adjust Date**: *Subtract 1 day* from today at midnight. Rename it **Yesterday Start**.
7. **Resting HR.** **Find Health Samples** where (all): *Type is Heart Rate*, *Source is Oura*, *Start Date is after* **Sleep Window**.
   - Then **Calculate Statistics**: *Minimum*. This is **RHR**.
8. **Sleep = time in bed − time awake.** Leave the Source filter off here: with it, Oura's sleep isn't found.
   - **Find Health Samples** where (all): *Type is Sleep Analysis*, *Start Date is after* **Sleep Window**, *Value is In Bed*. Then **Get Details**: *Duration*. Then **Calculate Statistics**: *Sum*.
   - The same again with *Value is Awake*.
   - **Calculate**: In Bed Sum − Awake Sum. Then **Calculate**: ÷ 3600. That's **Sleep** (hours).
   - Don't add up Core + Deep + REM instead: Oura writes some of those windows twice, and the sum reads about 45 minutes high. In Bed − Awake lands within about 10 minutes of Oura's number.
   - "Value is Asleep" finds nothing: Oura labels every piece Core, Deep or REM.
9. **Steps (yesterday).** **Find Health Samples** where (all): *Type is Steps*, *Source is* your iPhone, *Start Date is after* **Yesterday Start**, *Start Date is before* today at midnight.
   - Then **Calculate Statistics**: *Sum*. That's **Steps**.
   - Without the Source filter, the iPhone, Oura and Garmin are all added up and it reads about 35 % high. The iPhone alone comes within a few percent of the Health app's total.
10. **Weight** (optional): **Find Health Samples** where *Type is Weight* and *Start Date is today*, Latest First, Limit 1. Rename it **Weight**.
   - Only useful if a smart scale writes to Health. The app's weigh-in is still the main one; this only fills a day you forgot.

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

## The Resync copy: "WMCoach Health Resync"
The morning Shortcut stops once today's file exists. That's on purpose, so every trigger is safe. But an early sync can arrive before Oura has written last night. For that, keep a second copy that overwrites today's file:
1. Long-press **WMCoach Health** → **Duplicate**. Rename the copy exactly **`WMCoach Health Resync`**.
2. In the copy, delete step 5 (the **If**, **Stop This Shortcut** and **End If**). Keep steps 3 and 4.
3. In the copy's step 13 (the PUT), add a fourth Request Body field: `sha` (Text) = the **Dictionary Value** variable from step 4. GitHub only replaces an existing file when it gets that ID.

When today's file is missing or has no sleep or heart-rate data, the app shows a **Sync Health** chip on the Log and Body tabs. It opens the Resync copy when today's file exists, and the main Shortcut when it doesn't. A re-sync with new numbers makes the next coach run redo today's readiness, targets and daily summary, up to 3 times a day.

## Triggers
Shortcuts → **Automation** → **+** → **Create Personal Automation**. Set every automation to **Run Immediately** and turn **Notify When Run** off.

| Trigger | Set up | Why |
|---|---|---|
| **App → Is Opened** | Pick 1–3 apps you open every morning (e.g. Messages, Mail, Strava). | The phone is unlocked by definition, so this is the reliable one. Step 0 makes repeats harmless. |
| **Time of Day** | Daily, about 07:15 (just after you're usually up). | A second chance. It works only if the phone happens to be unlocked; when it fails, nothing breaks. |
| **Manual** | Nothing to set up. | When today's file is missing, the app's Log and Body tabs show a **Sync Health** chip that runs this Shortcut. |

## When something's off
- **The Sync Health chip stays:** open Oura so it syncs last night to Health, then tap the chip (or run the Resync copy). If step 13 fails, the GitHub token has expired: make a new one and paste it in steps 3 and 13 of both Shortcuts.
- **"Protected health data is inaccessible":** the phone was locked. The App-opened trigger covers it.
- **Travel:** nothing to change. The Shortcut uses the phone's clock and zone, so it runs in your morning wherever you are.
