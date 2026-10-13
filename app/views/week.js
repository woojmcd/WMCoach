// Week tab (spec §4.1): Mon–Sun strip in local time, today highlighted.
import { h, icon, openSheet } from '../ui.js';
import { getAll, getMeta } from '../db.js';
import { live } from '../records.js';
import { focusCheckin } from './body.js';
import { checkinState, currentPhase, realPhases } from '../../coach/phase.js';
import { weeklySummary, activeSummaryCheckin } from '../../coach/summary.js';
import { header, note, sessionList, addonCard } from './common.js';
import { cardioMeta } from './cardio.js';
import { loadTraining, planFor, progressCount } from '../training.js';
import { planItem } from './log.js';
import { ensurePlans, planNotice } from '../meal-plans.js';
import { weekDates, isoWeekday, WEEKDAYS, formatDayMonth, formatLong, tzCity } from '../../coach/time.js';
import { dayForWeekday } from '../../coach/program.js';

const OPEN_DAY = 'Rest, or runs, rides, swims and social sessions, read from Strava.';
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

  const cardioLine = (date) => {
    const c = cardioMeta(training.cardio, date, today);
    return c ? h('p', { class: 'small', style: 'margin:0 0 8px' }, c.text.replace(' · ', ': ')) : null;
  };
  const openDay = (date) => {
    const day = dayOf(date);
    const logged = sessionsOn(date);
    const stairs = stairsOn(date);
    if (date === today && day && day.exercises.length) { ctx.navigate('#/log'); return; }
    const title = `${WEEKDAYS[isoWeekday(date) - 1]} ${formatDayMonth(date)}`;
    if (logged.length) {
      const sx = logged[logged.length - 1];
      openSheet({ title: `${title} · ${sx.day_name}`, subtitle: sx.status === 'finished' ? 'Logged' : 'In progress', body: h('div', {}, cardioLine(date), sessionList(sx, ctx.program)), actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    if (!day || !day.exercises.length) {
      openSheet({ title: `${title} · Open day`, subtitle: stairs && !cardioLine(date) ? `Stairs ${stairs.minutes} min logged.` : OPEN_DAY, body: cardioLine(date), actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    if (date < today) {
      openSheet({ title: `${title} · ${day.name}`, subtitle: 'No session logged.', body: cardioLine(date), actions: [{ label: 'Close', kind: 'outline' }] });
      return;
    }
    const plan = planFor(ctx, training, day);
    openSheet({
      title: `${title} · ${day.name}`,
      subtitle: `Preview: targets from your last sessions${day.est_min ? ` · ~${day.est_min} min` : ''}.`,
      body: h('div', {}, cardioLine(date), h('div', { class: 'list' }, plan.map(planItem))),
      actions: [{ label: 'Close', kind: 'outline' }],
    });
  };

  const strip = h('div', { class: 'weekstrip', role: 'group', 'aria-label': 'This week' },
    dates.map((d) => {
      const day = dayOf(d);
      const done = sessionsOn(d).length > 0 || stairsOn(d) || (training.cardio && training.cardio.week.items.some((i) => i.local_date === d));
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
    let meta;
    if (logged.length) {
      const sx = logged[logged.length - 1];
      const p = progressCount(sx);
      meta = sx.status === 'finished' ? `Done · ${p.done} sets${sx.day_dow !== isoWeekday(d) ? ` · did ${sx.day_name}` : ''}` : `In progress · ${p.done} of ${p.total} sets`;
    } else if (day && day.exercises.length) {
      meta = `${day.exercises.length} exercises${day.est_min ? ` · ~${day.est_min} min` : ''}`;
    } else {
      meta = 'Rest, runs, rides, social';
    }
    // cardio on its own line under the workout (Walter, 2026-10-13)
    const cm = cardioMeta(training.cardio, d, today);
    return h('button', { type: 'button', class: `item day-row${d === today ? ' today' : ''}${logged.length ? ' logged' : ''}`, onClick: () => openDay(d) },
      h('span', { class: 'when' }, WEEKDAYS[isoWeekday(d) - 1]),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, day ? day.name : '—'), h('div', { class: 'meta' }, meta), cm ? h('div', { class: `meta cardio ${cm.state}` }, cm.text) : null),
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
  for (const a of training.addons || []) banners.push(addonCard(a));
  if (ci.open && !ci.done) {
    banners.push(h('div', { class: 'banner' },
      h('span', { class: 'accent' }, icon('body', { size: 20 })),
      h('span', { class: 'grow' }, h('div', { class: 'strong' }, 'Check-in day'), h('div', { class: 'muted xsmall' }, 'Tape measurements + weekly check-in')),
      h('button', { type: 'button', class: 'btn small primary', onClick: () => { focusCheckin(); ctx.navigate('#/body'); } }, 'Open')));
  }
  screen.append(
    header({ label: formatLong(today).replace(/ \d{4}$/, ''), title: todayDay ? todayDay.name : 'This week' }),
    ...(banners.length ? [h('div', { class: 'stack-sm', style: 'margin-bottom:16px' }, banners)] : []),
    ...(training.daily ? [dailyCard(training.daily)] : []),
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

// Yesterday in review + today's focus (the morning run's targets.daily). Always fully
// open (Walter, 2026-10-13): the headline, focus, today's plan and every area.
const pointList = (points) => h('div', { class: 'summary-points' },
  points.map((p) => h('div', { class: 'summary-point' },
    h('span', { class: `dot ${p.tone}`, 'aria-hidden': 'true' }),
    h('div', { class: 'grow' }, h('div', { class: 'pt-title' }, p.title), h('p', {}, p.text)))));

function dailyCard(d) {
  return h('section', { class: `card summary daily ${d.tone}`, 'aria-label': 'Yesterday in review', style: 'margin-bottom:16px' },
    h('p', { class: 'label' }, `Yesterday · ${d.label}`),
    h('p', { class: 'headline' }, d.headline),
    h('div', { class: 'focus' }, h('span', { class: 'label' }, 'Focus today'), h('span', {}, d.focus)),
    d.today ? h('div', { class: 'focus today' }, h('span', { class: 'label' }, 'Today'), h('span', {}, d.today)) : null,
    pointList(d.points));
}


// Week in review: a box that opens and closes with a tap anywhere on its header
// (Walter, 2026-10-13). Starts closed; this phone remembers how each week's was left.
const reviewKey = (week) => `wm.review.${week}`;
function reviewOpen(week) {
  if (week in ui.summaryOpen) return ui.summaryOpen[week];
  try { return localStorage.getItem(reviewKey(week)) === 'open'; } catch { return false; }
}
function summaryCard(sum) {
  let open = reviewOpen(sum.week_of);
  const range = sum.period.from.slice(5, 7) === sum.period.to.slice(5, 7)
    ? `${Number(sum.period.from.slice(8))}–${formatDayMonth(sum.period.to)}`
    : `${formatDayMonth(sum.period.from)} – ${formatDayMonth(sum.period.to)}`;
  const id = `review-${sum.week_of}`;
  const body = h('div', { class: 'summary-body', id, hidden: !open },
    h('div', { class: 'focus' }, h('span', { class: 'label' }, 'Focus'), h('span', {}, sum.focus)),
    pointList(sum.points));
  const head = h('button', { type: 'button', class: 'summary-head', 'aria-expanded': String(open), 'aria-controls': id },
    h('span', { class: 'grow' },
      h('span', { class: 'label' }, `Week in review · ${range}`),
      h('span', { class: 'headline' }, sum.headline)),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chevron', { size: 18 })));
  head.addEventListener('click', () => {
    open = !open;
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    ui.summaryOpen[sum.week_of] = open;
    try { localStorage.setItem(reviewKey(sum.week_of), open ? 'open' : 'closed'); } catch { /* private mode: this session only */ }
  });
  return h('section', { class: `card summary ${sum.tone}`, 'aria-label': 'Week in review', style: 'margin-bottom:16px' }, head, body);
}
