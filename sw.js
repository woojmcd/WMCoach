// WMCoach service worker (spec §3, §12a).
// - App shell: cache-first from a versioned cache; old caches deleted on activate.
// - data/plan/*, data/targets/*: network-first with a short timeout, cache fallback.
// - Everything else under data/: stale-while-revalidate.
// - A new version installs in the background and waits; it takes over only
//   when the app posts SKIP_WAITING after Walter taps "Update available, reload".

// Bump together with APP_VERSION in app/version.js on every release (a test checks).
const CACHE_VERSION = '0.5.0';
const SHELL_CACHE = `wmcoach-shell-${CACHE_VERSION}`;
const DATA_CACHE = 'wmcoach-data';
const NETWORK_FIRST = ['data/plan/', 'data/targets/'];
const NETWORK_TIMEOUT_MS = 3000;

// Every file the app needs offline. A test checks this list against the repo.
const SHELL_FILES = [
  "index.html",
  "manifest.webmanifest",
  "app/styles.css",
  "app/version.js",
  "app/main.js",
  "app/db.js",
  "app/backup.js",
  "app/seed.js",
  "app/tz.js",
  "app/ui.js",
  "app/sw-client.js",
  "app/import-flow.js",
  "app/records.js",
  "app/chart.js",
  "app/training.js",
  "app/timer.js",
  "app/meal-plans.js",
  "app/sync.js",
  "app/sync-ui.js",
  "app/push.js",
  "app/push-config.js",
  "app/views/common.js",
  "app/views/install.js",
  "app/views/onboarding.js",
  "app/views/week.js",
  "app/views/log.js",
  "app/views/body.js",
  "app/views/meals.js",
  "app/views/history.js",
  "app/views/settings.js",
  "coach/time.js",
  "coach/trend.js",
  "coach/seed.js",
  "coach/model.js",
  "coach/program.js",
  "coach/body.js",
  "coach/phase.js",
  "coach/progression.js",
  "coach/meals.js",
  "coach/summary.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon-180.png",
  "data/program.json",
  "data/weight_daily.csv",
  "data/metabolic_profile.json",
  "data/plans.json"
];

const scopePath = new URL(self.registration.scope).pathname;
const SHELL_SET = new Set(SHELL_FILES);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' bypasses the HTTP cache so a new version never stores stale files.
    await cache.addAll(SHELL_FILES.map((path) => new Request(path, { cache: 'reload' })));
  })());
  // No skipWaiting() here on purpose.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('wmcoach-shell-') && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return; // e.g. api.github.com
  const rel = url.pathname.slice(scopePath.length);
  if (req.mode === 'navigate' || rel === '') {
    event.respondWith(fromShell('index.html', req));
  } else if (SHELL_SET.has(rel)) {
    event.respondWith(fromShell(rel, req));
  } else if (rel.startsWith('data/')) {
    if (NETWORK_FIRST.some((prefix) => rel.startsWith(prefix))) event.respondWith(networkFirst(req));
    else event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function fromShell(path, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && req.mode !== 'navigate') cache.put(path, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    const res = await Promise.race([network, new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null))]);
    if (res) return res;
  } catch {
    // offline: fall through to the cache
  }
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || network;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  return (await network) || new Response('', { status: 504, statusText: 'Offline' });
}

// ---- Web Push (spec §8.4): the daily routine sends { title, body, url, tag } -----------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'WMCoach', {
    body: data.body || '',
    tag: data.tag || 'wmcoach',
    icon: 'icons/icon-192.png',
    data: { url: data.url || './#/week' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // only ever open a page of this app
  const scope = self.registration.scope;
  let url = new URL((event.notification.data && event.notification.data.url) || './#/week', scope).href;
  if (!url.startsWith(scope)) url = scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of wins) {
      if (win.url.startsWith(scope) && 'focus' in win) {
        await win.focus();
        if ('navigate' in win) await win.navigate(url).catch(() => {});
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
