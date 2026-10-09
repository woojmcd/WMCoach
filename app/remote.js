// What the daily routine publishes, brought onto the phone (spec §2: "remote files
// are pulled when online"): today's readiness + targets (data/targets/today.json),
// the published plans (data/plan/current.json, next.json), and whether today's
// Health file exists (the "Sync Health" chip, spec §12).
// It reads main through the GitHub API (no Pages delay), so it needs GitHub sync
// connected; without it the phone keeps working on its own (carried plans, on-device targets).
import { getAll, getMeta, setMeta, put } from './db.js';
import { live } from './records.js';
import { GitHub } from './sync.js';
import { weekDates } from '../coach/time.js';

const PULL_EVERY_MS = 5 * 60 * 1000;
const FILES = ['data/targets/today.json', 'data/plan/current.json', 'data/plan/next.json'];
export const SHORTCUT_URL = 'shortcuts://run-shortcut?name=WMCoach%20Health';

export async function remoteState(db) {
  return (await getMeta(db, 'remote')) || { shas: {}, targets: null, health: null, pulled_utc: null };
}

async function viaApi(cfg, today, prev, fetchImpl) {
  const gh = new GitHub(cfg, fetchImpl);
  const head = await gh.headSha();
  const tree = await gh.listTree(await gh.treeOf(head));
  const sha = Object.fromEntries(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const docs = {};
  for (const path of FILES) {
    if (!sha[path]) { docs[path] = null; continue; }
    if (prev.shas[path] === sha[path] && prev.docs && path in prev.docs) { docs[path] = prev.docs[path]; continue; }
    try { docs[path] = JSON.parse(await gh.blobText(sha[path])); } catch { docs[path] = null; }
  }
  return { docs, shas: Object.fromEntries(FILES.map((p) => [p, sha[p] || null])), healthToday: Boolean(sha[`data/health/${today}.json`]) };
}

// Published plans go into the phone's plans store (same record shape), replacing
// a seeded or carried plan for the same week; the newest routine plan wins.
async function adoptPlans(db, docs, nowUtc) {
  const mine = new Map(live(await getAll(db, 'plans')).map((p) => [p.id, p]));
  let changed = false;
  for (const path of ['data/plan/current.json', 'data/plan/next.json']) {
    const d = docs[path];
    if (!d || !d.week_start || !d.plan) continue;
    const cur = mine.get(d.week_start);
    if (cur && cur.source === 'routine' && (cur.generated_utc || '') >= (d.generated_utc || '')) continue;
    await put(db, 'plans', { ...d, id: d.week_start, source: 'routine', pulled_utc: nowUtc, updated_utc: d.generated_utc || nowUtc });
    changed = true;
  }
  return changed;
}

export async function pullRemote(ctx, { force = false, fetchImpl = (...a) => fetch(...a), now = new Date() } = {}) {
  const prev = await remoteState(ctx.db);
  const today = ctx.today();
  if (!force && prev.pulled_utc && now - new Date(prev.pulled_utc) < PULL_EVERY_MS && (prev.health || {}).date === today) return { status: 'fresh', changed: false };
  const cfg = await getMeta(ctx.db, 'github');
  if (!cfg || !cfg.token) return { status: 'off', changed: false };
  let got;
  try {
    got = await viaApi(cfg, today, prev, fetchImpl);
  } catch (err) {
    return { status: 'error', message: err.message, changed: false };
  }
  const targets = got.docs['data/targets/today.json'];
  const nowUtc = now.toISOString();
  const plansChanged = await adoptPlans(ctx.db, got.docs, nowUtc);
  const next = {
    pulled_utc: nowUtc,
    shas: got.shas,
    docs: got.docs,
    targets: targets && targets.local_date ? targets : null,
    health: { date: today, present: got.healthToday },
  };
  const changed = plansChanged || JSON.stringify(prev.targets) !== JSON.stringify(next.targets) || JSON.stringify(prev.health) !== JSON.stringify(next.health);
  await setMeta(ctx.db, 'remote', next);
  return { status: 'ok', changed };
}

// Today's routine targets (only if they are for today's local date).
export function todaysTargets(remote, today) {
  return remote && remote.targets && remote.targets.local_date === today ? remote.targets : null;
}

// The latest routine targets from this Mon–Sun week (today's or an earlier day's):
// their Strava cardio list still counts toward this week's cardio (spec §6.5).
export function weekTargets(remote, today) {
  const t = remote && remote.targets;
  if (!t || !t.local_date || t.local_date > today) return null;
  return t.local_date >= weekDates(today)[0] ? t : null;
}

// "Sync Health" chip: only when we know today's file is missing.
export function healthMissing(remote, today) {
  return Boolean(remote && remote.health && remote.health.date === today && remote.health.present === false);
}
