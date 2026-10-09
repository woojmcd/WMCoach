// First-launch seeding (spec §2a): the app never starts blank.
import { parseWeightCsv, historyWeighins, historyPhases, firstLaunchPhases, defaultSettings } from '../coach/seed.js';
import { seedModelState } from '../coach/model.js';
import { stamp } from '../coach/time.js';
import { writeAtomic, storeNames } from './db.js';

export async function fetchSeedFiles(base = './') {
  const get = async (path) => {
    const res = await fetch(base + path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  };
  const [csv, profile] = await Promise.all([
    get('data/weight_daily.csv').then((r) => r.text()),
    get('data/metabolic_profile.json').then((r) => r.json()),
  ]);
  return { weightCsv: csv, profile };
}

export function newId(prefix) {
  const rand = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

// answers: { weight_lb, height_in, lifted_less }
export async function seedFirstLaunch(db, { weightCsv, profile, answers, now = new Date(), tz, appVersion, makeId = newId }) {
  const at = stamp(now, tz);
  const history = historyWeighins(parseWeightCsv(weightCsv));
  const phases = [...historyPhases(profile), ...firstLaunchPhases(profile, at.local_date)];
  const weighins = history.map((w) => ({ ...w, updated_utc: at.utc }));
  if (Number.isFinite(answers.weight_lb)) {
    weighins.push({ id: makeId('w'), ...at, weight_lb: answers.weight_lb, source: 'app', updated_utc: at.utc });
  }
  const settings = defaultSettings({ now, tz, heightIn: answers.height_in ?? null, liftedLess: answers.lifted_less ?? null });
  const model = seedModelState(profile, { weighins, phases, generatedUtc: at.utc });
  // Weeks 1–2 of the bulk are observe-only (spec §2a): no macro change until
  // ≥ 10 new weigh-ins and 2 full weeks have passed.
  model.observe_only = { since: at.local_date, min_new_weighins: 10, min_days: 14 };
  const meta = (key, value) => ({ key, value, updated_utc: at.utc });
  await writeAtomic(db, {
    writes: {
      weighins,
      phases: phases.map((p) => ({ ...p, updated_utc: at.utc })),
      meta: [
        meta('settings', settings),
        meta('model', model),
        meta('onboarding', {
          completed_utc: at.utc,
          completed_local_date: at.local_date,
          tz,
          app_version: appVersion,
          history_weighins: history.length,
        }),
      ],
    },
  });
  return { historyCount: history.length, phases: phases.length, settings, model };
}

// Restore from GitHub on an empty phone (spec §12a): the seeded history comes
// from the repo's seed files, everything logged on the phone from data/log/.
// `remote` is the backup-shaped object from fetchRemoteLog().
export async function seedFromRemote(db, { weightCsv, profile, remote, now = new Date(), tz, appVersion }) {
  const at = stamp(now, tz);
  const known = new Set(storeNames(db));
  const history = historyWeighins(parseWeightCsv(weightCsv)).map((w) => ({ ...w, updated_utc: at.utc }));
  const histPhases = historyPhases(profile).map((p) => ({ ...p, updated_utc: at.utc }));
  const writes = { weighins: [...history], phases: [...histPhases] };
  for (const [store, records] of Object.entries(remote.stores)) {
    if (store === 'meta' || !known.has(store)) continue;
    writes[store] = [...(writes[store] || []), ...records.filter((r) => r && r.id)];
  }
  const remoteMeta = Object.fromEntries((remote.stores.meta || []).map((r) => [r.key, r]));
  const settings = remoteMeta.settings ? remoteMeta.settings.value : defaultSettings({ now, tz });
  const onboarding = remoteMeta.onboarding ? remoteMeta.onboarding.value : { completed_utc: at.utc, completed_local_date: at.local_date, tz, app_version: appVersion };
  const liveWeighins = writes.weighins.filter((w) => !w.deleted);
  const livePhases = writes.phases.filter((p) => !p.deleted && !p.superseded);
  const model = seedModelState(profile, { weighins: liveWeighins, phases: livePhases, generatedUtc: at.utc });
  model.observe_only = { since: onboarding.completed_local_date || at.local_date, min_new_weighins: 10, min_days: 14 };
  const meta = (key, value, updated) => ({ key, value, updated_utc: updated || at.utc });
  writes.meta = [
    meta('settings', settings, remoteMeta.settings && remoteMeta.settings.updated_utc),
    meta('onboarding', { ...onboarding, restored_utc: at.utc, restored_from: remote.source || 'github' }, remoteMeta.onboarding && remoteMeta.onboarding.updated_utc),
    meta('model', model),
    ...(remoteMeta.push_subscription ? [meta('push_subscription', remoteMeta.push_subscription.value, remoteMeta.push_subscription.updated_utc)] : []),
  ];
  await writeAtomic(db, { writes });
  const counts = Object.fromEntries(Object.entries(remote.stores).map(([k, v]) => [k, v.length]));
  return { historyCount: history.length, counts, settings };
}
