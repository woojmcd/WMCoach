// Small UI toolkit: DOM helper, line icons, toast, bottom sheets, steppers.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---- icons: one thin-stroke (1.5 px) set, inline SVG ------------------------------

function gearPath() {
  const teeth = 8; const r1 = 9.25; const r2 = 7.4; const pts = [];
  for (let i = 0; i < teeth * 2; i += 1) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? r1 : r2;
    pts.push([12 + r * Math.cos(a0 + 0.08), 12 + r * Math.sin(a0 + 0.08)], [12 + r * Math.cos(a1 - 0.08), 12 + r * Math.sin(a1 - 0.08)]);
  }
  return `M${pts.map((p) => p.map((n) => n.toFixed(2)).join(' ')).join('L')}Z`;
}

const ICONS = {
  week: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  log: '<path d="M6.5 7.5v9M17.5 7.5v9M3.75 10v4M20.25 10v4M6.5 12h11"/>',
  body: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.5 10.5a5 5 0 0 1 7 0M12 11.2l1.6-2"/>',
  meals: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0Z"/><path d="M9.5 8c0-1.2 1-1.6 1-2.8M13.5 8c0-1.2 1-1.6 1-2.8"/>',
  history: '<path d="M4 4.5V19.5H20"/><path d="M7.5 15.5l3.5-4.25 3 2.5 4.5-6"/>',
  gear: `<path d="${gearPath()}"/><circle cx="12" cy="12" r="3"/>`,
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7 10.5H5.5v10h13v-10H17"/>',
  upload: '<path d="M12 15.5V4.5M8 8.5l4-4 4 4"/><path d="M4.5 15v4.5h15V15"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  cloud: '<path d="M7.5 18.5h9.25a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 6.6 11.1 3.75 3.75 0 0 0 7.5 18.5Z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z"/>',
};

export function icon(name, { size = 24, label = null } = {}) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  if (label) span.setAttribute('aria-label', label);
  else span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---- toast ---------------------------------------------------------------------

let toastEl = null;
let toastTimer = null;
export function toast(text, ms = 2800) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  requestAnimationFrame(() => toastEl.classList.add('show'));
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---- bottom sheet ------------------------------------------------------------------

export function openSheet({ title = null, subtitle = null, body = null, actions = [], onClose = null, dismissible = true } = {}) {
  const scrim = h('div', { class: 'scrim' });
  const actionEls = actions.map((a) => h('button', {
    class: `btn block ${a.kind || ''}`,
    type: 'button',
    onClick: async () => {
      if (a.onClick) {
        const keep = await a.onClick();
        if (keep === true) return;
      }
      close();
    },
  }, a.label));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Sheet' },
    h('div', { class: 'grabber' }),
    title ? h('h2', { class: 'sheet-title' }, title) : null,
    subtitle ? h('p', { class: 'muted small', style: 'margin:0 0 8px' }, subtitle) : null,
    body,
    actions.length ? h('div', { class: 'actions' }, actionEls) : null);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    sheet.classList.remove('show');
    scrim.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 220);
    if (onClose) onClose();
  }
  function onKey(e) { if (e.key === 'Escape' && dismissible) close(); }
  if (dismissible) scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, sheet);
  requestAnimationFrame(() => { scrim.classList.add('show'); sheet.classList.add('show'); });
  return { close, el: sheet };
}

export function confirmSheet({ title, message, confirm = 'Confirm', kind = 'primary', cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet({
      title,
      body: message ? h('p', { class: 'muted body', style: 'margin:8px 0 0' }, message) : null,
      actions: [
        { label: confirm, kind, onClick: () => { answered = true; resolve(true); } },
        { label: cancel, kind: 'outline', onClick: () => { answered = true; resolve(false); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ---- controls ----------------------------------------------------------------------

export function segmented(options, current, onChange, { label = null } = {}) {
  const wrap = h('div', { class: 'segmented', role: 'group', 'aria-label': label || undefined });
  const buttons = options.map((o) => h('button', {
    type: 'button',
    'aria-pressed': String(o.value === current),
    onClick: () => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === btnFor(o.value)));
      onChange(o.value);
    },
  }, o.label));
  function btnFor(v) { return buttons[options.findIndex((o) => o.value === v)]; }
  append(wrap, buttons);
  return wrap;
}

export function chips(options, current, onChange, { label = null, className = '' } = {}) {
  const wrap = h('div', { class: `chips ${className}`.trim(), role: 'group', 'aria-label': label || undefined });
  const buttons = options.map((o) => h('button', {
    type: 'button',
    class: 'chip',
    'aria-pressed': String(o.value === current),
    onClick: () => {
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === o.value)));
      onChange(o.value);
    },
  }, o.label));
  return append(wrap, buttons);
}

// Number stepper: ± buttons for one-handed use; tapping the number opens the keypad.
export function stepper({ value = null, step = 1, min = -Infinity, max = Infinity, decimals = 0, unit = '', placeholder = '', compact = false, label = 'Value', onChange = () => {} }) {
  const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(decimals));
  const input = h('input', {
    class: 'input num',
    type: 'text',
    inputmode: decimals > 0 ? 'decimal' : 'numeric',
    autocomplete: 'off',
    enterkeyhint: 'done',
    'aria-label': label,
    placeholder,
    value: fmt(value),
  });
  let current = value;
  const set = (v, emit = true) => {
    if (v === null || Number.isNaN(v)) current = null;
    else current = Math.min(max, Math.max(min, Math.round(v * 10 ** decimals) / 10 ** decimals));
    input.value = fmt(current);
    if (emit) onChange(current);
  };
  input.addEventListener('change', () => {
    const raw = input.value.replace(',', '.').trim();
    set(raw === '' ? null : Number(raw));
  });
  input.addEventListener('focus', () => input.select());
  // From an empty field, the first tap fills in the suggested (placeholder) value.
  const suggested = placeholder !== '' && Number.isFinite(Number(placeholder)) ? Number(placeholder) : 0;
  const nudge = (d) => set(current === null ? suggested : current + d);
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': `Decrease ${label}`, onClick: () => nudge(-step) }, icon('minus'));
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': `Increase ${label}`, onClick: () => nudge(step) }, icon('plus'));
  const el = h('div', { class: `stepper${compact ? ' compact' : ''}` }, minus, input, unit ? h('span', { class: 'unit' }, unit) : null, plus);
  el.getValue = () => {
    const raw = input.value.replace(',', '.').trim();
    if (raw !== fmt(current)) set(raw === '' ? null : Number(raw), false);
    return current;
  };
  el.setValue = (v) => set(v, false);
  return el;
}

export function itemRow({ label, value = null, onClick = null, chevron = false, extra = null }) {
  const kids = [h('span', { class: 'grow' }, label), extra, value !== null ? h('span', { class: 'value' }, value) : null, chevron ? icon('chevron', { size: 18 }) : null];
  if (onClick) return h('button', { type: 'button', class: 'item', onClick }, kids);
  return h('div', { class: 'item' }, kids);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}
