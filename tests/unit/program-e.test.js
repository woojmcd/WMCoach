import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildProgramFromSource } from '../../coach/program.js';
import { targetFor } from '../../coach/progression.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const src = JSON.parse(read('data/programs/TRAIN-E26.json'));
const program = buildProgramFromSource(src);
const committed = JSON.parse(read('data/program.json'));
const c = JSON.parse(read('tests/fixtures/program-c.json'));
const all = program.days.flatMap((d) => d.exercises);
const byId = Object.fromEntries(all.map((e) => [e.id, e]));

test('the app runs Program E: committed data/program.json is built from data/programs/TRAIN-E26.json', () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(program)));
  assert.equal(program.id, 'TRAIN-E26');
  assert.deepEqual(program.days.map((d) => [d.day, d.name]), [
    ['Mon', 'Push A'], ['Tue', 'Pull A'], ['Wed', 'Legs and abs'], ['Thu', 'Push B'], ['Fri', 'Pull B'],
    ['Sat', 'Open: cardio / social'], ['Sun', 'Open: cardio / social'],
  ]);
  for (const d of program.days.filter((x) => x.exercises.length)) assert.ok(d.est_min <= 60, `${d.day} ≤ 60 min`);
  assert.equal(program.rules.length, 4);
  assert.match(program.stop_rule, /surgeon/);
});

test('main lifts per PROGRAM_E.md, and lifts kept from Program C keep their history', () => {
  assert.deepEqual(all.filter((e) => e.main_lift).map((e) => e.id), [
    'mon-low-incline-db-press', 'tue-chest-supported-machine-row', 'wed-leg-press', 'thu-converging-machine-chest-press', 'fri-single-arm-db-rows',
  ]);
  const cIds = new Set(c.days.flatMap((d) => d.exercises.map((e) => `${e.id}|${e.movement}`)));
  const kept = all.filter((e) => cIds.has(`${e.id}|${e.movement}`)).map((e) => e.id);
  for (const id of ['tue-reverse-cable-curls', 'tue-cable-bar-curls', 'wed-seated-hamstring-curls', 'thu-seated-lateral-db-raises', 'thu-standing-lateral-db-raises',
    'thu-pec-deck-flyes', 'thu-single-arm-cable-pushdowns', 'thu-incline-db-skullcrushers', 'fri-single-arm-db-rows', 'fri-single-arm-cable-pulldowns', 'fri-incline-db-curls',
    'mon-single-cable-lateral-raise', 'mon-rope-pushdowns']) assert.ok(kept.includes(id), `${id} carries over`);
});

test('banned mechanics are not in the program; no paired-cable or Smith lifts', () => {
  const banned = /smith|dip|pullover|deadlift|\bRDL\b|good morning|hip thrust|hyperextension|upright row|overhead|bent-over|pendlay|calf|leg raises\b|russian twist/i;
  for (const e of all) {
    assert.doesNotMatch(e.name, banned, e.name);
    assert.notEqual(e.equipment, 'smith_upper');
    assert.notEqual(e.equipment, 'smith_lower');
  }
  assert.ok(all.every((e) => !/cable fly(es)?$/i.test(e.name) || /single-arm/i.test(e.name)));
});

test('supersets: same-weight partners point at their lead; leads rest 15 s', () => {
  for (const e of all.filter((x) => x.type === 'superset_same_weight')) {
    const lead = byId[e.same_load_as];
    assert.ok(lead && lead.group === e.group && lead.type === 'superset_lead', e.id);
    assert.equal(lead.rest_s, 15);
  }
  assert.deepEqual(['mon-hanging-knee-raises', 'mon-machine-hip-abduction'].map((id) => byId[id].label), ['C1', 'C2']);
});

test('chain squat: never targeted above 225 lb; at the ceiling it progresses in tempo, not load', () => {
  const sq = byId['wed-close-stance-chain-squat'];
  assert.deepEqual([sq.max_load_lb, sq.rir, sq.increment_lb], [225, [3, 3], 10]);
  const hist = (load) => [{ local_date: '2026-11-18', deload: false, sets: [1, 2, 3].map(() => ({ kind: 'work', load, reps: 10, rir: 3, done: true })) }];
  const near = targetFor(sq, hist(220), { mode: 'bulk' });
  assert.deepEqual([near.load, near.change], [225, 'up'], '220 → the ceiling, not 230');
  const at = targetFor(sq, hist(225), { mode: 'bulk' });
  assert.deepEqual([at.load, at.change], [225, 'hold']);
  assert.match(at.reason, /225 lb ceiling: progress with a slower lowering/);
  const over = targetFor(sq, hist(245), { mode: 'bulk' });
  assert.ok(over.load <= 225, 'a logged load above the ceiling is never targeted again');
  assert.match(targetFor(sq, [], { mode: 'bulk' }).reason, /no more than 225 lb/);
});

test('carries are logged in metres', () => {
  const carry = byId['fri-kb-suitcase-carry'];
  assert.deepEqual([carry.scheme.unit, carry.prescription, carry.equipment, carry.load_kind], ['m', '3 × 30–40 m each side', 'kettlebell', 'external']);
});

test('a new program starts a new block: Program E opens at week 1, not in Program C’s week-6 deload', async () => {
  const { trainingCalendar } = await import('../../coach/progression.js');
  const cSessions = [];
  for (let d = new Date('2026-10-12T12:00:00Z'); d <= new Date('2026-11-13T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) cSessions.push({ id: `s${cSessions.length}`, local_date: d.toISOString().slice(0, 10), status: 'finished', day_dow: dow, exercises: [], started_utc: d.toISOString() });
  }
  const onC = trainingCalendar(cSessions, c, '2026-11-16');
  assert.deepEqual([onC.week, onC.deload.isDeload], [6, true], 'Program C would deload this week');
  const onE = trainingCalendar(cSessions, program, '2026-11-16');
  assert.deepEqual([onE.week, onE.deload.isDeload, onE.programStart], [1, false, '2026-10-12']);
  assert.equal(onE.firstBlock, false, '"lifted less since May" easing was for the first block only');
  assert.equal(onC.firstBlock, true);
  const withE = [...cSessions, { id: 'e1', local_date: '2026-11-16', status: 'finished', day_dow: 1, exercises: [], started_utc: '2026-11-16T17:00:00Z', program_id: 'TRAIN-E26' }];
  assert.equal(trainingCalendar(withE, program, '2026-11-23').week, 2);
  assert.equal(trainingCalendar(withE, program, '2026-12-21').deload.isDeload, true, 'E’s own week 6');
});
