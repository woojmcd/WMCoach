# Bring your Apple Health weigh-ins into WMCoach (one time, optional)

Apple Health holds ~152 weigh-ins since 10 May 2026 that aren't in the history file. A web app can't read Health directly, so this one-time Shortcut exports them as a CSV that the app imports.

## 1. Build the Shortcut (Shortcuts app → +)
1. **Find Health Samples** where *Type* is *Weight* and *Start Date* is after *9 May 2026*. Sort by *Start Date*, *Oldest First*. Turn *Limit* off.
2. **Repeat with Each** (item in Health Samples):
   1. **Get Details of Health Samples**: *Start Date* of *Repeat Item*.
   2. **Format Date**: *Date Format* ISO 8601, *Include ISO 8601 Time* on.
   3. **Get Details of Health Samples**: *Value* of *Repeat Item*.
   4. **Text**: `Formatted Date,Value` (insert the two variables with a comma between them).
3. **Combine Text**: *Repeat Results* with *New Lines*.
4. **Save File**: turn on *Ask Where to Save*. Name it `weights.csv`.

Run it and save `weights.csv` to iCloud Drive.

## 2. Import it
- **On first launch:** tap *Import Health weigh-ins (CSV) first* on the Set up screen.
- **Later:** Settings → *Import backup or CSV* → choose `weights.csv`.

The app shows how many weigh-ins are new, then adds them. Importing the same file twice adds nothing. Lines look like `2026-05-10T07:12:00-07:00,165.2`; if your Health weight unit is kg, the third column can say `kg`.
