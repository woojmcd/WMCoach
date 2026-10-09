// Cardio on the Log and Week tabs (spec §6.5): what the coach prescribes today, at what
// heart rate and why, what's done this week (Strava + Stairs ✓ taps), and logging a tap.
import { h, toast, stepper, openSheet } from '../ui.js';
import { saveDaily } from '../records.js';
import { cardioText, itemText, MIN_SESSION_MIN } from '../../coach/cardio.js';
import { weekDates, isoWeekday, WEEKDAYS } from '../../coach/time.js';

export function todayTitle(t) {
  return t.kind === 'walk' ? `${t.minutes} min easy walk` : `${t.minutes} min stairs · Zone ${t.zone}`;
}

function hrLine(t, hr) {
  if (t && t.kind === 'walk') return 'Easy pace (Zone 1): a relaxed walk, nose breathing.';
  if (!hr) return 'Easy pace (Zone 2): you can still talk in full sentences.';
  const src = hr.source === 'strava' ? 'your Strava zone 2' : `estimated from your Strava max ${hr.max_hr} bpm`;
  return `Heart rate ${hr.lo}–${hr.hi} bpm (${src}). You can still talk in full sentences.`;
}

// "This week: 1 of 2 · 27 of 50 min" and a Mon–Sun strip: planned days outlined, done days filled.
export function weekTracker(cardio, today) {
  const w = cardio.week;
  const doneDays = new Set(w.items.map((i) => i.local_date));
  const strip = h('div', { class: 'cardio-week', 'aria-hidden': 'true' }, weekDates(today).map((d) => {
    const cls = [w.days.includes(isoWeekday(d)) ? 'planned' : '', doneDays.has(d) ? 'done' : '', d === today ? 'today' : ''].filter(Boolean).join(' ');
    return h('span', { class: cls }, WEEKDAYS[isoWeekday(d) - 1].slice(0, 1));
  }));
  const met = w.done_sessions >= w.target_sessions;
  return h('div', { class: 'stack-sm' },
    h('div', { class: 'row' },
      h('span', { class: 'grow small' }, `This week: ${w.done_sessions} of ${w.target_sessions} sessions`),
      h('span', { class: `small${met ? ' accent' : ' muted'}` }, `${w.done_min} of ${w.target_min} min`)),
    strip);
}

export function whySheet(cardio) {
  const rx = cardio.rx;
  const lines = [
    h('p', { style: 'margin:0' }, rx.reason),
    h('p', { class: 'muted small', style: 'margin:0' }, 'Easy Zone 2 cardio adds to what you burn without eating into lifting recovery. Its calories are part of the expenditure your macros are set from, and the weekly check-in adjusts from your weight trend.'),
  ];
  if (rx.mode === 'cut') lines.push(h('p', { class: 'muted small', style: 'margin:0' }, 'In a cut, a stall adds one session a week (up to 6 × 30) before food comes down; losing too fast removes one. One change a week.'));
  if (rx.change) lines.push(h('p', { class: 'small', style: 'margin:0' }, `Changed this week: ${rx.change.from} → ${rx.change.to}.`));
  lines.push(h('p', { class: 'muted xsmall', style: 'margin:0' }, `Sessions under ${MIN_SESSION_MIN} min don’t count. Runs, rides and swims from Strava count too.`));
  openSheet({ title: 'Your cardio this week', subtitle: cardioText(rx), body: h('div', { class: 'stack-sm' }, lines), actions: [{ label: 'Close', kind: 'outline' }] });
}

function logger(ctx, { today, minutes, tap, walk }) {
  const field = stepper({ value: tap ? tap.minutes : minutes, step: 5, min: 5, max: 180, unit: 'min', compact: true, label: walk ? 'Walk minutes' : 'Stairs minutes' });
  return h('div', { class: 'stack-sm' },
    field,
    h('button', {
      type: 'button', class: `btn ${tap ? 'outline' : 'primary'} block`,
      onClick: async () => {
        const v = field.getValue();
        if (!(v > 0)) return;
        await saveDaily(ctx.db, 'stairs', { localDate: today, tz: ctx.tz(), prefix: 'stairs', fields: { minutes: v } });
        toast(`${walk ? 'Walk' : 'Stairs'} ${v} min logged`);
        ctx.refresh();
      },
    }, tap ? `Update (${tap.minutes} min logged)` : walk ? 'Walk ✓' : 'Stairs ✓'));
}

// The cardio card. On a lift day it sits under the exercises; on an open day it's the main card.
export function cardioCard(ctx, training, { openDay = false } = {}) {
  const cardio = training.cardio;
  if (!cardio) return null;
  const today = training.today;
  const t = cardio.today;
  const tap = training.stairs.filter((s) => s.local_date === today).pop() || null;
  const todays = t ? t.done : cardio.extra || [];
  const fromStrava = todays.some((i) => i.source === 'strava');
  const why = h('button', { type: 'button', class: 'link-btn', style: 'align-self:flex-start', onClick: () => whySheet(cardio) }, 'Why this cardio');

  if (!t) {
    // no session planned today: a short line on a lift day; logging + the week on an open day
    return h('section', { class: 'card stack-sm cardio-card', 'aria-label': 'Cardio' },
      h('div', { class: 'row' }, h('p', { class: 'label grow', style: 'margin:0' }, 'Cardio'), todays.length ? h('span', { class: 'badge up' }, 'Done') : null),
      h('div', { class: 'cardio-title' }, todays.length ? todays.map(itemText).join(' + ') : 'None planned today'),
      h('p', { class: 'muted xsmall', style: 'margin:0' }, `This week: ${cardioText(cardio.rx)}.`),
      openDay && !fromStrava ? logger(ctx, { today, minutes: 30, tap, walk: false }) : null,
      weekTracker(cardio, today),
      why);
  }

  const badge = t.status === 'done' ? h('span', { class: 'badge up' }, 'Done')
    : t.makeup ? h('span', { class: 'badge' }, 'Make-up')
      : t.optional ? h('span', { class: 'badge' }, 'Optional') : null;
  return h('section', { class: `card stack-sm cardio-card${t.status === 'done' ? ' done' : ''}`, 'aria-label': 'Cardio' },
    h('div', { class: 'row' }, h('p', { class: 'label grow', style: 'margin:0' }, openDay ? 'Cardio today' : 'Cardio after lifting'), badge),
    h('div', { class: 'cardio-title' }, todayTitle(t)),
    h('p', { class: 'muted small', style: 'margin:0' }, hrLine(t, t.hr)),
    t.kcal ? h('p', { class: 'muted xsmall', style: 'margin:0' }, `≈${t.kcal} kcal · already counted in your plan’s calories`) : null,
    t.note ? h('p', { class: 'small cardio-note', style: 'margin:0' }, t.note) : null,
    todays.length ? h('p', { class: 'small accent', style: 'margin:0' }, `Logged: ${todays.map(itemText).join(' + ')}`) : null,
    fromStrava ? null : logger(ctx, { today, minutes: t.minutes, tap, walk: t.kind === 'walk' }),
    weekTracker(cardio, today),
    why);
}

// Week tab: what the day's row says about cardio.
export function cardioMeta(cardio, date, today) {
  if (!cardio) return null;
  const items = cardio.week.items.filter((i) => i.local_date === date);
  if (items.length) return `${items.map(itemText).join(' + ')} ✓`;
  if (date < today) return cardio.rx.days.includes(isoWeekday(date)) ? 'cardio missed' : null;
  if (date === today && cardio.today) return `+ ${todayTitle(cardio.today).replace(' · ', ', ')}`;
  return cardio.rx.days.includes(isoWeekday(date)) ? `+ ${cardio.rx.minutes} min stairs` : null;
}
