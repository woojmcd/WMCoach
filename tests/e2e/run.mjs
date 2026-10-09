// End-to-end run at 375 × 812 in headless Chromium (spec §12a), with screenshots.
// Usage: npm run e2e        Screenshots: docs/screenshots/<stage>/
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../scripts/serve.mjs';

const STAGE = process.env.E2E_STAGE || 'stage-1';
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
async function shot(page, name, full = false) {
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
  await shot(page, '02-onboarding', true);
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
  await shot(page, '05-log', true);
  await noHorizontalScroll(page, 'log');
  await tab(page, 'Body');
  await page.locator('.hero', { hasText: '168.4' }).waitFor();
  await shot(page, '06-body');
  await tab(page, 'Meals');
  await shot(page, '07-meals');
  await tab(page, 'History');
  await page.getByText('Cut 2025').waitFor();
  await page.getByText('Holiday break').waitFor();
  await shot(page, '08-history', true);

  step('Settings: manual timezone → toast + history; back to auto');
  await page.getByLabel('Settings').click();
  await page.getByText('Timezone', { exact: true }).waitFor();
  await shot(page, '09-settings', true);
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
  assert.equal(backup.schema_version, 1);
  assert.equal(backup.stores.weighins.length, 280);
  assert.equal(backup.stores.snapshots, undefined);

  step('Import (merge) restores a deleted weigh-in');
  await page.evaluate(() => new Promise((resolve) => {
    indexedDB.open('wmcoach').onsuccess = (e) => {
      const tx = e.target.result.transaction('weighins', 'readwrite');
      tx.objectStore('weighins').delete('hist-2025-01-04');
      tx.oncomplete = resolve;
    };
  }));
  assert.equal(await countStore(page, 'weighins'), 279);
  await page.waitForTimeout(800);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import backup or CSV' }).click()]);
  await chooser.setFiles(backupPath);
  await page.getByText('Import backup', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  await shot(page, '12-import-preview');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await toastText(page, 'Merged');
  assert.equal(await countStore(page, 'weighins'), 280);

  step('Import Health weigh-ins CSV');
  const csvPath = join(tmp, 'weights.csv');
  await writeFile(csvPath, 'Date,Weight\n2026-05-10T07:12:00-07:00,165.2\n2026-05-11T06:58:00-07:00,165.0\n2026-05-12T07:05:00-07:00,164.8\n');
  await page.waitForTimeout(800);
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import backup or CSV' }).click()]);
  await chooser2.setFiles(csvPath);
  await page.getByRole('button', { name: 'Import 3' }).click();
  await toastText(page, 'Imported 3 weigh-ins');
  assert.equal(await countStore(page, 'weighins'), 283);

  step('Works offline after the first load');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Timezone', { exact: true }).waitFor(); // still on Settings
  await page.locator('.tabbar').waitFor();
  await context.setOffline(false);

  step('Update flow: new version waits for the banner, snapshot saved, then reload');
  state.versionOverride = '0.1.1-e2e';
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.getByText('Update available').waitFor({ timeout: 15000 });
  await shot(page, '13-update-banner');
  assert.equal(await page.evaluate(() => document.querySelector('.banner') !== null), true);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await page.locator('.tabbar').waitFor();
  await page.goto(`${url}#/settings`);
  await page.locator('.item', { hasText: 'Version' }).getByText('0.1.1-e2e').waitFor();
  assert.equal(await countStore(page, 'snapshots'), 2, 'one import snapshot + one update snapshot');
  assert.equal(await countStore(page, 'weighins'), 283, 'data survived the update');
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
