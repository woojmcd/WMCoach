import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildProgram, weeklySetsByMuscle } from '../../coach/program.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const history = JSON.parse(read('data/training_history.json'));
const program = buildProgram(history);
const byId = Object.fromEntries(program.days.flatMap((d) => d.exercises.map((e) => [e.id, e])));

test('committed data/program.json is up to date', () => {
  assert.deepEqual(JSON.parse(read('data/program.json')), JSON.parse(JSON.stringify(program)));
});

test('split: Mon–Fri sessions, open weekend', () => {
  assert.deepEqual(program.days.map((d) => [d.day, d.name, d.exercises.length]), [
    ['Mon', 'Push #1', 9], ['Tue', 'Pull #1', 7], ['Wed', 'Legs and abs', 7], ['Thu', 'Upper Push #2', 7],
    ['Fri', 'Upper Pull #2', 8], ['Sat', 'Open: cardio / social', 0], ['Sun', 'Open: cardio / social', 0],
  ]);
});

test('weekly sets per muscle match TRAINING_HISTORY.md', () => {
  assert.deepEqual(weeklySetsByMuscle(program), {
    chest: 19, side_delts: 14, triceps: 12, abs: 18, back: 21, rear_delts: 6, biceps: 12, hamstrings: 6, adductors: 3, quads: 5,
  });
});

test('types, schemes and RIR follow spec §5', () => {
  const flat = byId['mon-flat-db-bench'];
  assert.equal(flat.type, 'top_backoff');
  assert.equal(flat.scheme.backoff.load_factor, 0.7);
  assert.deepEqual(flat.rir, [1, 1]);
  assert.equal(byId['mon-incline-db-flyes'].cue, 'SLOW, DEEP, focus on stretching as far as possible');
  assert.equal(byId['mon-chest-dips'].type, 'amrap');
  assert.deepEqual(byId['mon-chest-dips'].rir, [0, 0]);
  assert.equal(byId['tue-assisted-pullups'].load_kind, 'assistance');
  assert.deepEqual(byId['tue-cable-lat-pullovers'].scheme, { kind: 'range', min: 10, max: 14, open: true });
  assert.equal(byId['tue-cable-lat-pullovers'].prescription, '3 × 10+');
  assert.equal(byId['wed-bb-squats'].name, 'BB Squats (Smith)');
  assert.equal(byId['wed-bb-squats'].increment_lb, 10);
  assert.equal(byId['thu-flat-smith-machine-bench'].increment_lb, 5);
  assert.equal(byId['wed-russian-twists'].scheme.seconds, 30);
  assert.equal(byId['mon-ab-vacuum'].type, 'timed');
  assert.deepEqual(byId['thu-pec-deck-flyes'].alternates, ['Cable Flyes', 'Flat DB Flyes']);
});

test('supersets: labels, same-weight partner, 15 s between partners', () => {
  const a1 = byId['mon-rope-tricep-extensions'];
  const a2 = byId['mon-rope-pushdowns'];
  assert.equal(a1.label, 'A1');
  assert.equal(a2.label, 'A2');
  assert.equal(a1.rest_s, 15);
  assert.equal(a2.rest_s, 90);
  assert.equal(a2.same_load_as, a1.id);
  assert.equal(byId['mon-cable-ab-crunches'].label, 'B1');
  assert.equal(byId['mon-cable-ab-crunches'].rest_s, 0);
  assert.equal(byId['tue-cable-bar-curls'].rest_s, 90, 'unstated rest falls back to 90 s');
  assert.equal(byId['thu-standing-lateral-db-raises'].same_load_as, 'thu-seated-lateral-db-raises');
});

test('main lifts for the reactive deload (spec §6.4)', () => {
  const main = program.days.flatMap((d) => d.exercises.filter((e) => e.main_lift).map((e) => e.name));
  assert.deepEqual(main, ['Flat DB Bench', 'Hammer Pulldowns', 'Single Leg Press', 'BB Squats (Smith)', 'Incline DB Bench', 'Single Arm DB Rows']);
});

test('exercise ids are unique', () => {
  const ids = program.days.flatMap((d) => d.exercises.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length);
});
