// History tab (spec §4.5). Stage 1: phase timeline and what's stored on this phone.
import { h, icon, fmtInt } from '../ui.js';
import { header, sectionLabel, note, phaseRange } from './common.js';
import { getAll, count, getMeta } from '../db.js';
import { formatDayMonth } from '../../coach/time.js';

export async function render(screen, ctx) {
  const phases = (await getAll(ctx.db, 'phases')).sort((a, b) => (a.start < b.start ? 1 : -1));
  const [weighins, snapshots, lastExport] = await Promise.all([
    count(ctx.db, 'weighins'), count(ctx.db, 'snapshots'), getMeta(ctx.db, 'last_export'),
  ]);
  const today = ctx.today();
  const gear = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', onClick: () => ctx.navigate('#/settings') }, icon('gear'));

  screen.append(
    header({ label: 'History', title: 'Phases', right: gear }),
    h('div', { class: 'card flush list' }, phases.map((p) => h('div', { class: 'item' },
      h('span', { class: `phase-dot ${p.kind}` }),
      h('span', { class: 'grow' }, h('div', {}, p.label), h('div', { class: 'muted xsmall num' }, phaseRange(p, today)))))),
    sectionLabel('On this phone'),
    h('div', { class: 'card flush list' },
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Weigh-ins'), h('span', { class: 'value' }, fmtInt(weighins))),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Update snapshots'), h('span', { class: 'value' }, fmtInt(snapshots))),
      h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Last backup'), h('span', { class: 'value' }, lastExport ? `${formatDayMonth(lastExport.local_date)} ${lastExport.local_date.slice(0, 4)}` : 'Never'))),
    h('div', { style: 'margin-top:16px' }, note('Sessions, lift trends, weekly volume and measurements arrive with stages 2–3.')));
}
