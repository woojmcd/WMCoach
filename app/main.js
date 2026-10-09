// App shell: boot, routing, timezone watch, update banner.
import { APP_VERSION } from './version.js';
import { openDB, getMeta, setMeta } from './db.js';
import { saveSnapshot } from './backup.js';
import { registerServiceWorker, activateWaitingUpdate, checkForUpdate, updateWaiting } from './sw-client.js';
import { applyDeviceZone } from './tz.js';
import { h, clear, icon, toast } from './ui.js';
import { deviceTimeZone, localDate, tzCity } from '../coach/time.js';
import { renderInstall } from './views/install.js';
import { renderOnboarding } from './views/onboarding.js';
import * as week from './views/week.js';
import * as log from './views/log.js';
import * as body from './views/body.js';
import * as meals from './views/meals.js';
import * as history from './views/history.js';
import * as settings from './views/settings.js';

const TABS = [
  { route: 'week', label: 'Week', icon: 'week', view: week },
  { route: 'log', label: 'Log', icon: 'log', view: log },
  { route: 'body', label: 'Body', icon: 'body', view: body },
  { route: 'meals', label: 'Meals', icon: 'meals', view: meals },
  { route: 'history', label: 'History', icon: 'history', view: history },
];
const ROUTES = { ...Object.fromEntries(TABS.map((t) => [t.route, t])), settings: { route: 'settings', parent: 'history', view: settings } };

const root = document.getElementById('app');
const LB_TO_KG = 0.45359237;

const ctx = {
  version: APP_VERSION,
  db: null,
  settings: null,
  program: null,
  updateReady: false,
  bannerSlot: h('div', { class: 'banner-slot', 'aria-live': 'polite' }),
  tz() { return (this.settings && this.settings.tz_current) || deviceTimeZone(); },
  today() { return localDate(new Date(), this.tz()); },
  fmtWeight(lb) { return (this.settings && this.settings.units === 'kg' ? lb * LB_TO_KG : lb).toFixed(1); },
  unitLabel() { return this.settings && this.settings.units === 'kg' ? 'kg' : 'lb'; },
  async saveSettings(next) {
    this.settings = next;
    await setMeta(this.db, 'settings', next);
  },
  // Stage 3 sets this while a workout is being logged; the update banner hides meanwhile.
  sessionInProgress() { return false; },
  navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  refresh() { render({ keepScroll: true }); },
  async reload() {
    this.settings = await getMeta(this.db, 'settings');
    await checkZone();
    render({ keepScroll: true });
  },
  async checkUpdate() {
    toast('Checking for updates…', 1500);
    const ready = await checkForUpdate();
    if (ready) showUpdateReady();
    else toast(`You’re on the latest version (${APP_VERSION})`);
  },
};

const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

function storageGet(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---- update banner (spec §12a) ------------------------------------------------------

function showUpdateReady() {
  ctx.updateReady = true;
  renderBanners();
}

function renderBanners() {
  clear(ctx.bannerSlot);
  if (ctx.updateReady && updateWaiting() && !ctx.sessionInProgress()) {
    const btn = h('button', { type: 'button', class: 'btn primary small', onClick: () => applyUpdate(btn) }, 'Reload');
    ctx.bannerSlot.append(h('div', { class: 'banner', role: 'status' },
      h('span', { class: 'accent' }, icon('refresh', { size: 20 })),
      h('span', { class: 'grow' }, 'Update available'),
      btn));
  }
}

async function applyUpdate(btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    // Before any update takes over, keep a local copy of everything (last 3 kept).
    if (ctx.db && (await getMeta(ctx.db, 'onboarding'))) {
      await saveSnapshot(ctx.db, { reason: 'update', appVersion: APP_VERSION, tz: ctx.tz(), localDate: ctx.today() });
    }
  } catch (err) {
    console.error(err);
    toast('Couldn’t save a safety snapshot, so the update is on hold');
    btn.disabled = false;
    btn.textContent = 'Reload';
    return;
  }
  if (!activateWaitingUpdate()) {
    toast('Update not ready yet');
    btn.disabled = false;
    btn.textContent = 'Reload';
  }
}

// ---- timezone watch (spec §2b) -------------------------------------------------------

async function checkZone() {
  if (!ctx.settings) return false;
  const next = applyDeviceZone(ctx.settings, deviceTimeZone(), new Date());
  if (!next) return false;
  await ctx.saveSettings(next);
  toast(`Now on ${tzCity(next.tz_current)} time`);
  return true;
}

// ---- routing ----------------------------------------------------------------------------

let tabbar = null;
let viewEl = null;
let renderedDate = null;
let renderSeq = 0;

function currentRoute() {
  const name = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return ROUTES[name] || ROUTES.week;
}

function buildShell() {
  clear(root);
  viewEl = h('div', { id: 'view' });
  tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Tabs' }, TABS.map((t) => h('a', { href: `#/${t.route}`, dataset: { route: t.route } }, icon(t.icon), h('span', {}, t.label))));
  root.append(viewEl, tabbar);
}

async function render({ keepScroll = false } = {}) {
  if (!viewEl) return;
  const seq = ++renderSeq;
  const route = currentRoute();
  const active = route.parent || route.route;
  for (const a of tabbar.querySelectorAll('a')) {
    if (a.dataset.route === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const y = window.scrollY;
  const screen = h('main', { class: 'screen' });
  screen.append(ctx.bannerSlot);
  renderBanners();
  renderedDate = ctx.today();
  try {
    await route.view.render(screen, ctx);
  } catch (err) {
    console.error(err);
    screen.append(h('p', { class: 'muted' }, `Something went wrong: ${err.message || err}`));
  }
  if (seq !== renderSeq) return; // a newer render started meanwhile
  viewEl.replaceChildren(screen);
  window.scrollTo(0, keepScroll ? y : 0);
}

async function loadProgram() {
  try {
    const res = await fetch('data/program.json');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---- boot -------------------------------------------------------------------------------

async function startApp() {
  // Ask iOS to keep this data (also covers a phone restored from a backup).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  ctx.settings = await getMeta(ctx.db, 'settings');
  await checkZone();
  ctx.program = await loadProgram();
  buildShell();
  window.addEventListener('hashchange', () => render());
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const zoneChanged = await checkZone();
    if (zoneChanged || ctx.today() !== renderedDate) render({ keepScroll: true });
    checkForUpdate();
  });
  // Roll over to the new local day at midnight while the app stays open.
  setInterval(() => { if (ctx.today() !== renderedDate) render({ keepScroll: true }); }, 60000);
  await render();
}

async function openApp() {
  try {
    ctx.db = await openDB();
  } catch (err) {
    clear(root).append(h('main', { class: 'screen no-tabs stack' },
      h('h1', { class: 'title' }, 'Storage unavailable'),
      h('p', { class: 'muted body' }, `The app can’t open its local database (${err.message || err}). Close other WMCoach windows and reopen.`)));
    return;
  }
  if (await getMeta(ctx.db, 'onboarding')) await startApp();
  else await renderOnboarding(root, ctx, { onDone: startApp });
}

function boot() {
  registerServiceWorker({ onUpdateReady: showUpdateReady });
  if (!isStandalone() && storageGet('wm.browser') !== '1') {
    renderInstall(root, { onContinue: () => { storageSet('wm.browser', '1'); openApp(); } });
    return;
  }
  openApp();
}

boot();
