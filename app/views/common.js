import { h, icon } from '../ui.js';
import { daysBetween, formatDayMonth, formatMonthYear } from '../../coach/time.js';

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

export function rirText(rir) {
  if (!rir) return null;
  return rir[0] === rir[1] ? `RIR ${rir[0]}` : `RIR ${rir[0]}–${rir[1]}`;
}

export function restText(ex) {
  if (ex.type === 'timed' && ex.rest_s === 0) return 'then partner';
  if (ex.rest_s === 0) return 'straight to partner';
  return `rest ${ex.rest_s} s`;
}

// Read-only preview of a day's exercises (the logging view replaces this in stage 3).
export function exerciseList(day) {
  const card = h('div', { class: 'card flush' });
  for (const ex of day.exercises) {
    const meta = [ex.prescription, rirText(ex.rir), restText(ex)].filter(Boolean).join(' · ');
    const partner = ex.label && !ex.label.endsWith('1');
    card.append(h('div', { class: `ex${partner ? ' paired' : ''}` },
      h('div', { class: 'ex-name' }, ex.label ? h('span', { class: 'ex-tag' }, ex.label) : null, ex.name),
      h('div', { class: 'ex-rx' }, meta),
      ex.same_load_as ? h('div', { class: 'ex-cue' }, 'Same weight as the first exercise; reps only') : null,
      ex.cue ? h('div', { class: 'ex-cue' }, ex.cue) : null));
  }
  return card;
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
