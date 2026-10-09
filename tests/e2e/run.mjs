// End-to-end run at 375 × 812 in headless Chromium (spec §12a), with screenshots.
// Usage: npm run e2e        Screenshots: docs/screenshots/<stage>/
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../scripts/serve.mjs';
import { DB_VERSION } from '../../app/db.js';
import { FakeGitHub } from '../fixtures/fake-github.mjs';

const STAGE = process.env.E2E_STAGE || 'stage-5';
const OUT = new URL(`../../docs/screenshots/${STAGE}/`, import.meta.url).pathname;
const PORT = Number(process.env.E2E_PORT || 4173);
await mkdir(OUT, { recursive: true });
const tmp = await mkdtemp(join(tmpdir(), 'wmcoach-e2e-'));

const { server, state, url } = await startServer({ port: PORT });
const browser = await chromium.launch();
const errors = [];
const DEVICE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true };

function watch(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // GitHub API errors (a wrong token on purpose, offline) are expected and handled in the app
  page.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').startsWith('https://api.github.com/')) errors.push(`console: ${m.text()}`); });
}
// Each screenshot documents one stage; a run saves only the current stage's
// (E2E_STAGE), so older stages' PR screenshots stay as they were.
async function shot(page, name, { full = false, stage = 'stage-1' } = {}) {
  if (stage !== STAGE && stage !== 'all') return;
  if (!full) return page.screenshot({ path: `${OUT}${name}.png` });
  // A taller viewport (not fullPage) keeps the fixed tab bar at the bottom, as on the phone.
  const size = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await page.setViewportSize(size);
}
const step = (s) => console.log(`• ${s}`);
async function noHorizontalScroll(page, where) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(w[0] <= w[1], `${where}: horizontal scroll (${w[0]} > ${w[1]})`);
}
const countStore = (page, store) => page.evaluate((s) => new Promise((resolve, reject) => {
  const req = indexedDB.open('wmcoach');
  req.onsuccess = () => { const r = req.result.transaction(s).objectStore(s).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); };
  req.onerror = () => reject(req.error);
}), store);
const toastText = (page, text) => page.locator('.toast.show', { hasText: text }).waitFor({ timeout: 5000 });
// api.github.com, answered by an in-memory repo (tests/fixtures/fake-github.mjs).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };
async function routeGitHub(context, gh) {
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (gh.offline) return route.abort('internetdisconnected');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    try {
      const r = gh.handle({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postData() });
      return await route.fulfill({ status: r.status, contentType: 'application/json', headers: CORS, body: JSON.stringify(r.body) });
    } catch (err) {
      console.error('fake GitHub:', err);
      return route.abort('failed');
    }
  });
}
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function tab(page, name) {
  await page.locator('.tabbar a', { hasText: name }).click();
  await page.locator('.title').first().waitFor();
  await page.waitForTimeout(150);
}

try {
  const context = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  watch(page);

  step('browser tab shows install instructions');
  await page.goto(url);
  await page.getByText('Install on your iPhone').waitFor();
  await shot(page, '01-install');
  await page.getByText('Continue in Safari (testing only)').click();

  step('onboarding: weight, height, lifted-less → seeds history');
  await page.getByText('Set up').waitFor();
  await shot(page, '02-onboarding', { full: true });
  const start = page.getByRole('button', { name: 'Start', exact: true });
  assert.equal(await start.isDisabled(), true, 'Start enabled before answers');
  await page.getByLabel('Current weight', { exact: true }).fill('168.4');
  await page.getByLabel('Current weight', { exact: true }).press('Enter');
  await page.getByLabel('Height feet', { exact: true }).fill('5');
  await page.getByLabel('Height feet', { exact: true }).press('Tab');
  await page.getByLabel('Height inches', { exact: true }).fill('10');
  await page.getByLabel('Height inches', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await start.click();
  await toastText(page, 'Loaded 279 weigh-ins');
  assert.equal(await countStore(page, 'weighins'), 280);
  assert.equal(await countStore(page, 'phases'), 7);

  step('Week tab: strip in local time, today highlighted');
  await page.locator('.weekstrip').waitFor();
  assert.equal(await page.locator('.weekstrip button').count(), 7);
  assert.equal(await page.locator('.weekstrip button.today').count(), 1);
  await page.waitForTimeout(3000); // let the toast fade
  await shot(page, '03-week');
  await noHorizontalScroll(page, 'week');
  await page.locator('.day-row', { hasText: 'Push #1' }).click();
  await page.locator('.sheet.show').waitFor();
  await page.waitForTimeout(250);
  await shot(page, '04-day-preview');
  await page.locator('.sheet.show').getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(250);

  step('Log, Body, Meals, History tabs');
  await tab(page, 'Log');
  await shot(page, '05-log', { full: true });
  await noHorizontalScroll(page, 'log');
  await tab(page, 'Body');
  await page.locator('.hero', { hasText: '168.4' }).waitFor();
  await shot(page, '06-body');
  await tab(page, 'Meals');
  await shot(page, '07-meals');
  await tab(page, 'History');
  await page.getByText('Cut 2025').waitFor();
  await page.getByText('Holiday break').waitFor();
  await shot(page, '08-history', { full: true });

  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()));
  const dayBefore = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const readStore = (store) => page.evaluate((s) => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => { e.target.result.transaction(s).objectStore(s).getAll().onsuccess = (r) => resolve(r.target.result); };
  }), store);
  const S2 = { stage: 'stage-2' };

  step('Body: update today, backdate yesterday');
  await tab(page, 'Body');
  await page.getByRole('button', { name: 'Update', exact: true }).waitFor();
  await shot(page, 'b01-body', S2);
  await page.getByLabel('Increase Weight', { exact: true }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await toastText(page, 'Updated 168.6 lb · Today');
  let n = await countStore(page, 'weighins');
  await page.locator('input[type="date"]').fill(dayBefore(today, 1));
  await page.getByRole('button', { name: 'Log weight' }).waitFor();
  await page.getByLabel('Weight', { exact: true }).fill('168.0');
  await page.getByLabel('Weight', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Log weight' }).click();
  await toastText(page, 'Logged 168.0 lb · Yesterday');
  await page.locator('.date-chip', { hasText: 'Today' }).waitFor(); // back to today after a backdated entry
  assert.equal(await countStore(page, 'weighins'), n + 1);
  const yRec = (await readStore('weighins')).find((w) => w.local_date === dayBefore(today, 1) && w.source === 'app');
  assert.equal(yRec.backdated, true);
  assert.equal(yRec.tz, 'America/Los_Angeles');

  // Three weeks of morning weigh-ins (test data in this browser only) so the rate badge has data.
  await page.evaluate(({ days }) => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      const tx = e.target.result.transaction('weighins', 'readwrite');
      days.forEach((d, i) => tx.objectStore('weighins').put({ id: `w-e2e-${i}`, local_date: d, utc: `${d}T14:00:00.000Z`, tz: 'America/Los_Angeles', weight_lb: Math.round((166.6 + i * 0.045 + (i % 3 === 0 ? 0.4 : i % 3 === 1 ? -0.3 : 0)) * 10) / 10, source: 'app', updated_utc: `${d}T14:00:00.000Z` }));
      tx.oncomplete = resolve;
    };
  }), { days: Array.from({ length: 19 }, (_, i) => dayBefore(today, 21 - i)) });

  step('Body: on plan today (Partial + kcal)');
  await tab(page, 'Week');
  await tab(page, 'Body');
  await page.getByRole('button', { name: 'Partial', exact: true }).click();
  await toastText(page, 'Partly on plan today');
  await page.getByLabel('Estimated kcal today', { exact: true }).fill('2600');
  await page.getByLabel('Estimated kcal today', { exact: true }).press('Enter');
  await page.waitForTimeout(300);
  const taps = await readStore('adherence');
  assert.equal(taps.length, 1);
  assert.deepEqual([taps[0].status, taps[0].kcal, taps[0].local_date], ['partial', 2600, today]);

  step('Body: mode switch waits for the next prep day; Undo cancels');
  await page.getByRole('button', { name: 'Cut', exact: true }).click();
  await page.getByText('Switch to Cut?').waitFor();
  await page.waitForTimeout(3000);
  await shot(page, 'b02-mode-confirm', S2);
  await page.getByLabel('Target weight', { exact: true }).fill('160');
  await page.getByLabel('Target weight', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Switch to Cut' }).click();
  await toastText(page, 'Cut starts');
  await page.locator('.accent', { hasText: 'Cut starts' }).waitFor();
  const settingsNow = (await readStore('meta')).find((m) => m.key === 'settings').value;
  assert.equal(settingsNow.mode, 'bulk', 'this week is unchanged');
  assert.equal(settingsNow.pending_mode.to, 'cut');
  assert.equal(settingsNow.pending_mode.targets.weight_lb, 160);
  await page.waitForTimeout(3000);
  await shot(page, 'b03-mode-pending', S2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Stay on Bulk?').waitFor();
  await page.getByRole('button', { name: 'Stay on Bulk' }).click();
  await toastText(page, 'Staying on Bulk');
  assert.deepEqual((await readStore('mode_changes')).map((c) => c.kind).sort(), ['cancel', 'switch']);

  step('Body: the check-in is easy to find (filled button on check-in day, Week banner)');
  await tab(page, 'Body');
  const dueButton = page.locator('.btn.primary', { hasText: 'Log measurements & check-in' });
  if (await dueButton.count()) {
    assert.equal(await page.locator('.site-row').count(), 0, 'card stays closed until tapped');
    await dueButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await shot(page, 'b00-body-checkin-button', S2);
    await tab(page, 'Week');
    const weekBanner = page.locator('.banner', { hasText: 'Check-in day' });
    await weekBanner.waitFor();
    await shot(page, 'b00-week-checkin-banner', S2);
    await weekBanner.getByRole('button', { name: 'Open' }).click();
    await page.locator('#checkin').waitFor();
    await page.waitForTimeout(800); // smooth scroll
    const top = await page.locator('#checkin').evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 300, `check-in card scrolled into view (top ${top})`);
    await shot(page, 'b00-body-checkin-focused', S2);
  } else {
    await page.locator('.link-btn', { hasText: 'Log measurements & check-in' }).click();
  }
  assert.ok(!(await page.locator('main').innerText()).includes('null'), 'no stray "null" text');

  step('Body: measurements (two readings, averaged) + check-in');
  await page.locator('.site-row input').first().waitFor();
  const tape = { Waist: [32.1, 32.3], Neck: [15.2, 15.2], Chest: [40, 40.2], Arm: [14.1, 14.1], Thigh: [22.5, 22.7] };
  for (const [site, [a, b]] of Object.entries(tape)) {
    await page.getByLabel(`${site} reading 1`).fill(String(a));
    await page.getByLabel(`${site} reading 2`).fill(String(b));
  }
  await page.locator('.site-row', { hasText: 'Waist' }).locator('.avg', { hasText: '32.2' }).waitFor();
  const save = page.getByRole('button', { name: 'Save check-in' });
  assert.equal(await save.isDisabled(), true, 'biofeedback required');
  for (const [i, bio] of ['Hunger', 'Energy', 'Sleep', 'Stress', 'Digestion'].entries()) {
    await page.getByRole('group', { name: bio, exact: true }).getByRole('button', { name: String([4, 4, 3, 4, 5][i]), exact: true }).click();
  }
  await page.waitForTimeout(2500);
  await shot(page, 'b04-checkin', { ...S2, full: true });
  await save.click();
  await toastText(page, 'Check-in saved');
  const [ci] = await readStore('checkins');
  const [meas] = await readStore('measurements');
  assert.deepEqual(ci.biofeedback, { hunger: 4, energy: 4, sleep: 3, stress: 4, digestion: 5 });
  assert.equal(ci.adherence_pct, 50, 'auto-filled from the one Partial tap');
  assert.equal(ci.measurement_id, meas.id);
  assert.equal(meas.avg.waist, 32.2);
  assert.deepEqual(meas.readings.waist, [32.1, 32.3]);
  if (await page.getByText('Back up this week?').count()) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(3000);
    await shot(page, 'b05-checkin-done', { ...S2, full: true });
  }

  step('Body: trend graph ranges, waist panel, edit and delete a weigh-in');
  const trendCardLoc = page.locator('.card', { has: page.locator('.chart') });
  await trendCardLoc.scrollIntoViewIfNeeded();
  await page.locator('.toast.show').waitFor({ state: 'detached', timeout: 1 }).catch(() => {});
  await page.waitForTimeout(3000); // let the toast fade
  await page.locator('.rate .status').waitFor();
  await trendCardLoc.screenshot({ path: STAGE === 'stage-2' ? `${OUT}b06-trend-12wk.png` : `${tmp}/x.png` });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.locator('.legend .key', { hasText: 'Cut' }).waitFor();
  await page.locator('.legend .key', { hasText: 'Break' }).waitFor();
  await trendCardLoc.screenshot({ path: STAGE === 'stage-2' ? `${OUT}b07-trend-all.png` : `${tmp}/x.png` });
  await page.getByRole('button', { name: '4 wk', exact: true }).click();
  await page.getByRole('button', { name: '+ Waist', exact: true }).click();
  await page.locator('.chart svg.chart-svg.overlay').waitFor();
  assert.equal(await page.locator('.chart svg.chart-svg').count(), 2, 'waist panel under the weight plot');
  // The chart redraws once at its real width after mounting; wait until it has settled.
  let box = null;
  for (let i = 0; i < 30 && !box; i += 1) {
    box = await page.locator('.chart svg.chart-svg').first().boundingBox();
    if (!box) await page.waitForTimeout(100);
  }
  await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
  await page.locator('.chart-tip.show').waitFor();
  await trendCardLoc.screenshot({ path: STAGE === 'stage-2' ? `${OUT}b08-trend-waist.png` : `${tmp}/x.png` });
  await page.getByRole('button', { name: 'Weight', exact: true }).click();
  await page.getByRole('button', { name: 'Show weigh-ins' }).click();
  await page.locator('.wtable button.item', { hasText: 'Today' }).click();
  await page.getByText('Weigh-in ·').waitFor();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await toastText(page, 'Weigh-in deleted');
  const del = (await readStore('weighins')).find((w) => w.local_date === today && w.source === 'app');
  assert.equal(del.deleted, true, 'soft delete keeps a tombstone');

  step('Body: a pending switch takes effect on-device on the prep day');
  // As if the bulk began 3 days ago and Maintenance was requested for today (the prep day).
  await page.evaluate(({ d, start }) => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      const tx = e.target.result.transaction(['meta', 'phases'], 'readwrite');
      const meta = tx.objectStore('meta');
      meta.get('settings').onsuccess = (r) => {
        const rec = r.target.result;
        rec.value.pending_mode = { to: 'maintenance', effective_date: d, change_id: 'e2e', targets: null };
        rec.value.mode_since = start;
        meta.put(rec);
      };
      const phases = tx.objectStore('phases');
      phases.get(`bulk-${d}`).onsuccess = (r) => {
        phases.delete(`bulk-${d}`);
        phases.put({ ...r.target.result, id: `bulk-${start}`, start });
      };
      tx.oncomplete = resolve;
    };
  }), { d: today, start: dayBefore(today, 3) });
  await page.reload();
  await toastText(page, 'Maintenance starts today');
  await page.locator('.segmented button[aria-pressed="true"]', { hasText: 'Maintenance' }).first().waitFor();
  const ph = await readStore('phases');
  assert.ok(ph.find((p) => p.id === `maintenance-${today}` && p.end === null));
  assert.equal(ph.find((p) => p.kind === 'bulk' && p.source === 'app').end, dayBefore(today, 1));
  await noHorizontalScroll(page, 'body');
  await tab(page, 'History');

  // ---- Stage 3: Log a session ---------------------------------------------------------
  const S3 = { stage: 'stage-3' };
  const card = (name) => page.locator('.ex-card', { has: page.locator('.ex-name', { hasText: name }) });
  async function logVia(name, { load, reps, rir } = {}) {
    const ed = page.locator('.set-editor');
    await ed.waitFor();
    if (load !== undefined) await page.getByLabel(`${name} weight`, { exact: true }).fill(String(load));
    if (reps !== undefined) await page.getByLabel(`${name} reps`, { exact: true }).fill(String(reps));
    if (rir !== undefined) await page.getByRole('group', { name: `${name} reps in reserve` }).getByRole('button', { name: String(rir), exact: true }).click();
    await ed.getByRole('button', { name: /Log set|Done|Save/ }).click();
    await page.waitForTimeout(250);
  }
  const doneCount = async () => (await readStore('sessions')).flatMap((x) => x.exercises.flatMap((e) => e.sets)).filter((x) => x.done).length;

  step('Log: today\'s session prefilled; first time is a calibration');
  await tab(page, 'Log');
  await page.locator('.title', { hasText: 'Upper Pull #2' }).waitFor();
  await page.getByText('Calibration', { exact: true }).waitFor();
  await page.getByText('Easing back in', { exact: true }).waitFor(); // answered Yes to "lifted less since May"
  await page.locator('.set-editor').waitFor();
  await page.waitForTimeout(3000); // let toasts fade
  await shot(page, 'c01-log-start', S3);

  step('Log: enter the calibration weight; it carries to the next sets; rest timer starts');
  await logVia('Reverse Pec Deck Flyes', { load: 100, reps: 12, rir: 1 });
  await page.locator('.rest.show').waitFor();
  const restText = await page.locator('.rest-time').innerText();
  assert.match(restText, /^1:[23]\d$/, `90 s rest (${restText})`);
  assert.equal(await page.getByLabel('Reverse Pec Deck Flyes weight', { exact: true }).inputValue(), '100', 'load carried to set 2');
  await page.getByRole('button', { name: 'Rest 15 seconds less' }).click();
  await shot(page, 'c02-set-logged-rest', S3);
  await logVia('Reverse Pec Deck Flyes', { reps: 12 });
  await logVia('Reverse Pec Deck Flyes', { reps: 12 });
  assert.equal(await doneCount(), 3);
  const [sess] = await readStore('sessions');
  assert.equal(sess.status, 'in_progress');
  // set 1 logged at RIR 1; sets 2–3 keep the prefilled target RIR (2 while easing back)
  assert.deepEqual(sess.exercises[0].sets.map((x) => [x.load, x.reps, x.rir]), [[100, 12, 1], [100, 12, 2], [100, 12, 2]]);

  step('Log: one-tap ✓ refuses a calibration set without a weight; the weight then fills the empty sets');
  await card('Cable Lat Pullovers').locator('.set-row', { hasText: 'Set 2' }).locator('.check').click();
  await toastText(page, 'Enter the weight you used');
  await card('Cable Lat Pullovers').locator('.set-editor', { hasText: 'Set 2' }).waitFor();
  await logVia('Cable Lat Pullovers', { load: 50, reps: 15 });
  await card('Cable Lat Pullovers').locator('.set-editor', { hasText: 'Set 3' }).waitFor(); // carries on forward
  assert.equal(await page.getByLabel('Cable Lat Pullovers weight', { exact: true }).inputValue(), '50');
  await logVia('Cable Lat Pullovers', {}); // set 3: one tap, prefilled 50 × 12
  const set1 = card('Cable Lat Pullovers').locator('.set-row', { hasText: 'Set 1' });
  assert.match(await set1.innerText(), /50 lb × 12/, 'the empty set 1 picked up the weight');
  await set1.locator('.check').click(); // compact row: one-tap ✓ as shown
  await card('Cable Lat Pullovers').locator('.set-row.done', { hasText: 'Set 1' }).waitFor();
  assert.equal(await doneCount(), 6);

  step('Log: superset A1 → A2 (timed), swap, skip, note');
  await page.getByRole('button', { name: 'Stop rest timer' }).click();
  await card('Cable Ab Crunches').locator('.set-main', { hasText: 'A1 · 1' }).click();
  await logVia('Cable Ab Crunches', { load: 80, reps: 15 });
  await card('Cable Ab Crunches').locator('.set-editor', { hasText: 'A2 · 1' }).waitFor(); // straight to the partner
  assert.equal(await page.locator('.rest.show').count(), 0, 'no rest between A1 and A2 (0 s)');
  await logVia('Ab Plank');
  await page.locator('.rest.show').waitFor();
  // a compact row's ✓ logs it as shown in one tap (timed plank, round 2)
  await card('Cable Ab Crunches').locator('.set-row', { hasText: 'A2 · 2' }).locator('.check').click();
  await card('Cable Ab Crunches').locator('.set-row.done', { hasText: 'A2 · 2' }).waitFor();
  await card('Cable Ab Crunches').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await shot(page, 'c03-superset', S3);
  await card('Incline DB Curls').getByRole('button', { name: 'More for Incline DB Curls' }).click();
  await page.getByRole('button', { name: 'Swap exercise' }).click();
  await page.getByLabel('Other exercise name').fill('Spider Curls');
  await shot(page, 'c04-swap', S3);
  await page.getByRole('button', { name: 'Use this name' }).click();
  await toastText(page, 'Swapped to Spider Curls');
  await card('Spider Curls').getByText('Swapped for Incline DB Curls').waitFor();
  await card('Single Arm Cable Pulldowns').getByRole('button', { name: 'More for Single Arm Cable Pulldowns' }).click();
  await page.getByRole('button', { name: 'Skip exercise' }).click();
  await card('Single Arm Cable Pulldowns').getByText('Skipped', { exact: true }).waitFor();

  step('Log: the update banner stays hidden during a session, then appears');
  state.versionOverride = '9.9.8-e2e';
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.waitForTimeout(4000);
  assert.equal(await page.getByText('Update available').count(), 0, 'no update banner mid-session');

  step('Log: Finish → next targets worked out on the phone');
  await page.getByRole('button', { name: 'Finish session' }).click();
  await page.getByText('Finish session?').waitFor();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.getByText('Session saved').waitFor();
  const nextRow = page.locator('.sheet.show .item', { hasText: 'Reverse Pec Deck Flyes' });
  assert.match(await nextRow.innerText(), /100 lb × 10–12/, 'week 0–1 back: hold the load');
  await page.waitForTimeout(300);
  await shot(page, 'c05-finished-next-targets', S3);
  await page.locator('.sheet.show').getByRole('button', { name: 'Done' }).click();
  const [fin] = await readStore('sessions');
  assert.equal(fin.status, 'finished');
  assert.equal(fin.exercises.find((e) => e.slot_id === 'fri-incline-db-curls').name, 'Spider Curls');
  assert.equal(fin.exercises.find((e) => e.slot_id === 'fri-single-arm-cable-pulldowns').skipped, true);
  await page.getByText('Update available').waitFor({ timeout: 15000 });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await page.locator('.tabbar').waitFor();

  step('Week + History show the session');
  await tab(page, 'Week');
  await page.locator('.day-row.today', { hasText: 'Done' }).waitFor();
  await shot(page, 'c06-week-done', S3);
  await page.locator('.day-row', { hasText: 'Push #1' }).click();
  await page.getByText('No session logged.').waitFor();
  await page.locator('.sheet.show').getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(250);
  await tab(page, 'History');
  await page.locator('.item', { hasText: 'Upper Pull #2' }).first().waitFor();
  await shot(page, 'c07-history', S3);
  const trained = await context.storageState({ indexedDB: true });

  // Next Friday (week 1, still easing back) and three weeks on (week 3), plus a Saturday.
  for (const [when, expect] of [['2026-10-16T16:00:00Z', 'hold'], ['2026-10-30T16:00:00Z', 'up']]) {
    step(`Log on ${when.slice(0, 10)}: targets from last Friday (${expect})`);
    const c = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles', storageState: trained });
    const p = await c.newPage();
    watch(p);
    await p.clock.install({ time: new Date(when) });
    await p.goto(`${url}#/log`);
    await p.getByText('Continue in Safari (testing only)').click();
    const rp = p.locator('.ex-card', { has: p.locator('.ex-name', { hasText: 'Reverse Pec Deck Flyes' }) });
    await rp.waitFor();
    const txt = await rp.innerText();
    if (expect === 'hold') {
      assert.match(txt, /Target 100 lb × 10–12 RIR 2/, `week 1: same load, RIR +1\n${txt}`);
    } else {
      assert.match(txt, /▲ \+10 lb/, txt);
      assert.match(txt, /Target 110 lb × 10–12 RIR 1/, txt);
      assert.match(txt, /Last: 100 × 12, 12, 12/, txt);
      await p.waitForTimeout(300);
      await shot(p, 'c08-next-targets', S3);
    }
    await c.close();
  }
  {
    step('Saturday: open day with the one-tap Stairs ✓');
    const c = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles', storageState: trained });
    const p = await c.newPage();
    watch(p);
    await p.clock.install({ time: new Date('2026-10-10T18:00:00Z') });
    await p.goto(`${url}#/log`);
    await p.getByText('Continue in Safari (testing only)').click();
    await p.locator('.title', { hasText: 'Open day' }).waitFor();
    await p.getByRole('button', { name: 'Stairs ✓' }).click();
    await p.locator('.toast.show', { hasText: 'Stairs 30 min logged' }).waitFor();
    await p.waitForTimeout(300);
    await shot(p, 'c09-open-day-stairs', S3);
    await c.close();
  }
  await tab(page, 'History');

  // ---- Stage 4: Meals ---------------------------------------------------------------
  const S4 = { stage: 'stage-4' };
  step('Meals: §8.0 starting plan with "What changed" vs CUT26-V4');
  await tab(page, 'Meals');
  await page.locator('.title', { hasText: 'Lead-in week' }).waitFor();
  const changed = page.locator('.card.changed');
  await changed.waitFor();
  const changedText = await changed.innerText();
  for (const needle of ['Carb cycling off: one plan every day.', 'Pre-workout rice cakes 4 → 5', 'Post-workout rice 200 → 270 g', 'M4 sweet potato 200 → 300 g', '2,192 → 2,353 kcal (+161)', 'vs CUT26-V4']) {
    assert.ok(changedText.includes(needle), `What changed should include "${needle}"\n${changedText}`);
  }
  assert.match(await page.locator('.hero').first().innerText(), /2,353/);
  assert.match(await page.locator('.macros').innerText(), /189 g protein.*282 g carbs.*52 g fat/s);
  for (const food of ['3 eggs', '3 slices Ezekiel bread', '5 rice cakes', '19 g nut butter', '1 scoop whey isolate', '5 oz chicken (cooked)', '270 g jasmine rice (cooked)', '6 oz 93/7 beef or turkey (cooked)', '300 g sweet potato', '70 g blueberries']) {
    await page.locator('.food', { hasText: food }).first().waitFor();
  }
  await page.getByText(/You’re in maintenance now; this week’s food is the bulk plan/).waitFor(); // Body test switched mode
  await page.waitForTimeout(2500);
  await shot(page, 'd01-meals-plan', { ...S4, full: true });

  step('Meals: prep list (cooked) and grocery list (raw/store units)');
  const prepItem = (label) => page.locator('.item', { hasText: label }).first().innerText();
  assert.match(await prepItem('Chicken (cooked)'), /35 oz · 992 g/);
  assert.match(await prepItem('Jasmine rice (cooked)'), /1,890 g/);
  assert.match(await prepItem('Eggs'), /21/);
  const groceryRow = page.locator('.grocery', { hasText: 'Chicken breast, raw' });
  assert.match(await groceryRow.innerText(), /2\.9 lb/);
  assert.match(await page.locator('.grocery', { hasText: 'Jasmine rice, dry' }).innerText(), /630 g/);
  await groceryRow.click();
  await page.locator('.grocery.got', { hasText: 'Chicken breast, raw' }).waitFor();
  await page.locator('.grocery', { hasText: 'Eggs' }).click();
  await page.locator('.grocery', { hasText: 'Eggs' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot(page, 'd02-grocery', S4);

  step('Meals: GI flag and travel mode');
  await page.locator('.food', { hasText: '93/7 beef or turkey' }).first().click();
  await page.getByText('Coach-approved swaps').waitFor();
  await shot(page, 'd03-food-swaps', S4);
  await page.getByRole('button', { name: 'Flag for GI issues' }).click();
  await toastText(page, 'Flagged');
  await page.locator('.food.flagged', { hasText: '93/7 beef or turkey' }).waitFor();
  assert.deepEqual((await readStore('foods')).map((f) => [f.id, f.gi_flag]), [['lean_beef', true]]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Travel', exact: true }).click();
  await page.getByText('Travel targets').waitFor();
  assert.match(await page.locator('.travel-grid').innerText(), /189\s*g[\s\S]*2,353\s*kcal/);
  await page.waitForFunction(() => !document.querySelector('.toast.show'));
  await page.waitForTimeout(400);
  await shot(page, 'd04-travel', S4);
  await page.getByRole('button', { name: 'Meal plan', exact: true }).click();
  await page.locator('.card.changed').waitFor();
  const afterMeals = await context.storageState({ indexedDB: true });

  step('Meals: on prep day the plan carries into the new week on the phone (no signal needed)');
  {
    const c = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles', storageState: afterMeals });
    const p = await c.newPage();
    watch(p);
    await p.clock.install({ time: new Date('2026-10-11T08:00:00Z') }); // Sun 11 Oct, 01:00 in LA
    await p.goto(`${url}#/meals`);
    await p.getByText('Continue in Safari (testing only)').click();
    await p.locator('.title', { hasText: 'Week 1' }).waitFor();
    await p.getByText('Same plan as last week: prep as usual.').waitFor();
    assert.equal(await p.locator('.card.changed').count(), 0, 'no What changed card when nothing changed');
    const plans = await p.evaluate(() => new Promise((resolve) => {
      indexedDB.open('wmcoach').onsuccess = (e) => { e.target.result.transaction('plans').objectStore('plans').getAll().onsuccess = (r) => resolve(r.target.result.map((x) => [x.week_start, x.source, x.plan.weekly_avg.kcal])); };
    }));
    assert.deepEqual(plans, [['2026-10-04', 'seed', 2353], ['2026-10-11', 'carry', 2353]]);
    await p.waitForTimeout(300);
    await shot(p, 'd05-week1-carried', S4);
    await c.close();
  }

  const S5 = { stage: 'stage-5' };
  step('Week: "Week in review" after the check-in (blunt, every section, folds away)');
  {
    await tab(page, 'Week');
    const review = page.locator('.card.summary');
    await review.waitFor();
    const text = await review.textContent();
    for (const t of ['Week in review', 'Focus', 'Adherence', 'Weight', 'Training', 'Measurements', 'Recovery', 'Plan']) assert.ok(text.includes(t), `review shows ${t}`);
    assert.match(text, /50 %\. Too low to judge anything/, 'the Partial tap is called out, not softened');
    assert.match(text, /No macro change while adherence is under 90 %/);
    assert.ok(!/\bnull\b|undefined|NaN/.test(text), 'no stray null/undefined/NaN');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await shot(page, 'e01-week-review', { ...S5, full: true });
    await review.getByRole('button', { name: 'Hide details' }).click();
    assert.equal(await review.locator('.summary-points').isHidden(), true);
    await review.getByRole('button', { name: 'Read the full review' }).click();
    assert.equal(await review.locator('.summary-points').isVisible(), true);
    await noHorizontalScroll(page, 'week review');
  }
  const afterReview = await context.storageState({ indexedDB: true });

  const gh = new FakeGitHub();
  step('GitHub sync: connect, first push (one commit, never the token)');
  {
    const c = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles', storageState: afterReview });
    await routeGitHub(c, gh);
    // headless Chromium has no push service or notification prompt: stand in for iOS
    await c.addInitScript(() => {
      let perm = 'default';
      Object.defineProperty(Notification, 'permission', { get: () => perm });
      Notification.requestPermission = async () => { perm = 'granted'; return perm; };
      ServiceWorkerRegistration.prototype.showNotification = async function showNotification(title, opts) { window.__shown = [...(window.__shown || []), [title, opts.body]]; };
      let sub = null;
      const fake = { endpoint: 'https://web.push.apple.com/QE2E-test', options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPe2e', auth: 'e2e' } }; }, async unsubscribe() { sub = null; return true; } };
      PushManager.prototype.subscribe = async function subscribe() { sub = fake; return fake; };
      PushManager.prototype.getSubscription = async function getSubscription() { return sub; };
    });
    const p = await c.newPage();
    watch(p);
    await p.goto(`${url}#/settings`);
    await p.getByText('Continue in Safari (testing only)').click();
    await p.getByRole('button', { name: 'Connect GitHub' }).waitFor();
    assert.equal(await p.locator('.sync-badge').isHidden(), true, 'no badge before sync is set up');
    await p.getByRole('button', { name: 'Connect GitHub' }).click();
    await p.getByLabel('GitHub token').fill('wrong-token');
    await p.locator('.sheet.show').getByRole('button', { name: 'Connect', exact: true }).click();
    await p.locator('.sheet.show [role="alert"]', { hasText: 'rejected the token' }).waitFor();
    await p.getByLabel('GitHub token').fill(gh.token);
    await p.waitForTimeout(300);
    await shot(p, 'e02-connect', S5);
    await p.locator('.sheet.show').getByRole('button', { name: 'Connect', exact: true }).click();
    await toastText(p, 'GitHub connected');
    await until(() => gh.files()['data/log/settings.json'], 'the first push');
    const files = Object.keys(gh.files()).filter((f) => f.startsWith('data/log/'));
    assert.ok(files.includes('data/log/checkins/2026-10.json') || files.some((f) => f.startsWith('data/log/checkins/')), 'check-ins synced');
    assert.ok(files.some((f) => f.startsWith('data/log/sessions/')), 'sessions synced');
    assert.ok(files.includes('data/log/onboarding.json'));
    for (const f of files) assert.ok(!gh.files()[f].includes(gh.token), `${f} must not contain the token`);
    assert.ok(!files.some((f) => gh.files()[f].includes('"source": "history"')), 'seeded history is not copied');
    assert.equal(gh.commitMessages().length, 2, 'one commit for the first sync');
    assert.match(gh.commitMessages()[0], /^log \d{4}-\d{2}-\d{2} \(America\/Los_Angeles\): \d+ records$/);
    await p.locator('.value', { hasText: 'Up to date' }).waitFor();
    await p.getByText('GitHub sync', { exact: true }).scrollIntoViewIfNeeded();
    await p.evaluate(() => window.scrollBy(0, -60));
    await p.waitForTimeout(3000);
    await shot(p, 'e03-settings-synced', S5);

    step('GitHub sync: offline edit → "Unsynced (1)" badge; back online → Sync now');
    gh.offline = true;
    await tab(p, 'Body');
    await p.getByLabel('Weight', { exact: true }).fill('168.8');
    await p.getByLabel('Weight', { exact: true }).press('Enter');
    await p.locator('.btn.primary', { hasText: /^(Update|Log weight)$/ }).click();
    await toastText(p, '168.8 lb');
    const badge = p.locator('.sync-badge');
    await badge.filter({ hasText: 'Unsynced (1)' }).waitFor();
    await until(async () => (await p.evaluate(() => new Promise((resolve) => {
      indexedDB.open('wmcoach').onsuccess = (e) => { e.target.result.transaction('meta').objectStore('meta').get('sync').onsuccess = (r) => resolve(r.target.result && r.target.result.value.failures); };
    }))) >= 1, 'a failed (offline) attempt');
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(2500);
    await shot(p, 'e04-unsynced-badge', S5);
    gh.offline = false;
    await badge.click();
    await p.getByRole('button', { name: 'Sync now' }).click();
    await toastText(p, 'Synced 1 change');
    await badge.waitFor({ state: 'hidden' });
    const todayW = Object.entries(gh.files()).filter(([f]) => f.startsWith('data/log/weighins/')).flatMap(([, t]) => JSON.parse(t).records).find((w) => w.local_date === today && w.source === 'app' && !w.deleted);
    assert.equal(todayW.weight_lb, 168.8);

    step('GitHub sync: held while a workout is in progress (one commit per session)');
    const putSession = (rec) => p.evaluate((r) => new Promise((resolve) => {
      indexedDB.open('wmcoach').onsuccess = (e) => { const tx = e.target.result.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(r); tx.oncomplete = resolve; };
    }), rec);
    const open = { id: 'sess-e2e-open', local_date: today, tz: 'America/Los_Angeles', utc: new Date().toISOString(), status: 'in_progress', day_dow: 5, day_name: 'Upper Pull #2', exercises: [], updated_utc: new Date().toISOString() };
    await putSession(open);
    const commits = gh.commitMessages().length;
    await tab(p, 'Body');
    await p.getByLabel('Weight', { exact: true }).fill('169.0');
    await p.getByLabel('Weight', { exact: true }).press('Enter');
    await p.locator('.btn.primary', { hasText: /^(Update|Log weight)$/ }).click();
    await toastText(p, '169.0 lb');
    await p.waitForTimeout(11000); // past the 8 s settle delay
    assert.equal(gh.commitMessages().length, commits, 'nothing pushed mid-workout');
    await badge.filter({ hasText: 'Unsynced' }).waitFor();
    await putSession({ ...open, deleted: true, deleted_utc: new Date().toISOString(), updated_utc: new Date().toISOString() });
    await badge.click();
    await p.getByRole('button', { name: 'Sync now' }).click();
    await toastText(p, 'Synced');
    await badge.waitFor({ state: 'hidden' });
    assert.equal(gh.commitMessages().length, commits + 1);

    step('Notifications: turn on (after install), test, subscription syncs');
    await p.getByText('Notifications', { exact: true }).scrollIntoViewIfNeeded();
    await p.getByRole('button', { name: 'Turn on notifications' }).click();
    await toastText(p, 'Notifications on');
    await p.getByRole('button', { name: 'Send a test' }).click();
    await toastText(p, 'Test sent');
    assert.match((await p.evaluate(() => window.__shown))[0][1], /check-in mornings/);
    await until(() => gh.json('data/log/push_subscription.json'), 'the subscription to sync');
    const sub = gh.json('data/log/push_subscription.json');
    assert.equal(sub.value.endpoint, 'https://web.push.apple.com/QE2E-test');
    assert.ok(sub.value.vapid_public_key);
    await p.getByText('Notifications', { exact: true }).scrollIntoViewIfNeeded();
    await p.evaluate(() => window.scrollBy(0, -60));
    await p.waitForTimeout(3000);
    await shot(p, 'e05-notifications', S5);
    await c.close();
  }

  step('Restore from GitHub on an empty phone: history + everything synced comes back');
  {
    const remoteWeighins = Object.entries(gh.files()).filter(([f]) => f.startsWith('data/log/weighins/')).flatMap(([, t]) => JSON.parse(t).records);
    const c = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles' });
    await routeGitHub(c, gh);
    const p = await c.newPage();
    watch(p);
    await p.goto(url);
    await p.getByText('Continue in Safari (testing only)').click();
    await p.getByRole('button', { name: 'Restore from GitHub' }).click();
    await p.getByLabel('GitHub token').fill(gh.token);
    await p.waitForTimeout(300);
    await shot(p, 'e06-restore', S5);
    await p.locator('.sheet.show').getByRole('button', { name: 'Restore', exact: true }).click();
    await toastText(p, 'Restored');
    await p.locator('.weekstrip').waitFor();
    assert.equal(await countStore(p, 'weighins'), 279 + remoteWeighins.length);
    for (const store of ['checkins', 'measurements', 'sessions', 'adherence', 'plans', 'foods']) {
      const remote = Object.entries(gh.files()).filter(([f]) => f.startsWith(`data/log/${store}`)).flatMap(([, t]) => JSON.parse(t).records).length;
      assert.equal(await countStore(p, store), remote, `${store} restored`);
    }
    await p.locator('.card.summary').waitFor(); // the review is rebuilt from the restored data
    await p.waitForTimeout(2500);
    assert.equal(await p.locator('.sync-badge').isHidden(), true, 'nothing pending after a restore');
    const before = gh.commitMessages().length;
    await p.waitForTimeout(2000);
    assert.equal(gh.commitMessages().length, before, 'a restore doesn’t push anything back');
    await c.close();
  }
  await tab(page, 'History');

  step('Settings: manual timezone → toast + history; back to auto');
  await page.getByLabel('Settings').click();
  await page.getByText('Timezone', { exact: true }).waitFor();
  await shot(page, '09-settings', { full: true });
  await noHorizontalScroll(page, 'settings');
  await page.getByRole('button', { name: 'Manual', exact: true }).click();
  await page.getByLabel('Search timezones').fill('tokyo');
  await page.locator('.tz-list button', { hasText: 'Tokyo' }).click();
  await toastText(page, 'Now on Tokyo time');
  await shot(page, '10-timezone-manual');
  await page.getByRole('button', { name: 'Auto (follow iPhone)' }).click();
  await toastText(page, 'Following iPhone: Los Angeles time');
  const tzHistory = await page.evaluate(() => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      e.target.result.transaction('meta').objectStore('meta').get('settings').onsuccess = (r) => resolve(r.target.result.value.tz_history.map((z) => z.tz));
    };
  }));
  assert.deepEqual(tzHistory, ['America/Los_Angeles', 'Asia/Tokyo', 'America/Los_Angeles']);

  step('Export → file with every store');
  await page.getByRole('button', { name: 'Export backup' }).click();
  await page.getByText('Backup ready').waitFor();
  await page.waitForTimeout(250);
  await shot(page, '11-export');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save to Files' }).click()]);
  assert.match(download.suggestedFilename(), /^walter-coach-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backupPath = join(tmp, download.suggestedFilename());
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.schema_version, DB_VERSION);
  const nWeighins = await countStore(page, 'weighins');
  assert.equal(backup.stores.weighins.length, nWeighins);
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence', 'sessions']) assert.ok(backup.stores[store].length > 0, store);
  assert.equal(backup.stores.snapshots, undefined);

  step('Import (merge) restores a deleted weigh-in');
  await page.evaluate(() => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      const tx = e.target.result.transaction('weighins', 'readwrite');
      tx.objectStore('weighins').delete('hist-2025-01-04');
      tx.oncomplete = resolve;
    };
  }));
  assert.equal(await countStore(page, 'weighins'), nWeighins - 1);
  await page.waitForTimeout(800);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import backup or CSV' }).click()]);
  await chooser.setFiles(backupPath);
  await page.getByText('Import backup', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  await shot(page, '12-import-preview');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await toastText(page, 'Merged');
  assert.equal(await countStore(page, 'weighins'), nWeighins);

  step('Import Health weigh-ins CSV');
  const csvPath = join(tmp, 'weights.csv');
  await writeFile(csvPath, 'Date,Weight\n2026-05-10T07:12:00-07:00,165.2\n2026-05-11T06:58:00-07:00,165.0\n2026-05-12T07:05:00-07:00,164.8\n');
  await page.waitForTimeout(800);
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import backup or CSV' }).click()]);
  await chooser2.setFiles(csvPath);
  await page.getByRole('button', { name: 'Import 3' }).click();
  await toastText(page, 'Imported 3 weigh-ins');
  assert.equal(await countStore(page, 'weighins'), nWeighins + 3);

  step('Works offline after the first load');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Timezone', { exact: true }).waitFor(); // still on Settings
  await page.locator('.tabbar').waitFor();
  await context.setOffline(false);

  step('Check for update with nothing new says so');
  await page.goto(`${url}#/settings`);
  await page.locator('.item', { hasText: 'Check for update' }).click();
  await toastText(page, 'latest version');

  step('Update flow: new version waits for the banner, snapshot saved, then reload');
  state.versionOverride = '9.9.9-e2e';
  // Use the Settings button itself: it must wait for the download, not report "latest" early.
  await page.goto(`${url}#/settings`);
  await page.locator('.item', { hasText: 'Check for update' }).click();
  await toastText(page, 'Update ready');
  await page.getByText('Update available').waitFor({ timeout: 15000 });
  await shot(page, '13-update-banner', { stage: 'all' });
  assert.equal(await page.evaluate(() => document.querySelector('.banner') !== null), true);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await page.locator('.tabbar').waitFor();
  await page.goto(`${url}#/settings`);
  await page.locator('.item', { hasText: 'Version' }).getByText('9.9.9-e2e').waitFor();
  assert.equal(await countStore(page, 'snapshots'), 3, 'one import snapshot + two update snapshots');
  assert.equal(await countStore(page, 'weighins'), nWeighins + 3, 'data survived the update');
  state.versionOverride = null;

  step('Phone changes timezone → toast on next launch');
  const saved = await context.storageState({ indexedDB: true });
  await context.close();
  const tokyo = await browser.newContext({ ...DEVICE, timezoneId: 'Asia/Tokyo', storageState: saved });
  const page2 = await tokyo.newPage();
  watch(page2);
  await page2.goto(url);
  await page2.getByText('Continue in Safari (testing only)').click();
  await toastText(page2, 'Now on Tokyo time');
  await shot(page2, '14-timezone-auto');
  await tokyo.close();

  step('Narrowest width (320 pt): no horizontal scroll');
  const narrow = await browser.newContext({ ...DEVICE, viewport: { width: 320, height: 640 }, storageState: saved });
  const page3 = await narrow.newPage();
  watch(page3);
  await page3.goto(url);
  await page3.getByText('Continue in Safari (testing only)').click();
  for (const name of ['Week', 'Log', 'Body', 'Meals', 'History']) {
    await tab(page3, name);
    await noHorizontalScroll(page3, `${name} @320`);
  }
  await page3.goto(`${url}#/settings`);
  await page3.getByText('Timezone', { exact: true }).waitFor();
  await noHorizontalScroll(page3, 'Settings @320');
  await narrow.close();

  step('A stage-1 phone (v1 database) upgrades in the browser and keeps everything');
  const v1 = JSON.parse(await readFile(new URL('../fixtures/backup-v1.json', import.meta.url), 'utf8'));
  const old = await browser.newContext({ ...DEVICE, timezoneId: 'America/Los_Angeles' });
  const p4 = await old.newPage();
  watch(p4);
  await p4.goto(`${url}manifest.webmanifest`);
  await p4.evaluate((stores) => new Promise((resolve, reject) => {
    const req = indexedDB.open('wmcoach', 1); // exactly what stage 1 created
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('weighins', { keyPath: 'id' }).createIndex('local_date', 'local_date');
      db.createObjectStore('phases', { keyPath: 'id' });
      db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('created_utc', 'created_utc');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(Object.keys(stores), 'readwrite');
      for (const [name, recs] of Object.entries(stores)) for (const r of recs) tx.objectStore(name).put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), v1.stores);
  await p4.goto(`${url}#/body`);
  await p4.getByText('Continue in Safari (testing only)').click();
  await p4.locator('.chart').waitFor();
  const info = await p4.evaluate(() => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      const db = e.target.result;
      db.transaction('weighins').objectStore('weighins').count().onsuccess = (r) => resolve({ version: db.version, stores: [...db.objectStoreNames], weighins: r.target.result });
    };
  }));
  assert.equal(info.version, DB_VERSION);
  assert.equal(info.weighins, v1.stores.weighins.length);
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence', 'sessions', 'stairs', 'exercise_prefs', 'plans', 'foods']) assert.ok(info.stores.includes(store), store);
  await old.close();

  const real = errors.filter((e) => !/favicon/.test(e));
  assert.deepEqual(real, [], `browser errors:\n${real.join('\n')}`);
  console.log(`\nE2E passed. Screenshots in docs/screenshots/${STAGE}/`);
} catch (err) {
  console.error('\nE2E FAILED:', err.message);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: `${tmp}/failure.png` }).catch(() => {});
  console.error(`Failure screenshot: ${tmp}/failure.png`);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
