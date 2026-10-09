// Week tab (spec §4.1): Mon–Sun strip in local time, today highlighted.
import { h, icon, openSheet } from '../ui.js';
import { getAll, getMeta } from '../db.js';
import { live } from '../records.js';
import { focusCheckin } from './body.js';
import { checkinState, currentPhase, realPhases } from '../../coach/phase.js';
import { weeklySummary, activeSummaryCheckin } from '../../coach/summary.js';
import { header, note, sessionList } from './common.js';
import { loadTraining, planFor, progressCount } from '../training.js';
import { planItem } from './log.js';
import { ensurePlans, planNotice } from '../meal-plans.js';
import { weekDates, isoWeekday, WEEKDAYS, formatDayMonth, formatLong, tzCity } from '../../coach/time.js';
import { dayForWeekday } from '../../coach/program.js';

const OPEN_DAY = 'Stairs by default, or runs, rides, swims and social sessions, read from Strava.';
// Same values as the seeded model (brief §5); used only if the model record is missing.
const DEFAULT_BANDS = { cut: { target: [-0.75, -0.5], slow_limit: -0.4, cap: -1.0 }, bulk: { target: [0.1, 0.2], cap: 0.35 }, maintenance: { target: [-0.1, 0.1] } };
const ui = { summaryOpen: {} };

export async function render(screen, ctx) {
  const today = ctx.today();
  const [checkins, training, plans] = await Promise.all([getAll(ctx.db, 'checkins'), loadTraining(ctx), ensurePlans(ctx).catch(() => null)]);
  const notice = plans ? planNotice(plans) : null;
  const ci = checkinState(today, ctx.settings.checkin_day, live(checkins));
  const summary = await buildSummary(ctx, { today, checkins: live(checkins), training, plans });
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
  if (notice) {
    banners.push(h('div', { class: 'banner' },
      h('span', { class: 'accent' }, icon('meals', { size: 20 })),
      h('span', { class: 'grow' }, h('div', { class: 'strong' }, `New plan ${WEEKDAYS[isoWeekday(notice.week_start) - 1]}`), h('div', { class: 'muted xsmall' }, notice.delta ? `${notice.delta > 0 ? '+' : ''}${notice.delta} kcal a day: see the changes` : 'See the changes')),
      h('button', { type: 'button', class: 'btn small primary', onClick: () => ctx.navigate('#/meals') }, 'View')));
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
    ...(summary ? [summaryCard(summary)] : []),
    h('div', { class: 'stack' },
      strip,
      rows,
      ctx.program ? null : note('Program not loaded yet: connect once to fetch it.'),
      h('p', { class: 'faint xsmall center' }, `${tzCity(s.tz_current)} time · ${s.tz_mode === 'auto' ? 'follows iPhone' : 'set manually'}`)));
}

// ---- weekly executive summary ----------------------------------------------------------------

async function buildSummary(ctx, { today, checkins, training, plans }) {
  const s = ctx.settings;
  const checkin = activeSummaryCheckin(checkins, today, s.prep_day);
  if (!checkin) return null;
  const [wAll, mAll, phasesAll, model] = await Promise.all([getAll(ctx.db, 'weighins'), getAll(ctx.db, 'measurements'), getAll(ctx.db, 'phases'), getMeta(ctx.db, 'model')]);
  const previousCheckin = checkins.filter((c) => c.local_date < checkin.local_date).sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0] || null;
  return weeklySummary({
    checkin, previousCheckin,
    weighins: live(wAll), measurements: live(mAll), sessions: training.sessions, program: ctx.program,
    mode: s.mode, phase: currentPhase(realPhases(phasesAll)),
    bands: (model && model.rate_bands_pct_bw_per_wk) || DEFAULT_BANDS,
    plans, today, prepDow: s.prep_day, units: s.units,
  });
}

function summaryCard(sum) {
  // open on check-in day and the day after; later it folds to the headline (tap to read)
  const open = ui.summaryOpen[sum.week_of] ?? sum.days_since <= 1;
  const range = sum.period.from.slice(5, 7) === sum.period.to.slice(5, 7)
    ? `${Number(sum.period.from.slice(8))}–${formatDayMonth(sum.period.to)}`
    : `${formatDayMonth(sum.period.from)} – ${formatDayMonth(sum.period.to)}`;
  const details = h('div', { class: 'summary-points', hidden: !open },
    sum.points.map((p) => h('div', { class: 'summary-point' },
      h('span', { class: `dot ${p.tone}`, 'aria-hidden': 'true' }),
      h('div', { class: 'grow' }, h('div', { class: 'pt-title' }, p.title), h('p', {}, p.text)))));
  const toggle = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': String(open) }, open ? 'Hide details' : 'Read the full review');
  toggle.addEventListener('click', () => {
    const now = details.hidden;
    details.hidden = !now;
    ui.summaryOpen[sum.week_of] = now;
    toggle.textContent = now ? 'Hide details' : 'Read the full review';
    toggle.setAttribute('aria-expanded', String(now));
  });
  return h('section', { class: `card summary ${sum.tone}`, 'aria-label': 'Week in review', style: 'margin-bottom:16px' },
    h('p', { class: 'label' }, `Week in review · ${range}`),
    h('p', { class: 'headline' }, sum.headline),
    h('div', { class: 'focus' }, h('span', { class: 'label' }, 'Focus'), h('span', {}, sum.focus)),
    details,
    toggle);
}
