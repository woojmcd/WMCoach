// Travel workout (Walter, 2026-10-20): when the gym on the road can't run the program's
// exact session, the same day is done with comparable free-weight and bodyweight lifts
// (dumbbells, a bench, a bar or rings for pull-ups), at the same effort: same sets, same
// RIR. Every travel lift has its own history (movement "travel-…"), so it progresses from
// the last travel workout and never moves the gym targets; the day still counts as done.
import { slug } from './program.js';

const BW_AMRAP = { type: 'amrap', scheme: { kind: 'amrap', add_load_at: 15 }, equipment: 'bodyweight', load_kind: 'bodyweight', increment_lb: 5 };
const DB = { equipment: 'dumbbell', load_kind: 'external' };

// slot id → { name, alternates, ...overrides }. A slot not listed keeps its exercise (it
// already works with dumbbells or bodyweight), still on a travel history.
export const TRAVEL = {
  // Push #1
  'mon-flat-db-bench': { name: 'Flat DB Bench', alternates: ['Feet-Elevated Push-ups'] },
  'mon-chest-dips': { name: 'Chest Dips', alternates: ['Bench Dips', 'Deficit Push-ups'] },
  'mon-single-cable-lateral-raise': { name: 'Lean-Away DB Lateral Raise', alternates: ['Standing Lateral DB Raises'], ...DB },
  'mon-rope-tricep-extensions': { name: 'Overhead DB Tricep Extensions', alternates: ['Incline DB Skullcrushers'], ...DB },
  'mon-rope-pushdowns': { name: 'DB Kickbacks', alternates: ['Close-Grip Push-ups'], ...DB },
  'mon-cable-ab-crunches': { name: 'Weighted Crunches (DB)', alternates: ['Lying Leg Raises'], ...DB },
  // Pull #1
  'tue-assisted-pullups': { name: 'Pull-ups', alternates: ['Inverted Rows', 'Pull-up Negatives'], ...BW_AMRAP, rir: [1, 1] },
  'tue-hammer-pulldowns': { name: 'Single Arm DB Rows', alternates: ['Chest-Supported DB Rows'], ...DB },
  'tue-cable-lat-pullovers': { name: 'DB Pullovers', ...DB },
  'tue-reverse-cable-curls': { name: 'Reverse-Grip DB Curls', ...DB },
  'tue-cable-bar-curls': { name: 'DB Curls', ...DB },
  // Legs and abs
  'wed-hamstring-hyperextensions': { name: 'Single-Leg Hip Thrusts', alternates: ['Glute Bridges'] },
  'wed-machine-adductors': { name: 'Sumo Goblet Squats', alternates: ['Cossack Squats'], ...DB },
  'wed-single-leg-press': { name: 'Bulgarian Split Squats (DB)', alternates: ['DB Reverse Lunges'], ...DB },
  'wed-bb-squats': { name: 'Goblet Squats', alternates: ['DB Front Squats'], ...DB },
  'wed-seated-hamstring-curls': { name: 'DB Romanian Deadlifts', alternates: ['Single-Leg DB RDL', 'Slider Leg Curls'], ...DB },
  'wed-hanging-leg-raises': { name: 'Hanging Leg Raises', alternates: ['Lying Leg Raises'] },
  // Upper Push #2
  'thu-pec-deck-flyes': { name: 'Flat DB Flyes', alternates: ['Incline DB Flyes'], ...DB },
  'thu-flat-smith-machine-bench': { name: 'Flat DB Bench', alternates: ['Feet-Elevated Push-ups'], ...DB },
  'thu-single-arm-cable-pushdowns': { name: 'Single Arm DB Kickbacks', alternates: ['Overhead DB Tricep Extensions'], ...DB },
  // Upper Pull #2
  'fri-reverse-pec-deck-flyes': { name: 'Reverse DB Flyes', ...DB },
  'fri-cable-lat-pullovers': { name: 'DB Pullovers', ...DB },
  'fri-single-arm-cable-pulldowns': { name: 'Chest-Supported DB Rows', alternates: ['Pull-ups'], ...DB },
  'fri-hammer-rope-curls': { name: 'DB Hammer Curls', ...DB },
  'fri-cable-ab-crunches': { name: 'Weighted Crunches (DB)', alternates: ['Lying Leg Raises'], ...DB },
};

// Alternatives done with body weight (logged as reps, +lb only if weighted), whatever slot they fill.
const BODYWEIGHT = new Set(['Feet-Elevated Push-ups', 'Deficit Push-ups', 'Close-Grip Push-ups', 'Bench Dips', 'Chest Dips', 'Pull-ups', 'Inverted Rows', 'Pull-up Negatives', 'Lying Leg Raises', 'Hanging Leg Raises', 'Glute Bridges', 'Single-Leg Hip Thrusts', 'Slider Leg Curls', 'Cossack Squats']);
export const isBodyweightLift = (name) => BODYWEIGHT.has(name);

export const travelMovement = (name) => `travel-${slug(name)}`;
export const isTravelMovement = (m) => String(m || '').startsWith('travel-');

// The travel version of a program exercise (optionally with another travel lift's name).
// Keeps the slot id, sets, rest, superset links and cue; swaps name, equipment and history.
export function travelExercise(ex, name = null) {
  const t = TRAVEL[ex.id] || { name: ex.name };
  const pick = name || t.name;
  const { name: _n, alternates = [], ...over } = t;
  const bw = isBodyweightLift(pick) && ex.load_kind !== 'bodyweight' ? BW_AMRAP : {};
  return {
    ...ex, ...over, ...bw,
    name: pick,
    movement: travelMovement(pick),
    travel_of: ex.name,
    alternates: [...new Set([t.name, ...alternates, ex.name])].filter((n) => n !== pick),
    cue: !TRAVEL[ex.id] ? ex.cue
      : (bw.load_kind || over.load_kind) === 'bodyweight' ? 'Same effort as the gym lift: hit the RIR. Too easy? Slow the lowering to 3 s or pause at the hardest point.'
        : 'Same effort as the gym lift: hit the RIR. If the dumbbells top out, add reps or slow the lowering to 3 s.',
  };
}

export function travelDay(day) {
  return { ...day, exercises: day.exercises.map((ex) => travelExercise(ex)) };
}
