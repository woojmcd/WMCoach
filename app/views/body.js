// Body tab (spec §4.3). Stage 1 confirms what was seeded; the mode switch,
// daily weight entry, trend graph and Friday check-in arrive in stage 2.
import { h } from '../ui.js';
import { header, note, monthSpan } from './common.js';
import { getAll } from '../db.js';
import { formatDayMonth } from '../../coach/time.js';

const MODE_LABEL = { cut: 'Cut', maintenance: 'Maintenance', bulk: 'Bulk' };

export async function render(screen, ctx) {
  const all = await getAll(ctx.db, 'weighins');
  const history = all.filter((w) => w.source === 'history').sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
  const recent = all.filter((w) => w.source !== 'history').sort((a, b) => ((a.utc || a.local_date) < (b.utc || b.local_date) ? -1 : 1));
  const latest = recent[recent.length - 1] || history[history.length - 1];
  const today = ctx.today();
  const s = ctx.settings;

  const latestCard = latest
    ? h('div', { class: 'card stack-sm' },
      h('p', { class: 'label' }, latest.local_date === today ? 'Today' : `Latest · ${formatDayMonth(latest.local_date)} ${latest.local_date.slice(0, 4)}`),
      h('div', { class: 'hero' }, ctx.fmtWeight(latest.weight_lb), h('small', {}, ctx.unitLabel())),
      h('p', { class: 'muted small', style: 'margin:0' }, latest.source === 'health' ? 'From Apple Health' : latest.source === 'history' ? 'From history' : 'Logged in the app'))
    : null;

  screen.append(
    header({ label: 'Body', title: MODE_LABEL[s.mode] || 'Body' }),
    h('div', { class: 'stack' },
      latestCard,
      h('div', { class: 'card flush list' },
        h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Mode'), h('span', { class: 'value' }, `${MODE_LABEL[s.mode]} · since ${formatDayMonth(s.mode_since)}`)),
        h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Macros'), h('span', { class: 'value' }, 'Observe only, weeks 1–2')),
        history.length ? h('div', { class: 'item' }, h('span', { class: 'grow' }, 'History'), h('span', { class: 'value' }, `${history.length} weigh-ins · ${monthSpan(history[0].local_date, history[history.length - 1].local_date)}`)) : null,
        recent.length ? h('div', { class: 'item' }, h('span', { class: 'grow' }, 'Since history'), h('span', { class: 'value' }, `${recent.length} weigh-in${recent.length === 1 ? '' : 's'}`)) : null),
      note('Daily weight, the trend graph, the mode switch and the Friday measurements and check-in arrive in stage 2.')));
}
