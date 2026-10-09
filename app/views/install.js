// Shown in a Safari tab (spec §3): install first, because Safari-tab data and
// home-screen-app data are stored separately.
import { h, icon, clear } from '../ui.js';

export function renderInstall(root, { onContinue }) {
  clear(root);
  const share = h('span', { class: 'share-glyph' }, icon('share', { size: 20, label: 'Share' }));
  root.append(h('main', { class: 'screen no-tabs stack-lg' },
    h('div', { class: 'stack' },
      h('img', { class: 'monogram', src: 'icons/icon-192.png', alt: '' }),
      h('div', {}, h('p', { class: 'label' }, 'WMCoach'), h('h1', { class: 'title' }, 'Install on your iPhone'))),
    h('div', { class: 'card stack' },
      h('div', { class: 'install-step' }, h('span', { class: 'n' }, '1'), h('p', { class: 'body', style: 'margin:0' }, 'Tap ', share, ' Share in Safari’s toolbar.')),
      h('div', { class: 'install-step' }, h('span', { class: 'n' }, '2'), h('p', { class: 'body', style: 'margin:0' }, 'Choose ', h('span', { class: 'strong' }, 'Add to Home Screen'), ', then Add.')),
      h('div', { class: 'install-step' }, h('span', { class: 'n' }, '3'), h('p', { class: 'body', style: 'margin:0' }, 'Open WMCoach from your home screen.'))),
    h('p', { class: 'muted small' }, 'Safari and the home-screen app keep separate data. Log only in the installed app, or entries made here won’t be there.'),
    h('button', { type: 'button', class: 'btn ghost block', onClick: onContinue }, 'Continue in Safari (testing only)')));
}
