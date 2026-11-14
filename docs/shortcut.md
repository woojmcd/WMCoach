# The Health Shortcut: "WMCoach Health" (set up once, about 15 minutes)

Each morning this Shortcut does two things:
1. It copies last night's recovery data from Apple Health into the repo, as `data/health/<date>.json`.
2. It starts the daily coach run.

It runs when you **close the Oura app** in the morning, not at a fixed time. Two things have to be true for a sync to work, and a clock trigger guarantees neither:
- **The phone is unlocked.** iOS blocks Health reads while the iPhone is locked ("Protected health data is inaccessible").
- **Oura has sent last night to Apple Health.** It only does that when its app opens and syncs.

What went wrong before (checked 2026-11-14): from 20 Oct to 14 Nov, 10 of the 16 syncs came from the 07:00 clock trigger. On 4 of those 10 mornings Oura hadn't sent the night yet, so the file went up with no sleep. The old step 5 then stopped every later run that day, because "today's file exists". That left only the Sync Health chip, which is why it felt like running it by hand every morning. On the 10 days with no sync at all, the phone was most likely still locked at 07:00 and no other trigger fired.

This version fixes both. It stops early only when today's file already has last night's sleep. It refuses to upload a file without sleep, and tells you to open Oura instead. And it can replace an incomplete file.

**Before you start, have these ready:**
- **A GitHub token** with *Contents: Read and write* on WMCoach only. The one you made for the app works (`docs/github-sync.md`). A second one named `WMCoach Shortcut` is fine too.
- **The coach run's API URL and token**, from `docs/routine.md` step 3.

The tokens live only in this Shortcut and in the app's settings, never in the repo.

## Build the Shortcut
Shortcuts app → **+** → name it exactly **`WMCoach Health`**. The app's **Sync Health** chip opens it by that name.

**0. Stop only if today is already complete.** Every trigger is then safe to fire many times a day, and an incomplete file still gets fixed.
1. **Format Date**: Current Date, Date Format *Custom* `yyyy-MM-dd`. Rename the result **Today**.
2. **Format Date**: Current Date, Custom `VV` (gives your time zone, e.g. `America/Los_Angeles`). Rename it **Zone**.
3. **Get Contents of URL**:
   - URL: `https://api.github.com/repos/woojmcd/WMCoach/contents/data/health/`**Today**`.json`
   - Method **GET**.
   - Headers: `Authorization` = `Bearer <your GitHub token>`, `Accept` = `application/vnd.github+json`.
4. **Get Dictionary Value**: *Value* for key `sha` in Contents of URL. Rename it **Existing** (it's empty when today has no file yet).
5. **If** **Existing** *has any value*:
   - **Get Dictionary Value**: *Value* for key `content` in Contents of URL.
   - **Base64 Decode** it, then **Get Dictionary from Input**.
   - **Get Dictionary Value**: *Value* for key `sleep_samples`.
   - **If** it *has any value* → **Stop This Shortcut** (today's file already has last night). **End If**.
   - **End If**.

**1. Read Health.** Allow each type when iOS asks the first time.

Oura writes sleep and overnight heart rate to Apple Health, but not HRV or resting heart rate (checked 2026-10-13). So resting HR is your lowest overnight heart rate (Oura's own definition), and HRV stays blank, which the coach treats as "no data".

Oura sends a night to Apple Health when its app opens and syncs. Until then Health has no sleep, and the coach treats the file as not in yet (Sync Health chip). So the best trigger is closing Oura in the morning (see **Triggers**).

The **"in the last 1 day"** filter counts from midnight at the start of *yesterday*, not 24 hours, so it would mix in the night before. Every step below uses a fixed window instead.

6. **Windows.**
   - **Date**: Current Date.
   - **Adjust Date**: *Get Start of Day* (today at midnight).
   - **Adjust Date**: *Subtract 6 hours* from that. Rename it **Sleep Window** (yesterday at 6 PM).
   - **Adjust Date**: *Subtract 1 day* from today at midnight. Rename it **Yesterday Start**.
7. **Sleep samples.** The coach works out sleep from the samples themselves (2026-10-20). Oura rewrites a night in Health two or three times, so the same stretch is often there more than once. Sums inside the Shortcut came out double (14.3 h for a 7.2 h night), and the coach can count each stretch once.
   - **Find Health Samples** where (all): *Type is Sleep Analysis*, *Start Date is after* **Sleep Window**. No Value or Source filter. Tap **Show More** and check **Limit** is **off**.
   - **Repeat with Each** item in Health Samples:
     - **Text**: `Repeat Item`'s **Start Date**, then `|`, then `Repeat Item`'s **End Date**, then `|`, then `Repeat Item`'s **Value**. To pick each one, tap the Repeat Item variable and choose the property; for both dates set **Date Format** to **ISO 8601**. One line looks like `2026-10-20T00:23:30-07:00|2026-10-20T07:46:30-07:00|In Bed`.
     - **Add to Variable**: name it **Sleep Rows**.
   - **End Repeat.** Then **Combine Text**: **Sleep Rows**, with **New Lines**. Rename the result **Sleep Samples**.
   - **No night yet? Don't upload.** Right after the Find Health Samples above, add **Count** (Items) of Health Samples, then **If** Count *is* 0:
     - **Show Notification**: "Last night isn't in Apple Health yet. Open Oura, let it sync, then close it."
     - **Stop This Shortcut**. **End If**.
     - (Put this before the Repeat.) A file without sleep was the root of the old trouble. The next Oura-close runs the Shortcut again.
8. **Heart rate samples.** Resting HR is the lowest heart rate *inside the night*, like Oura's "lowest heart rate".
   - **Find Health Samples** where (all): *Type is Heart Rate*, *Source is Oura*, *Start Date is after* **Sleep Window**. **Limit off.** With a limit on, it sees only the latest readings. That's the likely reason the old step sent 61–87 for nights whose lowest was 52–58.
   - **Repeat with Each**: **Text** = `Repeat Item`'s **Start Date** (ISO 8601), `|`, `Repeat Item`'s **Value**. **Add to Variable** **HR Rows**.
   - **End Repeat.** **Combine Text**: **HR Rows**, with **New Lines**. Rename it **HR Samples**.
   - The old **RHR** and **Sleep** steps (Calculate Statistics, In Bed − Awake) can go. If they stay, the coach ignores them whenever the samples are there.

9. **Steps (yesterday).** **Find Health Samples** where (all): *Type is Steps*, *Source is* your iPhone, *Start Date is after* **Yesterday Start**, *Start Date is before* today at midnight.
   - Then **Calculate Statistics**: *Sum*. That's **Steps**.
   - Without the Source filter, the iPhone, Oura and Garmin are all added up and it reads about 35 % high. The iPhone alone comes within a few percent of the Health app's total.
10. **Weight** (optional): **Find Health Samples** where *Type is Weight* and *Start Date is today*, Latest First, Limit 1. Rename it **Weight**.
   - Only useful if a smart scale writes to Health. The app's weigh-in is still the main one; this only fills a day you forgot.

**2. Build the file.**

11. **Dictionary** with these keys. Set each value's type to **Number**, except `date`, `tz`, `sleep_samples` and `hr_samples` (Text):
    - `date` = Today
    - `tz` = Zone
    - `hrv_ms` = HRV (blank: Oura doesn't share it)
    - `sleep_samples` (**Text**) = Sleep Samples
    - `hr_samples` (**Text**) = HR Samples
    - `steps` = Steps
    - `weight_lb` = Weight

    A value that's missing on some morning is fine: the coach treats it as "no data".
12. **Base64 Encode** the Dictionary (Line Breaks: *None*).

**3. Commit it to GitHub.**

13. **If** **Existing** *has any value* (today's file is there but incomplete: replace it):
    - **Get Contents of URL**: URL the same as step 3, Method **PUT**, Headers the same as step 3, Request Body **JSON**:
      - `message` (Text) = `health ` + Today
      - `content` (Text) = Base64 Encoded
      - `branch` (Text) = `main`
      - `sha` (Text) = **Existing** (GitHub only replaces a file when it gets this ID)
    - **Otherwise** (no file yet): the same **Get Contents of URL**, without the `sha` field.
    - **End If**.

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

A second tap should stop at step 5 (today's file already has sleep).

## The Resync copy: "WMCoach Health Resync"
The app's **Sync Health** chip opens this copy when today's file exists. It forces a fresh upload, for example after Oura has revised last night.
1. Delete the old **WMCoach Health Resync**.
2. Long-press the new **WMCoach Health** → **Duplicate**. Rename the copy exactly **`WMCoach Health Resync`**.
3. In the copy, delete the inner **If** in step 5 (the one that stops when `sleep_samples` has a value). Keep everything else; step 13 already replaces the file.

A re-sync with new numbers makes the next coach run redo today's readiness, targets and daily summary, up to 3 times a day.

## Triggers
Shortcuts → **Automation** → **+** → **Create Personal Automation**. On every automation:
- Choose **Run Immediately**, not **Run After Confirmation**. With "after confirmation", iOS shows a notification you have to tap, so it feels like running it by hand.
- Turn **Notify When Run** off.

| Trigger | Set up | Why |
|---|---|---|
| **App → Oura → Is Closed** | Oura only. **The main one.** | Checking Oura makes it send last night to Health, and closing it is the moment the data is there. The phone is unlocked by definition. |
| **App → Is Opened** | 1–2 apps you open every morning after Oura (e.g. Messages, Strava). | A backup. Step 0 makes repeats harmless, and an early run without sleep just says "open Oura". |
| **Time of Day** | Optional, about 09:00. Delete the 07:00 one. | Works only if the phone happens to be unlocked. At 07:00 Oura rarely had last night in Health yet. |
| **Manual** | Nothing to set up. | When today's file is missing or incomplete, the app's Log and Body tabs show **Sync Health**. |

## When something's off
- **The Sync Health chip stays:** open Oura so it syncs last night to Health, then tap the chip (or run the Resync copy). If step 13 fails, the GitHub token has expired: make a new one and paste it in steps 3 and 13 of both Shortcuts.
- **Sleep reads about double (e.g. 14 h):** the old In Bed − Awake sums counted a night Oura had written twice. Steps 7–8 above fix it; until then the coach ignores any sleep over 12 h and shows the **Sync Health** chip.
- **No sleep, odd resting HR:** Oura hadn't sent the night to Health yet. Open Oura, wait for it to sync, then tap **Sync Health**.
- **"Protected health data is inaccessible":** the phone was locked. The Oura-closed trigger covers it.
- **It still asks before running:** open the automation and switch it to **Run Immediately**.
- **"Last night isn't in Apple Health yet":** open Oura, wait for the sync to finish, then close it.
- **Travel:** nothing to change. The Shortcut uses the phone's clock and zone, so it runs in your morning wherever you are.
