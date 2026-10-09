// Week tab (spec §4.1): Mon–Sun strip in local time, today highlighted.
import { h, icon, openSheet } from '../ui.js';
import { getAll } from '../db.js';
import { live } from '../records.js';
import { focusCheckin } from './body.js';
import { checkinState } from '../../coach/phase.js';
import { header, exerciseList, note } from './common.js';
import { weekDates, isoWeekday, WEEKDAYS, formatDayMonth, formatLong, tzCity } from '../../coach/time.js';
import { dayForWeekday } from '../../coach/program.js';

const OPEN_DAY = 'Stairs by default, or runs, rides, swims and social sessions, read from Strava.';

export async function render(screen, ctx) {
  const today = ctx.today();
  const ci = checkinState(today, ctx.settings.checkin_day, live(await getAll(ctx.db, 'checkins')));
  const dates = weekDates(today);
  const dayOf = (date) => (ctx.program ? dayForWeekday(ctx.program, isoWeekday(date)) : null);
  const todayDay = dayOf(today);

  const openDay = (date) => {
    const day = dayOf(date);
    const when = date === today ? 'Today' : date < today ? 'Past' : 'Preview';
    openSheet({
      title: `${WEEKDAYS[isoWeekday(date) - 1]} ${formatDayMonth(date)} · ${day ? day.name : ''}`,
      subtitle: day && day.exercises.length
        ? `${when}: ${day.exercises.length} exercises${day.est_min ? ` · ~${day.est_min} min` : ''}. Logging arrives in stage 3.`
        : OPEN_DAY,
      body: day && day.exercises.length ? exerciseList(day) : null,
      actions: [{ label: 'Close', kind: 'outline' }],
    });
  };

  const strip = h('div', { class: 'weekstrip', role: 'group', 'aria-label': 'This week' },
    dates.map((d) => {
      const day = dayOf(d);
      const cls = [d === today ? 'today' : '', d < today ? 'past' : ''].filter(Boolean).join(' ');
      return h('button', {
        type: 'button', class: cls, 'aria-current': d === today ? 'date' : null,
        'aria-label': `${formatLong(d)}${day ? `, ${day.name}` : ''}`, onClick: () => openDay(d),
      },
      h('span', { class: 'dow' }, WEEKDAYS[isoWeekday(d) - 1]),
      h('span', { class: 'dom' }, String(Number(d.slice(8)))),
      h('span', { class: `dot${day && day.exercises.length ? '' : ' off'}` }));
    }));

  const rows = h('div', { class: 'card flush list' }, dates.map((d) => {
    const day = dayOf(d);
    const meta = day && day.exercises.length
      ? `${day.exercises.length} exercises${day.est_min ? ` · ~${day.est_min} min` : ''}`
      : 'Stairs, runs, rides, social';
    return h('button', { type: 'button', class: `item day-row${d === today ? ' today' : ''}`, onClick: () => openDay(d) },
      h('span', { class: 'when' }, WEEKDAYS[isoWeekday(d) - 1]),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, day ? day.name : '—'), h('div', { class: 'meta' }, meta)));
  }));

  const s = ctx.settings;
  const banner = ci.open && !ci.done
    ? h('div', { class: 'banner', style: 'margin-bottom:16px' },
      h('span', { class: 'accent' }, icon('body', { size: 20 })),
      h('span', { class: 'grow' }, h('div', { class: 'strong' }, 'Check-in day'), h('div', { class: 'muted xsmall' }, 'Tape measurements + weekly check-in')),
      h('button', { type: 'button', class: 'btn small primary', onClick: () => { focusCheckin(); ctx.navigate('#/body'); } }, 'Open'))
    : null;
  screen.append(
    header({ label: formatLong(today).replace(/ \d{4}$/, ''), title: todayDay ? todayDay.name : 'This week' }),
    ...(banner ? [banner] : []),
    h('div', { class: 'stack' },
      strip,
      rows,
      ctx.program ? null : note('Program not loaded yet: connect once to fetch it.'),
      h('p', { class: 'faint xsmall center' }, `${tzCity(s.tz_current)} time · ${s.tz_mode === 'auto' ? 'follows iPhone' : 'set manually'}`)));
}
