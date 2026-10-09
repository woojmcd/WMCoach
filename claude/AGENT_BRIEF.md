# AGENT BRIEF — Walter's personal nutrition-coaching app

**For:** the AI agent building a nutrition / physique-coaching app tailored to Walter.
**What this package is:** 17 months of coached history (Dec 2024 – May 2026): every weigh-in, every dated meal-plan version from his previous coach ("Dakota"), modelled macros for each version, and an analysis of how his body weight responded to each change.
**Your job:** use it as (1) seed data, (2) priors for an adaptive energy-expenditure model, and (3) a spec for how plans should be structured and adjusted. Everything here is **evidence-based coaching logic**: trend weight over scale noise, rate targets as % of body weight per week, protein-first macros, small carb-led adjustments.

> Read sections 1–4 before writing code. Section 5 is the adjustment algorithm to implement. Section 7 lists what is unknown, so don't treat those items as facts.

---

## 0. Package contents

| File | What it is | Key fields |
|---|---|---|
| `data/weight_daily.csv` | 279 weigh-ins, 2024-12-28 → 2026-05-14 (lb). Source: app weight log ← Apple Health. Verified against the app's own weekly averages (67/67 exact). | `date, weight_lb` |
| `data/daily_timeline.csv` | One row per calendar day: logged weight, EWMA trend, plan in effect, day type (carb-cycle), planned kcal/P/C/F, activity (lifting d/wk, stair min/wk, modelled stair kcal) | `date, weight_lb, trend_lb, weekly_avg_lb, plan_id, day_type, kcal, protein_g, carbs_g, fat_g, weighed_in, lifting_days_wk, stair_min_wk, activity_note, cardio_kcal` |
| `data/plans.json` | **Canonical plan data.** Food DB + 15 dated plan versions, each with meals → foods → qty/unit, computed macros per day type and weekly average, coach notes, carb-cycle schedule | see schema below |
| `data/plan_macros.csv` | Flat macros per plan × day type | `plan_id, phase, start, day_type, kcal, protein_g, carbs_g, fat_g` |
| `data/plan_windows.csv` | Each plan's effective window joined with weight response + maintenance estimate (total, and base excl. cardio) | `plan_id … rate_lb_per_wk, rate_pct_bw_per_wk, est_tdee_kcal, cardio_kcal_avg, base_maint_kcal, base_kcal_per_lb, confidence, coach_note` |
| `data/phase_blocks.csv` | Merged, longer on-plan windows (more robust than single plan windows) | |
| `data/breaks.csv` | The two off-plan breaks: dates, weigh-ins, weight before/after | |
| `data/health_daily.csv` | **Apple Health**, one row per day 2024-12-20 → 2026-10-08: steps, device active kcal, logged minutes/kcal per workout type, `logged_extra_kcal` | `date, steps, active_kcal, stairs_min, stairs_kcal, run_*, bike_*, swim_*, lift_*, hike_*, other_cardio_*, logged_extra_kcal, watch_like` |
| `data/workouts.csv` | **Apple Health workouts**, deduplicated (639 sessions) | `date, start, type, minutes, km, kcal, kcal_imputed, n_records` |
| `data/activity_by_phase.csv` | Steps, logged sessions/wk, km/wk and logged cardio kcal per phase | |
| `data/rolling_tdee_28d.csv` | Weekly-stepped 28-day maintenance estimates | |
| `data/metabolic_profile.json` | **Machine-readable priors and rules** distilled from this brief. Load this first. | |
| `scripts/build_data.py`, `scripts/analyze.py` | Reproducible pipeline (food DB → macros → windows/TDEE). Edit the food DB and rerun. `analyze.py` reads `health_daily.csv` when present. | |
| `Walter_Bodybuilding_History.xlsx` | Human-readable workbook with live formulas and charts (same data) | |

`plans.json` schema:
```
{ "food_db": { "<food_id>": {name, unit, protein_g, carbs_g, fat_g, basis} },   // per 1 unit; unit = g | oz | each | slice | scoop | cup
  "plans": [ { id, phase, start (ISO date), structure: "single"|"carb_cycle",
               schedule?: {MP1, MP2, mp1_days, mp2_days, ASSUMPTION?},
               days: { "MP" | "MP1" | "MP2": { "<meal>": [ {food, name, qty, unit} ] } },
               macros: { "<day_type>": {kcal, P, C, F, per_meal:{...}} },
               weekly_avg: {kcal, P, C, F}, coach_note, travel_override? } ] }
```
A plan is in effect from `start` until the day before the next plan's `start`; the last plan (CUT26-V4) is assumed to run until the last weigh-in.

---

## 1. Timeline at a glance

| Phase | Dates | Weekly-avg weight | Plan kcal | Avg rate |
|---|---|---|---|---|
| Cut 2025 | 2024-12-28 → 2025-04-23 | 185.0 → 166.5 | (no plan before 02-11) 2,343 → 2,011 | −1.1 lb/wk ≈ −0.6 %BW/wk |
| **Break** (off-plan) | 2025-04-24 → 2025-07-19 | 167.2 → 165.9 (wandered 164–172) | unknown | ≈ flat |
| Bulk 2025 | 2025-07-20 → 2025-12-20 | ~166 → ~177 | 1,934 → 2,539 in 7 steps | +0.5 lb/wk overall; +1.34 lb/wk Oct–Nov |
| **Holiday break** (off-plan) | 2025-12-21 → 2026-01-31 | 177.0 → 177.6 (2 weigh-ins) | unknown | ≈ flat |
| Cut 2026 | 2026-02-01 → 2026-05-14 | 179.2 → 164.6 (new low) | 2,421 → 2,127; carb cycle avg 2,192 from 03-05 | −1.0 lb/wk overall; ≈ −1.9 lb/wk mid-April |

**Activity: stated by Walter, checked against Apple Health:**

| Period | Lifting | Stated cardio | Apple Health shows | Cardio kcal used in the model |
|---|---|---|---|---|
| Cut 2025 (2024-12-28 → 2025-04-23) | 5 d/wk | Stairs 6 × 40 min/wk | Phone only (no watch workouts). Steps 5.5k–9.2k/day; snowboarding trips Jan & early Mar 2025 | stairs ≈ 255/day (modelled) + ~30–60 logged |
| Bulk 2025 (2025-07-20 → 2025-12-20) | 5 d/wk | None, "walking a lot" | **Confirmed: 11.1k–12.8k steps/day**, the highest of any phase; occasional short rides from Oct | 0 stairs + 13–103 logged |
| Cut 2026 (2026-02-01 → 2026-05-14) | 5 d/wk | Stairs 6 × 30 min/wk | Apple Watch from ~late Feb. **Unstated endurance block:** runs 1.3–2.1/wk (6–13 km/wk), rides ~1/wk incl. 62–103 km rides in March and a **152 km ride on 2026-04-19 (~5,200 kcal)**, swims, and a sprint triathlon on 2026-05-03. Steps 7.4k–8.6k/day | stairs ≈ 190/day (modelled) + **~370–420/day logged** (Mar–May) |

Stair cost is **calibrated to his own watch**: the median of 23 logged stair sessions is 7.2 kcal/min (≈ 5.4 net MET; kcal/min = 5.4 × 3.5 × kg / 200), so 30 min ≈ 220 kcal and 40 min ≈ 295 kcal at ~172 lb. Stairs stay modelled from the stated routine because watch logging was incomplete (~1.5 stair and ~2.6 lifting sessions/wk logged in spring 2026 vs 6 and 5 stated). Break days carry no modelled stairs.

**Apple Health data notes for the app:**
- **Steps are complete** for every week since Dec 2024. Device "active kcal" is phone-only until ~late Feb 2026 and mostly Apple Watch after, so it is **not comparable across that boundary**.
- Workouts are often written twice (Apple Watch + a companion app, sometimes with "Other" as the type). Dedupe by time overlap ≥ 50 % and keep the specific type. 27 runs/rides had no kcal and were imputed at his own median rate (runs ≈ 70 kcal/km).
- Health holds **152 weigh-ins since 2026-05-10 and 23 body-fat / lean-mass readings**, but read access for those types is off, so they couldn't be imported. Turn them on (Health → Sharing → Apps → Claude) and re-import.
- No food is logged in Health (dietary energy is empty).

**Breaks:** Walter confirmed that any gap in the data is a break he took. Break periods are off-plan with unknown intake and no structured cardio, so they're **excluded from every maintenance estimate** (`data/breaks.csv`, `status` column in `daily_timeline.csv`). A plan is treated as ending when a break starts, so CUT25-V4 covers only 2025-04-15 → 04-23 and BULK25-V7 only 2025-11-15 → 12-20. The app should support an explicit "break" status and must not learn expenditure from break periods.

He finished Cut 2026 ~2 lb below his Cut 2025 low after a ~13 lb bulk. With no body-composition data, it's plausible but **unverified** that he's leaner at a similar weight.

### 1a. Per-plan-version response
Rate = OLS slope of daily weights within the window. Est. maintenance = plan kcal − rate × 3,500 / 7. **Base maintenance** = est. maintenance − modelled stair kcal, i.e. maintenance with lifting 5 d/wk + daily life and no cardio. Short windows (<14 d) are dominated by glycogen/water, so trust "high" rows.

| plan_id | start | end | kcal/day (wk avg) | P / C / F g | weigh-ins | rate lb/wk | %BW/wk | est. maint. | steps/d | stairs kcal/d | logged cardio kcal/d | base maint. | confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CUT25-V1 | 2025-02-11 | 2025-03-24 | 2,343 | 214 / 256 / 52 | 27 | -0.89 | -0.51 | 2,787 | 9,200 | 260 | 58 | 2,470 | high |
| CUT25-V2 | 2025-03-25 | 2025-04-05 | 2,220 | 212 / 224 / 51 | 12 | -1.12 | -0.65 | 2,780 | 5,481 | 254 | 35 | 2,491 | low |
| CUT25-V3 | 2025-04-06 | 2025-04-14 | 2,078 | 210 / 199 / 51 | 9 | -2.73 | -1.61 | 3,443 | 5,979 | 252 | 0 | 3,191 | low |
| CUT25-V4 | 2025-04-15 | 2025-04-23 | 2,026 | 209 / 179 / 51 | 8 | -0.72 | -0.43 | 2,388 | 6,253 | 249 | 50 | 2,088 | low |
| BULK25-V1 | 2025-07-20 | 2025-07-29 | 1,934 | 201 / 180 / 46 | 7 | +1.19 | +0.71 | 1,341 | 12,688 | 0 | 0 | 1,341 | low |
| BULK25-V2 | 2025-07-30 | 2025-08-05 | 1,991 | 203 / 192 / 46 | 3 |  |  |  | 15,230 | 0 | 86 |  | low |
| BULK25-V3 | 2025-08-06 | 2025-08-20 | 2,160 | 207 / 227 / 47 | 8 | +0.81 | +0.48 | 1,757 | 12,012 | 0 | 0 | 1,757 | medium |
| BULK25-V4 | 2025-08-21 | 2025-09-03 | 2,299 | 210 / 258 / 47 | 10 | -0.13 | -0.07 | 2,362 | 11,969 | 0 | 0 | 2,362 | medium |
| BULK25-V5 | 2025-09-04 | 2025-10-08 | 2,388 | 212 / 278 / 48 | 18 | +0.53 | +0.31 | 2,122 | 12,762 | 0 | 16 | 2,106 | high |
| BULK25-V6 | 2025-10-09 | 2025-11-14 | 2,501 | 220 / 305 / 44 | 21 | +1.34 | +0.78 | 1,830 | 11,096 | 0 | 63 | 1,767 | high |
| BULK25-V7 | 2025-11-15 | 2025-12-20 | 2,539 | 221 / 314 / 44 | 18 | +0.34 | +0.19 | 2,369 | 11,429 | 0 | 103 | 2,266 | high |
| CUT26-V1 | 2026-02-01 | 2026-02-10 | 2,421 | 188 / 299 / 52 | 9 | +0.12 | +0.07 | 2,363 | 3,881 | 196 | 0 | 2,166 | low |
| CUT26-V2 | 2026-02-11 | 2026-02-26 | 2,353 | 188 / 286 / 51 | 6 | -0.58 | -0.33 | 2,645 | 8,939 | 196 | 121 | 2,328 | medium |
| CUT26-V3 | 2026-02-27 | 2026-03-04 | 2,127 | 185 / 231 / 52 | 5 |  |  |  | 9,422 | 194 | 170 |  | low |
| CUT26-V4 | 2026-03-05 | 2026-05-14 | 2,194 | 186 / 245 / 52 | 47 | -1.31 | -0.77 | 2,848 | 8,467 | 189 | 387 | 2,272 | high |

### 1b. Merged blocks (use these for priors)

| block | dates | plan kcal | avg wt lb | rate lb/wk | %BW/wk | est. maint. | steps/d | stairs kcal/d | logged cardio kcal/d | **base maint.** | **base kcal/lb** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2025 cut, carb-cycle V1 (pre-plan weights excluded) | 2025-02-11 → 2025-03-24 | 2,343 | 174.9 | -0.89 | -0.51 | 2,787 | 9,200 | 260 | 58 | 2,470 | 14.1 |
| 2025 cut, V2-V4 late cut | 2025-03-25 → 2025-04-23 | 2,119 | 169.9 | -1.58 | -0.93 | 2,910 | 5,862 | 252 | 29 | 2,629 | 15.5 |
| Bulk ramp V1-V4 (1934->2299 kcal) | 2025-07-20 → 2025-09-03 | 2,127 | 166.8 | +0.28 | +0.17 | 1,986 | 12,636 | 0 | 13 | 1,972 | 11.8 |
| Bulk V5 (2388 kcal) | 2025-09-04 → 2025-10-08 | 2,388 | 170.4 | +0.53 | +0.31 | 2,122 | 12,762 | 0 | 16 | 2,106 | 12.4 |
| Bulk V6 (2501 kcal) | 2025-10-09 → 2025-11-14 | 2,501 | 173.1 | +1.34 | +0.78 | 1,830 | 11,096 | 0 | 63 | 1,767 | 10.2 |
| Bulk V7 (2539 kcal, to holiday break) | 2025-11-15 → 2025-12-20 | 2,539 | 176.3 | +0.34 | +0.19 | 2,369 | 11,429 | 0 | 103 | 2,266 | 12.9 |
| 2026 cut V1-V3 incl. travel | 2026-02-01 → 2026-03-04 | 2,332 | 176.7 | -0.55 | -0.31 | 2,609 | 7,449 | 196 | 92 | 2,321 | 13.1 |
| 2026 cut V4 carb cycle, Mar | 2026-03-05 → 2026-04-01 | 2,192 | 174.1 | -0.74 | -0.42 | 2,560 | 8,628 | 193 | 420 | 1,947 | 11.2 |
| 2026 cut V4 carb cycle, Apr-May | 2026-04-02 → 2026-05-14 | 2,195 | 167.7 | -1.26 | -0.75 | 2,826 | 8,361 | 187 | 366 | 2,273 | 13.6 |

### 1c. Daily macros per plan and day type

| plan_id | day type | kcal | P | C | F |
|---|---|---|---|---|---|
| CUT25-V1 | MP1 | 2,514 | 217 | 294 | 52 |
| CUT25-V1 | MP2 | 2,275 | 212 | 240 | 52 |
| CUT25-V2 | MP1 | 2,405 | 216 | 268 | 52 |
| CUT25-V2 | MP2 | 2,127 | 211 | 206 | 51 |
| CUT25-V3 | MP1 | 2,341 | 215 | 254 | 52 |
| CUT25-V3 | MP2 | 2,003 | 208 | 177 | 51 |
| CUT25-V4 | MP1 | 2,234 | 213 | 230 | 51 |
| CUT25-V4 | MP2 | 1,922 | 207 | 159 | 51 |
| BULK25-V1 | MP | 1,934 | 201 | 180 | 46 |
| BULK25-V2 | MP | 1,991 | 203 | 192 | 46 |
| BULK25-V3 | MP | 2,160 | 207 | 227 | 47 |
| BULK25-V4 | MP | 2,299 | 210 | 258 | 47 |
| BULK25-V5 | MP | 2,388 | 212 | 278 | 48 |
| BULK25-V6 | MP | 2,501 | 220 | 305 | 44 |
| BULK25-V7 | MP | 2,539 | 221 | 314 | 44 |
| CUT26-V1 | MP | 2,421 | 188 | 299 | 52 |
| CUT26-V2 | MP | 2,353 | 188 | 286 | 51 |
| CUT26-V3 | MP | 2,127 | 185 | 231 | 52 |
| CUT26-V4 | MP1 | 2,127 | 185 | 231 | 52 |
| CUT26-V4 | MP2 | 2,353 | 189 | 282 | 52 |

---

## 2. What the data says about his metabolism

**Caveat for everything below:** intake = *plan as written, 100 % adherence*. Cooking oil, sauces, drinks and off-plan meals were not recorded. Cardio comes from Walter's stated routine (modelled), and steps are not yet imported. So every maintenance figure is a **plan-calorie equivalent**: "on paper, Walter maintains at X". For an app that writes plans in the same food format, that is exactly the number you need. It is not necessarily his true TDEE.

1. **Base maintenance ≈ 13.2 kcal per lb body weight**, meaning lifting 5 d/wk + normal daily life with **all cardio removed** (modelled stairs + Apple Health logged runs/rides/swims/hikes). On-plan windows, breaks excluded:
   - Cut 2025 V1 (Feb 11 – Mar 24): 2,787 total − 318 cardio → 2,470 (14.1/lb)
   - Bulk V4 (Aug 2025): 2,362 @ 167.5 lb, no cardio (14.1/lb) · Bulk V5: 2,106 (12.4/lb) · Bulk V7: 2,266 (12.9/lb)
   - Cut 2026 Feb (V1–V3): 2,609 − 288 → 2,321 (13.1/lb) · **Cut 2026 carb cycle, whole window Mar 5 – May 14: 2,848 − 576 → 2,272 (13.3/lb)**
   - Median 13.2, range 12.4–14.1. Outliers are explained in items 3, 6 and 7 and are excluded from the prior.
   - **Prior: TDEE ≈ 13.2 × bodyweight_lb (± 250) + cardio kcal.** At 165 lb: ≈ 2,180 base; ≈ 2,360 with 6 × 30 min stairs; ≈ 2,420 with 6 × 40.
2. **Cardio explains the cut-vs-bulk gap.** Before activity was added, cuts looked like maintenance was 300–600 kcal higher than in bulks. Stairs (~190–255/day) plus, in 2026, the endurance block (~370–420/day logged) account for it. Two implications:
   - **His cuts ran on a modest diet deficit plus cardio.** In Cut 2025, plan intake sat ~130–510 kcal under base and the stairs supplied a third to two-thirds of the deficit. In Cut 2026 (Mar–May), the carb-cycle plan (2,194) was roughly *at* base maintenance (2,272), so **nearly all of the ~650 kcal/day deficit came from cardio** (stairs ~190 + logged endurance ~390).
   - **The app must treat cardio as a first-class input and lever.** Import workouts from Apple Health (dedupe as above), add their kcal to expenditure, and if he drops cardio, intake must drop by the same amount to hold the rate.
   - Bulk steps were ~3,000–5,000/day higher than in the cuts, yet bulk base reads a little *lower* (12.4–12.9). Higher NEAT can't explain that, so bulks most likely included some off-plan eating and glycogen water.
3. **Breaks, and restarting after one.** Both breaks were weight-stable without a plan: −1.3 lb across the 12-week break after Cut 2025 (range 164–172, including a ~+4 lb weekly-average bump in the first two weeks as food and glycogen came back), and +0.6 lb across the 6-week holiday break. The coach restarted the bulk *below* the last cut plan (1,934 kcal), and the first +365 kcal (1,934 → 2,299 over ~6 weeks) produced only +0.28 lb/wk (base read ≈ 11.9/lb). Gains became clear only at ≥ 2,390. **Rule:** after a break, restart near the base prior (13.2 × BW), not far below it, and expect the first 1–2 weeks of scale change to be water/glycogen. When exiting a cut, drop or reduce cardio first (in 2026 that alone frees ~580 kcal/day), then add intake in 100–150 kcal weekly steps.
4. **He gains fast once above maintenance.** At 2,501 kcal (Oct–Nov 2025) he gained 1.34 lb/wk (0.78 %BW/wk), about 2–3× a lean-gain target. Part of that is carb/glycogen water (carbs rose to ~305 g), but sustained over 5 weeks it implies a surplus ≥ 400 kcal. **Rule:** surplus should be ~150–250 kcal over maintenance, targeting +0.1–0.2 %BW/wk (≈ 0.2–0.35 lb/wk at his size).
5. **Responsive to carb cuts.** Each coach reduction of ~20–55 g carbs/day (70–230 kcal, weekly avg) was usually followed by a downward move within 1–2 weeks. (CUT25-V4's window is only 9 days before the break.) Early drops are partly glycogen water, so don't over-credit the first week after a carb change.
6. **April 2026 acceleration: explained by Apple Health.** Plan calories (~2,192) were constant from 2026-03-05, but loss went from −0.74 lb/wk (March) to −1.85 to −2.08 lb/wk (28-day windows ending Apr 13–27). Apple Health shows an **endurance block he didn't mention**: long rides (62, 75 and 103 km in March; 152 km on Apr 19), runs (9–13 km/wk), swims, and a sprint triathlon on May 3. That's ~420 kcal/day logged in March and ~370/day in April–May on top of the stairs. March reads low (base 11.2/lb), because a new high-volume endurance block retains water (glycogen, plasma volume, muscle repair). The loss then showed up in April. Over the whole window the base is 13.3/lb, in line with every other phase. **Rules:** (a) judge the response to a new training block over ≥ 4 weeks, not 2; (b) a cut plus endurance volume like this drove ~1.1 %BW/wk, above the muscle-retention cap, so add food on high-volume days (long rides especially).
7. **Bulk Oct–Nov 2025 reads low.** Base maintenance ≈ 1,770 (10.2/lb) on 2,501 plan kcal, with ~11k steps/day and only short rides, is out of line with every other phase. Likely causes: off-plan intake (holiday season) and/or glycogen water as carbs rose to ~305 g. Using 2,750 kcal/lb for gain tissue lifts it only to ~1,975. Don't use this window as a prior.
8. **Macro habits.** Protein 185–220 g/day (≈ 1.05–1.3 g/lb), consistently high, which is good. Fat 44–52 g/day (≈ 0.25–0.31 g/lb, 16–21 % of kcal), at the low end. Carbs are the variable the coach always moved. Fat is ~constant across all phases.

---

## 3. The previous coach's method (replicate the good parts)

- **Food template:** 4 meals + 1 snack, structured around training. Cut format: M1 (eggs/egg whites + Ezekiel bread), Pre-workout (cream of rice or rice cakes + nut butter + whey isolate), Post-workout (chicken + jasmine rice + green veg), M4 (lean red meat/turkey + sweet potato + green veg), Snack (0 % Greek yogurt + berries + small treat/granola). Bulk format: eggs + rice; chicken/tuna + rice; 93/7 beef or salmon + rice; Cheerios + isolate + milk; protein yogurt.
- **Levers, in order:** (1) carbs (rice, sweet potato, cream of rice/rice cakes, fruit), adjusted in 20–70 g food-weight steps; (2) carb cycling (2 higher-carb days/wk, Tue/Thu in 2025), explicitly used "to keep metabolism going without lowering food much more or hyping cardio"; (3) cardio last. Protein and fat stay ~fixed.
- **Cadence:** cut changes came every 6–42 days (mostly 9–16 d late in a cut), each −70 to −230 kcal (weekly avg). Bulk steps came every 7–37 days, each +38 to +169 kcal.
- **Swaps the coach allows:** chicken ↔ tuna; 93/7 beef ↔ 93/7 turkey ↔ 96/4 beef ↔ steak ↔ salmon; jasmine rice ↔ sweet potato at **1 g rice ≈ 1.6 g sweet potato**; cream of rice ↔ rice cakes (70 g dry CoR ≈ 59 g C ≈ 5 flavored cakes); almond ↔ oat milk; Cheerios ↔ "50–70 g carbs of healthy cereal".
- **Travel mode:** drop the meal plan and give targets only, e.g. "P 185 g, 2,400 kcal, 20 min slow jog daily". The app should support a simple-targets mode.
- **Digestion watch:** the coach asked him to monitor digestion on turkey vs beef. Let the user flag foods that cause GI issues.

---

## 4. Food database and weighing conventions

The full DB is in `plans.json → food_db`, editable. Conventions (calibrated, see §7):
- **Meats weighed COOKED**: chicken 31 g P / 3.6 g F per 100 g; 93/7 beef/turkey ~26.5 g P / 8.5 g F per 100 g.
- **Rice weighed COOKED**: 28.2 g C / 2.7 g P per 100 g.
- Calibration check: the coach's own per-meal macros for 2025-07-20 total ~1,970 kcal (model 1,934), and the coach's travel target of 185 P / 2,400 kcal matches the 2026-02-11 plan (model 188 P / 2,353). The model is within ~2 % of the coach's numbers.
- When a plan offered alternatives, the first option is modelled (e.g. chicken, not tuna; almond milk, not oat).

---

## 5. Adjustment algorithm to implement

Implement an adaptive loop in the style of MacroFactor. Seed it with the priors in `metabolic_profile.json`.

**Daily inputs:** morning weight (fasted, post-bathroom), logged intake (kcal + P/C/F), Apple Health steps + workouts (auto-import), training day (y/n), optional: sleep, an "off-plan" flag.

**Trend weight:** time-aware EWMA, half-life 7 days. Formula used here: `trend += (1 − 0.5^(Δdays/7)) × (weight − trend)`. Never react to single weigh-ins.

**Expenditure estimate (weekly):**
```
window = last 21–28 days (require ≥ 8 weigh-ins)
tdee_obs = mean(logged_kcal) − slope(trend or raw weights, lb/day) × K
K = 3500 kcal/lb when losing; 2500–3000 when gaining (gain tissue is less energy-dense)
tdee_est = blend(prior, tdee_obs) with weight on tdee_obs rising as data accrues
         (e.g. w = min(0.85, n_weighins / 30)); clamp week-to-week change to ±150 kcal
prior = 13.2 × trend_lb (± 250)  +  cardio_kcal
        cardio_kcal = Apple Health workout kcal (deduped; stairs, runs, rides, swims, hikes)
                      fallback by minutes: stairs ≈ 5.4 net MET → 5.4 × 3.5 × kg / 200 kcal/min (his watch); runs ≈ 70 kcal/km
        (prefer watch 'active energy' for cardio sessions when available; lifting 5 d/wk and normal walking are already inside the 13.2 base)
exclude days flagged status = "break" (off-plan) from tdee_obs; resume learning when logging resumes
```
Back-test: replaying the history (`daily_timeline.csv`) should reproduce the base-maintenance figures in §1b within ~±150 kcal for the high-confidence blocks, excluding the flagged anomalies (Bulk ramp, Bulk V6, late Cut 2025, Mar 2026 sub-window) and the breaks.

**Target rates (evidence-based defaults for an intermediate lifter):**
| Goal | Target | Hard limits | His history |
|---|---|---|---|
| Cut | −0.5 to −0.75 %BW/wk (≈ −0.8 to −1.25 lb/wk at 165–175 lb) | slow to ≥ −0.4; cap −1.0 %BW/wk | −0.5 to −0.8 typical; −1.1 to −1.2 in Apr 2026 with the endurance block (too fast) |
| Lean gain | +0.1 to +0.2 %BW/wk (≈ +0.2 to +0.35 lb/wk) | cap +0.35 %BW/wk | +0.31 upper end of OK (Sep 25); +0.78 too fast (Oct–Nov 25) |
| Maintenance / reverse | ±0.1 %BW/wk | after a cut: drop cardio, then +100–150 kcal/wk until intake ≈ 13.2 kcal/lb | 12-wk off-plan break post-cut held weight within ±3 lb |

**Weekly check-in rule:**
```
rate_2wk = trend slope over last 14 d (%BW/wk)
if goal == cut:
    if rate_2wk > target_hi (losing too slowly) for 2 consecutive check-ins → cut 100–150 kcal from CARBS
        (cardio alternative: +30 stair-min/wk ≈ +30 kcal/day; he already ran up to 6 × 40 stairs or 6 × 30 + endurance, so prefer food first)
    on endurance-heavy days (rides > 2 h, long runs) add carbs ≈ 50 % of the logged workout kcal
    if rate_2wk < −1.0 %BW/wk → add 100–150 kcal carbs (protect muscle)
    after ~6–8 wks of dieting or if adjustments stall: consider carb cycle (2 high days at +~225–340 kcal over the 5 low days, as his coach did)
                                                    or a 1–2 wk diet break at maintenance before cutting further food
if goal == gain:
    if rate_2wk > +0.35 %BW/wk → −100 kcal ; if < +0.1 for 3 wks → +100–150 kcal (carbs)
ignore the first 5–7 days after any carb change (glycogen/water) when judging the response
```
**Macro rules:**
- Protein: 1.0–1.1 g/lb in cuts (≈ 165–190 g), 0.8–1.0 g/lb in bulks. He has been at 1.05–1.3 and tolerates it, so keep ≥ 1.0 g/lb as his default.
- Fat floor: ≥ 0.3 g/lb (~50 g). Don't cut fat below his historical ~45 g.
- Carbs: the remainder, and the primary adjustment lever. Bias carbs toward pre/post-workout meals (matches the template).
- Express adjustments as **food-weight changes in his staple foods** (e.g. "post-workout rice 200 → 170 g"), since that's how he's used to receiving plans. ~30 g cooked rice ≈ 8.5 g carbs ≈ 34 kcal; 50 g sweet potato ≈ 10 g carbs ≈ 40 kcal.

**Plan generator constraints:** reuse the meal structure and swap tables in §3; allow carb-cycle mode (MP1/MP2 with user-chosen high days) and travel/simple-targets mode.

---

## 6. Suggested starting point for his next phase

His last weigh-in was **2026-05-14 at 163.4 lb** (weekly avg 164.6). The status since then is unknown. Before prescribing anything, ask for current weight trend (2 weeks of weigh-ins), current intake and goal.
- If maintaining at ~165 lb now with no structured cardio: maintenance prior ≈ **2,180 kcal**, e.g. ~185 P / 50 F / ~250 C. Add the cardio he's currently doing (6 × 30 stairs ≈ +180/day). Since May 2026 Apple Health shows ~9.7k steps/day, ~1 logged lift/wk, ~1 run/wk (6.5 km), and no logged stairs.
- If he has been on a break since May 2026: treat it like his previous breaks (likely weight-stable). Collect 2 weeks of weigh-ins + intake before setting targets.
- If coming straight out of the cut: the last plan (~2,190) is already ≈ base maintenance at 165 lb, so dropping cardio alone ends the deficit. Hold ~2,190–2,250 for 2 weeks and observe.
- Next lean gain: start ≈ maintenance + 150–200 (≈ 2,350 at 165 lb, plus any cardio) and adjust to +0.2–0.35 lb/wk. Don't jump to the Oct-2025 2,500 level, which drove gain too fast.

---

## 7. Known gaps, assumptions, open questions (don't fabricate around these)

1. **No plan data** for 2024-12-28 → 2025-02-10 (first ~6 weeks of Cut 2025: 185 → ~178.7 lb). Weights were logged, so this was not a break; the plan just wasn't provided.
2. **Break 2025-04-24 → 2025-07-19** (confirmed by Walter: gaps = breaks). Off-plan, intake unknown, excluded from estimates. Start date inferred from the 9-day weigh-in gap after 04-23.
3. **Holiday break 2025-12-21 → 2026-01-31**, inferred from weigh-in gaps (21 Dec–15 Jan, 17–29 Jan). Off-plan and excluded. BULK25-V7 is analysed 2025-11-15 → 12-20 only.
4. **2026 carb-cycle day split not stated.** Modelled as MP2 (higher carb) Tue/Thu and MP1 the other 5 days. The weekly avg would be 2,192 (2 high) vs 2,224 (3 high), so it's low impact.
5. **Cardio: stated routine + Apple Health.** Stairs are modelled from the stated routine and calibrated to his watch (5.4 net MET). Runs/rides/swims come from Health and are logged, not modelled. Logging is incomplete (fewer stair/lift sessions than stated), so logged cardio is a lower bound. **Open:** in spring 2026, were all 6 × 30 stair sessions done on top of the endurance work, or did some runs/rides replace stairs? If they replaced them, Mar–May base would read ~14.2 instead of 13.3.
6. **Adherence assumed 100 %.** Oils/sauces/drinks not in plans; the cappuccino is modelled as 12 oz with 2 % milk.
7. **No weigh-ins after 2026-05-14** in this export. Apple Health holds 152 more (from 2026-05-10), but read permission for Weight is off.
8. **Body composition:** Apple Health holds 23 body-fat % and lean-mass readings (permission off, not imported). No measurements, training performance or photos. Rates are body-weight only.
9. 3,500 kcal/lb is used for all estimates. For gain phases, true maintenance is probably ~100–200 kcal *higher* than shown (gain tissue is less energy-dense).

---

## 8. Reproduce / extend
```
python3 scripts/build_data.py   # food DB + plans → out/plans.json, out/plan_macros.csv
python3 scripts/analyze.py      # + data/weight_daily.csv (+ out/health_daily.csv if present) → timeline, windows, blocks, rolling TDEE
```
(First `cp data/weight_daily.csv scripts/ && mkdir -p scripts/out && cp data/health_daily.csv scripts/out/`. Apple Health processing lives in `scripts/health/`; the scripts read it from their own folder and write to `scripts/out/`. Verified: a clean run reproduces `data/plan_windows.csv` and `data/phase_blocks.csv` byte-for-byte.) To add a new plan, append to `PLANS` in `build_data.py`. To add weigh-ins, append rows to `weight_daily.csv`.
