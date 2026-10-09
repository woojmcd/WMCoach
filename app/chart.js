// Trend chart (spec §3a charts, §4.3): raw weigh-ins as faint dots, the EWMA
// trend as a 2 px accent line, phase bands as tints (breaks hatched), 3–4 faint
// guides, a crosshair + tooltip, and an optional waist / body-fat panel
// underneath on the same date axis (its own scale; never a second y-axis on
// the weight plot, which would imply a correlation the scales invent).
import { h } from './ui.js';
import { addDays, daysBetween, formatDayMonth, formatMonthYear, isoWeekday, WEEKDAYS } from '../coach/time.js';

const NS = 'http://www.w3.org/2000/svg';
const GAP_DAYS = 14; // don't draw the trend across breaks in the data
const PHASE_FILL = {
  cut: 'var(--phase-cut)', bulk: 'var(--phase-bulk)', maintenance: 'var(--phase-maintenance)', break: 'var(--phase-break)',
};
const PHASE_NAME = { cut: 'Cut', bulk: 'Bulk', maintenance: 'Maintenance', break: 'Break' };
let chartSeq = 0;

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

// Clean tick values (e.g. 166, 168, 170) covering [lo, hi].
export function niceTicks(lo, hi, maxTicks = 4) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];
  const step = steps.find((st) => Math.floor(hi / st) - Math.ceil(lo / st) + 1 <= maxTicks) || 100;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

export function yDomain(values, minSpan) {
  if (!values.length) return null;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

// Split a date-sorted series wherever consecutive points are > GAP_DAYS apart.
export function segments(points) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && daysBetween(cur[cur.length - 1].date, p.date) > GAP_DAYS) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function dateLabel(date, spanDays) {
  return spanDays > 120 ? formatMonthYear(date) : formatDayMonth(date);
}

function nearest(points, date) {
  let best = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(daysBetween(p.date, date));
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

// opts: { points: [{date, weight, trend}] in display units (full history, so the
//         trend is warmed up), domain: [start, end], phases, unit, decimals,
//         overlay: null | { label, unit, decimals, points: [{date, value}] } }
export function trendChart(opts) {
  const id = ++chartSeq;
  const wrap = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite' });
  const legend = h('div', { class: 'legend' });
  let width = 335;
  let svgs = [];
  let api = null;

  const draw = () => {
    for (const el of svgs) el.remove();
    svgs = [];
    api = build(opts, width, id);
    svgs = api.svgs;
    wrap.prepend(...svgs);
  };

  function build(o, W, cid) {
    const [d0, d1] = o.domain;
    const span = Math.max(1, daysBetween(d0, d1));
    const padL = 38; const padR = 12; const padT = 10; const padB = 24;
    const plotW = W - padL - padR;
    const x = (date) => padL + (daysBetween(d0, date) / span) * plotW;
    const pts = o.points.filter((p) => p.date >= d0 && p.date <= d1);
    const dom = yDomain(pts.flatMap((p) => [p.weight, p.trend]), o.unit === 'kg' ? 1 : 2) || [0, 1];
    const H = 196;

    const main = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', tabindex: 0, 'aria-label': `Weight trend, ${formatDayMonth(d0)} to ${formatDayMonth(d1)}. Use left and right arrows to read values.` });
    const y = (v) => padT + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (H - padT - padB);
    const defs = svg('defs', {},
      svg('pattern', { id: `hatch-${cid}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, style: 'stroke: rgba(255,255,255,0.07); stroke-width: 1.5' })),
      svg('clipPath', { id: `clip-${cid}` }, svg('rect', { x: padL, y: 0, width: plotW, height: H })));
    main.append(defs);

    // phase bands
    const bands = svg('g', { 'clip-path': `url(#clip-${cid})` });
    const kindsShown = new Set();
    for (const ph of o.phases) {
      const a = ph.start > d0 ? ph.start : d0;
      const b = (ph.end || d1) < d1 ? ph.end || d1 : d1;
      if (a > b) continue;
      kindsShown.add(ph.kind);
      const x0 = x(a);
      const x1 = Math.min(padL + plotW, x(addDays(b, 1)));
      const attrs = { x: x0, y: padT, width: Math.max(0, x1 - x0), height: H - padT - padB };
      bands.append(svg('rect', { ...attrs, style: `fill: ${PHASE_FILL[ph.kind] || 'transparent'}` }));
      if (ph.kind === 'break') bands.append(svg('rect', { ...attrs, fill: `url(#hatch-${cid})` }));
    }
    main.append(bands);

    // guides + y labels
    for (const t of niceTicks(dom[0], dom[1], 4)) {
      main.append(svg('line', { x1: padL, x2: padL + plotW, y1: y(t), y2: y(t), class: 'guide' }));
      const lab = svg('text', { x: padL - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' });
      lab.textContent = Number.isInteger(t) ? String(t) : t.toFixed(1);
      main.append(lab);
    }
    // x labels: start, middle, end (never collide)
    const mid = addDays(d0, Math.round(span / 2));
    [[d0, 'start', padL], [mid, 'middle', x(mid)], [d1, 'end', padL + plotW]].forEach(([d, anchor, xx]) => {
      const lab = svg('text', { x: xx, y: H - 6, 'text-anchor': anchor, class: 'axis' });
      lab.textContent = dateLabel(d, span);
      main.append(lab);
    });

    // raw weigh-ins, then the trend on top
    const dots = svg('g', {});
    for (const p of pts) dots.append(svg('circle', { cx: x(p.date), cy: y(p.weight), r: 2.25, class: 'raw' }));
    main.append(dots);
    for (const seg of segments(pts)) {
      const d = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${y(p.trend).toFixed(1)}`).join(' ');
      main.append(svg('path', { d, class: seg.length > 1 ? 'trend' : 'trend single' }));
    }
    const last = pts[pts.length - 1];
    if (last) main.append(svg('circle', { cx: x(last.date), cy: y(last.trend), r: 4, class: 'end' }));

    // crosshair layer
    const cross = svg('line', { x1: 0, x2: 0, y1: padT, y2: H - padB, class: 'cross', visibility: 'hidden' });
    const mark = svg('circle', { r: 4.5, class: 'end', visibility: 'hidden' });
    main.append(cross, mark);
    const out = [main];

    // overlay panel on the same date axis
    let overlay = null;
    if (o.overlay) {
      const OH = 112;
      const ov = o.overlay;
      const opts2 = ov.points.filter((p) => p.date >= d0 && p.date <= d1);
      const od = yDomain(opts2.map((p) => p.value), ov.minSpan || 1) || [0, 1];
      const oy = (v) => 22 + (1 - (v - od[0]) / (od[1] - od[0])) * (OH - 22 - 10);
      const panel = svg('svg', { viewBox: `0 0 ${W} ${OH}`, width: W, height: OH, class: 'chart-svg overlay', role: 'img', 'aria-label': `${ov.label} over the same dates` });
      const title = svg('text', { x: padL, y: 12, class: 'axis title' });
      title.textContent = `${ov.label} (${ov.unit})`;
      panel.append(title);
      for (const t of niceTicks(od[0], od[1], 3)) {
        panel.append(svg('line', { x1: padL, x2: padL + plotW, y1: oy(t), y2: oy(t), class: 'guide' }));
        const lab = svg('text', { x: padL - 6, y: oy(t) + 4, 'text-anchor': 'end', class: 'axis' });
        lab.textContent = Number.isInteger(t) ? String(t) : t.toFixed(1);
        panel.append(lab);
      }
      if (opts2.length) {
        panel.append(svg('path', { d: opts2.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${oy(p.value).toFixed(1)}`).join(' '), class: 'overlay-line' }));
        for (const p of opts2) panel.append(svg('circle', { cx: x(p.date), cy: oy(p.value), r: 3.5, class: 'overlay-dot' }));
      } else {
        const none = svg('text', { x: padL + plotW / 2, y: OH / 2 + 6, 'text-anchor': 'middle', class: 'axis' });
        none.textContent = 'No measurements in this range yet';
        panel.append(none);
      }
      const cross2 = svg('line', { x1: 0, x2: 0, y1: 18, y2: OH - 10, class: 'cross', visibility: 'hidden' });
      panel.append(cross2);
      overlay = { cross: cross2, points: opts2 };
      out.push(panel);
    }

    // interaction: the crosshair finds the date; the tooltip reads every series there
    let index = -1;
    const show = (p) => {
      if (!p) return;
      index = pts.indexOf(p);
      const xx = x(p.date);
      for (const c of [cross, overlay && overlay.cross]) {
        if (!c) continue;
        c.setAttribute('x1', xx); c.setAttribute('x2', xx); c.setAttribute('visibility', 'visible');
      }
      mark.setAttribute('cx', xx); mark.setAttribute('cy', y(p.trend)); mark.setAttribute('visibility', 'visible');
      const strong = h('strong', {}, `${p.weight.toFixed(o.decimals)} ${o.unit}`);
      const parts = [strong, ` · trend ${p.trend.toFixed(o.decimals)}`];
      if (overlay) {
        const ovp = overlay.points.filter((q) => q.date <= p.date).pop();
        if (ovp) parts.push(` · ${o.overlay.short || o.overlay.label.toLowerCase()} ${ovp.value.toFixed(o.overlay.decimals)}`);
      }
      tip.replaceChildren(h('span', { class: 'when' }, `${WEEKDAYS[isoWeekday(p.date) - 1]} ${formatDayMonth(p.date)}`), h('span', {}, ...parts));
      tip.classList.add('show');
      const left = Math.max(0, Math.min(W - 200, xx - 100));
      tip.style.left = `${left}px`;
    };
    const hide = () => {
      for (const c of [cross, overlay && overlay.cross]) if (c) c.setAttribute('visibility', 'hidden');
      mark.setAttribute('visibility', 'hidden');
      tip.classList.remove('show');
    };
    const fromEvent = (e) => {
      const rect = main.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const frac = Math.min(1, Math.max(0, (px - padL) / plotW));
      return nearest(pts, addDays(d0, Math.round(frac * span)));
    };
    let hideTimer = null;
    main.addEventListener('pointerdown', (e) => { clearTimeout(hideTimer); show(fromEvent(e)); });
    main.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) show(fromEvent(e)); });
    main.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    main.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hideTimer = setTimeout(hide, 2500); });
    main.addEventListener('blur', hide);
    main.addEventListener('keydown', (e) => {
      if (!pts.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const next = index < 0 ? pts.length - 1 : Math.max(0, Math.min(pts.length - 1, index + (e.key === 'ArrowLeft' ? -1 : 1)));
      show(pts[next]);
    });
    return { svgs: out, kindsShown };
  }

  draw();
  const keys = [h('span', { class: 'key' }, h('i', { class: 'key-dot' }), 'Weigh-in'), h('span', { class: 'key' }, h('i', { class: 'key-line' }), 'Trend')];
  for (const kind of ['cut', 'maintenance', 'bulk', 'break']) {
    if (api.kindsShown.has(kind)) keys.push(h('span', { class: 'key' }, h('i', { class: `key-band ${kind}` }), PHASE_NAME[kind]));
  }
  legend.append(...keys);
  wrap.append(tip, legend);

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && Math.abs(w - width) > 1) { width = w; draw(); }
    });
    ro.observe(wrap);
  }
  return wrap;
}
