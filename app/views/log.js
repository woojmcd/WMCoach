// Log tab (spec §4.2): today's session, fast set logging, rest timer,
// "Finish session" → next targets computed on-device (spec §6.2).
import { h, icon, toast, openSheet, confirmSheet, stepper, chips, segmented } from '../ui.js';
import { header, note, healthChip, addonCard } from './common.js';
import { put } from '../db.js';
import { saveDaily } from '../records.js';
import {
  loadTraining, draftSession, saveSession, logSet, updateExercise, progressCount, finishSession, planFor, exerciseFromPlan, restAfter, setFromPlan,
} from '../training.js';
import { startRest, stopRest, unlockAudio, keepAwake } from '../timer.js';
import { targetFor, historyFor, RIR_CHIPS } from '../../coach/progression.js';
import { dayForWeekday, slug } from '../../coach/program.js';
import { isoWeekday, formatDayMonth, WEEKDAYS } from '../../coach/time.js';

const ui = { dayDow: null, active: null, date: null };

const KIND_LABEL = { work: 'Set', top: 'Top', backoff: 'Backoff', amrap: 'Set', timed: 'Set' };

function programIndex(program) {
  const idx = {};
  for (const d of program.days) for (const e of d.exercises) idx[e.id] = e;
  return idx;
}

export function fmtLoad(load, ex) {
  if (ex.load_kind === 'bodyweight') return load ? `BW +${load}` : 'BW';
  if (load === null || load === undefined) return '—';
  if (ex.load_kind === 'assistance') return `${load} lb assist`;
  return `${load} lb`;
}

function repsText(t) {
  if (t.amrap || (t.reps_min === null && t.aim === null)) return 'max';
  if (t.reps_min !== null && t.reps_max !== null && t.reps_min !== t.reps_max) return `${t.reps_min}–${t.reps_max}`;
  return String(t.reps_min ?? t.aim);
}

function rirText(rir) {
  if (!rir) return '';
  return `RIR ${rir[0] === rir[1] ? rir[0] : `${rir[0]}–${rir[1]}`}`;
}

function targetLine(e, pex) {
  const first = e.sets.find((s) => !s.skipped) || e.sets[0];
  if (!first) return '';
  const t = first.target;
  if (e.type === 'timed') return `${e.sets.length} × ${t.seconds} s`;
  if (e.type === 'superset_same_weight') return `Same weight · to failure${first.target.aim ? ` · beat ${e.sets.reduce((a, s) => a + (s.target.aim || 0), 0)}` : ''}`;
  if (e.type === 'amrap') return e.reason && e.reason.startsWith('Beat') ? `${fmtLoad(t.load, pex)} · ${e.reason.toLowerCase()}` : `${fmtLoad(t.load, pex)} × as many as possible`;
  if (e.calibration) return `Calibrate · ${repsText(t)} reps ${rirText(t.rir)}`;
  return `Target ${fmtLoad(t.load, pex)} × ${repsText(t)} ${rirText(t.rir)}`.trim();
}

// Display order: superset partners interleave (A1·1, A2·1, A1·2, …).
function rowsForCard(session, idxs) {
  const rows = [];
  const max = Math.max(...idxs.map((i) => session.exercises[i].sets.length));
  if (idxs.length > 1) {
    for (let k = 0; k < max; k += 1) for (const i of idxs) if (session.exercises[i].sets[k]) rows.push([i, k]);
  } else {
    session.exercises[idxs[0]].sets.forEach((_, k) => rows.push([idxs[0], k]));
  }
  return rows;
}

function cards(session) {
  const out = [];
  session.exercises.forEach((e, i) => {
    const prev = out[out.length - 1];
    if (e.group && prev && session.exercises[prev[0]].group === e.group) prev.push(i);
    else out.push([i]);
  });
  return out;
}

function allRows(session) {
  return cards(session).flatMap((c) => rowsForCard(session, c));
}

function firstOpen(session, rows = allRows(session)) {
  return rows.find(([i, k]) => !session.exercises[i].skipped && !session.exercises[i].sets[k].done && !session.exercises[i].sets[k].skipped) || null;
}

export async function render(screen, ctx) {
  if (!ctx.program) {
    screen.append(header({ label: 'Today', title: 'Log' }), note('Program not loaded yet: connect once to fetch it.'));
    return;
  }
  const training = await loadTraining(ctx);
  ctx.training = training;
  const today = training.today;
  if (ui.date !== today) { ui.date = today; ui.dayDow = null; ui.active = null; }
  const todays = training.sessions.filter((s) => s.local_date === today);
  const dow = ui.dayDow ?? (todays.length ? todays[todays.length - 1].day_dow : isoWeekday(today));
  const day = dayForWeekday(ctx.program, dow);
  const pidx = programIndex(ctx.program);

  if (!day.exercises.length) {
    ctx.setActiveSession(null);
    return renderOpenDay(screen, ctx, training);
  }

  let session = todays.filter((s) => s.day_dow === dow).pop() || draftSession(ctx, training, day);
  ctx.setActiveSession(session.status === 'in_progress' ? session : null);
  keepAwake(session.status === 'in_progress');

  const prog = progressCount(session);
  const label = `Today · ${WEEKDAYS[isoWeekday(today) - 1]} ${formatDayMonth(today)} · ${training.week === 0 ? 'lead-in week' : `week ${training.week}`}`;
  const change = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Change workout', onClick: () => chooseDay(ctx, today) }, icon('week'));
  screen.append(header({ label, title: day.name, right: change }));

  if (training.healthMissing) screen.append(h('div', { class: 'chip-row' }, healthChip(), h('span', { class: 'muted xsmall' }, 'Today’s recovery data isn’t in yet.')));
  for (const a of training.addons) screen.append(addonCard(a));

  // notices
  const notices = [];
  const rd = training.readiness;
  if (rd && !session.deload && session.status === 'draft') {
    if (rd.status === 'amber') notices.push(['Readiness: amber', `${cap(rd.reason)}. Loads held today; beating a held target still counts as progress.`]);
    if (rd.status === 'red') notices.push(['Readiness: red', `${cap(rd.reason)}. Same loads, one set fewer per exercise.`]);
  }
  if (session.deload) notices.push(['Deload week', 'Half the sets, same loads, RIR 3+; finishers stop 2 short of failure.']);
  if (ctx.settings.lifted_less_since_may && training.week <= 2 && !session.deload) notices.push(['Easing back in', training.week <= 1 ? 'One rep further from failure (RIR +1), no load increases this week.' : 'One rep further from failure (RIR +1) this week.']);
  const calibrating = session.exercises.filter((e) => e.calibration && !e.skipped).length;
  if (calibrating && session.status !== 'finished') {
    const all = calibrating === session.exercises.filter((e) => e.type !== 'timed').length;
    notices.push(['Calibration', all
      ? 'No loads on record yet: log the weight you actually use. Progression starts from there.'
      : `${calibrating} exercise${calibrating === 1 ? ' has' : 's have'} no load on record yet: log the weight you use.`]);
  }
  for (const [title, text] of notices) screen.append(h('div', { class: 'banner', style: 'margin-bottom:12px' }, h('span', { class: 'grow' }, h('div', { class: 'strong' }, title), h('div', { class: 'muted xsmall' }, text))));

  if (session.status !== 'draft') {
    const started = session.started_utc ? new Date(session.started_utc) : null;
    const mins = started ? Math.round(((session.finished_utc ? new Date(session.finished_utc) : new Date()) - started) / 60000) : 0;
    screen.append(h('p', { class: 'muted small', style: 'margin:0 0 12px' },
      session.status === 'finished' ? `Done · ${prog.done} sets · ${mins} min` : `In progress · ${prog.done} of ${prog.total} sets · ${mins} min`));
  }

  if (!ui.active || !session.exercises[ui.active[0]] || !session.exercises[ui.active[0]].sets[ui.active[1]]) {
    ui.active = session.status === 'finished' ? null : firstOpen(session);
  }

  const save = async (next, { rest = null } = {}) => {
    const saved = await saveSession(ctx.db, next);
    ctx.setActiveSession(saved.status === 'in_progress' ? saved : null);
    if (rest) startRest(rest.seconds, { next: rest.next });
    ctx.refresh();
    return saved;
  };

  const stack = h('div', { class: 'stack' });
  for (const idxs of cards(session)) stack.append(exerciseCard(ctx, { session, idxs, pidx, training, save }));
  screen.append(stack);

  // finish
  if (session.status === 'in_progress') {
    screen.append(h('div', { style: 'margin-top:24px' },
      h('button', {
        type: 'button', class: 'btn primary block',
        onClick: async () => {
          const left = progressCount(session);
          if (left.done < left.total) {
            const ok = await confirmSheet({ title: 'Finish session?', message: `${left.total - left.done} set${left.total - left.done === 1 ? '' : 's'} not logged. They won’t count toward progression.`, confirm: 'Finish' });
            if (!ok) return;
          }
          const done = await finishSession(ctx.db, session);
          stopRest();
          keepAwake(false);
          ctx.setActiveSession(null);
          ui.active = null;
          await showNextTargets(ctx, done, day);
          ctx.refresh();
        },
      }, 'Finish session')));
  } else if (session.status === 'finished') {
    screen.append(h('div', { class: 'center', style: 'margin-top:16px' },
      h('button', { type: 'button', class: 'link-btn', onClick: () => showNextTargets(ctx, session, day) }, 'Next session targets')));
  }
}

// ---- one card: an exercise, or a superset pair ------------------------------------------------

function exerciseCard(ctx, { session, idxs, pidx, training, save }) {
  const card = h('div', { class: 'card ex-card' });
  for (const i of idxs) {
    const e = session.exercises[i];
    const pex = pidx[e.slot_id];
    const badge = e.change === 'up' && e.delta_lb
      ? h('span', { class: 'badge up' }, e.delta_lb > 0 ? `▲ +${e.delta_lb} lb` : `▲ ${Math.abs(e.delta_lb)} lb less assist`)
      : e.change === 'down' ? h('span', { class: 'badge' }, `▼ ${e.delta_lb} lb`)
        : e.calibration ? h('span', { class: 'badge' }, 'Calibrate') : null;
    const more = h('button', { type: 'button', class: 'icon-btn small', 'aria-label': `More for ${e.name}`, onClick: () => exerciseActions(ctx, { session, i, pex, training, save }) }, h('span', { class: 'dots' }, '•••'));
    card.append(h('div', { class: `ex-head${e.skipped ? ' skipped' : ''}` },
      h('div', { class: 'row between', style: 'align-items:flex-start' },
        h('div', { class: 'grow' },
          h('div', { class: 'ex-name' }, e.label ? h('span', { class: 'ex-tag' }, e.label) : null, e.name),
          e.swapped_from ? h('div', { class: 'ex-cue' }, `Swapped for ${e.swapped_from}`) : null,
          pex && pex.cue ? h('div', { class: 'ex-cue' }, pex.cue) : null),
        badge, more),
      h('div', { class: 'ex-target' }, e.skipped ? 'Skipped' : targetLine(e, pex)),
      e.last && !e.skipped ? h('div', { class: 'ex-last' }, `Last: ${e.last}`) : null,
      e.reason && !e.skipped && (e.change === 'down' || /hold|held|set fewer|twice|Deload|easing|once more|Unassisted|Every set/i.test(e.reason)) ? h('div', { class: 'reason-chip' }, e.reason) : null,
      e.note ? h('div', { class: 'ex-cue' }, `Note: ${e.note}`) : null));
  }
  const rows = rowsForCard(session, idxs);
  const list = h('div', { class: 'sets' });
  for (const [i, k] of rows) {
    const e = session.exercises[i];
    if (e.skipped) continue;
    const isActive = ui.active && ui.active[0] === i && ui.active[1] === k;
    list.append(isActive ? setEditor(ctx, { session, i, k, pidx, idxs, save }) : setRow(ctx, { session, i, k, pidx, idxs, save }));
  }
  card.append(list);
  return card;
}

function setLabel(e, k, idxs) {
  const s = e.sets[k];
  if (idxs.length > 1) return `${e.label} · ${k + 1}`;
  if (s.kind === 'backoff') return 'Backoff';
  const sameKind = e.sets.filter((x) => x.kind === s.kind);
  return `${KIND_LABEL[s.kind]} ${sameKind.indexOf(s) + 1}`;
}

function valueText(s, pex) {
  if (s.kind === 'timed') return `${s.seconds} s`;
  const load = fmtLoad(s.load, pex);
  const reps = s.done ? s.reps : s.reps ?? (s.target.amrap || s.kind === 'amrap' ? 'max' : repsText(s.target));
  const rir = s.done && s.rir !== null && s.rir !== undefined && s.kind !== 'amrap' && !s.target.amrap ? ` · RIR ${s.rir}` : '';
  return `${load} × ${reps}${rir}`;
}

function setRow(ctx, { session, i, k, pidx, idxs, save }) {
  const e = session.exercises[i];
  const s = e.sets[k];
  const pex = pidx[e.slot_id];
  const activate = () => { ui.active = [i, k]; ctx.refresh(); };
  const check = h('button', {
    type: 'button', class: `check${s.done ? ' done' : ''}`, 'aria-label': s.done ? `Edit ${setLabel(e, k, idxs)}` : `Log ${setLabel(e, k, idxs)} as shown`,
    onClick: async () => {
      if (s.done || s.skipped || session.status === 'finished') { activate(); return; }
      const needsLoad = pex.load_kind === 'external' && (s.load === null || s.load === undefined);
      const needsReps = s.kind !== 'timed' && (s.reps === null || s.reps === undefined);
      if (needsLoad || needsReps) { ui.active = [i, k]; toast(needsLoad ? 'Enter the weight you used' : 'Enter your reps'); ctx.refresh(); return; }
      await commit(ctx, { session, i, k, values: { load: s.load, reps: s.reps, rir: s.rir, seconds: s.seconds }, pidx, save });
    },
  }, icon('check', { size: 20 }));
  return h('div', { class: `set-row${s.done ? ' done' : ''}${s.skipped ? ' skipped' : ''}` },
    h('button', { type: 'button', class: 'set-main', onClick: activate },
      h('span', { class: 'set-label' }, setLabel(e, k, idxs)),
      h('span', { class: 'set-value num' }, s.skipped ? 'skipped' : valueText(s, pex))),
    check);
}

async function commit(ctx, { session, i, k, values, pidx, save }) {
  unlockAudio();
  const e = session.exercises[i];
  const pex = pidx[e.slot_id];
  const wasDone = e.sets[k].done;
  let next = logSet(session, i, k, values, { increment: incrementFor(ctx, pex, e) });
  if (next.status === 'finished') {
    await put(ctx.db, 'sessions', { ...next, updated_utc: new Date().toISOString() });
    ui.active = null;
    ctx.refresh();
    return;
  }
  // rest + what's next: the next open set after this one (so a superset goes A1 → A2),
  // wrapping to the first open set if everything after it is done
  const rows = allRows(next);
  const at = rows.findIndex(([a, b]) => a === i && b === k);
  const after = rows.slice(at + 1).concat(rows.slice(0, at + 1));
  const open = firstOpen(next, after);
  ui.active = open;
  let rest = null;
  if (!wasDone && open) {
    const seconds = restAfter(e, pex, ctx.settings);
    const nextName = next.exercises[open[0]].name;
    rest = { seconds, next: nextName };
  }
  next = await save(next, { rest });
  if (open) setTimeout(() => scrollToActive(), 80);
}

function scrollToActive() {
  const el = document.querySelector('.set-editor');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 140 || r.top < 60) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function incrementFor(ctx, pex, e) {
  return (ctx.training && ctx.training.prefs[e.slot_id] && ctx.training.prefs[e.slot_id].increment_lb) || pex.increment_lb || 5;
}

function setEditor(ctx, { session, i, k, pidx, idxs, save }) {
  const e = session.exercises[i];
  const s = e.sets[k];
  const pex = pidx[e.slot_id];
  const finished = session.status === 'finished';
  let load = s.load;
  let reps = s.reps;
  let rir = s.rir;
  const kids = [];
  const inc = incrementFor(ctx, pex, e);
  const showRir = s.kind !== 'timed' && s.kind !== 'amrap' && !s.target.amrap && s.target.rir;

  if (s.kind === 'timed') {
    kids.push(h('p', { class: 'body', style: 'margin:0' }, `Hold ${s.seconds} s`));
  } else {
    const grid = h('div', { class: 'editor-grid' });
    if (e.type === 'superset_same_weight') {
      grid.append(h('div', { class: 'fixed-load' }, h('span', { class: 'muted xsmall' }, 'Same weight'), h('span', { class: 'num' }, fmtLoad(load, pex))));
    } else if (pex.load_kind !== 'none') {
      const unit = pex.load_kind === 'bodyweight' ? '+lb' : pex.load_kind === 'assistance' ? 'assist' : 'lb';
      grid.append(stepper({ value: load, step: inc, min: 0, max: 1000, decimals: inc % 1 ? 1 : 0, unit, compact: true, label: `${e.name} weight`, placeholder: s.target.load ?? '', onChange: (v) => { load = v; } }));
    }
    grid.append(stepper({ value: reps, step: 1, min: 0, max: 100, unit: 'reps', compact: true, label: `${e.name} reps`, placeholder: s.target.aim ?? s.target.reps_min ?? '', onChange: (v) => { reps = v; } }));
    kids.push(grid);
    if (showRir) {
      kids.push(h('div', { class: 'rir-row' }, h('span', { class: 'label' }, 'RIR'),
        chips(RIR_CHIPS.map((n) => ({ value: n, label: n === 4 ? '4+' : String(n) })), rir, (v) => { rir = v; }, { label: `${e.name} reps in reserve` })));
    }
  }
  const getValues = () => {
    const steppers = kids[0] && kids[0].querySelectorAll ? kids[0].querySelectorAll('.stepper') : [];
    // read the inputs (a typed value may not have fired change yet)
    if (steppers.length === 2) { load = steppers[0].getValue(); reps = steppers[1].getValue(); } else if (steppers.length === 1) { reps = steppers[0].getValue(); }
    return { load, reps, rir: showRir ? rir : s.kind === 'amrap' || s.target.amrap ? 0 : rir, seconds: s.seconds };
  };
  const logBtn = h('button', {
    type: 'button', class: 'btn primary', style: 'flex:1 1 auto',
    onClick: async () => {
      const v = getValues();
      if (s.kind !== 'timed' && !(v.reps >= 0 && v.reps !== null)) { toast('Enter your reps'); return; }
      if (pex.load_kind === 'external' && e.type !== 'superset_same_weight' && !(v.load > 0)) { toast('Enter the weight you used'); return; }
      await commit(ctx, { session, i, k, values: v, pidx, save });
    },
  }, icon('check', { size: 20 }), s.done || finished ? 'Save' : s.kind === 'timed' ? 'Done' : 'Log set');
  const skipBtn = !s.done && !finished ? h('button', {
    type: 'button', class: 'btn outline small',
    onClick: async () => {
      const exs = session.exercises.map((x, xi) => (xi === i ? { ...x, sets: x.sets.map((y, yk) => (yk === k ? { ...y, skipped: true } : y)) } : x));
      ui.active = null;
      await save({ ...session, exercises: exs });
    },
  }, 'Skip set') : h('button', { type: 'button', class: 'btn outline small', onClick: () => { ui.active = null; ctx.refresh(); } }, 'Close');
  kids.push(h('div', { class: 'row', style: 'gap:8px' }, skipBtn, logBtn));
  return h('div', { class: 'set-editor' }, h('div', { class: 'set-label' }, setLabel(e, k, idxs), s.target && s.target.aim && !s.done ? h('span', { class: 'faint' }, ` · aim ${s.target.aim}`) : null), ...kids);
}

// ---- per-exercise actions: swap, add a set, skip, note ------------------------------------

function exerciseActions(ctx, { session, i, pex, training, save }) {
  const e = session.exercises[i];
  const anyDone = e.sets.some((s) => s.done);
  const sheet = openSheet({
    title: e.name,
    actions: [
      { label: 'Swap exercise', kind: 'outline', onClick: () => { if (anyDone) { toast('Sets already logged: skip it and add the swap next time'); return true; } swapSheet(ctx, { session, i, pex, training, save }); return false; } },
      {
        label: 'Add a set', kind: 'outline',
        onClick: async () => {
          const last = e.sets[e.sets.length - 1];
          const added = setFromPlan({ ...last.target, kind: last.kind });
          added.load = last.load;
          await save(updateExercise(session, i, { sets: [...e.sets, added] }));
        },
      },
      { label: e.skipped ? 'Unskip exercise' : 'Skip exercise', kind: 'outline', onClick: async () => { ui.active = null; await save(updateExercise(session, i, { skipped: !e.skipped })); } },
      { label: e.note ? 'Edit note' : 'Add a note', kind: 'outline', onClick: () => { noteSheet(ctx, { session, i, save }); return false; } },
      { label: 'Close', kind: 'ghost' },
    ],
  });
  return sheet;
}

function noteSheet(ctx, { session, i, save }) {
  const e = session.exercises[i];
  const area = h('textarea', { class: 'input', placeholder: 'e.g. machine 3 taken, used cables', value: e.note || '', 'aria-label': 'Exercise note' });
  openSheet({ title: `Note · ${e.name}`, body: area, actions: [{ label: 'Save', kind: 'primary', onClick: async () => { await save(updateExercise(session, i, { note: area.value.trim() || null })); } }, { label: 'Cancel', kind: 'outline' }] });
}

function swapSheet(ctx, { session, i, pex, training, save }) {
  const e = session.exercises[i];
  const prefs = training.prefs[e.slot_id] || {};
  const names = [...new Set([...(pex.alternates || []), ...(prefs.alternates || [])])].filter((n) => n !== e.name);
  if (e.swapped_from) names.unshift(e.swapped_from);
  let remember = false;
  const custom = h('input', { class: 'input', placeholder: 'Other exercise…', 'aria-label': 'Other exercise name' });
  const apply = async (name) => {
    if (!name) return;
    const original = e.swapped_from || pex.name;
    const backToOriginal = name === original;
    const movement = backToOriginal ? pex.movement : slug(name);
    const hist = historyFor(training.sessions, e.slot_id, movement);
    const t = targetFor(pex, hist, { mode: ctx.settings.mode, deload: session.deload });
    const ex2 = exerciseFromPlan({ ex: pex, movement, name: backToOriginal ? pex.name : name, swapped_from: backToOriginal ? null : original, target: t });
    if (remember) {
      const alts = [...new Set([...(prefs.alternates || []), ...(backToOriginal ? [] : [name])])];
      await put(ctx.db, 'exercise_prefs', { ...prefs, id: e.slot_id, alternates: alts, swap: backToOriginal ? null : { name, movement }, updated_utc: new Date().toISOString() });
    }
    ui.active = null;
    await save({ ...session, exercises: session.exercises.map((x, xi) => (xi === i ? ex2 : x)) });
    toast(backToOriginal ? `Back to ${name}` : `Swapped to ${name}${remember ? ' from now on' : ''}`);
  };
  const list = h('div', { class: 'list' }, names.map((n) => h('button', { type: 'button', class: 'item', onClick: () => { sheet.close(); apply(n); } }, h('span', { class: 'grow' }, n), icon('chevron', { size: 16 }))));
  const sheet = openSheet({
    title: 'Swap exercise',
    subtitle: 'Progression carries over only for the same movement; a new one starts with a calibration.',
    body: h('div', { class: 'stack' },
      names.length ? list : h('p', { class: 'muted small' }, 'No alternates saved for this exercise yet.'),
      custom,
      segmented([{ value: false, label: 'Just today' }, { value: true, label: 'From now on' }], false, (v) => { remember = v; }, { label: 'Swap scope' })),
    actions: [
      { label: 'Use this name', kind: 'primary', onClick: async () => { const n = custom.value.trim(); if (!n) { toast('Type a name or pick one above'); return true; } await apply(n); } },
      { label: 'Cancel', kind: 'outline' },
    ],
  });
}

// ---- choosing a different program day, open days, next targets -----------------------------

function chooseDay(ctx, today) {
  const days = ctx.program.days.filter((d) => d.exercises.length);
  const sheet = openSheet({
    title: 'Which workout?',
    subtitle: `Today is ${WEEKDAYS[isoWeekday(today) - 1]}. Pick another session if you’re shifting days.`,
    body: h('div', { class: 'list' }, days.map((d) => h('button', {
      type: 'button', class: 'item',
      onClick: () => { ui.dayDow = d.dow; ui.active = null; sheet.close(); ctx.refresh(); },
    }, h('span', { class: 'when', style: 'width:44px;color:var(--text-2);font-size:13px' }, d.day.toUpperCase()), h('span', { class: 'grow' }, d.name), icon('chevron', { size: 16 })))),
    actions: [{ label: 'Close', kind: 'outline' }],
  });
}

async function renderOpenDay(screen, ctx, training) {
  const today = training.today;
  const logged = training.stairs.filter((s) => s.local_date === today).pop() || null;
  let minutes = logged ? logged.minutes : 30;
  const field = stepper({ value: minutes, step: 5, min: 5, max: 180, unit: 'min', compact: true, label: 'Stairs minutes', onChange: (v) => { minutes = v; } });
  screen.append(
    header({ label: `Today · ${WEEKDAYS[isoWeekday(today) - 1]} ${formatDayMonth(today)}`, title: 'Open day' }),
    h('div', { class: 'card stack' },
      h('p', { class: 'label' }, 'Stairs'),
      field,
      h('button', {
        type: 'button', class: 'btn primary block',
        onClick: async () => {
          const v = field.getValue();
          if (!(v > 0)) return;
          await saveDaily(ctx.db, 'stairs', { localDate: today, tz: ctx.tz(), prefix: 'stairs', fields: { minutes: v } });
          toast(`Stairs ${v} min logged`);
          ctx.refresh();
        },
      }, icon('check', { size: 20 }), logged ? `Update stairs (${logged.minutes} min)` : 'Stairs ✓'),
      h('p', { class: 'muted xsmall', style: 'margin:0' }, 'For sessions that don’t reach Strava. Runs, rides and swims come from Strava once the daily run is set up.')),
    h('div', { class: 'center', style: 'margin-top:16px' },
      h('button', { type: 'button', class: 'link-btn', onClick: () => chooseDay(ctx, today) }, 'Lift today instead')));
}

// One line of a plan preview: "Flat DB Bench · ▲ 75 lb × 8–10".
export function planTargetText(p) {
  const t = p.target;
  const first = t.sets[0];
  if (!first) return '';
  if (p.ex.type === 'timed') return `${t.sets.length} × ${first.seconds} s`;
  if (t.calibration) return 'calibrate';
  if (p.ex.type === 'superset_same_weight') return `same weight${first.aim ? ` · beat ${t.sets.reduce((a, x) => a + (x.aim || 0), 0)}` : ''}`;
  if (p.ex.type === 'amrap') return t.reason;
  return `${fmtLoad(t.load, p.ex)} × ${repsText(first)}`;
}

export function planItem(p) {
  const mark = p.target.change === 'up' ? '▲ ' : p.target.change === 'down' ? '▼ ' : '';
  return h('div', { class: 'item' }, h('span', { class: 'grow' }, p.ex.label ? `${p.ex.label} ${p.name}` : p.name), h('span', { class: `value${mark === '▲ ' ? ' accent' : ''}` }, `${mark}${planTargetText(p)}`));
}

async function showNextTargets(ctx, session, day) {
  const training = await loadTraining(ctx);
  const plan = planFor(ctx, training, day);
  const lines = plan.map(planItem);
  openSheet({
    title: session.status === 'finished' ? 'Session saved' : 'Next session',
    subtitle: `Next ${day.name}: targets worked out on this phone.`,
    body: h('div', { class: 'list' }, lines),
    actions: [{ label: 'Done', kind: 'primary' }],
  });
}

function cap(x) {
  return x ? x.charAt(0).toUpperCase() + x.slice(1) : x;
}
