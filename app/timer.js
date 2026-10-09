// Rest timer (spec §4.2): starts when a set is logged; editable. Counts against
// an end timestamp, so it stays right if the phone sleeps or the app is
// backgrounded. A short chime plays at the end (audio unlocked by the ✓ tap).
import { h, icon } from './ui.js';

let el = null;
let endAt = 0;
let tick = null;
let audio = null;
let hideTimer = null;

function fmt(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function ensure() {
  if (el) return el;
  const time = h('span', { class: 'rest-time num', 'aria-live': 'off' });
  const label = h('span', { class: 'rest-label' });
  const adjust = (d) => { endAt = Math.max(Date.now() + 1000, endAt + d * 1000); render(); };
  el = h('div', { class: 'rest', role: 'timer', 'aria-label': 'Rest timer' },
    h('div', { class: 'rest-main' }, time, label),
    h('button', { type: 'button', class: 'rest-btn', 'aria-label': 'Rest 15 seconds less', onClick: () => adjust(-15) }, '−15'),
    h('button', { type: 'button', class: 'rest-btn', 'aria-label': 'Rest 15 seconds more', onClick: () => adjust(15) }, '+15'),
    h('button', { type: 'button', class: 'rest-btn', 'aria-label': 'Stop rest timer', onClick: () => stopRest() }, icon('close', { size: 18 })));
  el.time = time;
  el.label = label;
  document.body.append(el);
  return el;
}

function render() {
  if (!el) return;
  const left = endAt - Date.now();
  el.time.textContent = left > 0 ? fmt(left) : 'Go';
  el.classList.toggle('done', left <= 0);
  if (left <= 0 && tick) {
    clearInterval(tick);
    tick = null;
    chime();
    el.label.textContent = el.label.dataset.next ? `Next: ${el.label.dataset.next}` : 'Rest done';
    hideTimer = setTimeout(() => stopRest(), 12000);
  }
}

export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio */ }
}

function chime() {
  if (!audio) return;
  try {
    const t0 = audio.currentTime;
    [0, 0.18].forEach((dt, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = i ? 1046 : 784;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.3);
    });
  } catch { /* ignore */ }
}

export function startRest(seconds, { next = null } = {}) {
  if (!seconds || seconds <= 0) return;
  ensure();
  clearTimeout(hideTimer);
  endAt = Date.now() + seconds * 1000;
  el.label.dataset.next = next || '';
  el.label.textContent = next ? `Rest · next ${next}` : 'Rest';
  el.classList.add('show');
  el.classList.remove('done');
  document.body.classList.add('resting'); // room at the bottom so the pill never hides Finish
  clearInterval(tick);
  tick = setInterval(render, 250);
  render();
}

export function stopRest() {
  clearInterval(tick);
  tick = null;
  clearTimeout(hideTimer);
  if (el) el.classList.remove('show', 'done');
  document.body.classList.remove('resting');
}

export function restRunning() {
  return Boolean(tick);
}

// Keep the screen on while a session is in progress (Safari 16.4+).
let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
