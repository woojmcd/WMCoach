// Builds data/program.json from TRAIN-CUT26 in data/training_history.json (spec §5).
// Sets, rest, superset groups, cues and alternates come from the coach's
// transcription. Exercise type, rep scheme and target RIR follow the spec §5
// table, because the coach's free-text rep strings are ambiguous to parse.

export const PROGRAM_ID = 'TRAIN-CUT26';
export const PROGRAM_SCHEMA_VERSION = 1;

// Load increments (spec §6.1). Editable per exercise in Settings later.
export const INCREMENTS_LB = {
  dumbbell: 5, // next DB, per hand
  smith_upper: 5,
  smith_lower: 10,
  machine: 10, // next pin/plate
  cable: 5, // next pin
  bodyweight: 5, // belt load once reps are high
  assisted: 10, // one pin less assistance
  none: 0,
};

const LOAD_KIND = {
  dumbbell: 'external', smith_upper: 'external', smith_lower: 'external', machine: 'external', cable: 'external',
  bodyweight: 'bodyweight', assisted: 'assistance', none: 'none',
};

const R = (min, max, extra = {}) => ({ kind: 'range', min, max, ...extra });

// Target RIR (spec §5): first/heaviest exercise of the day and top sets 1;
// other work 0–1; AMRAP, to-failure and same-weight finishers 0.
const RULES = {
  // Mon: Push #1
  'Mon|Incline DB Flyes': { type: 'range', scheme: R(8, 10), rir: [1, 1], equipment: 'dumbbell', muscle: 'chest' },
  'Mon|Flat DB Bench': { type: 'top_backoff', scheme: { kind: 'top_backoff', top_sets: 2, min: 8, max: 10, backoff: { sets: 1, min: 12, max: 12, load_factor: 0.7, rir: [0, 1] } }, rir: [1, 1], equipment: 'dumbbell', muscle: 'chest', main_lift: true },
  'Mon|Chest Dips': { type: 'amrap', scheme: { kind: 'amrap', add_load_at: 15 }, rir: [0, 0], equipment: 'bodyweight', muscle: 'chest' },
  'Mon|Single Cable Lateral Raise': { type: 'range', scheme: R(12, 15, { per_side: true }), rir: [0, 1], equipment: 'cable', muscle: 'side_delts' },
  'Mon|Standing Lateral DB Raises': { type: 'range', scheme: R(10, 12), rir: [0, 1], equipment: 'dumbbell', muscle: 'side_delts' },
  'Mon|Rope Tricep Extensions': { type: 'superset_lead', scheme: R(10, 12), rir: [0, 1], equipment: 'cable', muscle: 'triceps' },
  'Mon|Rope Pushdowns': { type: 'superset_same_weight', scheme: { kind: 'amrap' }, rir: [0, 0], equipment: 'cable', muscle: 'triceps' },
  'Mon|Cable Ab Crunches': { type: 'range', scheme: R(15, 15), rir: [0, 1], equipment: 'cable', muscle: 'abs' },
  'Mon|Ab Vacuum': { type: 'timed', scheme: { kind: 'timed', seconds: 15 }, rir: null, equipment: 'none', muscle: 'abs' },
  // Tue: Pull #1
  'Tue|Assisted Pullups': { type: 'assisted', scheme: { kind: 'assisted', min: 6, progress_at: 8 }, rir: [1, 1], equipment: 'assisted', muscle: 'back' },
  'Tue|Incline DB Rows (upper back)': { type: 'fixed', scheme: { kind: 'fixed', reps: 10 }, rir: [0, 1], equipment: 'dumbbell', muscle: 'back' },
  'Tue|Hammer Pulldowns': { type: 'range', scheme: R(8, 10), rir: [0, 1], equipment: 'machine', muscle: 'back', main_lift: true },
  'Tue|Cable Lat Pullovers': { type: 'open_range', scheme: R(10, 14, { open: true }), rir: [0, 0], equipment: 'cable', muscle: 'back' },
  'Tue|Reverse DB Flyes': { type: 'range', scheme: R(10, 12), rir: [0, 1], equipment: 'dumbbell', muscle: 'rear_delts' },
  'Tue|Reverse Cable Curls': { type: 'superset_lead', scheme: R(8, 10), rir: [0, 1], equipment: 'cable', muscle: 'biceps' },
  'Tue|Cable Bar Curls': { type: 'superset_same_weight', scheme: { kind: 'amrap' }, rir: [0, 0], equipment: 'cable', muscle: 'biceps' },
  // Wed: Legs and abs
  'Wed|Hamstring Hyperextensions': { type: 'amrap', scheme: { kind: 'amrap', add_load_at: 15 }, rir: [0, 0], equipment: 'bodyweight', muscle: 'hamstrings' },
  'Wed|Machine Adductors': { type: 'range', scheme: R(12, 15), rir: [0, 1], equipment: 'machine', muscle: 'adductors' },
  'Wed|Single Leg Press': { type: 'range', scheme: R(10, 12, { per_side: true }), rir: [0, 1], equipment: 'machine', muscle: 'quads', main_lift: true },
  'Wed|BB Squats (smith machine)': { name: 'BB Squats (Smith)', type: 'range', scheme: R(8, 10), rir: [1, 1], equipment: 'smith_lower', muscle: 'quads', main_lift: true },
  'Wed|Seated Hamstring Curls': { type: 'top_backoff', scheme: { kind: 'top_backoff', top_sets: 2, min: 8, max: 10, backoff: { sets: 1, min: 12, max: 15, load_factor: 0.7, rir: [0, 1] } }, rir: [1, 1], equipment: 'machine', muscle: 'hamstrings' },
  'Wed|Hanging Leg Raises': { type: 'amrap', scheme: { kind: 'amrap', reps_only: true }, rir: [0, 0], equipment: 'bodyweight', muscle: 'abs' },
  'Wed|Russian Twists': { type: 'timed', scheme: { kind: 'timed', seconds: 30 }, rir: null, equipment: 'none', muscle: 'abs' },
  // Thu: Upper Push #2
  'Thu|Pec Deck Flyes': { type: 'range', scheme: R(12, 15), rir: [1, 1], equipment: 'machine', muscle: 'chest' },
  'Thu|Incline DB Bench': { type: 'top_backoff', scheme: { kind: 'top_backoff', top_sets: 2, min: 8, max: 10, backoff: { sets: 1, amrap: true, load_factor: 0.7, rir: [0, 0] } }, rir: [1, 1], equipment: 'dumbbell', muscle: 'chest', main_lift: true },
  'Thu|Flat Smith Machine Bench': { type: 'range', scheme: R(10, 12), rir: [0, 1], equipment: 'smith_upper', muscle: 'chest' },
  'Thu|Seated Lateral DB Raises': { type: 'superset_lead', scheme: { kind: 'fixed', reps: 10 }, rir: [0, 1], equipment: 'dumbbell', muscle: 'side_delts' },
  'Thu|Standing Lateral DB Raises': { type: 'superset_same_weight', scheme: { kind: 'amrap', partials: '5+' }, rir: [0, 0], equipment: 'dumbbell', muscle: 'side_delts' },
  'Thu|Single Arm Cable Pushdowns': { type: 'range', scheme: R(10, 12, { per_side: true }), rir: [0, 1], equipment: 'cable', muscle: 'triceps' },
  'Thu|Incline DB Skullcrushers': { type: 'range', scheme: R(12, 15), rir: [0, 1], equipment: 'dumbbell', muscle: 'triceps' },
  // Fri: Upper Pull #2
  'Fri|Reverse Pec Deck Flyes': { type: 'range', scheme: R(10, 12), rir: [1, 1], equipment: 'machine', muscle: 'rear_delts' },
  'Fri|Cable Lat Pullovers': { type: 'range', scheme: R(12, 15), rir: [0, 1], equipment: 'cable', muscle: 'back' },
  'Fri|Single Arm DB Rows': { type: 'range', scheme: R(8, 10), rir: [0, 1], equipment: 'dumbbell', muscle: 'back', main_lift: true },
  'Fri|Single Arm Cable Pulldowns': { type: 'fixed', scheme: { kind: 'fixed', reps: 10 }, rir: [0, 1], equipment: 'cable', muscle: 'back' },
  'Fri|Incline DB Curls': { type: 'range', scheme: R(8, 10), rir: [0, 0], equipment: 'dumbbell', muscle: 'biceps' },
  'Fri|Hammer Rope Curls': { type: 'range', scheme: R(12, 15), rir: [0, 1], equipment: 'cable', muscle: 'biceps' },
  'Fri|Cable Ab Crunches': { type: 'range', scheme: R(15, 15), rir: [0, 1], equipment: 'cable', muscle: 'abs' },
  'Fri|Ab Plank': { type: 'timed', scheme: { kind: 'timed', seconds: 30 }, rir: null, equipment: 'none', muscle: 'abs' },
};

const DAY_NAMES = { Sat: 'Open: cardio / social', Sun: 'Open: cardio / social' };
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function slug(s) {
  return s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function prescriptionText(sets, scheme) {
  const side = scheme.per_side ? ' each side' : '';
  switch (scheme.kind) {
    case 'range':
      if (scheme.open) return `${sets} × ${scheme.min}+`;
      return scheme.min === scheme.max ? `${sets} × ${scheme.min}${side}` : `${sets} × ${scheme.min}–${scheme.max}${side}`;
    case 'fixed':
      return `${sets} × ${scheme.reps}`;
    case 'top_backoff': {
      const b = scheme.backoff;
      const back = b.amrap ? 'AMRAP' : b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`;
      return `${scheme.top_sets} × ${scheme.min}–${scheme.max}, then ${b.sets} × ${back} lighter`;
    }
    case 'amrap':
      return `${sets} × AMRAP`;
    case 'assisted':
      return `${sets} × ${scheme.min}+`;
    case 'timed':
      return `${sets} × ${scheme.seconds} s`;
    default:
      return `${sets} sets`;
  }
}

export function buildProgram(trainingHistory, { defaultRestS = 90 } = {}) {
  const src = trainingHistory.programs.find((p) => p.id === PROGRAM_ID);
  if (!src) throw new Error(`${PROGRAM_ID} not found in training_history.json`);
  const used = new Set();
  const days = src.days.map((d) => {
    const groupCount = new Map();
    const exercises = d.exercises.map((e, i) => {
      const key = `${d.day}|${e.name}`;
      const rule = RULES[key];
      if (!rule) throw new Error(`No rule for ${key}`);
      used.add(key);
      let label = null;
      if (e.group) {
        const n = (groupCount.get(e.group) || 0) + 1;
        groupCount.set(e.group, n);
        label = `${e.group.split('-').pop()}${n}`;
      }
      const name = rule.name || e.name;
      const id = `${d.day.toLowerCase()}-${slug(e.name)}`;
      return {
        id,
        movement: slug(e.name),
        name,
        source_name: e.name,
        order: i + 1,
        group: e.group || null,
        label,
        sets: e.sets,
        type: rule.type,
        scheme: rule.scheme,
        prescription: prescriptionText(e.sets, rule.scheme),
        rir: rule.rir,
        rest_s: e.rest_s === null || e.rest_s === undefined ? defaultRestS : e.rest_s,
        cue: e.cue || null,
        equipment: rule.equipment,
        load_kind: LOAD_KIND[rule.equipment],
        increment_lb: INCREMENTS_LB[rule.equipment],
        muscle: rule.muscle,
        main_lift: Boolean(rule.main_lift),
        alternates: e.alternates || [],
      };
    });
    // Superset partners: the second item uses the lead's load (same-weight finishers).
    for (const ex of exercises) {
      if (ex.type === 'superset_same_weight') {
        const lead = exercises.find((x) => x.group === ex.group && x.type === 'superset_lead');
        ex.same_load_as = lead ? lead.id : null;
      }
    }
    return { dow: DOW[d.day], day: d.day, name: DAY_NAMES[d.day] || d.name, est_min: d.est_min || null, exercises };
  });
  const unused = Object.keys(RULES).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`Rules not matched to the program: ${unused.join(', ')}`);
  return {
    schema_version: PROGRAM_SCHEMA_VERSION,
    id: PROGRAM_ID,
    name: 'Program C',
    source: `data/training_history.json#${PROGRAM_ID}`,
    generated_by: 'scripts/build_program.mjs',
    defaults: { rest_s: defaultRestS, superset_rest_s: 15 },
    days,
  };
}

export function weeklySetsByMuscle(program) {
  const out = {};
  for (const d of program.days) for (const e of d.exercises) out[e.muscle] = (out[e.muscle] || 0) + e.sets;
  return out;
}

export function dayForWeekday(program, isoDow) {
  return program.days.find((d) => d.dow === isoDow) || null;
}
