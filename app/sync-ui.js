// GitHub sync on the phone: the background queue (debounced after every write,
// on launch, when signal returns), the small "Unsynced (n)" badge in each
// header, the Settings section, and Restore from GitHub (spec §2, §12a).
import { h, icon, toast, openSheet, confirmSheet, itemRow, fmtInt } from './ui.js';
import { getMeta, getAll, onWrite } from './db.js';
import { validateBackup, migrateBackup } from './backup.js';
import { importBackupSheet } from './import-flow.js';
import { fetchSeedFiles, seedFromRemote } from './seed.js';
import {
  syncNow, collectLocal, pendingItems, syncState, fetchRemoteLog, markSynced, saveConfig, disconnect, checkAccess,
  DEFAULT_REPO, SYNC_META, SYNC_STORES, NEEDS_USER, retryDelayS, GitHub, LOG_DIR,
} from './sync.js';
import { localDate, formatDayMonth, localParts } from '../coach/time.js';
import { pullRemote, remoteState, healthMissing } from './remote.js';

export const TOKEN_GUIDE = 'https://github.com/woojmcd/WMCoach/blob/main/docs/github-sync.md';

const badge = h('a', { class: 'sync-badge', href: '#/settings', hidden: true });
const SETTLE_MS = 8000;
const loop = { ctx: null, timer: null, running: null, again: false, syncing: false, badgeTimer: null };

// The badge lives in the header's label line on every tab.
export function syncBadge() {
  return badge;
}

export async function syncStatus(db) {
  const cfg = await getMeta(db, 'github');
  const state = await syncState(db);
  const items = await collectLocal(db);
  const pending = pendingItems(items, state).length;
  return { configured: Boolean(cfg && cfg.token), cfg, state, pending, total: items.length };
}

async function refreshBadge() {
  if (!loop.ctx) return;
  const st = await syncStatus(loop.ctx.db);
  const paused = st.state.last_error && NEEDS_USER.has(st.state.last_error.code);
  badge.hidden = !st.configured || (!st.pending && !paused);
  badge.classList.toggle('paused', Boolean(paused));
  badge.textContent = paused ? 'Sync paused' : loop.syncing ? `Syncing (${st.pending})` : `Unsynced (${st.pending})`;
  badge.setAttribute('aria-label', paused ? 'Sync paused: open Settings' : `${st.pending} changes not on GitHub yet`);
}

function badgeSoon() {
  clearTimeout(loop.badgeTimer);
  loop.badgeTimer = setTimeout(refreshBadge, 250);
}

function schedule(ms) {
  clearTimeout(loop.timer);
  loop.timer = setTimeout(() => { runSync(); }, ms);
}

const relevant = (c) => (c.store === 'meta' ? Boolean(c.record && c.record.key in SYNC_META) : c.store in SYNC_STORES);

export function startSync(ctx) {
  loop.ctx = ctx;
  onWrite((changes) => {
    if (!changes.some(relevant)) return;
    badgeSoon();
    schedule(SETTLE_MS); // a weigh-in and an on-plan tap a few seconds apart → one commit
  });
  window.addEventListener('online', () => { schedule(500); refreshRemote(); });
  // back in the app: catch up; leaving it: push now, before iOS suspends the app
  document.addEventListener('visibilitychange', async () => {
    schedule(document.visibilityState === 'visible' ? 1000 : 0);
    if (document.visibilityState !== 'visible') return;
    // back from the Health Shortcut: look again right away
    refreshRemote(healthMissing(await remoteState(ctx.db), ctx.today()));
  });
  refreshBadge();
  schedule(1500);
  setTimeout(() => refreshRemote(), 2000);
}

// Pull what the routine published (plans, today's targets, Health present?) and redraw if it changed.
export async function refreshRemote(force = false) {
  if (!loop.ctx || navigator.onLine === false) return null;
  const r = await pullRemote(loop.ctx, { force });
  if (r.changed) loop.ctx.refresh();
  return r;
}

// manual: Settings → Sync now (ignores backoff and a paused state).
export async function runSync({ manual = false } = {}) {
  const ctx = loop.ctx;
  if (!ctx) return { status: 'off' };
  if (loop.running) { loop.again = true; return loop.running; }
  loop.running = (async () => {
    const cfg = await getMeta(ctx.db, 'github');
    if (!cfg || !cfg.token) return { status: 'off' };
    const st = await syncState(ctx.db);
    if (!manual) {
      if (st.last_error && NEEDS_USER.has(st.last_error.code)) return { status: 'paused' };
      // A workout syncs once, when it's finished: one commit instead of one per set
      // (also keeps GitHub Pages under its ~10 builds/hour once it serves main).
      if ((await getAll(ctx.db, 'sessions')).some((x) => x.status === 'in_progress' && !x.deleted)) return { status: 'held' };
      const wait = st.next_retry_utc ? Date.parse(st.next_retry_utc) - Date.now() : 0;
      if (wait > 0) { schedule(wait + 250); return { status: 'waiting' }; }
      if (navigator.onLine === false) return { status: 'offline' };
    }
    loop.syncing = true;
    badgeSoon();
    const now = new Date();
    const r = await syncNow(ctx.db, { now, tz: ctx.tz(), localDate: ctx.today() });
    loop.syncing = false;
    if (r.status === 'error' && !NEEDS_USER.has(r.code)) {
      const failures = (await syncState(ctx.db)).failures || 1;
      schedule(retryDelayS(failures) * 1000 + 250);
    }
    return r;
  })();
  try {
    return await loop.running;
  } finally {
    loop.running = null;
    loop.syncing = false;
    refreshBadge();
    if (loop.again) { loop.again = false; schedule(1000); }
  }
}

// ---- Settings → GitHub sync -----------------------------------------------------------------

function whenText(utc, ctx) {
  if (!utc) return 'Never';
  const d = new Date(utc);
  const date = localDate(d, ctx.tz());
  const p = localParts(d, ctx.tz());
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return date === ctx.today() ? `Today ${time}` : `${formatDayMonth(date)} ${time}`;
}

export async function syncSection(ctx) {
  const st = await syncStatus(ctx.db);
  if (!st.configured) {
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'card stack-sm' },
        h('p', { class: 'body', style: 'margin:0' }, 'Off. Everything you log lives only on this phone and in your backups.'),
        h('p', { class: 'muted small', style: 'margin:0' }, `Connect to copy it to the WMCoach repo after every change, for the daily coach run and as a second backup. ${fmtInt(st.total)} records are waiting.`)),
      h('button', { type: 'button', class: 'btn primary block', onClick: () => connectSheet(ctx) }, icon('cloud', { size: 20 }), 'Connect GitHub'));
  }
  const err = st.state.last_error;
  const statusText = err ? err.message : st.pending ? `${fmtInt(st.pending)} change${st.pending === 1 ? '' : 's'} waiting` : 'Up to date';
  const syncBtn = h('button', { type: 'button', class: 'btn primary block' }, icon('refresh', { size: 20 }), 'Sync now');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    const r = await runSync({ manual: true });
    await refreshRemote(true);
    if (r.status === 'ok') toast(r.pushed ? `Synced ${fmtInt(r.pushed)} change${r.pushed === 1 ? '' : 's'}` : 'Already up to date');
    else if (r.status === 'error') toast(r.message, 5000);
    ctx.refresh();
  });
  return h('div', { class: 'stack-sm' },
    h('div', { class: 'card flush list' },
      itemRow({ label: 'Repository', value: `${st.cfg.owner}/${st.cfg.repo} · ${st.cfg.branch}` }),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Status'), h('span', { class: `value${err ? ' sync-error' : ''}`, style: 'white-space:normal' }, statusText)),
      itemRow({ label: 'Last sync', value: whenText(st.state.last_ok_utc, ctx) })),
    syncBtn,
    h('button', { type: 'button', class: 'btn outline block', onClick: () => restoreSheet(ctx) }, icon('upload', { size: 20 }), 'Restore from GitHub'),
    h('div', { class: 'row-buttons' },
      h('button', { type: 'button', class: 'btn ghost', onClick: () => connectSheet(ctx, { cfg: st.cfg }) }, 'Change token'),
      h('button', {
        type: 'button', class: 'btn ghost',
        onClick: async () => {
          const ok = await confirmSheet({ title: 'Disconnect GitHub?', message: 'The token is removed from this phone. Nothing is deleted, here or in the repo.', confirm: 'Disconnect', kind: 'danger' });
          if (!ok) return;
          await disconnect(ctx.db);
          toast('GitHub disconnected');
          refreshBadge();
          ctx.refresh();
        },
      }, 'Disconnect')),
    h('p', { class: 'muted xsmall', style: 'margin:4px 0 0' }, 'Syncs a few seconds after each change (a workout once you finish it) and retries on its own when there’s no signal. The repo is public: your log is readable there; the token never leaves this phone.'));
}

function tokenFields(cfg = {}) {
  const token = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'github_pat_…', 'aria-label': 'GitHub token' });
  const repo = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: `${cfg.owner || DEFAULT_REPO.owner}/${cfg.repo || DEFAULT_REPO.repo}`, 'aria-label': 'Repository' });
  const branch = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: cfg.branch || DEFAULT_REPO.branch, 'aria-label': 'Branch' });
  const errorEl = h('p', { class: 'small sync-error', role: 'alert', style: 'margin:0', hidden: true });
  const body = h('div', { class: 'stack-sm' },
    h('p', { class: 'muted small', style: 'margin:0' }, 'A fine-grained token for this repo only, with Contents: Read and write. ', h('a', { href: TOKEN_GUIDE, target: '_blank', rel: 'noopener' }, 'How to make one')),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Token'), token),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repository'), repo),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Branch'), branch),
    errorEl);
  const read = () => {
    const [owner, name] = repo.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').split('/');
    return { owner, repo: name, branch: branch.value.trim() || 'main', token: token.value.trim() };
  };
  const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
  return { body, read, fail, focus: () => token.focus() };
}

async function remoteFileCount(cfg) {
  const gh = new GitHub(cfg);
  const head = await gh.headSha();
  return (await gh.listTree(head)).filter((e) => e.type === 'blob' && e.path.startsWith(`${LOG_DIR}/`)).length;
}

export function connectSheet(ctx, { cfg = null } = {}) {
  const f = tokenFields(cfg || {});
  openSheet({
    title: cfg ? 'Change token' : 'Connect GitHub',
    body: f.body,
    actions: [
      {
        label: 'Connect',
        kind: 'primary',
        onClick: async () => {
          const next = f.read();
          if (!next.token) { f.fail('Paste the token first.'); return true; }
          if (!next.owner || !next.repo) { f.fail('Repository should look like owner/name.'); return true; }
          try {
            await checkAccess(next);
          } catch (err) {
            f.fail(err.message);
            return true;
          }
          const firstTime = !Object.keys((await syncState(ctx.db)).synced || {}).length;
          await saveConfig(ctx.db, next);
          let remoteFiles = 0;
          try { remoteFiles = firstTime ? await remoteFileCount(next) : 0; } catch { /* offer nothing */ }
          if (remoteFiles) {
            const restore = await confirmSheet({
              title: 'The repo already has a log',
              message: `${fmtInt(remoteFiles)} files in data/log/. Bring them onto this phone first? Nothing here is overwritten by older entries.`,
              confirm: 'Restore and merge', cancel: 'Not now',
            });
            if (restore) { await restoreSheet(ctx); return false; }
          }
          toast('GitHub connected: syncing');
          runSync({ manual: true }).then(() => ctx.refresh());
          ctx.refresh();
          return false;
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
  setTimeout(f.focus, 300);
}

// Settings: merge data/log/ into this phone (newer record wins; never Replace,
// because the repo doesn't hold the seeded history).
export async function restoreSheet(ctx) {
  const cfg = await getMeta(ctx.db, 'github');
  toast('Reading data/log/ from GitHub…', 30000);
  let remote;
  try {
    remote = await fetchRemoteLog(cfg);
  } catch (err) {
    toast(err.message, 5000);
    return;
  }
  if (!remote.files) { toast('Nothing in data/log/ yet: sync first'); return; }
  const v = validateBackup(remote);
  if (!v.ok) { toast(`Can’t read the repo’s log: ${v.errors.join(' ')}`, 5000); return; }
  toast(`Found ${fmtInt(remote.files)} files`, 1500);
  await importBackupSheet(ctx, { kind: 'backup', backup: migrateBackup(remote), warnings: v.warnings, name: `GitHub ${cfg.owner}/${cfg.repo}` }, {
    mergeOnly: true,
    title: 'Restore from GitHub',
    onDone: async () => { await markSynced(ctx.db); await ctx.reload(); runSync(); },
  });
}

// First launch: rebuild the phone from the repo (seed history + data/log/).
export function onboardingRestoreSheet(ctx, { onDone }) {
  const f = tokenFields();
  openSheet({
    title: 'Restore from GitHub',
    subtitle: 'Rebuilds this phone from data/log/ in the repo, on top of your seeded history.',
    body: f.body,
    actions: [
      {
        label: 'Restore',
        kind: 'primary',
        onClick: async () => {
          const cfg = f.read();
          if (!cfg.token) { f.fail('Paste the token first.'); return true; }
          let remote;
          try {
            await checkAccess(cfg);
            remote = await fetchRemoteLog(cfg);
          } catch (err) {
            f.fail(err.message);
            return true;
          }
          if (!remote.files) { f.fail('There’s nothing in data/log/ yet. Set up as new instead.'); return true; }
          const v = validateBackup(remote);
          if (!v.ok) { f.fail(v.errors.join(' ')); return true; }
          const seed = await fetchSeedFiles();
          const tz = ctx.tz();
          const r = await seedFromRemote(ctx.db, { ...seed, remote: migrateBackup(remote), now: new Date(), tz, appVersion: ctx.version });
          await saveConfig(ctx.db, cfg);
          await markSynced(ctx.db);
          const n = Object.entries(r.counts).filter(([k]) => k !== 'meta').reduce((a, [, c]) => a + c, 0);
          toast(`Restored ${fmtInt(n)} records from GitHub`);
          onDone();
          return false;
        },
      },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
  setTimeout(f.focus, 300);
}
