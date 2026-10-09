// End-to-end run at 375 × 812 in headless Chromium (spec §12a), with screenshots.
// Usage: npm run e2e        Screenshots: docs/screenshots/<stage>/
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../scripts/serve.mjs';

const STAGE = process.env.E2E_STAGE || 'stage-2';
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
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

  step('Body: measurements (two readings, averaged) + check-in');
  if (!(await page.locator('.site-row input').count())) await page.getByRole('button', { name: /Check in now/ }).click();
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
  assert.equal(backup.schema_version, 2);
  const nWeighins = await countStore(page, 'weighins');
  assert.equal(backup.stores.weighins.length, nWeighins);
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence']) assert.ok(backup.stores[store].length > 0, store);
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
  assert.equal(await countStore(page, 'snapshots'), 2, 'one import snapshot + one update snapshot');
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
  assert.equal(info.version, 2);
  assert.equal(info.weighins, v1.stores.weighins.length);
  for (const store of ['mode_changes', 'measurements', 'checkins', 'adherence']) assert.ok(info.stores.includes(store), store);
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
