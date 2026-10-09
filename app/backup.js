// Export / Import (spec §11) and local update snapshots (spec §12a).
// Works in the browser and in Node tests (with fake-indexeddb).
import {
  DB_VERSION, EXPORT_EXCLUDE, PRIVATE_META, MIGRATIONS, getAll, keyPathOf, put, del, storeNames, writeAtomic,
} from './db.js';

export const BACKUP_APP = 'wmcoach';
export const SNAPSHOTS_KEPT = 3;

export async function buildBackup(db, { appVersion, now = new Date(), tz = null, localDate = null } = {}) {
  const stores = {};
  for (const name of storeNames(db)) {
    if (EXPORT_EXCLUDE.has(name)) continue;
    const records = await getAll(db, name);
    stores[name] = name === 'meta' ? records.filter((r) => !PRIVATE_META.has(r.key)) : records;
  }
  return {
    app: BACKUP_APP,
    schema_version: db.version,
    app_version: appVersion,
    exported_at: now.toISOString(),
    exported_tz: tz,
    exported_local_date: localDate,
    stores,
  };
}

export function backupFileName(localDate) {
  return `walter-coach-backup-${localDate}.json`;
}

export function countRecords(backup) {
  return Object.fromEntries(Object.entries(backup.stores || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
}

export function validateBackup(obj) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object') errors.push('Not a JSON object.');
  else {
    if (obj.app !== BACKUP_APP) errors.push('This file is not a WMCoach backup.');
    if (!Number.isInteger(obj.schema_version) || obj.schema_version < 1) errors.push('Missing or invalid schema_version.');
    if (!obj.stores || typeof obj.stores !== 'object' || Array.isArray(obj.stores)) errors.push('Missing stores.');
    else {
      for (const [name, records] of Object.entries(obj.stores)) {
        if (!Array.isArray(records)) errors.push(`Store "${name}" is not a list.`);
      }
    }
    if (Number.isInteger(obj.schema_version) && obj.schema_version > DB_VERSION) {
      warnings.push(`Backup is from a newer app (schema ${obj.schema_version}; this app knows ${DB_VERSION}). Stores this version doesn't know are skipped.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Bring an older backup up to the current schema by replaying record-level migrations.
export function migrateBackup(backup, migrations = MIGRATIONS) {
  const out = { ...backup, stores: { ...backup.stores } };
  for (const m of migrations) {
    if (m.version <= backup.schema_version || !m.migrateRecord) continue;
    for (const [name, records] of Object.entries(out.stores)) {
      out.stores[name] = records.map((r) => m.migrateRecord(name, r) || r);
    }
  }
  out.schema_version = Math.max(backup.schema_version, migrations[migrations.length - 1].version);
  return out;
}

function newer(a, b) {
  // true when a should win over b; records without timestamps let the incoming one win
  if (a.updated_utc && b.updated_utc) return a.updated_utc >= b.updated_utc;
  return true;
}

// What an import would do, per store.
export async function previewImport(db, backup) {
  const known = new Set(storeNames(db));
  const rows = [];
  for (const [name, records] of Object.entries(backup.stores)) {
    if (EXPORT_EXCLUDE.has(name)) continue;
    if (!known.has(name)) {
      rows.push({ store: name, incoming: records.length, added: 0, updated: 0, unchanged: 0, skipped: records.length, unknown: true });
      continue;
    }
    const keyPath = keyPathOf(db, name);
    const existing = new Map((await getAll(db, name)).map((r) => [r[keyPath], r]));
    let added = 0; let updated = 0; let unchanged = 0;
    for (const r of records) {
      const cur = existing.get(r[keyPath]);
      if (!cur) added += 1;
      else if (JSON.stringify(cur) === JSON.stringify(r) || !newer(r, cur)) unchanged += 1;
      else updated += 1;
    }
    rows.push({ store: name, incoming: records.length, added, updated, unchanged, skipped: 0, existing: existing.size });
  }
  return rows;
}

// mode: 'merge' (by record id; the newer record wins) or 'replace' (clear, then write).
export async function applyImport(db, backup, mode) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode ${mode}`);
  const known = new Set(storeNames(db));
  const writes = {};
  const clear = [];
  for (const [name, records] of Object.entries(backup.stores)) {
    if (!known.has(name) || EXPORT_EXCLUDE.has(name)) continue;
    const keyPath = keyPathOf(db, name);
    let valid = records.filter((r) => r && r[keyPath] !== undefined && r[keyPath] !== null);
    // the GitHub token and sync state belong to this phone, not to a backup
    if (name === 'meta') valid = valid.filter((r) => !PRIVATE_META.has(r.key));
    if (mode === 'replace') {
      clear.push(name);
      writes[name] = name === 'meta' ? [...valid, ...(await getAll(db, 'meta')).filter((r) => PRIVATE_META.has(r.key))] : valid;
    } else {
      const existing = new Map((await getAll(db, name)).map((r) => [r[keyPath], r]));
      writes[name] = valid.filter((r) => {
        const cur = existing.get(r[keyPath]);
        return !cur || newer(r, cur);
      });
    }
  }
  await writeAtomic(db, { clear, writes });
  return Object.fromEntries(Object.entries(writes).map(([k, v]) => [k, v.length]));
}

// ---- local snapshots: saved before an update is applied (keep the last 3) ----

export async function saveSnapshot(db, { reason, appVersion, now = new Date(), tz = null, localDate = null }) {
  const backup = await buildBackup(db, { appVersion, now, tz, localDate });
  const snap = {
    id: `snap-${now.toISOString()}-${reason}`,
    created_utc: now.toISOString(),
    reason,
    app_version: appVersion,
    records: Object.values(countRecords(backup)).reduce((a, b) => a + b, 0),
    backup,
  };
  await put(db, 'snapshots', snap);
  await pruneSnapshots(db, reason);
  return snap;
}

export async function listSnapshots(db) {
  const all = await getAll(db, 'snapshots');
  return all.sort((a, b) => (a.created_utc < b.created_utc ? 1 : -1));
}

async function pruneSnapshots(db, reason) {
  const same = (await listSnapshots(db)).filter((s) => s.reason === reason);
  for (const s of same.slice(SNAPSHOTS_KEPT)) await del(db, 'snapshots', s.id);
}
