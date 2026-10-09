// History tab (spec §4.5). Stage 1: phase timeline and what's stored on this phone.
import { h, icon, fmtInt, openSheet } from '../ui.js';
import { header, sectionLabel, note, phaseRange, sessionList } from './common.js';
import { progressCount } from '../training.js';
import { getAll, count, getMeta } from '../db.js';
import { live } from '../records.js';
import { formatDayMonth, isoWeekday, WEEKDAYS } from '../../coach/time.js';

export async function render(screen, ctx) {
  const phases = (await getAll(ctx.db, 'phases')).filter((p) => !p.superseded).sort((a, b) => (a.start < b.start ? 1 : -1));
  const [weighins, snapshots, lastExport] = await Promise.all([
    getAll(ctx.db, 'weighins').then((all) => live(all).length), count(ctx.db, 'snapshots'), getMeta(ctx.db, 'last_export'),
  ]);
  const today = ctx.today();
  const gear = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', onClick: () => ctx.navigate('#/settings') }, icon('gear'));

  const sessions = live(await getAll(ctx.db, 'sessions')).filter((x) => x.status !== 'draft')
    .sort((a, b) => (a.local_date === b.local_date ? ((a.started_utc || '') < (b.started_utc || '') ? 1 : -1) : a.local_date < b.local_date ? 1 : -1));
  const sessionRows = sessions.slice(0, 30).map((x) => {
    const p = progressCount(x);
    return h('button', {
      type: 'button', class: 'item',
      onClick: () => openSheet({ title: `${x.day_name} · ${formatDayMonth(x.local_date)}`, subtitle: `${p.done} sets${x.deload ? ' · deload' : ''}${x.status === 'in_progress' ? ' · in progress' : ''}`, body: sessionList(x, ctx.program), actions: [{ label: 'Close', kind: 'outline' }] }),
    }, h('span', { class: 'when', style: 'width:76px;flex:0 0 auto;color:var(--text-2);font-size:13px' }, `${WEEKDAYS[isoWeekday(x.local_date) - 1]} ${formatDayMonth(x.local_date)}`),
    h('span', { class: 'grow' }, x.day_name), h('span', { class: 'value xsmall' }, `${p.done} sets`), icon('chevron', { size: 16 }));
  });

  screen.append(
    header({ label: 'History', title: 'Training', right: gear }),
    sessionRows.length ? h('div', { class: 'card flush list' }, sessionRows) : note('No sessions yet. Log one on the Log tab; it shows up here.'),
    sectionLabel('Phases'),
    h('div', { class: 'card flush list' }, phases.map((p) => h('div', { class: 'item' },
      h('span', { class: `phase-dot ${p.kind}` }),
      h('span', { class: 'grow' }, h('div', {}, p.label), h('div', { class: 'muted xsmall num' }, phaseRange(p, today)))))),
    sectionLabel('On this phone'),
    h('div', { class: 'card flush list' },
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Weigh-ins'), h('span', { class: 'value' }, fmtInt(weighins))),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Update snapshots'), h('span', { class: 'value' }, fmtInt(snapshots))),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Last backup'), h('span', { class: 'value' }, lastExport ? `${formatDayMonth(lastExport.local_date)} ${lastExport.local_date.slice(0, 4)}` : 'Never'))),
    h('div', { style: 'margin-top:16px' }, note('Lift trends (estimated 1RM, PRs) and weekly volume per muscle come in a later stage.')));
}
