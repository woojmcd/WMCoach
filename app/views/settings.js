// Settings (spec §4.5 gear): timezone (§2b), profile, schedule, rest timer,
// Export / Import (§11), local snapshots and app version.
import { h, icon, toast, openSheet, segmented, chips, stepper, itemRow, formatBytes, fmtInt } from '../ui.js';
import { header, sectionLabel, backButton } from './common.js';
import { getMeta } from '../db.js';
import { listSnapshots } from '../backup.js';
import { exportFlow, importFlow, backupFile, shareFile } from '../import-flow.js';
import { setManualZone, setAutoZone, offsetLabel } from '../tz.js';
import {
  deviceTimeZone, supportedTimeZones, tzCity, tzOffsetMinutes, WEEKDAYS, WEEKDAYS_LONG, formatDayMonth, localDate,
} from '../../coach/time.js';

const DAY_CHIPS = WEEKDAYS.map((d, i) => ({ value: i + 1, label: d }));

function heightText(inches) {
  if (!inches) return 'Not set';
  return `${Math.floor(inches / 12)}′ ${inches % 12}″`;
}

export async function render(screen, ctx) {
  const s = ctx.settings;
  const now = new Date();
  const device = deviceTimeZone();
  const save = async (next, message) => {
    if (!next) return;
    await ctx.saveSettings(next);
    if (message) toast(message);
    ctx.refresh();
  };
  const patch = (fields, message) => save({ ...ctx.settings, ...fields, updated_utc: new Date().toISOString() }, message);

  // ---- timezone ----
  const zoneRow = itemRow({
    label: 'Zone',
    value: `${tzCity(s.tz_current)} · ${offsetLabel(tzOffsetMinutes(now, s.tz_current))}`,
    chevron: s.tz_mode === 'manual',
    onClick: s.tz_mode === 'manual' ? () => zonePicker(ctx, save) : null,
  });
  const tzMode = segmented([{ value: 'auto', label: 'Auto (follow iPhone)' }, { value: 'manual', label: 'Manual' }], s.tz_mode, (mode) => {
    if (mode === 'auto') save(setAutoZone(ctx.settings, device, new Date()), `Following iPhone: ${tzCity(device)} time`);
    else zonePicker(ctx, save, () => ctx.refresh());
  }, { label: 'Timezone mode' });
  const recentZones = [...(s.tz_history || [])].reverse().slice(0, 5);

  // ---- profile ----
  const heightRow = itemRow({ label: 'Height', value: heightText(s.height_in), chevron: true, onClick: () => heightSheet(ctx, patch) });
  const units = segmented([{ value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }], s.units, (u) => patch({ units: u }), { label: 'Units' });
  const liftedLess = segmented([{ value: true, label: 'Yes' }, { value: false, label: 'No' }], s.lifted_less_since_may, (v) => patch({ lifted_less_since_may: v }), { label: 'Lifted less since May' });

  // ---- schedule ----
  const prep = chips(DAY_CHIPS, s.prep_day, (d) => patch({ prep_day: d }, `Prep day: ${WEEKDAYS_LONG[d - 1]}`), { label: 'Prep day', className: 'days' });
  const checkin = chips(DAY_CHIPS, s.checkin_day, (d) => patch({ checkin_day: d }, `Check-in: ${WEEKDAYS_LONG[d - 1]}`), { label: 'Check-in day', className: 'days' });

  // ---- rest timer ----
  const rest = stepper({ value: s.rest_default_s, step: 15, min: 15, max: 300, unit: 's', compact: true, label: 'Default rest', onChange: (v) => v && patch({ rest_default_s: v }) });
  const ssRest = stepper({ value: s.rest_superset_s, step: 5, min: 0, max: 60, unit: 's', compact: true, label: 'Superset rest', onChange: (v) => v !== null && patch({ rest_superset_s: v }) });

  // ---- backup ----
  const [lastExport, snapshots] = await Promise.all([getMeta(ctx.db, 'last_export'), listSnapshots(ctx.db)]);
  const snapRows = snapshots.map((snap) => {
    const date = localDate(new Date(snap.created_utc), ctx.tz());
    return itemRow({
      label: h('span', {}, h('div', {}, `${snap.reason === 'update' ? 'Before update' : 'Before import'} · v${snap.app_version}`), h('div', { class: 'muted xsmall' }, `${formatDayMonth(date)} ${date.slice(0, 4)} · ${fmtInt(snap.records)} records`)),
      extra: icon('share', { size: 20 }),
      onClick: async () => {
        const file = backupFile(snap.backup, date);
        const r = await shareFile(file);
        if (r !== 'cancelled') toast(`Snapshot ${r === 'shared' ? 'shared' : 'downloaded'} (${formatBytes(file.size)})`);
      },
    });
  });

  // ---- app ----
  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { /* unknown */ }

  screen.append(
    h('div', { style: 'margin:0 0 -8px -12px' }, backButton(() => ctx.navigate('#/history'))),
    header({ label: 'History', title: 'Settings' }),

    sectionLabel('Timezone'),
    h('div', { class: 'stack-sm' },
      tzMode,
      h('div', { class: 'card flush list' }, zoneRow,
        recentZones.length > 1 ? h('div', { class: 'item' }, h('span', { class: 'grow muted xsmall' }, 'Recent'), h('span', { class: 'value xsmall' }, recentZones.map((z) => tzCity(z.tz)).filter((v, i, a) => a.indexOf(v) === i).join(' · '))) : null)),

    sectionLabel('Profile'),
    h('div', { class: 'stack' },
      h('div', { class: 'card flush list' }, heightRow),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Units'), units),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Lifted less since May'), liftedLess)),

    sectionLabel('Schedule'),
    h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Meal-prep day (plan locks for 7 days)'), prep),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Check-in and measurements'), checkin)),

    sectionLabel('Rest timer'),
    h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Between sets'), rest),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Between superset partners'), ssRest)),

    sectionLabel('Backup'),
    h('div', { class: 'stack-sm' },
      h('button', { type: 'button', class: 'btn primary block', onClick: () => exportFlow(ctx) }, icon('share', { size: 20 }), 'Export backup'),
      h('button', { type: 'button', class: 'btn outline block', onClick: () => importFlow(ctx, { onDone: () => ctx.reload() }) }, icon('upload', { size: 20 }), 'Import backup or CSV'),
      h('p', { class: 'muted xsmall center', style: 'margin:4px 0 0' }, lastExport ? `Last backup ${formatDayMonth(lastExport.local_date)} ${lastExport.local_date.slice(0, 4)}` : 'No backup yet'),
      snapshots.length ? h('div', {}, h('p', { class: 'label', style: 'margin:16px 0 8px' }, 'Local snapshots'), h('div', { class: 'card flush list' }, snapRows)) : null),

    sectionLabel('App'),
    h('div', { class: 'card flush list' },
      itemRow({ label: 'Version', value: ctx.version }),
      itemRow({ label: 'Data schema', value: `v${ctx.db.version}` }),
      itemRow({ label: 'Storage', value: persisted === null ? 'Unknown' : persisted ? 'Persistent' : 'Best effort' }),
      itemRow({ label: 'Check for update', extra: icon('refresh', { size: 20 }), onClick: () => ctx.checkUpdate() })));
}

function zonePicker(ctx, save, onCancel = null) {
  const zones = supportedTimeZones();
  const now = new Date();
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search city or zone', autocomplete: 'off', 'aria-label': 'Search timezones' });
  const list = h('div', { class: 'tz-list' });
  let chosen = false;
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/\s+/g, '_');
    const matches = zones.filter((z) => !q || z.toLowerCase().includes(q)).slice(0, 60);
    list.replaceChildren(...matches.map((z) => h('button', {
      type: 'button',
      'aria-pressed': String(z === ctx.settings.tz_current),
      onClick: async () => {
        chosen = true;
        sheet.close();
        await save(setManualZone(ctx.settings, z, new Date()), `Now on ${tzCity(z)} time`);
        ctx.refresh();
      },
    }, h('span', {}, tzCity(z), h('span', { class: 'faint xsmall' }, `  ${z}`)), h('span', { class: 'off' }, offsetLabel(tzOffsetMinutes(now, z))))));
    if (!matches.length) list.append(h('p', { class: 'muted small' }, 'No match.'));
  };
  search.addEventListener('input', draw);
  draw();
  const sheet = openSheet({
    title: 'Timezone',
    subtitle: 'Today, the week and check-in days follow this zone.',
    body: h('div', {}, search, list),
    actions: [{ label: 'Cancel', kind: 'outline' }],
    onClose: () => { if (!chosen && onCancel) onCancel(); },
  });
}

function heightSheet(ctx, patch) {
  const cur = ctx.settings.height_in;
  const ft = stepper({ value: cur ? Math.floor(cur / 12) : null, step: 1, min: 4, max: 7, placeholder: '5', unit: 'ft', compact: true, label: 'Feet' });
  const inch = stepper({ value: cur ? cur % 12 : null, step: 1, min: 0, max: 11, placeholder: '10', unit: 'in', compact: true, label: 'Inches' });
  openSheet({
    title: 'Height',
    subtitle: 'Used only for the body-fat trend estimate.',
    body: h('div', { class: 'stack-sm' }, ft, inch),
    actions: [
      {
        label: 'Save', kind: 'primary',
        onClick: () => {
          const f = ft.getValue();
          if (f === null) return true;
          patch({ height_in: f * 12 + (inch.getValue() || 0) }, 'Height saved');
          return false;
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
}
