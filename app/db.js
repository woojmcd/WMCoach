// IndexedDB with numbered, additive-only migrations (spec §12a).
//
// Rules for every future change:
//  - Append a new entry to MIGRATIONS; never edit or reorder an existing one.
//  - Only add stores, indexes or fields. Never delete or rename in place
//    (copy-then-switch if a rename is unavoidable).
//  - If records need new default fields, add `migrateRecord`; it runs both on
//    the stored data during the upgrade and on older backups during Import.
//  - Older app code must still read newer data: openDB() falls back to opening
//    the newer database as-is, so a rollback never breaks.

export const DB_NAME = 'wmcoach';

export const MIGRATIONS = [
  {
    version: 1,
    description: 'Core stores: meta (settings, model, flags), weigh-ins, phases, update snapshots',
    up(db) {
      db.createObjectStore('meta', { keyPath: 'key' });
      const w = db.createObjectStore('weighins', { keyPath: 'id' });
      w.createIndex('local_date', 'local_date');
      db.createObjectStore('phases', { keyPath: 'id' });
      const s = db.createObjectStore('snapshots', { keyPath: 'id' });
      s.createIndex('created_utc', 'created_utc');
    },
  },
  {
    version: 2,
    description: 'Body tab: mode changes, weekly measurements, weekly check-ins, daily on-plan taps',
    up(db) {
      for (const name of ['mode_changes', 'measurements', 'checkins', 'adherence']) {
        const store = db.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('local_date', 'local_date');
      }
    },
  },
  {
    version: 3,
    description: 'Training: workout sessions (sets nested), weekend stairs taps, per-exercise preferences (increment, alternates, swap)',
    up(db) {
      for (const name of ['sessions', 'stairs']) {
        const store = db.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('local_date', 'local_date');
      }
      db.createObjectStore('exercise_prefs', { keyPath: 'id' });
    },
  },
  {
    version: 4,
    description: 'Meals: one plan per prep week (local copy; the weekly run publishes later ones), food flags (GI issues)',
    up(db) {
      db.createObjectStore('plans', { keyPath: 'id' }).createIndex('week_start', 'week_start');
      db.createObjectStore('foods', { keyPath: 'id' });
    },
  },
];

export const DB_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Local safety copies are never part of an export (they *are* exports).
export const EXPORT_EXCLUDE = new Set(['snapshots']);

export function openDB({ name = DB_NAME, migrations = MIGRATIONS, idb = globalThis.indexedDB } = {}) {
  const version = migrations[migrations.length - 1].version;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      for (const m of migrations) {
        if (m.version > event.oldVersion && m.version <= event.newVersion) {
          m.up(db, tx);
          if (m.migrateRecord) migrateStoredRecords(db, tx, m);
        }
      }
    };
    req.onsuccess = () => resolve(watch(req.result));
    req.onerror = (event) => {
      if (req.error && req.error.name === 'VersionError') {
        // A newer app version already upgraded this database. Migrations are
        // additive, so this (older) code can read it as-is.
        event.preventDefault?.();
        const again = idb.open(name);
        again.onsuccess = () => resolve(watch(again.result));
        again.onerror = () => reject(again.error);
        return;
      }
      reject(req.error);
    };
  });
}

function watch(db) {
  // A newer version in another context wants to upgrade: let it.
  db.onversionchange = () => db.close();
  return db;
}

function migrateStoredRecords(db, tx, m) {
  for (const name of db.objectStoreNames) {
    const store = tx.objectStore(name);
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const next = m.migrateRecord(name, cursor.value);
      if (next && next !== cursor.value) cursor.update(next);
      cursor.continue();
    };
  }
}

export function storeNames(db) {
  return Array.from(db.objectStoreNames);
}

export function keyPathOf(db, storeName) {
  return db.transaction(storeName, 'readonly').objectStore(storeName).keyPath;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(db, store, key) {
  return request(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getAll(db, store) {
  return request(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function getAllByIndex(db, store, index, query) {
  return request(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(query));
}

export async function count(db, store) {
  return request(db.transaction(store, 'readonly').objectStore(store).count());
}

export async function put(db, store, value) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
  return value;
}

export async function putMany(db, store, values) {
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await done(tx);
  return values.length;
}

export async function del(db, store, key) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

// Several stores in one atomic transaction: writes = { store: [records] }, clear = [stores].
export async function writeAtomic(db, { clear = [], writes = {} }) {
  const names = [...new Set([...clear, ...Object.keys(writes)])];
  if (!names.length) return;
  const tx = db.transaction(names, 'readwrite');
  for (const name of clear) tx.objectStore(name).clear();
  for (const [name, values] of Object.entries(writes)) {
    const os = tx.objectStore(name);
    for (const v of values) os.put(v);
  }
  await done(tx);
}

export async function getMeta(db, key) {
  const rec = await get(db, 'meta', key);
  return rec ? rec.value : undefined;
}

export async function setMeta(db, key, value) {
  await put(db, 'meta', { key, value, updated_utc: new Date().toISOString() });
  return value;
}
