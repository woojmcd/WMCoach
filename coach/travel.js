// Travel workout (Walter, 2026-10-20): when the gym on the road can't run the program's
// exact session, the same day is done with comparable free-weight and bodyweight lifts
// (dumbbells, a bench, a bar or rings for pull-ups), at the same effort: same sets, same
// RIR. Every travel lift has its own history (movement "travel-…"), so it progresses from
// the last travel workout and never moves the gym targets; the day still counts as done.
import { slug } from './program.js';

const BW_AMRAP = { type: 'amrap', scheme: { kind: 'amrap', add_load_at: 15 }, equipment: 'bodyweight', load_kind: 'bodyweight', increment_lb: 5 };
const DB = { equipment: 'dumbbell', load_kind: 'external' };

// slot id → { name, alternates, cue?, ...overrides } for Program E (2026-11-14). A slot not
// listed keeps its exercise (it already works with dumbbells or bodyweight), still on a
// travel history. Program E's banned lifts stay banned on the road: no dips, no pullovers,
// no hinges, nothing overhead for triceps, flyes stop at the shoulder line.
const STOP = 'Stop at the shoulder line: no deep stretch.';
export const TRAVEL = {
  // Push A
  'mon-rope-face-pulls': { name: 'Prone Reverse DB Flyes', alternates: ['Band Pull-Aparts'], ...DB, cue: 'Primer: chest on an incline bench, light, 2 s squeeze.' },
  'mon-single-cable-lateral-raise': { name: 'Lean-Away DB Lateral Raise', alternates: ['Standing Lateral DB Raises'], ...DB },
  'mon-pec-deck-flyes': { name: 'Flat DB Flyes', alternates: ['Feet-Elevated Push-ups'], ...DB, cue: STOP },
  'mon-rope-pushdowns': { name: 'DB Kickbacks', ...DB },
  'mon-straight-bar-pushdowns': { name: 'Close-Grip Push-ups', alternates: ['DB Kickbacks'] },
  'mon-machine-hip-abduction': { name: 'Side-Lying Hip Abduction', alternates: ['Banded Lateral Walks'] },
  // Pull A
  'tue-chest-supported-machine-row': { name: 'Chest-Supported DB Rows', alternates: ['Single Arm DB Rows'], ...DB, cue: 'Chest on an incline bench, neutral grip, 2 s squeeze.' },
  'tue-neutral-grip-pulldown': { name: 'Neutral-Grip Pull-ups', alternates: ['Single Arm DB Rows'] },
  'tue-wide-grip-cable-rows': { name: 'Wide Incline DB Rows', alternates: ['Reverse DB Flyes'], ...DB, cue: 'Chest on an incline bench, elbows about 75°.' },
  'tue-kneeling-cable-crunches': { name: 'Weighted Crunches (DB)', alternates: ['Bench Reverse Crunch'], ...DB },
  'tue-reverse-pec-deck-flyes': { name: 'Reverse DB Flyes', ...DB },
  'tue-reverse-cable-curls': { name: 'Reverse-Grip DB Curls', ...DB },
  'tue-cable-bar-curls': { name: 'DB Curls', ...DB },
  // Legs and abs
  'wed-machine-hip-abduction': { name: 'Side-Lying Hip Abduction', alternates: ['Banded Lateral Walks'] },
  'wed-close-stance-chain-squat': { name: 'Heel-Elevated Goblet Squats', alternates: ['DB Front Squats'], ...DB, cue: 'Knees over toes. Exhale on the way up; no breath-hold.' },
  'wed-leg-press': { name: 'Bulgarian Split Squats (DB)', alternates: ['DB Reverse Lunges'], ...DB },
  'wed-leg-extensions': { name: 'Sissy Squats', alternates: ['Heel-Elevated Goblet Squats'] },
  'wed-seated-hamstring-curls': { name: 'Slider Leg Curls', alternates: ['Swiss Ball Leg Curls'] },
  'wed-standing-cable-hip-abduction': { name: 'Banded Lateral Walks', alternates: ['Side-Lying Hip Abduction'] },
  'wed-heavy-cable-crunches': { name: 'Weighted Crunches (DB)', alternates: ['Bench Reverse Crunch'], ...DB },
  // Push B
  'thu-rope-face-pulls': { name: 'Prone Reverse DB Flyes', alternates: ['Band Pull-Aparts'], ...DB, cue: 'Primer: chest on an incline bench, light, 2 s squeeze.' },
  'thu-converging-machine-chest-press': { name: 'Flat DB Bench', alternates: ['Feet-Elevated Push-ups'], ...DB },
  'thu-pec-deck-flyes': { name: 'Flat DB Flyes', alternates: ['Feet-Elevated Push-ups'], ...DB, cue: STOP },
  'thu-cable-y-raises': { name: 'Prone Incline Y-Raises', ...DB },
  'thu-cable-shrugs': { name: 'Seated DB Shrugs', ...DB },
  'thu-single-arm-cable-pushdowns': { name: 'Single Arm DB Kickbacks', ...DB },
  // Pull B
  'fri-single-arm-cable-pulldowns': { name: 'Neutral-Grip Pull-ups', alternates: ['Single Arm DB Rows'] },
  'fri-chest-supported-wide-grip-rows': { name: 'Wide Incline DB Rows', ...DB, cue: 'Chest on an incline bench, elbows about 75°, 2 s squeeze.' },
  'fri-single-cable-lateral-raise': { name: 'Lean-Away DB Lateral Raise', alternates: ['Standing Lateral DB Raises'], ...DB },
  'fri-cable-woodchops': { name: 'DB Woodchops', ...DB },
  'fri-kb-suitcase-carry': { name: 'KB Suitcase Carry', alternates: ['DB Suitcase Carry'] },
};

// Alternatives done with body weight (logged as reps, +lb only if weighted), whatever slot they fill.
const BODYWEIGHT = new Set(['Feet-Elevated Push-ups', 'Close-Grip Push-ups', 'Pull-ups', 'Neutral-Grip Pull-ups', 'Inverted Rows', 'Pull-up Negatives', 'Hanging Knee Raises', 'Bench Reverse Crunch', 'Slider Leg Curls', 'Swiss Ball Leg Curls', 'Sissy Squats', 'Side-Lying Hip Abduction', 'Banded Lateral Walks', 'Band Pull-Aparts']);
export const isBodyweightLift = (name) => BODYWEIGHT.has(name);

export const travelMovement = (name) => `travel-${slug(name)}`;
export const isTravelMovement = (m) => String(m || '').startsWith('travel-');

// The travel version of a program exercise (optionally with another travel lift's name).
// Keeps the slot id, sets, rest, superset links and cue; swaps name, equipment and history.
export function travelExercise(ex, name = null) {
  const t = TRAVEL[ex.id] || { name: ex.name };
  const pick = name || t.name;
  const { name: _n, alternates = [], cue: tcue, ...over } = t;
  const bw = isBodyweightLift(pick) && ex.load_kind !== 'bodyweight' ? BW_AMRAP : {};
  return {
    ...ex, ...over, ...bw,
    name: pick,
    movement: travelMovement(pick),
    travel_of: ex.name,
    alternates: [...new Set([t.name, ...alternates, ex.name])].filter((n) => n !== pick),
    cue: !TRAVEL[ex.id] ? ex.cue
      : tcue && pick === t.name ? tcue
      : (bw.load_kind || over.load_kind) === 'bodyweight' ? 'Same effort as the gym lift: hit the RIR. Too easy? Slow the lowering to 3 s or pause at the hardest point.'
        : 'Same effort as the gym lift: hit the RIR. If the dumbbells top out, add reps or slow the lowering to 3 s.',
  };
}

export function travelDay(day) {
  return { ...day, exercises: day.exercises.map((ex) => travelExercise(ex)) };
}
