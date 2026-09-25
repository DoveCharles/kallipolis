import { openWindow } from './w3-window.js';

// ============================================================ settings windows
// Under the Windows 3.0 window (ui/win3-menu.js), the World panel keeps only what's reached for while playing — the time,
// the peds, the weather — and the settings that are set once and left open from the Options menu, each in a window of its
// own (ui/w3-window.js). The controls are the panel's own, marked in index.html with data-settings="<window>": opening a
// window moves them into it, and closing it puts them back where they were, so everything that drives them (by id) is
// none the wiser, and anywhere without the menu bar — a phone — keeps them in the panel as ever.
const WINDOWS = {
  world: { title: 'World', width: 280, resizable: true }, // (opened from World in the toolbar rather than the Options menu)
  display: { title: 'Display', width: 280 },
  effects: { title: 'Effects', width: 300 },
  game: { title: 'Game', width: 300 },
  speech: { title: 'Speech', width: 300 },
};

/**
 * Open a settings window, or bring it to the front.
 * @param {keyof WINDOWS} name
 * @returns {void}
 */
export function openSettings(name) {
  const groups = [...document.querySelectorAll(`#panel [data-settings="${name}"]`)];
  const homes = groups.map(group => { const mark = document.createComment(name); group.before(mark); return mark; });
  openWindow({ id: `settings-${name}`, ...WINDOWS[name],
    fill: body => body.append(...groups),
    onClose: () => groups.forEach((group, i) => { homes[i].replaceWith(group); }),
  });
}
