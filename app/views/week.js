// Week tab (spec §4.1): Mon–Sun strip in local time, today highlighted.
import { h, icon, openSheet } from '../ui.js';
import { getAll } from '../db.js';
import { live } from '../records.js';
import { focusCheckin } from './body.js';
import { checkinState } from '../../coach/phase.js';
import { header, note, sessionList } from './common.js';
import { loadTraining, planFor, progressCount } from '../training.js';
import { planItem } from './log.js';
import { weekDates, isoWeekday, WEEKDAYS, formatDayMonth, formatLong, tzCity } from '../../coach/time.js';
import { dayForWeekday } from '../../coach/program.js';

const OPEN_DAY = 'Stairs by default, or runs, rides, swims and social sessions, read from Strava.';

export async function render(screen, ctx) {
  const today = ctx.today();
  const [checkins, training] = await Promise.all([getAll(ctx.db, 'checkins'), loadTraining(ctx)]);
  const ci = checkinState(today, ctx.settings.checkin_day, live(checkins));
  const dates = weekDates(today);
  const dayOf = (date) => (ctx.program ? dayForWeekday(ctx.program, isoWeekday(date)) : null);
  const todayDay = dayOf(today);
  const sessionsOn = (date) => training.sessions.filter((x) => x.local_date === date);
  const stairsOn = (date) => training.stairs.filter((x) => x.local_date === date).pop() || null;

  const openDay = (date) => {
    const day = dayOf(date);
    const logged = sessionsOn(date);
    const stairs = stairsOn(date);
    if (date === today && day && day.exercises.length) { ctx.navigate('#/log'); return; }
    const title = `${WEEKDAYS[isoWeekday(date) - 1]} ${formatDayMonth(date)}`;
    if (logged.length) {
      const sx = logged[logged.length - 1];
      openSheet({ title: `${title} · ${sx.day_name}`, subtitle: sx.status === 'finished' ? 'Logged' : 'In progress', body: sessionList(sx, ctx.program), actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    if (!day || !day.exercises.length) {
      openSheet({ title: `${title} · Open day`, subtitle: stairs ? `Stairs ${stairs.minutes} min logged.` : OPEN_DAY, actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    if (date < today) {
      openSheet({ title: `${title} · ${day.name}`, subtitle: 'No session logged.', actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    const plan = planFor(ctx, training, day);
    openSheet({
      title: `${title} · ${day.name}`,
      subtitle: `Preview: targets from your last sessions${day.est_min ? ` · ~${day.est_min} min` : ''}.`,
      body: h('div', { class: 'list' }, plan.map(planItem)),
      actions: [{ label: 'Close', kind: 'outline' }],
    });
  };

  const strip = h('div', { class: 'weekstrip', role: 'group', 'aria-label': 'This week' },
    dates.map((d) => {
      const day = dayOf(d);
      const done = sessionsOn(d).length > 0 || stairsOn(d);
      const cls = [d === today ? 'today' : '', d < today ? 'past' : ''].filter(Boolean).join(' ');
      return h('button', {
        type: 'button', class: cls, 'aria-current': d === today ? 'date' : null,
        'aria-label': `${formatLong(d)}${day ? `, ${day.name}` : ''}${done ? ', logged' : ''}`, onClick: () => openDay(d),
      },
      h('span', { class: 'dow' }, WEEKDAYS[isoWeekday(d) - 1]),
      h('span', { class: 'dom' }, String(Number(d.slice(8)))),
      h('span', { class: `dot${done ? ' logged' : day && day.exercises.length ? '' : ' off'}` }));
    }));

  const rows = h('div', { class: 'card flush list' }, dates.map((d) => {
    const day = dayOf(d);
    const logged = sessionsOn(d);
    const stairs = stairsOn(d);
    let meta;
    if (logged.length) {
      const sx = logged[logged.length - 1];
      const p = progressCount(sx);
      meta = sx.status === 'finished' ? `Done · ${p.done} sets${sx.day_dow !== isoWeekday(d) ? ` · did ${sx.day_name}` : ''}` : `In progress · ${p.done} of ${p.total} sets`;
    } else if (day && day.exercises.length) {
      meta = `${day.exercises.length} exercises${day.est_min ? ` · ~${day.est_min} min` : ''}`;
    } else {
      meta = stairs ? `Stairs ${stairs.minutes} min` : 'Stairs, runs, rides, social';
    }
    return h('button', { type: 'button', class: `item day-row${d === today ? ' today' : ''}${logged.length ? ' logged' : ''}`, onClick: () => openDay(d) },
      h('span', { class: 'when' }, WEEKDAYS[isoWeekday(d) - 1]),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, day ? day.name : '—'), h('div', { class: 'meta' }, meta)),
      logged.length && logged[logged.length - 1].status === 'finished' ? h('span', { class: 'accent' }, icon('check', { size: 18 })) : null);
  }));

  const s = ctx.settings;
  const banners = [];
  if (training.deload.isDeload) {
    banners.push(h('div', { class: 'banner' }, h('span', { class: 'grow' }, h('div', { class: 'strong' }, 'Deload week'), h('div', { class: 'muted xsmall' }, `Half the sets, same loads, RIR 3+. ${training.deload.reason || ''}`.trim()))));
  } else if (training.deload.announceNext) {
    banners.push(h('div', { class: 'banner' }, h('span', { class: 'grow' }, h('div', { class: 'strong' }, 'Deload next week'), h('div', { class: 'muted xsmall' }, `From ${formatDayMonth(training.deload.nextDeloadWeekStart)}: half the sets, same loads, easy reps.`))));
  }
  if (ci.open && !ci.done) {
    banners.push(h('div', { class: 'banner' },
      h('span', { class: 'accent' }, icon('body', { size: 20 })),
      h('span', { class: 'grow' }, h('div', { class: 'strong' }, 'Check-in day'), h('div', { class: 'muted xsmall' }, 'Tape measurements + weekly check-in')),
      h('button', { type: 'button', class: 'btn small primary', onClick: () => { focusCheckin(); ctx.navigate('#/body'); } }, 'Open')));
  }
  screen.append(
    header({ label: formatLong(today).replace(/ \d{4}$/, ''), title: todayDay ? todayDay.name : 'This week' }),
    ...(banners.length ? [h('div', { class: 'stack-sm', style: 'margin-bottom:16px' }, banners)] : []),
    h('div', { class: 'stack' },
      strip,
      rows,
      ctx.program ? null : note('Program not loaded yet: connect once to fetch it.'),
      h('p', { class: 'faint xsmall center' }, `${tzCity(s.tz_current)} time · ${s.tz_mode === 'auto' ? 'follows iPhone' : 'set manually'}`)));
}
