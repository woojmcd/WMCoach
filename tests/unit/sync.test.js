// GitHub sync (spec §2) and Restore from GitHub (spec §12a), against an
// in-memory GitHub and fake-indexeddb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, getAll, get, put, writeAtomic, setMeta, getMeta, onWrite } from '../../app/db.js';
import { buildBackup, applyImport } from '../../app/backup.js';
import {
  syncNow, collectLocal, pendingItems, syncState, fetchRemoteLog, markSynced, saveConfig, pathFor, retryDelayS, checkAccess,
} from '../../app/sync.js';
import { seedFromRemote } from '../../app/seed.js';
import { FakeGitHub } from '../fixtures/fake-github.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/backup-sample.json', import.meta.url), 'utf8'));
const weightCsv = readFileSync(new URL('../../data/weight_daily.csv', import.meta.url), 'utf8');
const profile = JSON.parse(readFileSync(new URL('../../data/metabolic_profile.json', import.meta.url), 'utf8'));
const TOKEN = 'github_pat_test';
const NOW = new Date('2026-10-16T15:00:00Z');

let n = 0;
async function phoneWith(stores = fixture.stores) {
  const db = await openDB({ name: `sync-${n += 1}`, idb: new IDBFactory() });
  await writeAtomic(db, { writes: stores });
  return db;
}
async function connected(gh, stores) {
  const db = await phoneWith(stores);
  await saveConfig(db, { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: TOKEN });
  return db;
}
const opts = (gh, extra = {}) => ({ fetchImpl: gh.fetch, now: NOW, tz: 'America/Los_Angeles', localDate: '2026-10-16', ...extra });
const logFiles = (gh) => Object.keys(gh.files()).filter((p) => p.startsWith('data/log/')).sort();
const synced = (db) => [...fixture.stores.weighins].filter((w) => w.source !== 'history');

test('not set up: nothing happens', async () => {
  const gh = new FakeGitHub();
  const db = await phoneWith();
  assert.deepEqual(await syncNow(db, opts(gh)), { status: 'off', pushed: 0 });
  assert.equal(gh.log.length, 0);
});

test('first sync: one commit with everything logged on the phone, split by store and month; never the token', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  const items = await collectLocal(db);
  assert.ok(items.every((i) => i.record.source !== 'history'), 'seeded history is rebuilt from the repo, not copied');
  const r = await syncNow(db, opts(gh));
  assert.equal(r.status, 'ok');
  assert.equal(r.pushed, items.length);
  assert.deepEqual(gh.commitMessages().slice(0, 2), [`log 2026-10-16 (America/Los_Angeles): ${items.length} records`, 'init']);
  const files = logFiles(gh);
  assert.ok(files.includes('data/log/settings.json'));
  assert.ok(files.includes('data/log/onboarding.json'));
  assert.ok(files.some((f) => /^data\/log\/weighins\/\d{4}-\d{2}\.json$/.test(f)));
  assert.ok(files.includes('data/log/phases.json'));
  assert.ok(files.includes('data/log/exercise_prefs.json'));
  for (const f of files) {
    const text = gh.files()[f];
    assert.ok(!text.includes(TOKEN), `${f} leaks the token`);
    assert.ok(!text.includes('"key": "sync"') && !text.includes('"key": "github"'), f);
  }
  const wFile = gh.json(pathFor('weighins', synced()[0]));
  assert.equal(wFile.store, 'weighins');
  assert.equal(wFile.schema_version, db.version);
  assert.ok(wFile.records.some((w) => w.id === synced()[0].id));
  assert.equal(gh.json('data/log/settings.json').value.tz_current, fixture.stores.meta.find((m) => m.key === 'settings').value.tz_current);
  // nothing pending afterwards, and a second sync is a no-op
  assert.equal(pendingItems(await collectLocal(db), await syncState(db)).length, 0);
  const before = gh.commitMessages().length;
  assert.equal((await syncNow(db, opts(gh))).pushed, 0);
  assert.equal(gh.commitMessages().length, before);
});

test('later syncs rewrite only the files that changed', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  await syncNow(db, opts(gh));
  const w = synced()[0];
  await put(db, 'weighins', { ...w, weight_lb: 170.2, updated_utc: '2026-10-16T14:00:00.000Z' });
  await put(db, 'weighins', { id: 'w-new', local_date: '2026-10-16', utc: '2026-10-16T14:05:00.000Z', tz: 'America/Los_Angeles', weight_lb: 166.4, source: 'app', updated_utc: '2026-10-16T14:05:00.000Z' });
  assert.equal(pendingItems(await collectLocal(db), await syncState(db)).length, 2);
  const before = { ...gh.files() };
  const r = await syncNow(db, opts(gh));
  assert.equal(r.pushed, 2);
  const changed = Object.keys(gh.files()).filter((p) => gh.files()[p] !== before[p]);
  assert.deepEqual(changed.sort(), [...new Set([pathFor('weighins', w), 'data/log/weighins/2026-10.json'])].sort());
  const oct = gh.json('data/log/weighins/2026-10.json').records;
  assert.ok(oct.find((x) => x.id === 'w-new'));
  assert.equal(gh.json(pathFor('weighins', w)).records.find((x) => x.id === w.id).weight_lb, 170.2);
});

test('a wiped phone never overwrites history it doesn’t have', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  await syncNow(db, opts(gh));
  const w = synced()[0];
  const path = pathFor('weighins', w);
  const remoteBefore = gh.json(path).records.length;
  // a fresh phone with just one new weigh-in in the same month
  const fresh = await connected(gh, { weighins: [{ ...w, id: 'w-fresh', weight_lb: 160, updated_utc: NOW.toISOString() }] });
  await syncNow(fresh, opts(gh));
  const after = gh.json(path).records;
  assert.equal(after.length, remoteBefore + 1);
  assert.ok(after.find((x) => x.id === w.id), 'the old record is still there');
});

test('a tombstone syncs, so a deleted entry stays deleted', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  await syncNow(db, opts(gh));
  const w = synced()[0];
  await put(db, 'weighins', { ...w, deleted: true, deleted_utc: NOW.toISOString(), updated_utc: NOW.toISOString() });
  await syncNow(db, opts(gh));
  assert.equal(gh.json(pathFor('weighins', w)).records.find((x) => x.id === w.id).deleted, true);
});

test('the routine pushing at the same time: rebuild on the new head, keep its commit', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  gh.beforeUpdateRef = () => gh.externalCommit('data/targets/today.json', '{"date":"2026-10-16"}\n', 'daily 2026-10-16 (America/Los_Angeles)');
  const r = await syncNow(db, opts(gh));
  assert.equal(r.status, 'ok');
  assert.equal(gh.files()['data/targets/today.json'], '{"date":"2026-10-16"}\n');
  assert.ok(gh.files()['data/log/settings.json']);
  assert.deepEqual(gh.commitMessages().slice(1, 3), ['daily 2026-10-16 (America/Los_Angeles)', 'init']);
});

test('failures: offline retries with backoff; a bad token waits for Settings; recovery clears it', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  gh.offline = true;
  let r = await syncNow(db, opts(gh));
  assert.equal(r.code, 'offline');
  let st = await syncState(db);
  assert.equal(st.failures, 1);
  assert.equal(st.next_retry_utc, new Date(NOW.getTime() + 15000).toISOString());
  r = await syncNow(db, opts(gh));
  st = await syncState(db);
  assert.equal(st.failures, 2);
  assert.equal(st.next_retry_utc, new Date(NOW.getTime() + 30000).toISOString());
  assert.equal(retryDelayS(20), 1800, 'capped at 30 min');
  gh.offline = false;
  await saveConfig(db, { token: 'wrong' });
  r = await syncNow(db, opts(gh));
  assert.equal(r.code, 'auth');
  st = await syncState(db);
  assert.equal(st.next_retry_utc, null, 'no automatic retry with a bad token');
  assert.match(st.last_error.message, /rejected the token/);
  await saveConfig(db, { token: TOKEN });
  r = await syncNow(db, opts(gh));
  assert.equal(r.status, 'ok');
  st = await syncState(db);
  assert.equal(st.failures, 0);
  assert.equal(st.last_error, null);
  assert.ok(st.pending === undefined);
});

test('checkAccess: a good token reads the repo; a missing repo says so', async () => {
  const gh = new FakeGitHub();
  assert.deepEqual(await checkAccess({ owner: 'woojmcd', repo: 'WMCoach', branch: 'main', token: TOKEN }, gh.fetch), { fullName: 'woojmcd/WMCoach', private: false, canPush: true });
  await assert.rejects(checkAccess({ owner: 'woojmcd', repo: 'Nope', branch: 'main', token: TOKEN }, gh.fetch), /Not found/);
  await assert.rejects(checkAccess({ owner: 'woojmcd', repo: 'WMCoach', branch: 'main', token: 'bad' }, gh.fetch), /rejected the token/);
});

test('Restore from GitHub on an empty phone: history re-seeded, everything logged comes back, nothing pending', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  await syncNow(db, opts(gh));
  const remote = await fetchRemoteLog({ owner: gh.owner, repo: gh.repo, branch: gh.branch, token: TOKEN }, { fetchImpl: gh.fetch, now: NOW });
  assert.equal(remote.app, 'wmcoach');
  assert.equal(remote.files, logFiles(gh).length);
  const empty = await openDB({ name: `sync-${n += 1}`, idb: new IDBFactory() });
  const r = await seedFromRemote(empty, { weightCsv, profile, remote, now: NOW, tz: 'America/Los_Angeles', appVersion: 'test' });
  assert.ok(r.historyCount > 200);
  for (const store of ['weighins', 'phases', 'mode_changes', 'measurements', 'checkins', 'adherence', 'sessions', 'stairs', 'exercise_prefs', 'plans', 'foods']) {
    const want = fixture.stores[store] || [];
    const have = new Map((await getAll(empty, store)).map((x) => [x.id, x]));
    for (const rec of want) {
      assert.ok(have.has(rec.id), `${store}/${rec.id} missing after restore`);
      if (rec.source !== 'history') assert.deepEqual(have.get(rec.id), rec, `${store}/${rec.id} changed`);
    }
  }
  const settings = await getMeta(empty, 'settings');
  assert.deepEqual(settings, fixture.stores.meta.find((m) => m.key === 'settings').value);
  assert.ok(await getMeta(empty, 'onboarding'));
  assert.ok(await getMeta(empty, 'model'));
  await saveConfig(empty, { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: TOKEN });
  await markSynced(empty);
  assert.equal(pendingItems(await collectLocal(empty), await syncState(empty)).length, 0);
});

test('the token never leaves the phone: not exported, and a replace import keeps it', async () => {
  const gh = new FakeGitHub();
  const db = await connected(gh);
  await syncNow(db, opts(gh));
  const backup = await buildBackup(db, { appVersion: 'test' });
  assert.ok(!JSON.stringify(backup).includes(TOKEN));
  assert.ok(!backup.stores.meta.some((m) => m.key === 'github' || m.key === 'sync'));
  await applyImport(db, { ...backup, stores: { ...backup.stores, meta: [...backup.stores.meta, { key: 'github', value: { token: 'evil' } }] } }, 'replace');
  assert.equal((await getMeta(db, 'github')).token, TOKEN);
  assert.ok((await getMeta(db, 'sync')).synced);
});

test('every write is announced to the sync queue', async () => {
  const db = await phoneWith({});
  const seen = [];
  const off = onWrite((changes) => seen.push(...changes.map((c) => c.store)));
  await put(db, 'weighins', { id: 'w1', local_date: '2026-10-16', weight_lb: 165 });
  await setMeta(db, 'settings', { units: 'lb' });
  await writeAtomic(db, { writes: { checkins: [{ id: 'c1', local_date: '2026-10-16' }] } });
  off();
  await put(db, 'weighins', { id: 'w2', local_date: '2026-10-16', weight_lb: 165 });
  assert.deepEqual(seen, ['weighins', 'meta', 'checkins']);
  assert.ok(await get(db, 'weighins', 'w2'));
});
