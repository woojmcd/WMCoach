// Notifications (spec §8.4, Walter 2026-10-09): permission is asked once, from a
// button, in the installed app. The subscription syncs to data/log/ so the daily
// routine can send the check-in-morning and plan notices by Web Push.
import { getMeta, setMeta } from './db.js';
import { VAPID_PUBLIC_KEY } from './push-config.js';

function keyBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

// 'unsupported' | 'install' (iOS: only home-screen apps can get push) | 'default' | 'granted' | 'denied',
// plus whether this phone's subscription is synced and uses the current key.
export async function pushState(db) {
  const sub = await getMeta(db, 'push_subscription');
  const current = Boolean(sub && sub.endpoint && sub.vapid_public_key === VAPID_PUBLIC_KEY && !sub.revoked);
  if (!pushSupported()) return { permission: isStandalone() ? 'unsupported' : 'install', subscribed: false, sub };
  return { permission: Notification.permission, subscribed: current && Notification.permission === 'granted', sub };
}

// Must run inside a tap handler (iOS asks only from a user gesture).
export async function enablePush(db, { now = new Date() } = {}) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, permission };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const saved = await getMeta(db, 'push_subscription');
  if (sub && saved && saved.vapid_public_key && saved.vapid_public_key !== VAPID_PUBLIC_KEY) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const json = sub.toJSON();
  await setMeta(db, 'push_subscription', {
    endpoint: json.endpoint,
    keys: json.keys,
    vapid_public_key: VAPID_PUBLIC_KEY,
    created_utc: (saved && saved.endpoint === json.endpoint && saved.created_utc) || now.toISOString(),
    updated_utc: now.toISOString(),
  });
  return { ok: true, permission };
}

export async function disablePush(db, { now = new Date() } = {}) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* already gone */ }
  const saved = await getMeta(db, 'push_subscription');
  await setMeta(db, 'push_subscription', { ...(saved || {}), endpoint: null, keys: null, revoked: true, updated_utc: now.toISOString() });
}

// A local notification through the service worker: proves permission works on this phone.
export async function testNotification() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('WMCoach', {
    body: 'Notifications work. You’ll get one on check-in mornings and when a new plan is ready.',
    tag: 'wmcoach-test',
    icon: 'icons/icon-192.png',
    data: { url: './#/week' },
  });
}
