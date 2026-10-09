// First launch (spec §2a): load history, then ask only what the history can't know.
import { h, clear, stepper, segmented, toast, openSheet } from '../ui.js';
import { fetchSeedFiles, seedFirstLaunch } from '../seed.js';
import { pickFile, readImportFile, importBackupSheet } from '../import-flow.js';
import { putMany, getMeta } from '../db.js';
import { deviceTimeZone, tzCity, localDate, formatDayMonth, formatMonthYear } from '../../coach/time.js';
import { parseWeightCsv } from '../../coach/seed.js';

export async function renderOnboarding(root, ctx, { onDone }) {
  clear(root);
  const screen = h('main', { class: 'screen no-tabs stack-lg' });
  root.append(screen);

  let seed;
  try {
    seed = await fetchSeedFiles();
  } catch (err) {
    screen.append(h('div', { class: 'stack' },
      h('h1', { class: 'title' }, 'Can’t load your history'),
      h('p', { class: 'muted body' }, 'The first launch needs a connection once to load 17 months of history. Connect and try again.'),
      h('p', { class: 'faint xsmall' }, String(err.message || err)),
      h('button', { type: 'button', class: 'btn primary block', onClick: () => renderOnboarding(root, ctx, { onDone }) }, 'Try again')));
    return;
  }

  const history = parseWeightCsv(seed.weightCsv);
  const last = history[history.length - 1];
  const tz = deviceTimeZone();
  const answers = { weight_lb: null, height_in: null, lifted_less: null };
  let healthRecords = [];

  const start = h('button', { type: 'button', class: 'btn primary block', disabled: true }, 'Start');
  const update = () => { start.disabled = !(Number.isFinite(answers.weight_lb) && answers.lifted_less !== null); };

  const weight = stepper({
    value: null, step: 0.2, min: 80, max: 400, decimals: 1, unit: 'lb', placeholder: last.weight_lb.toFixed(1), label: 'Current weight',
    onChange: (v) => { answers.weight_lb = v; update(); },
  });
  let ft = null; let inch = null;
  const setHeight = () => { answers.height_in = ft !== null ? ft * 12 + (inch || 0) : null; };
  const feet = stepper({ value: null, step: 1, min: 4, max: 7, placeholder: '5', unit: 'ft', compact: true, label: 'Height feet', onChange: (v) => { ft = v; setHeight(); } });
  const inches = stepper({ value: null, step: 1, min: 0, max: 11, placeholder: '10', unit: 'in', compact: true, label: 'Height inches', onChange: (v) => { inch = v; setHeight(); } });
  const healthNote = h('p', { class: 'muted small', style: 'margin:8px 0 0' });

  const importHealth = async () => {
    const file = await pickFile();
    if (!file) return;
    const parsed = await readImportFile(file);
    if (parsed.kind !== 'health-csv') {
      toast(parsed.kind === 'backup' ? 'That’s a backup: use “Restore from a backup” below' : parsed.message);
      return;
    }
    healthRecords = parsed.records;
    const latest = [...healthRecords].sort((a, b) => (a.local_date < b.local_date ? -1 : 1)).pop();
    healthNote.textContent = `${healthRecords.length} Health weigh-ins ready (latest ${latest.weight_lb.toFixed(1)} lb on ${formatDayMonth(latest.local_date)}).`;
    if (latest.local_date === localDate(new Date(), tz)) weight.setValue(latest.weight_lb);
    answers.weight_lb = weight.getValue();
    update();
  };

  const restore = async () => {
    const file = await pickFile();
    if (!file) return;
    const parsed = await readImportFile(file);
    if (parsed.kind !== 'backup') {
      openSheet({ title: 'Not a backup', body: h('p', { class: 'muted body' }, parsed.message || 'Choose a walter-coach-backup-….json file.'), actions: [{ label: 'OK', kind: 'outline' }] });
      return;
    }
    await importBackupSheet(ctx, parsed, {
      replaceOnly: true,
      onDone: async () => {
        if (await getMeta(ctx.db, 'onboarding')) onDone();
        else toast('That backup has no settings; finish setup below');
      },
    });
  };

  start.addEventListener('click', async () => {
    start.disabled = true;
    start.textContent = 'Loading history…';
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist().catch(() => false);
      const now = new Date();
      const today = localDate(now, tz);
      const sameDayHealth = healthRecords.find((r) => r.local_date === today && Math.abs(r.weight_lb - answers.weight_lb) < 0.05);
      const result = await seedFirstLaunch(ctx.db, {
        ...seed,
        answers: { ...answers, weight_lb: sameDayHealth ? null : answers.weight_lb },
        now, tz, appVersion: ctx.version,
      });
      if (healthRecords.length) await putMany(ctx.db, 'weighins', healthRecords.map((r) => ({ ...r, updated_utc: now.toISOString() })));
      toast(`Loaded ${result.historyCount} weigh-ins from history`);
      onDone();
    } catch (err) {
      console.error(err);
      start.disabled = false;
      start.textContent = 'Start';
      toast(`Setup failed: ${err.message || err}`, 5000);
    }
  });

  screen.append(
    h('div', { class: 'stack' },
      h('img', { class: 'monogram', src: 'icons/icon-192.png', alt: '' }),
      h('div', {}, h('p', { class: 'label' }, 'WMCoach'), h('h1', { class: 'title' }, 'Set up'))),
    h('p', { class: 'muted body' }, `Your history loads automatically: ${history.length} weigh-ins from ${formatMonthYear(history[0].date)} to ${formatMonthYear(last.date)}, the cut and bulk phases, and the metabolism priors. Nothing is logged after ${formatDayMonth(last.date)}, so a few questions first.`),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Weight this morning'),
      weight,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, `Fasted, after the bathroom. Last logged: ${last.weight_lb.toFixed(1)} lb on ${formatDayMonth(last.date)} ${last.date.slice(0, 4)}.`),
      h('button', { type: 'button', class: 'link-btn', onClick: importHealth }, 'Import Health weigh-ins (CSV) first'),
      healthNote),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Height (optional)'),
      h('div', { class: 'stack-sm' }, feet, inches),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Used only for the body-fat trend estimate.')),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Since May, have you lifted less than usual?'),
      segmented([{ value: true, label: 'Yes' }, { value: false, label: 'No' }], null, (v) => { answers.lifted_less = v; update(); }, { label: 'Lifted less since May' }),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'If yes, weeks 1–2 run one rep further from failure, with no load increases in week 1.')),
    h('div', { class: 'card flush list' },
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Mode'), h('span', { class: 'value' }, 'Bulk, from today')),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Timezone'), h('span', { class: 'value' }, `${tzCity(tz)} · follows iPhone`)),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Prep day · check-in'), h('span', { class: 'value' }, 'Sunday · Friday'))),
    h('div', { class: 'stack-sm' },
      start,
      h('button', { type: 'button', class: 'btn ghost block', onClick: restore }, 'Restore from a backup instead')));
}
