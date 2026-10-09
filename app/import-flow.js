// Export / Import UI flows (spec §11), shared by Settings and first launch.
import { h, openSheet, confirmSheet, toast, formatBytes, fmtInt } from './ui.js';
import {
  buildBackup, backupFileName, countRecords, validateBackup, migrateBackup, previewImport, applyImport, saveSnapshot,
} from './backup.js';
import { parseHealthWeightCsv } from '../coach/seed.js';
import { getAllByIndex, putMany, setMeta } from './db.js';
import { formatDayMonth } from '../coach/time.js';

const STORE_LABELS = { meta: 'Settings and model', weighins: 'Weigh-ins', phases: 'Phases' };
const storeLabel = (name) => STORE_LABELS[name] || name;

// ---- export -------------------------------------------------------------------------

export function backupFile(backup, localDate) {
  const json = JSON.stringify(backup);
  return new File([json], backupFileName(localDate), { type: 'application/json' });
}

// Share sheet ("Save to Files" → iCloud Drive), falling back to a download link.
// Must run inside a tap handler: iOS only allows share() from a user gesture.
export async function shareFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return 'downloaded';
}

export async function exportFlow(ctx) {
  const today = ctx.today();
  const backup = await buildBackup(ctx.db, { appVersion: ctx.version, tz: ctx.tz(), localDate: today });
  const file = backupFile(backup, today);
  const counts = countRecords(backup);
  const body = h('div', { class: 'list' },
    Object.entries(counts).map(([k, n]) => h('div', { class: 'item' }, h('span', { class: 'grow' }, storeLabel(k)), h('span', { class: 'value' }, fmtInt(n)))),
    h('div', { class: 'item' }, h('span', { class: 'grow muted' }, file.name), h('span', { class: 'value' }, formatBytes(file.size))));
  openSheet({
    title: 'Backup ready',
    subtitle: 'Save it to Files → iCloud Drive.',
    body,
    actions: [
      {
        label: 'Save to Files',
        kind: 'primary',
        onClick: async () => {
          const result = await shareFile(file);
          if (result === 'cancelled') return true; // keep the sheet open
          await setMeta(ctx.db, 'last_export', { utc: new Date().toISOString(), local_date: today, file: file.name });
          toast(result === 'shared' ? 'Backup saved' : 'Backup downloaded');
          ctx.refresh();
          return false;
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
}

// ---- import -------------------------------------------------------------------------

export function pickFile() {
  return new Promise((resolve) => {
    // No `accept` filter: iOS greys out .json files for some MIME filters.
    const input = h('input', { type: 'file', style: 'display:none' });
    input.addEventListener('change', () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export async function readImportFile(file) {
  const text = await file.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { kind: 'error', message: 'The file is not valid JSON.' };
    }
    const v = validateBackup(obj);
    if (!v.ok) return { kind: 'error', message: v.errors.join(' ') };
    return { kind: 'backup', backup: migrateBackup(obj), warnings: v.warnings, name: file.name };
  }
  const { records, errors } = parseHealthWeightCsv(text);
  if (!records.length) return { kind: 'error', message: 'No weigh-ins found. Expected a WMCoach backup (.json) or a CSV of "date,weight".' };
  return { kind: 'health-csv', records, errors, name: file.name };
}

function previewTable(rows) {
  return h('div', { class: 'list' }, rows.map((r) => h('div', { class: 'item' },
    h('span', { class: 'grow' }, storeLabel(r.store), r.unknown ? h('span', { class: 'faint xsmall' }, ' (newer app; skipped)') : null),
    h('span', { class: 'value xsmall' }, r.unknown
      ? `${fmtInt(r.incoming)} skipped`
      : `${fmtInt(r.incoming)} in file · ${fmtInt(r.added)} new · ${fmtInt(r.updated)} newer`))));
}

// Backup: preview counts, then Merge (by record id) or Replace (confirmed).
// `onDone` runs after a successful import.
export async function importBackupSheet(ctx, parsed, { onDone, replaceOnly = false } = {}) {
  const rows = await previewImport(ctx.db, parsed.backup);
  const when = parsed.backup.exported_at ? new Date(parsed.backup.exported_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown date';
  const body = h('div', {},
    h('p', { class: 'muted small', style: 'margin:0 0 8px' }, `${parsed.name} · exported ${when} · app ${parsed.backup.app_version || '?'}`),
    parsed.warnings.length ? h('p', { class: 'small', style: 'color:var(--warn)' }, parsed.warnings.join(' ')) : null,
    previewTable(rows));
  const doImport = async (mode) => {
    await saveSnapshot(ctx.db, { reason: 'import', appVersion: ctx.version, tz: ctx.tz(), localDate: ctx.today() });
    const written = await applyImport(ctx.db, parsed.backup, mode);
    const n = Object.values(written).reduce((a, b) => a + b, 0);
    toast(mode === 'replace' ? `Restored ${fmtInt(n)} records` : `Merged ${fmtInt(n)} records`);
    if (onDone) await onDone();
  };
  const actions = [];
  if (!replaceOnly) actions.push({ label: 'Merge', kind: 'primary', onClick: () => doImport('merge') });
  actions.push({
    label: replaceOnly ? 'Restore' : 'Replace everything',
    kind: replaceOnly ? 'primary' : 'danger',
    onClick: async () => {
      if (!replaceOnly) {
        const ok = await confirmSheet({
          title: 'Replace all data?',
          message: 'Everything on this phone is replaced by the backup. A safety snapshot is saved first.',
          confirm: 'Replace', kind: 'danger',
        });
        if (!ok) return;
      }
      await doImport('replace');
    },
  });
  actions.push({ label: 'Cancel', kind: 'outline' });
  openSheet({ title: replaceOnly ? 'Restore backup' : 'Import backup', body, actions });
}

// Health weigh-ins CSV (one-time export via a Shortcut). Adds entries; never overwrites app entries.
export async function importHealthCsvSheet(ctx, parsed, { onDone } = {}) {
  const dates = parsed.records.map((r) => r.local_date).sort();
  const existing = new Set();
  for (const r of parsed.records) {
    const same = await getAllByIndex(ctx.db, 'weighins', 'local_date', r.local_date);
    if (same.some((s) => s.id === r.id)) existing.add(r.id);
  }
  const fresh = parsed.records.filter((r) => !existing.has(r.id));
  const body = h('div', { class: 'list' },
    h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Weigh-ins in file'), h('span', { class: 'value' }, fmtInt(parsed.records.length))),
    h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Dates'), h('span', { class: 'value' }, `${formatDayMonth(dates[0])} ${dates[0].slice(0, 4)} – ${formatDayMonth(dates[dates.length - 1])} ${dates[dates.length - 1].slice(0, 4)}`)),
    h('div', { class: 'item' }, h('span', { class: 'grow' }, 'New'), h('span', { class: 'value' }, fmtInt(fresh.length))),
    parsed.errors.length ? h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Unreadable lines'), h('span', { class: 'value' }, fmtInt(parsed.errors.length))) : null);
  openSheet({
    title: 'Import Health weigh-ins',
    body,
    actions: [
      {
        label: `Import ${fmtInt(fresh.length)}`,
        kind: 'primary',
        onClick: async () => {
          const utc = new Date().toISOString();
          await putMany(ctx.db, 'weighins', fresh.map((r) => ({ ...r, updated_utc: utc })));
          toast(`Imported ${fmtInt(fresh.length)} weigh-ins`);
          if (onDone) await onDone();
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
}

export async function importFlow(ctx, { onDone } = {}) {
  const file = await pickFile();
  if (!file) return;
  const parsed = await readImportFile(file);
  if (parsed.kind === 'error') {
    openSheet({ title: 'Can’t import this file', body: h('p', { class: 'muted body' }, parsed.message), actions: [{ label: 'OK', kind: 'outline' }] });
    return;
  }
  if (parsed.kind === 'health-csv') await importHealthCsvSheet(ctx, parsed, { onDone });
  else await importBackupSheet(ctx, parsed, { onDone });
}
