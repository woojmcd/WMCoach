// First-launch seeding (spec §2a): the app never starts blank.
import { parseWeightCsv, historyWeighins, historyPhases, firstLaunchPhases, defaultSettings } from '../coach/seed.js';
import { seedModelState } from '../coach/model.js';
import { stamp } from '../coach/time.js';
import { writeAtomic } from './db.js';

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
