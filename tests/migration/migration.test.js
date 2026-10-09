// Migration test (spec §12a): every record in the sample backup survives a
// fresh DB + all migrations, an upgrade from every older schema, and a
// rollback to older code reading a newer database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, MIGRATIONS, DB_VERSION, getAll, keyPathOf, writeAtomic, storeNames } from '../../app/db.js';
import {
  applyImport, buildBackup, migrateBackup, previewImport, validateBackup, saveSnapshot, listSnapshots, SNAPSHOTS_KEPT,
} from '../../app/backup.js';

const fixtureDir = new URL('../fixtures/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'));
const fixture = load('backup-sample.json'); // current schema
// Every fixture, including frozen older ones (backup-v1.json = a stage-1 phone).
const allFixtures = readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).map((f) => [f, load(f)]);

async function assertAllRecordsSurvive(db, backup) {
  for (const [name, records] of Object.entries(backup.stores)) {
    const keyPath = keyPathOf(db, name);
    const stored = new Map((await getAll(db, name)).map((r) => [r[keyPath], r]));
    assert.equal(stored.size >= records.length, true, `${name}: ${stored.size} < ${records.length}`);
    for (const r of records) {
      const s = stored.get(r[keyPath]);
      assert.ok(s, `${name}/${r[keyPath]} missing`);
      for (const [k, v] of Object.entries(r)) assert.deepEqual(s[k], v, `${name}/${r[keyPath]}.${k} changed`);
    }
  }
}

test('fixtures are valid backups with seeded data; the sample is at the current schema', () => {
  assert.ok(allFixtures.length >= 2, 'keep the frozen older fixtures');
  for (const [name, f] of allFixtures) {
    const v = validateBackup(f);
    assert.equal(v.ok, true, `${name}: ${v.errors.join('; ')}`);
    assert.equal(f.stores.weighins.length, 280, name);
    assert.ok(f.stores.meta.find((m) => m.key === 'settings'), name);
  }
  assert.equal(fixture.schema_version, DB_VERSION, 'run npm run fixture after adding a migration');
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence']) assert.ok(fixture.stores[store].length > 0, store);
});

test('fresh DB: all migrations run, every fixture imports and every record survives', async () => {
  for (const [name, f] of allFixtures) {
    const db = await openDB({ idb: new IDBFactory() });
    assert.equal(db.version, DB_VERSION);
    const migrated = migrateBackup(f);
    assert.equal(migrated.schema_version, DB_VERSION, name);
    await applyImport(db, migrated, 'replace');
    await assertAllRecordsSurvive(db, migrated);
    const roundTrip = await buildBackup(db, { appVersion: 'test' });
    for (const [store, records] of Object.entries(migrated.stores)) assert.deepEqual(roundTrip.stores[store], records, `${name}/${store}`);
    db.close();
  }
});

test('a stage-1 phone (v1 database) upgrades in place and keeps everything', async () => {
  const v1 = load('backup-v1.json');
  const idb = new IDBFactory();
  const old = await openDB({ idb, migrations: MIGRATIONS.slice(0, 1) });
  await writeAtomic(old, { writes: v1.stores });
  old.close();
  const db = await openDB({ idb });
  assert.equal(db.version, DB_VERSION);
  await assertAllRecordsSurvive(db, v1);
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence']) assert.ok(storeNames(db).includes(store), store);
  db.close();
});

test('upgrade from every older schema keeps every record', async () => {
  for (let i = 0; i < MIGRATIONS.length; i += 1) {
    const idb = new IDBFactory();
    const old = await openDB({ idb, migrations: MIGRATIONS.slice(0, i + 1) });
    const known = new Set(storeNames(old));
    const writes = Object.fromEntries(Object.entries(fixture.stores).filter(([k]) => known.has(k)));
    await writeAtomic(old, { writes });
    old.close();
    const db = await openDB({ idb });
    assert.equal(db.version, DB_VERSION);
    await assertAllRecordsSurvive(db, { stores: writes });
    db.close();
  }
});

test('rollback: older code opens a newer database and still reads it', async () => {
  const idb = new IDBFactory();
  const future = [...MIGRATIONS, {
    version: DB_VERSION + 1,
    description: 'hypothetical future store',
    up(db) { db.createObjectStore('future_things', { keyPath: 'id' }); },
    migrateRecord(store, r) { return store === 'weighins' ? { ...r, future_field: true } : r; },
  }];
  const newer = await openDB({ idb, migrations: future });
  await writeAtomic(newer, { writes: { ...fixture.stores, future_things: [{ id: 'x' }] } });
  newer.close();

  const db = await openDB({ idb }); // today's code
  assert.equal(db.version, DB_VERSION + 1);
  await assertAllRecordsSurvive(db, fixture);
  const backup = await buildBackup(db, { appVersion: 'old' });
  assert.equal(backup.stores.weighins.length, fixture.stores.weighins.length);
  db.close();
});

test('import of a newer backup skips unknown stores with a warning', async () => {
  const db = await openDB({ idb: new IDBFactory() });
  const newerBackup = { ...fixture, schema_version: DB_VERSION + 1, stores: { ...fixture.stores, future_things: [{ id: 'x' }] } };
  const v = validateBackup(newerBackup);
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 1);
  const preview = await previewImport(db, newerBackup);
  assert.equal(preview.find((r) => r.store === 'future_things').unknown, true);
  await applyImport(db, newerBackup, 'merge');
  await assertAllRecordsSurvive(db, fixture);
  db.close();
});

test('merge by id: newer record wins, local-only records are kept', async () => {
  const db = await openDB({ idb: new IDBFactory() });
  await applyImport(db, fixture, 'replace');
  const local = { id: 'w-local', local_date: '2026-10-10', weight_lb: 168, source: 'app', updated_utc: '2026-10-10T07:00:00.000Z' };
  const edited = { ...fixture.stores.weighins[0], weight_lb: 999, updated_utc: '2000-01-01T00:00:00.000Z' };
  await writeAtomic(db, { writes: { weighins: [local] } });
  const incoming = { ...fixture, stores: { weighins: [edited] } };
  const preview = await previewImport(db, incoming);
  assert.deepEqual(preview[0], { store: 'weighins', incoming: 1, added: 0, updated: 0, unchanged: 1, skipped: 0, existing: 281 });
  await applyImport(db, incoming, 'merge');
  const all = await getAll(db, 'weighins');
  assert.equal(all.length, 281);
  assert.equal(all.find((r) => r.id === edited.id).weight_lb, fixture.stores.weighins[0].weight_lb, 'older incoming record lost');
  db.close();
});

test('replace clears stores first', async () => {
  const db = await openDB({ idb: new IDBFactory() });
  await writeAtomic(db, { writes: { weighins: [{ id: 'stray', local_date: '2026-01-01', weight_lb: 1 }] } });
  await applyImport(db, fixture, 'replace');
  const all = await getAll(db, 'weighins');
  assert.equal(all.length, fixture.stores.weighins.length);
  assert.ok(!all.find((r) => r.id === 'stray'));
  db.close();
});

test('invalid files are rejected', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ app: 'other', schema_version: 1, stores: {} }).ok, false);
  assert.equal(validateBackup({ app: 'wmcoach', schema_version: 0, stores: {} }).ok, false);
  assert.equal(validateBackup({ app: 'wmcoach', schema_version: 1, stores: { weighins: {} } }).ok, false);
});

test('update snapshots: last 3 kept, never exported', async () => {
  const db = await openDB({ idb: new IDBFactory() });
  await applyImport(db, fixture, 'replace');
  for (let i = 0; i < 5; i += 1) {
    await saveSnapshot(db, { reason: 'update', appVersion: `0.0.${i}`, now: new Date(Date.UTC(2026, 9, 9, 8, i)) });
  }
  const snaps = await listSnapshots(db);
  assert.equal(snaps.length, SNAPSHOTS_KEPT);
  assert.deepEqual(snaps.map((s) => s.app_version), ['0.0.4', '0.0.3', '0.0.2']);
  assert.equal(snaps[0].backup.stores.weighins.length, 280);
  const backup = await buildBackup(db, { appVersion: 'x' });
  assert.equal(backup.stores.snapshots, undefined);
  db.close();
});
