// Meals tab (spec §4.4): arrives in stage 4.
import { h } from '../ui.js';
import { header, note } from './common.js';

export function render(screen) {
  screen.append(
    header({ label: 'Meals', title: 'Week 1' }),
    h('div', { class: 'stack' },
      h('div', { class: 'card stack-sm' },
        h('p', { class: 'label' }, 'Starting plan'),
        h('p', { class: 'body', style: 'margin:0' }, 'The bulk starts from CUT26-V4’s high-carb day (MP2), every day: the same meals, foods and cooked weights you already prep.')),
      note('The plan, “What changed”, the prep list and the grocery list arrive in stage 4.')));
}
