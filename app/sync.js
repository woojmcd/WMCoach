// GitHub sync (spec §2). The phone is the only writer of data/log/: local writes
// apply at once, and a background queue pushes them when there's signal, as one
// commit per sync (Git Data API, so a sync is atomic and needs no per-file SHAs).
// Each file is merged with what's already in the repo (newer record wins), so a
// wiped phone can never overwrite history it doesn't have.
// Works in the browser and in Node tests (fetch is injectable).
import { get, getAll, getMeta, setMeta, storeNames } from './db.js';
import { BACKUP_APP } from './backup.js';

export const LOG_DIR = 'data/log';
export const DEFAULT_REPO = { owner: 'woojmcd', repo: 'WMCoach', branch: 'main' };
const API = 'https://api.github.com';

// Stores mirrored under data/log/<store>/, split into monthly files by this field
// (null = one file, data/log/<store>.json). Seeded history (source "history") is
// rebuilt from the repo's seed files and isn't copied.
export const SYNC_STORES = {
  weighins: 'local_date',
  mode_changes: 'local_date',
  measurements: 'local_date',
  checkins: 'local_date',
  adherence: 'local_date',
  sessions: 'local_date',
  stairs: 'local_date',
  plans: 'week_start',
  phases: null,
  exercise_prefs: null,
  foods: null,
};
// Meta records mirrored as single files. The token and sync state never leave the phone.
export const SYNC_META = { settings: 'settings.json', onboarding: 'onboarding.json', push_subscription: 'push_subscription.json' };

export class SyncError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- files ----------------------------------------------------------------------------------

export function pathFor(store, record) {
  if (store === 'meta') return `${LOG_DIR}/${SYNC_META[record.key]}`;
  const field = SYNC_STORES[store];
  if (!field) return `${LOG_DIR}/${store}.json`;
  const v = record[field];
  return `${LOG_DIR}/${store}/${typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : 'undated'}.json`;
}

// FNV-1a over the JSON: cheap change detection per record.
export function hashOf(value) {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const syncable = (store, r) => r && r.source !== 'history' && (store !== 'meta' || r.key in SYNC_META);

// Every local record that belongs in data/log/, with its file and hash.
export async function collectLocal(db) {
  const known = new Set(storeNames(db));
  const items = [];
  for (const store of Object.keys(SYNC_STORES)) {
    if (!known.has(store)) continue;
    for (const r of await getAll(db, store)) {
      if (!syncable(store, r)) continue;
      items.push({ id: `${store}/${r.id}`, store, path: pathFor(store, r), record: r, hash: hashOf(r) });
    }
  }
  for (const key of Object.keys(SYNC_META)) {
    const r = await get(db, 'meta', key);
    if (r) items.push({ id: `meta/${key}`, store: 'meta', path: pathFor('meta', r), record: r, hash: hashOf(r) });
  }
  return items;
}

export async function syncState(db) {
  return (await getMeta(db, 'sync')) || { synced: {}, failures: 0 };
}

export function pendingItems(items, state) {
  const synced = (state && state.synced) || {};
  return items.filter((it) => synced[it.id] !== it.hash);
}

const sortKey = (store, r) => `${(SYNC_STORES[store] && r[SYNC_STORES[store]]) || r.start || ''}|${r.id}`;
const remoteWins = (remote, local) => Boolean(remote.updated_utc && local.updated_utc && remote.updated_utc > local.updated_utc);

// The file's new content: local records merged over the repo's copy, the newer
// record winning; records only in the repo are kept.
export function renderFile(path, localItems, remote, schemaVersion) {
  const store = localItems[0].store;
  if (store === 'meta') {
    const local = localItems[0].record;
    const rec = remote && remote.key && remoteWins(remote, local) ? { key: remote.key, value: remote.value, updated_utc: remote.updated_utc } : local;
    return `${JSON.stringify({ schema_version: schemaVersion, key: rec.key, updated_utc: rec.updated_utc || null, value: rec.value }, null, 2)}\n`;
  }
  const byId = new Map(((remote && remote.records) || []).map((r) => [r.id, r]));
  for (const it of localItems) {
    const cur = byId.get(it.record.id);
    if (!cur || !remoteWins(cur, it.record)) byId.set(it.record.id, it.record);
  }
  const records = [...byId.values()].sort((a, b) => (sortKey(store, a) < sortKey(store, b) ? -1 : 1));
  const partition = path.endsWith(`/${store}.json`) ? null : path.slice(path.lastIndexOf('/') + 1, -5);
  return `${JSON.stringify({ schema_version: schemaVersion, store, ...(partition ? { partition } : {}), records }, null, 2)}\n`;
}

// ---- GitHub API -----------------------------------------------------------------------------

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHub {
  constructor({ owner, repo, branch, token }, fetchImpl = globalThis.fetch) {
    Object.assign(this, { owner, repo, branch, token });
    // called unbound: window.fetch throws "Illegal invocation" with any other `this`
    this.fetch = (...args) => fetchImpl(...args);
  }

  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (err) {
      if (!(err instanceof TypeError) || /illegal invocation/i.test(err.message)) throw err;
      throw new SyncError('No connection to GitHub. It retries when there’s signal.', 'offline');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* not JSON */ }
    if (res.status === 401) throw new SyncError('GitHub rejected the token. Paste a new one in Settings → GitHub sync.', 'auth', 401);
    if (res.status === 403 && res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining') === '0') throw new SyncError('GitHub rate limit reached. It retries later.', 'rate', 403);
    if (res.status === 403) throw new SyncError('The token can’t write to this repo. It needs “Contents: Read and write” for WMCoach.', 'forbidden', 403);
    if (res.status === 404) throw new SyncError(`Not found: check the repo (${this.owner}/${this.repo}), the branch (${this.branch}), and that the token includes this repo.`, 'not_found', 404);
    if (res.status === 409 || res.status === 422) throw new SyncError(detail || 'The repo changed meanwhile.', 'conflict', res.status);
    throw new SyncError(`GitHub error ${res.status}${detail ? `: ${detail}` : ''}. It retries automatically.`, 'server', res.status);
  }

  async repoInfo() { return this.call('GET', ''); }

  async headSha() { return (await this.call('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`)).object.sha; }

  async treeOf(commitSha) { return (await this.call('GET', `/git/commits/${commitSha}`)).tree.sha; }

  async listTree(ref) {
    const r = await this.call('GET', `/git/trees/${ref}?recursive=1`);
    return r.tree || [];
  }

  async blobText(sha) { return b64decode((await this.call('GET', `/git/blobs/${sha}`)).content); }

  async commitFiles({ files, message, parent, baseTree }) {
    const tree = await this.call('POST', '/git/trees', { base_tree: baseTree, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
    const commit = await this.call('POST', '/git/commits', { message, tree: tree.sha, parents: [parent] });
    await this.call('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }
}

// ---- push -----------------------------------------------------------------------------------

const RETRY_BASE_S = 15;
const RETRY_MAX_S = 30 * 60;
export const retryDelayS = (failures) => Math.min(RETRY_MAX_S, RETRY_BASE_S * 2 ** Math.max(0, failures - 1));
// Errors that won't fix themselves: wait for Settings (or a manual sync) instead of retrying.
export const NEEDS_USER = new Set(['auth', 'forbidden', 'not_found']);

// One sync: push every pending record, one commit. Returns { status, pushed, files, commit }.
export async function syncNow(db, { fetchImpl = globalThis.fetch, now = new Date(), tz = 'UTC', localDate = null } = {}) {
  const cfg = await getMeta(db, 'github');
  if (!cfg || !cfg.token) return { status: 'off', pushed: 0 };
  const state = await syncState(db);
  const items = await collectLocal(db);
  const pending = pendingItems(items, state);
  const attemptUtc = now.toISOString();
  if (!pending.length) {
    await setMeta(db, 'sync', { ...state, last_ok_utc: attemptUtc, failures: 0, last_error: null, next_retry_utc: null });
    return { status: 'ok', pushed: 0, files: 0, commit: null };
  }
  const gh = new GitHub(cfg, fetchImpl);
  const paths = [...new Set(pending.map((p) => p.path))].sort();
  let commit = null;
  let files = [];
  try {
    for (let attempt = 1; ; attempt += 1) {
      const head = await gh.headSha();
      const baseTree = await gh.treeOf(head);
      // one listing tells which files exist; only those are read (no 404s)
      const blobs = new Map((await gh.listTree(baseTree)).filter((e) => e.type === 'blob' && e.path.startsWith(`${LOG_DIR}/`)).map((e) => [e.path, e.sha]));
      files = [];
      for (const path of paths) {
        const text = blobs.has(path) ? await gh.blobText(blobs.get(path)) : null;
        let remote = null;
        try { remote = text ? JSON.parse(text) : null; } catch { remote = null; }
        const content = renderFile(path, items.filter((i) => i.path === path), remote, db.version);
        if (content !== text) files.push({ path, content });
      }
      if (!files.length) break; // the repo already has all of it
      const n = pending.length;
      const message = `log ${localDate || attemptUtc.slice(0, 10)} (${tz}): ${n} record${n === 1 ? '' : 's'}`;
      try {
        commit = await gh.commitFiles({ files, message, parent: head, baseTree });
        break;
      } catch (err) {
        // the routine pushed in between: rebuild on the new head (one writer per path, so no conflicts)
        if (err.code !== 'conflict' || attempt >= 3) throw err;
      }
    }
  } catch (err) {
    const failures = (state.failures || 0) + 1;
    const code = err.code || 'server';
    await setMeta(db, 'sync', {
      ...state,
      failures,
      last_attempt_utc: attemptUtc,
      last_error: { message: err.message, code, utc: attemptUtc },
      next_retry_utc: NEEDS_USER.has(code) ? null : new Date(now.getTime() + retryDelayS(failures) * 1000).toISOString(),
    });
    return { status: 'error', code, message: err.message, pushed: 0 };
  }
  // Re-read: anything written during the sync stays pending for the next one.
  const fresh = await syncState(db);
  const synced = { ...fresh.synced };
  for (const it of pending) synced[it.id] = it.hash;
  await setMeta(db, 'sync', {
    ...fresh,
    synced,
    failures: 0,
    last_error: null,
    next_retry_utc: null,
    last_attempt_utc: attemptUtc,
    last_ok_utc: attemptUtc,
    last_commit: commit || fresh.last_commit || null,
    last_pushed: pending.length,
  });
  return { status: 'ok', pushed: pending.length, files: files.length, commit };
}

// ---- restore --------------------------------------------------------------------------------

// Everything under data/log/ as a backup object (same shape as Export), so it
// goes through the same validation, migration and merge as Import.
export async function fetchRemoteLog(cfg, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const gh = new GitHub(cfg, fetchImpl);
  const head = await gh.headSha();
  const entries = (await gh.listTree(head)).filter((e) => e.type === 'blob' && e.path.startsWith(`${LOG_DIR}/`) && e.path.endsWith('.json'));
  const stores = {};
  let schema = 1;
  let files = 0;
  const queue = [...entries];
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift();
      let doc;
      try { doc = JSON.parse(await gh.blobText(e.sha)); } catch (err) { if (err instanceof SyncError) throw err; continue; }
      files += 1;
      schema = Math.max(schema, Number.isInteger(doc.schema_version) ? doc.schema_version : 1);
      if (doc.store && Array.isArray(doc.records)) stores[doc.store] = [...(stores[doc.store] || []), ...doc.records];
      else if (doc.key && SYNC_META[doc.key] && 'value' in doc) (stores.meta = stores.meta || []).push({ key: doc.key, value: doc.value, updated_utc: doc.updated_utc || null });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { app: BACKUP_APP, schema_version: schema, exported_at: now.toISOString(), source: `github:${cfg.owner}/${cfg.repo}@${head.slice(0, 7)}`, files, stores };
}

export function remoteCounts(backup) {
  const out = {};
  for (const [k, v] of Object.entries(backup.stores)) out[k] = v.length;
  return out;
}

// After a restore, what came from the repo is already synced.
export async function markSynced(db) {
  const items = await collectLocal(db);
  const state = await syncState(db);
  const synced = { ...state.synced };
  for (const it of items) synced[it.id] = it.hash;
  await setMeta(db, 'sync', { ...state, synced });
}

export async function saveConfig(db, cfg) {
  const prev = (await getMeta(db, 'github')) || {};
  const next = { ...DEFAULT_REPO, ...prev, ...cfg, updated_utc: new Date().toISOString() };
  await setMeta(db, 'github', next);
  // a new repo or branch starts from scratch: everything is pending again
  if (prev.owner !== next.owner || prev.repo !== next.repo || prev.branch !== next.branch) await setMeta(db, 'sync', { synced: {}, failures: 0 });
  else {
    const st = await syncState(db);
    await setMeta(db, 'sync', { ...st, failures: 0, last_error: null, next_retry_utc: null });
  }
  return next;
}

export async function disconnect(db) {
  const cfg = await getMeta(db, 'github');
  if (cfg) await setMeta(db, 'github', { ...cfg, token: null, disconnected_utc: new Date().toISOString() });
}

// Check a token before saving it: can it read the repo, and may it push?
export async function checkAccess(cfg, fetchImpl = globalThis.fetch) {
  const gh = new GitHub(cfg, fetchImpl);
  const info = await gh.repoInfo();
  await gh.headSha();
  return { fullName: info.full_name, private: Boolean(info.private), canPush: !info.permissions || info.permissions.push !== false };
}

