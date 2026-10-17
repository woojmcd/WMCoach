// The weigh-in and "On plan?" inputs, shared by the Body tab (today) and the Week tab's day
// sheets (any day up to today), so a forgotten day can be filled in or fixed later with the
// same controls (Walter, 2026-10-17).
import { h, toast, segmented, stepper } from '../ui.js';
import { saveDaily, live } from '../records.js';
import { addDays, formatDayMonth, isoWeekday, WEEKDAYS } from '../../coach/time.js';

export const dayText = (date, today) => {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${formatDayMonth(date)}`;
};

const newestFirst = (a, b) => ((a.updated_utc || '') < (b.updated_utc || '') ? 1 : -1);

// The entry a day's input shows and edits. Today: only one made in the current zone, so a
// date repeated after crossing the date line gets its own entry (spec §2b). An earlier day:
// the newest entry for that date, edited in its own zone.
function entryFor(records, date, tz, today) {
  const mine = records.filter((r) => r.local_date === date).sort(newestFirst);
  return mine.find((r) => r.tz === tz) || (date === today ? null : mine[0] || null);
}

export function weighinFor(weighins, date, tz, today) {
  return entryFor(live(weighins).filter((w) => w.source !== 'history'), date, tz, today);
}

export function tapFor(taps, date, tz, today) {
  const t = entryFor(live(taps), date, tz, today);
  if (t || date !== today) return t;
  return live(taps).filter((x) => x.local_date === date).sort(newestFirst)[0] || null; // shown, not edited
}

// Weight stepper + Log/Update button + a hint line. onSaved runs after the record is written.
export function weightEntry(ctx, { date, weighins, today, hint = null, onSaved = null }) {
  const tz = ctx.tz();
  const existing = weighinFor(weighins, date, tz, today);
  const latest = [...live(weighins)].filter((w) => w.local_date <= date).sort((a, b) => (a.local_date < b.local_date ? -1 : 1)).pop();
  const field = stepper({
    value: existing ? Number(ctx.fmtWeight(existing.weight_lb)) : null,
    step: ctx.settings.units === 'kg' ? 0.1 : 0.2, min: 40, max: 400, decimals: 1, unit: ctx.unitLabel(),
    placeholder: latest ? ctx.fmtWeight(latest.weight_lb) : '', label: 'Weight',
  });
  const info = h('p', { class: 'muted xsmall', style: 'margin:0' });
  const btn = h('button', { type: 'button', class: 'btn primary block' });
  const show = (rec) => {
    btn.textContent = rec ? 'Update' : 'Log weight';
    info.textContent = rec
      ? `Logged ${ctx.fmtWeight(rec.weight_lb)} ${ctx.unitLabel()}${date === today ? ' this morning' : ''}. Change it and tap Update.`
      : hint || 'Morning, fasted, after the bathroom.';
  };
  show(existing);
  let rec = existing;
  btn.addEventListener('click', async () => {
    const v = field.getValue();
    if (!(v > 0)) { toast('Enter a weight first'); return; }
    const lb = Math.round(ctx.toLb(v) * 10) / 10;
    const { record, edited } = await saveDaily(ctx.db, 'weighins', {
      localDate: date, tz: rec ? rec.tz : tz, prefix: 'w', editable: (r) => r.source === 'app',
      fields: { weight_lb: lb, source: 'app', backdated: date !== today },
    });
    rec = record;
    show(rec);
    toast(`${edited ? 'Updated' : 'Logged'} ${ctx.fmtWeight(lb)} ${ctx.unitLabel()} · ${dayText(date, today)}`);
    if (onSaved) onSaved(record);
  });
  return h('div', { class: 'stack' }, field, btn, info);
}

// Yes / Partial / Off, plus an optional kcal estimate when not fully on plan. Saves on tap.
export function onPlanEntry(ctx, { date, taps, today, onSaved = null }) {
  const current = tapFor(taps, date, ctx.tz(), today);
  // today: the current zone's entry (spec §2b); an earlier day: edit the entry it already has
  let tz = date !== today && current ? current.tz : ctx.tz();
  let kcal = current && current.kcal ? current.kcal : null;
  let picked = current ? current.status : null;
  const when = date === today ? 'today' : `on ${dayText(date, today)}`;
  const save = async (status) => {
    const { record } = await saveDaily(ctx.db, 'adherence', { localDate: date, tz, prefix: 'plan', fields: { status, kcal: status === 'yes' ? null : kcal } });
    tz = record.tz;
    if (onSaved) onSaved(record);
  };
  const kcalField = stepper({
    value: kcal, step: 50, min: 0, max: 8000, unit: 'kcal', compact: true, label: `Estimated kcal ${when}`, placeholder: '2400',
    onChange: async (v) => { kcal = v; if (picked) await save(picked); },
  });
  const kcalWrap = h('div', { class: 'stack-sm', style: picked && picked !== 'yes' ? '' : 'display:none' },
    h('span', { class: 'label' }, 'Estimated kcal (optional)'), kcalField);
  const seg = segmented([{ value: 'yes', label: 'Yes' }, { value: 'partial', label: 'Partial' }, { value: 'off', label: 'Off' }], picked, async (v) => {
    picked = v;
    await save(v);
    kcalWrap.style.display = v === 'yes' ? 'none' : '';
    toast(v === 'yes' ? `On plan ${when}` : v === 'partial' ? `Partly on plan ${when}` : `Off plan ${when}: not used for the TDEE estimate`);
  }, { label: `On plan ${when}` });
  return h('div', { class: 'stack' }, seg, kcalWrap);
}

// Week tab: the day's weight and food in one line ("182.4 lb · On plan", "No weigh-in · Food not logged").
export function dayLogMeta(ctx, { date, weighins, taps, today }) {
  if (date > today) return null;
  const w = weighinFor(weighins, date, ctx.tz(), today) || live(weighins).find((x) => x.local_date === date);
  const t = tapFor(taps, date, ctx.tz(), today) || live(taps).find((x) => x.local_date === date);
  const food = t ? { yes: 'On plan', partial: 'Partly on plan', off: 'Off plan' }[t.status] : 'Food not logged';
  const weight = w ? `${ctx.fmtWeight(w.weight_lb)} ${ctx.unitLabel()}` : 'No weigh-in';
  return { text: `${weight} · ${food}`, complete: Boolean(w && t) };
}
