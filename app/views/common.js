import { h, icon } from '../ui.js';
import { daysBetween, formatDayMonth, formatMonthYear } from '../../coach/time.js';
import { describeEntry } from '../../coach/progression.js';

export function header({ label, title, right = null }) {
  return h('header', { class: 'header' },
    h('div', { class: 'grow' }, h('p', { class: 'label' }, label), h('h1', { class: 'title' }, title)),
    right);
}

export function sectionLabel(text) {
  return h('h2', { class: 'label section' }, text);
}

export function note(text) {
  return h('p', { class: 'empty-note' }, text);
}

export function phaseRange(p, today) {
  const end = p.end || today;
  const weeks = Math.max(1, Math.round((daysBetween(p.start, end) + 1) / 7));
  if (!p.end) return `Since ${formatDayMonth(p.start)} ${p.start.slice(0, 4)} · week ${weeks}`;
  const sameYear = p.start.slice(0, 4) === p.end.slice(0, 4);
  return `${formatDayMonth(p.start)}${sameYear ? '' : ` ${p.start.slice(0, 4)}`} – ${formatDayMonth(p.end)} ${p.end.slice(0, 4)} · ${weeks} wk`;
}

export function monthSpan(a, b) {
  return `${formatMonthYear(a)} – ${formatMonthYear(b)}`;
}

export function backButton(onClick) {
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onClick }, icon('back'));
}

// Read-only list of what was logged in a session.
export function sessionList(session, program) {
  const idx = {};
  for (const d of program.days) for (const e of d.exercises) idx[e.id] = e;
  return h('div', { class: 'list' }, session.exercises.map((e) => {
    const pex = idx[e.slot_id] || { load_kind: 'external' };
    const text = e.skipped ? 'skipped' : describeEntry({ sets: e.sets }, pex) || 'not logged';
    return h('div', { class: 'item', style: 'align-items:flex-start' },
      h('span', { class: 'grow' }, e.label ? `${e.label} ${e.name}` : e.name),
      h('span', { class: 'value xsmall', style: 'max-width:55%' }, text));
  }));
}
