// Log tab (spec §4.2). Stage 1 shows today's prescription read-only; set
// logging, the rest timer and on-device progression arrive in stage 3.
import { h } from '../ui.js';
import { header, exerciseList, note } from './common.js';
import { isoWeekday, formatDayMonth, WEEKDAYS } from '../../coach/time.js';
import { dayForWeekday } from '../../coach/program.js';

export function render(screen, ctx) {
  const today = ctx.today();
  const day = ctx.program ? dayForWeekday(ctx.program, isoWeekday(today)) : null;
  const label = `Today · ${WEEKDAYS[isoWeekday(today) - 1]} ${formatDayMonth(today)}`;
  if (!day) {
    screen.append(header({ label, title: 'Today' }), note('Program not loaded yet: connect once to fetch it.'));
    return;
  }
  if (!day.exercises.length) {
    screen.append(
      header({ label, title: 'Open day' }),
      h('div', { class: 'card stack-sm' },
        h('p', { class: 'body', style: 'margin:0' }, 'Cardio or social.'),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Stairs by default, or runs, rides, swims and social sessions, all read from Strava. The one-tap “Stairs ✓” fallback arrives in stage 3.')));
    return;
  }
  screen.append(
    header({ label, title: day.name }),
    h('div', { class: 'stack' },
      exerciseList(day),
      note('Set logging, the rest timer and progression arrive in stage 3. Strava has no recorded loads, so the first session of each exercise is a calibration session.')));
}
