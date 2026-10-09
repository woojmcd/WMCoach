// Service-worker registration and the safe update flow (spec §12a):
// a new version installs in the background but only takes over when Walter
// taps "Update available, reload". Never auto-reload.

let registration = null;
let onReady = () => {};

export async function registerServiceWorker({ onUpdateReady }) {
  onReady = onUpdateReady;
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
  if (registration.waiting && navigator.serviceWorker.controller) onReady();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // Only an *update* (there is already a controller) needs the banner.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onReady();
    });
  });
  return registration;
}

export function updateWaiting() {
  return Boolean(registration && registration.waiting && navigator.serviceWorker.controller);
}

// Resolves true when a new version is installed and waiting for Reload.
// update() returns before a found update finishes downloading, so wait for
// the installing worker to settle instead of reporting "latest" too early.
export async function checkForUpdate({ timeoutMs = 30000 } = {}) {
  if (!registration) return false;
  try {
    await registration.update();
  } catch {
    return false;
  }
  const worker = registration.installing;
  if (worker) {
    await new Promise((resolve) => {
      const settle = () => {
        if (worker.state !== 'installing') resolve();
      };
      worker.addEventListener('statechange', settle);
      setTimeout(resolve, timeoutMs);
      settle();
    });
  }
  return updateWaiting();
}

// Call only after the caller has saved a local snapshot.
export function activateWaitingUpdate() {
  if (!registration || !registration.waiting) return false;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}
