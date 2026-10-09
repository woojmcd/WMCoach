// Generates data/program.json from TRAIN-CUT26 in data/training_history.json.
// Usage: npm run build:program
import { readFile, writeFile } from 'node:fs/promises';
import { buildProgram } from '../coach/program.js';

const root = new URL('../', import.meta.url);
const history = JSON.parse(await readFile(new URL('data/training_history.json', root), 'utf8'));
const program = buildProgram(history);
await writeFile(new URL('data/program.json', root), `${JSON.stringify(program, null, 2)}\n`);
const n = program.days.reduce((s, d) => s + d.exercises.length, 0);
console.log(`data/program.json: ${program.name}, ${n} exercises over ${program.days.filter((d) => d.exercises.length).length} days`);
