// Meals tab (spec §4.4): this week's plan in Walter's format (meals → foods →
// cooked weights), "What changed", prep list, grocery list, travel mode, GI flags.
import { h, icon, openSheet, segmented, toast, fmtInt } from '../ui.js';
import { header, sectionLabel, note } from './common.js';
import { put } from '../db.js';
import { ensurePlans } from '../meal-plans.js';
import {
  MEAL_ORDER, prepList, groceryList, GROCERY_GROUPS, ozToG, SWAPS, dayCounts,
} from '../../coach/meals.js';
import { formatDayMonth, WEEKDAYS, isoWeekday } from '../../coach/time.js';

const ui = { dayType: null };

// Food names as Walter's coach wrote them: [singular, plural] for counted units.
const NAMES = {
  egg: ['egg', 'eggs'], egg_white: ['egg white', 'egg whites'], ezekiel: ['slice Ezekiel bread', 'slices Ezekiel bread'],
  rice_cake: ['rice cake', 'rice cakes'], whey_iso: ['scoop whey isolate', 'scoops whey isolate'], greek_yogurt: ['0 % Greek yogurt', '0 % Greek yogurts'],
  granola: ['granola portion', 'granola portions'], fruit: ['apple or banana', 'apples or bananas'], pb_cup: ['PB cup', 'PB cups'],
  turkey_bacon: ['slice turkey bacon', 'slices turkey bacon'], cappuccino: ['cappuccino', 'cappuccinos'], protein_yogurt: ['protein yogurt', 'protein yogurts'],
  almond_milk: ['cup almond milk', 'cups almond milk'], skim_milk: ['cup skim milk', 'cups skim milk'],
  chicken: 'chicken (cooked)', lean_beef: '93/7 beef or turkey (cooked)', rice: 'jasmine rice (cooked)', sweet_potato: 'sweet potato',
  green_veg: 'green veg', blueberries: 'blueberries', nut_butter: 'nut butter', cream_rice: 'Cream of Rice (dry)', cheerios: 'Cheerios', egg_white_oz: 'liquid egg whites',
};
// Prep list: what you cook and the unit you count it in.
const PREP = {
  ezekiel: ['Ezekiel bread', 'slice', 'slices'], whey_iso: ['Whey isolate', 'scoop', 'scoops'], greek_yogurt: ['0 % Greek yogurt', 'cup', 'cups'],
  granola: ['Granola', 'portion', 'portions'], turkey_bacon: ['Turkey bacon', 'slice', 'slices'], almond_milk: ['Almond milk', 'cup', 'cups'],
  skim_milk: ['Skim milk', 'cup', 'cups'],
};
const SHORT = { rice: 'rice', sweet_potato: 'sweet potato', rice_cake: 'rice cakes', chicken: 'chicken', lean_beef: 'beef/turkey', egg: 'eggs', ezekiel: 'Ezekiel', nut_butter: 'nut butter', whey_iso: 'whey', green_veg: 'green veg', greek_yogurt: 'yogurt', granola: 'granola', blueberries: 'blueberries' };

const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 10) / 10));

export function foodText(it) {
  const n = NAMES[it.food];
  if (Array.isArray(n)) return `${fmtQty(it.qty)} ${it.qty === 1 ? n[0] : n[1]}`;
  const name = n || it.name;
  if (it.unit === 'g') return `${fmtQty(it.qty)} g ${name}`;
  if (it.unit === 'oz') return `${fmtQty(it.qty)} oz ${name}`;
  return `${fmtQty(it.qty)} ${it.unit} ${name}`;
}

function changeLine(c) {
  const unit = c.unit === 'each' || c.unit === 'slice' || c.unit === 'scoop' || c.unit === 'cup' ? '' : ` ${c.unit}`;
  const what = SHORT[c.food] || c.name;
  if (c.from === 0) return `${c.meal}: add ${fmtQty(c.to)}${unit} ${what}`;
  if (c.to === 0) return `${c.meal}: drop the ${what}`;
  return `${c.meal} ${what} ${fmtQty(c.from)} → ${fmtQty(c.to)}${unit}`;
}

function weekRange(rec) {
  const a = rec.week_start; const b = rec.week_end;
  return a.slice(5, 7) === b.slice(5, 7) ? `${Number(a.slice(8))}–${formatDayMonth(b)}` : `${formatDayMonth(a)} – ${formatDayMonth(b)}`;
}

export async function render(screen, ctx) {
  let state;
  try {
    state = await ensurePlans(ctx);
  } catch (err) {
    screen.append(header({ label: 'Meals', title: 'This week' }), note(`Can’t load the meal plan yet (${err.message}). Connect once to fetch it.`));
    return;
  }
  const { current, previous, foodDb, flags, week } = state;
  const plan = current.plan;
  const s = ctx.settings;
  const title = week === 0 ? 'Lead-in week' : week ? `Week ${week}` : 'This week';
  screen.append(header({ label: `Meals · ${weekRange(current)}`, title }));

  const travel = Boolean(s.travel_mode);
  screen.append(h('div', { style: 'margin-bottom:16px' }, segmented([{ value: false, label: 'Meal plan' }, { value: true, label: 'Travel' }], travel, async (v) => {
    await ctx.saveSettings({ ...ctx.settings, travel_mode: v, updated_utc: new Date().toISOString() });
    ctx.refresh();
  }, { label: 'Meal plan or travel targets' })));

  if (travel) {
    screen.append(travelCard(plan));
    return;
  }

  // What changed (spec §4.4): only when this week differs from the last one
  const ch = current.changes;
  if (ch && ch.changed) {
    const vs = current.source === 'seed' ? `vs ${current.based_on}, your last coach plan` : 'vs last week';
    const lines = [
      ch.structure ? h('div', { class: 'item' }, h('span', { class: 'grow' }, ch.structure)) : null,
      ...ch.items.map((c) => h('div', { class: 'item' }, h('span', { class: 'grow num' }, changeLine(c), c.where ? h('span', { class: 'muted xsmall' }, ` · ${c.where}`) : null))),
      ch.kcal.delta ? h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Daily average'), h('span', { class: 'value num' }, `${fmtInt(ch.kcal.from)} → ${fmtInt(ch.kcal.to)} kcal (${ch.kcal.delta > 0 ? '+' : ''}${ch.kcal.delta})`)) : null,
    ];
    screen.append(h('div', { class: 'card changed' },
      h('div', { class: 'row between' }, h('p', { class: 'label', style: 'color:var(--accent)' }, 'What changed'), h('span', { class: 'muted xsmall' }, vs)),
      h('div', { class: 'list' }, lines),
      current.reason ? h('p', { class: 'muted xsmall', style: 'margin:8px 0 0' }, current.reason) : null));
  } else if (previous) {
    screen.append(h('p', { class: 'muted small', style: 'margin:0 0 16px' }, 'Same plan as last week: prep as usual.'));
  }
  if (current.mode && s.mode !== current.mode) {
    screen.append(h('div', { class: 'banner', style: 'margin:16px 0' }, h('span', { class: 'grow' }, `You’re in ${s.mode} now; this week’s food is the ${current.mode} plan, locked until ${formatDayMonth(current.week_end)}. The weekly run builds the first ${s.mode} plan.`)));
  }

  // day type (carb cycle) and macros
  const dayTypes = Object.keys(plan.days);
  if (!ui.dayType || !plan.days[ui.dayType]) ui.dayType = dayTypes.includes('MP2') ? 'MP2' : dayTypes[0];
  const dt = ui.dayType;
  const m = plan.macros[dt];
  const counts = dayCounts(plan);
  const macroCard = h('div', { class: 'card stack-sm', style: 'margin-top:16px' },
    plan.structure === 'carb_cycle'
      ? segmented(dayTypes.map((d) => ({ value: d, label: `${d === 'MP1' ? 'Low' : 'High'} · ${counts[d]} days` })), dt, (v) => { ui.dayType = v; ctx.refresh(); }, { label: 'Day type' })
      : null,
    h('p', { class: 'label' }, plan.structure === 'carb_cycle' ? `${dt === 'MP1' ? 'Low' : 'High'}-carb day` : 'Every day'),
    h('div', { class: 'hero' }, fmtInt(m.kcal), h('small', {}, 'kcal')),
    h('div', { class: 'macros num' },
      h('span', {}, h('b', {}, `${Math.round(m.P)}`), ' g protein'), h('span', {}, h('b', {}, `${Math.round(m.C)}`), ' g carbs'), h('span', {}, h('b', {}, `${Math.round(m.F)}`), ' g fat')),
    plan.structure === 'carb_cycle' ? h('p', { class: 'muted xsmall', style: 'margin:0' }, `Weekly average ${fmtInt(plan.weekly_avg.kcal)} kcal`) : null);
  screen.append(macroCard);

  // meals → foods → cooked weights
  screen.append(sectionLabel('Meals'));
  const meals = plan.days[dt];
  const order = [...MEAL_ORDER.filter((x) => meals[x]), ...Object.keys(meals).filter((x) => !MEAL_ORDER.includes(x))];
  screen.append(h('div', { class: 'card flush' }, order.map((meal) => {
    const pm = m.per_meal[meal];
    return h('div', { class: 'meal' },
      h('div', { class: 'row between' }, h('span', { class: 'meal-name' }, meal), h('span', { class: 'muted xsmall num' }, `${pm.kcal} kcal · ${Math.round(pm.P)} g P`)),
      h('div', { class: 'foods' }, meals[meal].map((it) => h('button', { type: 'button', class: `food${flags[it.food] && flags[it.food].gi_flag ? ' flagged' : ''}`, onClick: () => foodSheet(ctx, it, foodDb, flags) },
        h('span', { class: 'grow' }, foodText(it)), flags[it.food] && flags[it.food].gi_flag ? h('span', { class: 'flag' }, 'GI') : null))));
  })));

  // prep list (cooked weights for the week)
  screen.append(sectionLabel('Prep for the week'));
  const prep = prepList(plan);
  screen.append(h('div', { class: 'card flush list prep' }, prep.map((p) => {
    const counted = Array.isArray(NAMES[p.food]);
    const unitName = PREP[p.food];
    const label = unitName ? unitName[0] : cap(counted ? NAMES[p.food][1] : NAMES[p.food] || p.name);
    const amount = unitName ? `${fmtQty(p.total)} ${p.total === 1 ? unitName[1] : unitName[2]}`
      : counted ? fmtQty(p.total)
      : p.unit === 'oz' ? `${fmtQty(p.total)} oz · ${fmtInt(ozToG(p.total))} g`
        : `${fmtInt(Math.round(p.total))} ${p.unit}`;
    const split = plan.structure === 'carb_cycle' && p.by_day_type.MP1 !== undefined && p.by_day_type.MP2 !== undefined && p.by_day_type.MP1 / counts.MP1 !== p.by_day_type.MP2 / counts.MP2
      ? `low days ${fmtQty(p.by_day_type.MP1)} · high days ${fmtQty(p.by_day_type.MP2)}` : null;
    return h('div', { class: 'item' }, h('span', { class: 'grow' }, h('div', {}, label), split ? h('div', { class: 'muted xsmall' }, split) : null), h('span', { class: 'value num' }, amount));
  })));
  screen.append(h('p', { class: 'muted xsmall', style: 'margin:8px 0 0' }, `${plan.structure === 'carb_cycle' ? `${counts.MP2} high + ${counts.MP1} low days` : '7 days'} · meats and rice weighed cooked`));

  // grocery list (raw / store units), tick off while shopping
  screen.append(sectionLabel('Grocery list'));
  const items = groceryList(prep);
  const key = `wm.grocery.${current.week_start}`;
  const checked = new Set(readChecked(key));
  for (const group of GROCERY_GROUPS) {
    const list = items.filter((i) => i.group === group);
    if (!list.length) continue;
    screen.append(h('p', { class: 'label', style: 'margin:12px 0 6px' }, group));
    screen.append(h('div', { class: 'card flush list' }, list.map((i) => {
      const row = h('button', {
        type: 'button', class: `item grocery${checked.has(i.food) ? ' got' : ''}`, 'aria-pressed': String(checked.has(i.food)),
        onClick: () => {
          if (checked.has(i.food)) checked.delete(i.food); else checked.add(i.food);
          writeChecked(key, [...checked]);
          row.classList.toggle('got');
          row.setAttribute('aria-pressed', String(checked.has(i.food)));
        },
      }, h('span', { class: 'box' }, icon('check', { size: 16 })), h('span', { class: 'grow' }, h('div', {}, i.label), i.note ? h('div', { class: 'muted xsmall' }, i.note) : null), h('span', { class: 'value num' }, i.amount));
      return row;
    })));
  }
  screen.append(h('p', { class: 'muted xsmall', style: 'margin:8px 0 0' }, `Raw meat ≈ cooked ÷ 0.75; dry rice ≈ cooked ÷ 3. Plan locked ${WEEKDAYS[isoWeekday(current.week_start) - 1]} ${formatDayMonth(current.week_start)} – ${WEEKDAYS[isoWeekday(current.week_end) - 1]} ${formatDayMonth(current.week_end)}.`));
}

function travelCard(plan) {
  const m = plan.weekly_avg;
  return h('div', { class: 'card stack' },
    h('p', { class: 'label' }, 'Travel targets'),
    h('div', { class: 'travel-grid' },
      h('div', {}, h('div', { class: 'hero' }, String(Math.round(m.P)), h('small', {}, 'g')), h('div', { class: 'muted small' }, 'Protein')),
      h('div', {}, h('div', { class: 'hero' }, fmtInt(m.kcal), h('small', {}, 'kcal')), h('div', { class: 'muted small' }, 'Energy'))),
    h('p', { class: 'body', style: 'margin:0' }, `Protein first, keep fat around ${Math.round(m.F)} g, fill the rest with carbs. Cardio as usual.`),
    h('p', { class: 'muted xsmall', style: 'margin:0' }, 'Meals are hidden while travelling, the way your coach did it. Switch back to Meal plan when you’re home.'));
}

function foodSheet(ctx, it, foodDb, flags) {
  const f = foodDb[it.food] || {};
  const flagged = Boolean(flags[it.food] && flags[it.food].gi_flag);
  const swaps = SWAPS[it.food] || [];
  openSheet({
    title: cap(Array.isArray(NAMES[it.food]) ? NAMES[it.food][1] : NAMES[it.food] || it.name),
    subtitle: `${foodText(it)} · ${[['protein_g', 'P'], ['carbs_g', 'C'], ['fat_g', 'F']].map(([k, l]) => `${Math.round(f[k] * it.qty)}\u00a0g\u00a0${l}`).join(' · ')}`,
    body: h('div', { class: 'stack-sm' },
      swaps.length ? h('div', {}, h('p', { class: 'label' }, 'Coach-approved swaps'), h('div', { class: 'list' }, swaps.map((x) => h('div', { class: 'item' }, x)))) : null,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, flagged ? 'Flagged for GI issues. Future plans avoid it.' : 'Causing GI trouble? Flag it and future plans avoid it.')),
    actions: [
      {
        label: flagged ? 'Remove GI flag' : 'Flag for GI issues', kind: flagged ? 'outline' : 'primary',
        onClick: async () => {
          await put(ctx.db, 'foods', { id: it.food, gi_flag: !flagged, updated_utc: new Date().toISOString() });
          toast(flagged ? 'GI flag removed' : 'Flagged: future plans avoid it');
          ctx.refresh();
        },
      },
      { label: 'Close', kind: 'ghost' },
    ],
  });
}

function cap(x) {
  return x.charAt(0).toUpperCase() + x.slice(1);
}

function readChecked(key) {
  try { return JSON.parse(window.localStorage.getItem(key) || '[]'); } catch { return []; }
}
function writeChecked(key, list) {
  try { window.localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode */ }
}
