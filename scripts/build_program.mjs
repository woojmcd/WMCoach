// Generates data/program.json from the program the app runs: Program E (TRAIN-E26),
// written out in data/programs/TRAIN-E26.json. Usage: npm run build:program
import { readFile, writeFile } from 'node:fs/promises';
import { buildProgramFromSource } from '../coach/program.js';

export const PROGRAM_SOURCE = 'data/programs/TRAIN-E26.json';
const root = new URL('../', import.meta.url);
const src = JSON.parse(await readFile(new URL(PROGRAM_SOURCE, root), 'utf8'));
const program = buildProgramFromSource(src);
await writeFile(new URL('data/program.json', root), `${JSON.stringify(program, null, 2)}\n`);
const n = program.days.reduce((s, d) => s + d.exercises.length, 0);
console.log(`data/program.json: ${program.name}, ${n} exercises over ${program.days.filter((d) => d.exercises.length).length} days`);
