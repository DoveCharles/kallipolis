// ============================================================ the Kallipolis window
// On a screen wider than a phone, the whole tab is one application window: a frame
// round the edge, a title bar saying Kallipolis, and a menu bar under it — File, Edit, View, Options, Help — with the
// side panel docked down its left like Paintbrush's toolbox, and the canvas tools still over the view. The styles are in
// css/win3.css ("the application window"); on a phone none of it shows, the panel keeping its own title bar instead.
//
// Nearly every menu item presses a button that's already on the page, so it does exactly what that button does, and its
// check mark is read off the button's own state each time the menu opens rather than kept here.
import { S } from '../core/shared.js';
import { isMuted } from '../audio/sfx.js';
import { openSoundLevels } from './sound-levels.js';
import { openSettings } from './settings-windows.js';
import { openHelp } from './help.js';
import { closeWindows } from './w3-window.js';
import { editHints, generalHints } from './view-prefs.js';
import { fpsCounter } from './fps.js';
import { openHeldDebug } from './held-debug.js';
import { people } from '../life/people/people.js';
import { cars } from '../life/traffic/state.js';
import { toUi } from './ui-scale.js';

const $ = id => document.getElementById(id);
const press = id => () => $(id).click();
const has = (id, cls) => () => $(id).classList.contains(cls);
const body = document.body;
const typingIn = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// ---- the panel and the tools, hidden from the View menu
function setShown(cls, shown) { body.classList.toggle(cls, !shown); }
const panelShown = () => !body.classList.contains('w3-no-panel');
const toolsShown = () => !body.classList.contains('w3-no-tools');

function toggleFullScreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
// the mode tabs along the top of the panel (World, Edit, Maps), and the Paths/Zones/Objects row under Edit
// (the second row only shows in Edit, so its items are greyed out elsewhere)
const tab = (sel, enabled = () => true) => ({ enabled, radio: () => panelShown() && document.querySelector(sel).classList.contains('active'),
  run: () => { if (!(panelShown() && document.querySelector(sel).classList.contains('active'))) { setShown('w3-no-panel', true); document.querySelector(sel).click(); } } });
const inEdit = () => $('entity-toolbar').style.display !== 'none';

// ---- message boxes: a little window in the middle of the view, a line or two of text and a row of buttons
function messageBox(title, html, buttons = ['OK']) {
  return new Promise(resolve => {
    closeMenus();
    const veil = document.createElement('div');
    veil.className = 'w3-modal';
    veil.innerHTML = `<div class="w3-dialog" role="dialog" aria-label="${title}">
      <div class="win3-titlebar"><button class="win3-sysbox" title="Close"></button><div class="win3-title">${title}</div></div>
      <div class="w3-dialog-body">${html}</div>
      <div class="w3-dialog-buttons">${buttons.map((b, i) => `<button class="btn${i ? '' : ' w3-default'}">${b}</button>`).join('')}</div></div>`;
    const done = answer => { veil.remove(); window.removeEventListener('keydown', key, true); resolve(answer); };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(buttons[0]); }
    };
    veil.querySelectorAll('.w3-dialog-buttons button').forEach((b, i) => b.addEventListener('click', () => done(buttons[i])));
    veil.querySelector('.win3-sysbox').addEventListener('click', () => done(null));
    window.addEventListener('keydown', key, true);
    body.append(veil);
    veil.querySelector('.w3-default').focus();
  });
}

async function newProject() {
  const answer = await messageBox('Kallipolis', '<p>Clear the whole city — every path, zone, object and map image — and start again?</p>', ['OK', 'Cancel']);
  if (answer === 'OK') $('btn-clear').click();
}
function about() {
  const n = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  messageBox('About Kallipolis', `<div class="w3-about"><div class="w3-about-icon"></div><div>
    <p><b>Kallipolis</b><br>A city-blockout tool</p>
    <p>${n(S.roadLines.length, 'path')}, ${n(S.zones.length, 'zone')}<br>${n(people.length, 'person').replace('persons', 'people')}, ${n(cars.length, 'car')} about</p>
    <p>Free memory: 640 KB<br>(ought to be enough for anybody)</p></div></div>`);
}
// Help > Show Tooltips: the bottom hints, Edit and General together (View has them one by one)
const anyHints = () => editHints.shown() || generalHints.shown();
function toggleAllHints() {
  const on = !anyHints();
  if (editHints.shown() !== on) editHints.toggle();
  if (generalHints.shown() !== on) generalHints.toggle();
}

// ---- the menus. key is the underlined letter (Alt+it opens a menu; in an open one, it picks the item); an item may be
// checked (check), one of a set (radio), greyed out (enabled), and show a shortcut at the right.
const MENUS = [
  { name:'File', key:'f', items:[
    { label:'New', key:'n', run:newProject },
    { label:'Open...', key:'o', shortcut:'Ctrl+O', run:press('btn-load-project') },
    { label:'Save', key:'s', shortcut:'Ctrl+S', run:press('btn-save-project') },
    '-',
    { label:'Import Map Image...', key:'i', run:press('btn-import-image') },
    '-',
    { label:'Export GLB...', key:'g', run:press('btn-export-glb') },
    { label:'Export OBJ...', key:'b', run:press('btn-export') },
  ]},
  { name:'Edit', key:'e', items:[
    { label:'Undo', key:'u', shortcut:'Ctrl+Z', run:press('btn-undo'), enabled:() => !$('btn-undo').disabled },
    { label:'Redo', key:'r', shortcut:'Ctrl+Y', run:press('btn-redo'), enabled:() => !$('btn-redo').disabled },
    '-',
    { label:'Clear All...', key:'a', run:newProject },
  ]},
  { name:'View', key:'v', items:[
    { label:'World...', key:'w', check:worldOpen, run:toggleWorld },
    { label:'Edit', key:'e', ...tab('#mode-toolbar [data-mode=node]') },
    { label:'Maps', key:'m', ...tab('#mode-toolbar [data-mode=maps]') },
    '-',
    { label:'Paths', key:'p', ...tab('#entity-toolbar [data-entity=paths]', inEdit) },
    { label:'Zones', key:'z', ...tab('#entity-toolbar [data-entity=zone]', inEdit) },
    { label:'Objects', key:'o', ...tab('#entity-toolbar [data-entity=objects]', inEdit) },
    '-',
    { label:'Side Panel', key:'s', check:panelShown, run:togglePanel },
    { label:'Toolbar', key:'t', check:toolsShown, run:() => setShown('w3-no-tools', !toolsShown()) },
    { label:'Favorites', key:'f', check:() => !$('favorites-panel').hidden, run:() => { setShown('w3-no-tools', true); $('btn-favorites').click(); } },
    '-',
    { label:'Orthographic', key:'h', check:has('btn-projection', 'on'), run:press('btn-projection') },
    { label:'Ped View', key:'d', check:has('btn-ped-view', 'on'), run:press('btn-ped-view') },
    { label:'Full Screen', key:'u', check:() => !!document.fullscreenElement, run:toggleFullScreen },
    '-',
    { label:'Edit Hints', key:'i', check:editHints.shown, run:editHints.toggle },
    { label:'General Hints', key:'g', check:generalHints.shown, run:generalHints.toggle },
    '-',
    { label:'Roadsafety Radius (debug)', key:'r', check:has('s-roadsafety-debug', 'on'), enabled:has('s-people', 'on'), run:press('s-roadsafety-debug') },
    { label:'Ped Navmesh (debug)', key:'n', check:has('s-peoplenav-debug', 'on'), enabled:has('s-people', 'on'), run:press('s-peoplenav-debug') },
    { label:'FPS (debug)', key:'b', check:fpsCounter.shown, run:fpsCounter.toggle },
    { label:'Held Items (debug)', key:'l', enabled:has('s-people', 'on'), run:openHeldDebug },
  ]},
  { name:'Options', key:'o', items:[
    { label:'Snap to Grid', key:'g', check:has('grid-toggle', 'active'), run:press('grid-toggle') },
    { label:'Sound', key:'s', check:() => !isMuted(), run:press('btn-sound') },
    { label:'Sound Levels...', key:'l', run:openSoundLevels },
    '-',
    { label:'Display...', key:'d', run:() => openSettings('display') },
    { label:'Effects...', key:'e', run:() => openSettings('effects') },
    { label:'Game...', key:'a', run:() => openSettings('game') },
  ]},
  { name:'Help', key:'h', items:[
    { label:'Contents', key:'c', shortcut:'F1', run:() => openHelp() },
    { label:'Keyboard Shortcuts', key:'k', run:() => openHelp('keys') },
    { label:'Show Tooltips', key:'t', check:anyHints, run:toggleAllHints },
    '-',
    { label:'About Kallipolis...', key:'a', run:about },
  ]},
];
// the control-menu box at the left of the title bar
const CONTROL = { items:[
  { label:'Restore', key:'r', enabled:() => !!document.fullscreenElement, run:toggleFullScreen },
  { label:'Minimize', key:'n', enabled:panelShown, run:hidePanel },
  { label:'Maximize', key:'x', enabled:() => !document.fullscreenElement, run:toggleFullScreen },
]};

// the label with its letter underlined
const labelHTML = (label, key) => { const i = label.toLowerCase().indexOf(key); return i < 0 ? label : `${label.slice(0, i)}<u>${label[i]}</u>${label.slice(i + 1)}`; };

// ---- the window itself
const frame = document.createElement('div');
frame.id = 'app-frame';
frame.innerHTML = `<div class="win3-titlebar"><button class="win3-sysbox" title="Control menu"></button><div class="win3-title">Kallipolis</div><button class="win3-min" title="Hide or show the side panel"></button><button class="win3-max" title="Full screen"></button></div><div id="w3-menubar" role="menubar"></div>`;
body.prepend(frame);
const bar = frame.querySelector('#w3-menubar');
const titles = MENUS.map(menu => {
  const b = document.createElement('button');
  b.className = 'w3-menu-title';
  b.innerHTML = labelHTML(menu.name, menu.key);
  bar.append(b);
  return b;
});
frame.querySelector('.win3-min').addEventListener('click', togglePanel);
frame.querySelector('.win3-max').addEventListener('click', toggleFullScreen);
frame.querySelector('.win3-title').addEventListener('dblclick', toggleFullScreen);
const sysbox = frame.querySelector('.win3-sysbox');

let open = null;        // { menu, dropdown, anchor, index } while a menu's down
function closeMenus() {
  if (!open) return;
  open.dropdown.remove();
  open.anchor.classList.remove('open');
  open = null;
}
function openMenu(menu, anchor, highlightFirst = false) {
  closeMenus();
  const dropdown = document.createElement('div');
  dropdown.className = 'w3-dropdown';
  dropdown.setAttribute('role', 'menu');
  const rows = [];
  menu.items.forEach(item => {
    if (item === '-') { dropdown.append(Object.assign(document.createElement('div'), { className:'w3-sep' })); return; }
    const row = document.createElement('button');
    const enabled = item.enabled ? item.enabled() : true;
    const mark = item.check?.() || item.radio?.();
    row.className = 'w3-item' + (mark ? (item.radio ? ' radio' : ' checked') : '');
    row.disabled = !enabled;
    row.innerHTML = `<span class="w3-label">${labelHTML(item.label, item.key)}</span><span class="w3-short">${item.shortcut || ''}</span>`;
    row.addEventListener('click', () => { closeMenus(); item.run(); });
    row.addEventListener('mouseenter', () => highlight(rows.indexOf(entry)));
    const entry = { item, row };
    rows.push(entry);
    dropdown.append(row);
  });
  const r = anchor.getBoundingClientRect();
  dropdown.style.left = toUi(r.left) + 'px';
  dropdown.style.top = toUi(r.bottom) + 'px';
  body.append(dropdown);
  anchor.classList.add('open');
  open = { menu, dropdown, anchor, rows, index:-1 };
  if (highlightFirst) highlight(step(-1, 1));
}
function highlight(i) {
  if (!open) return;
  open.rows.forEach((e, j) => e.row.classList.toggle('hot', j === i));
  open.index = i;
}
// the next enabled row from i in direction d, wrapping round
function step(i, d) {
  const n = open.rows.length;
  for (let k = 1; k <= n; k++) { const j = ((i + d*k) % n + n) % n; if (!open.rows[j].row.disabled) return j; }
  return -1;
}

titles.forEach((t, i) => {
  t.addEventListener('mousedown', e => { e.preventDefault(); if (open?.anchor === t) closeMenus(); else openMenu(MENUS[i], t); });
  t.addEventListener('mouseenter', () => { if (open && open.anchor !== t) openMenu(MENUS[i], t); }); // sliding along the bar with one down
});
sysbox.addEventListener('mousedown', e => { e.preventDefault(); if (open?.anchor === sysbox) closeMenus(); else openMenu(CONTROL, sysbox); });
window.addEventListener('mousedown', e => { if (open && !open.dropdown.contains(e.target) && !open.anchor.contains(e.target)) closeMenus(); }, true);
window.addEventListener('blur', closeMenus);

// ---- World / Edit / Maps: in the window, they sit at the left of the toolbar rather than the top of the side panel, and go
// back to the panel whenever the window isn't showing (on a phone). They're found by id
// everywhere else (tools.js, favorites.js), so it doesn't matter to anything else which of the two they're in.
const modeButtons = $('mode-toolbar');
const panelHome = modeButtons.parentElement, panelNext = modeButtons.nextElementSibling;
const wide = window.matchMedia('(min-width: 761px)');
function placeModeButtons() {
  if (wide.matches) { if (modeButtons.parentElement !== $('canvas-tools')) $('canvas-tools').prepend(modeButtons); }
  else {
    if (modeButtons.parentElement !== panelHome) panelHome.insertBefore(modeButtons, panelNext);
    closeWindows(); // (and any settings in a window go back to the panel: see ui/settings-windows.js)
  }
}
placeModeButtons();

// In the toolbar, Edit and Maps are radio buttons that can both be let up: pressing the one that's down lets it up and
// hides the side panel, leaving the view to work as it does in World; pressing either then opens the panel on it. World
// (an icon, like Maps) isn't one of them: it opens and closes a window of the World controls — the time, the peds, the
// weather (ui/settings-windows.js) — and leaves the mode alone, so it can be open while editing. (Hiding the panel any
// other way — the View menu, ▲ — lets Edit and Maps up the same, so there's never an editing mode without its panel.)
const worldButton = modeButtons.querySelector('[data-mode=move]');
worldButton.title = 'World';
modeButtons.querySelector('[data-mode=maps]').title = 'Maps';
function worldOpen() { return !!$('settings-world'); }
function toggleWorld() {
  if (worldOpen()) $('settings-world').close(); else openSettings('world');
  worldButton.classList.toggle('w3-open', worldOpen());
}
function hidePanel() {
  if (S.interactionMode !== 'move') worldButton.click();
  setShown('w3-no-panel', false);
}
function togglePanel() {
  if (panelShown()) hidePanel();
  else if (S.interactionMode === 'move') modeButtons.querySelector('[data-mode=node]').click(); // (which opens it)
  else setShown('w3-no-panel', true);
}
modeButtons.addEventListener('click', e => {
  const button = e.target.closest('.tool-btn');
  if (!button || !wide.matches) return;
  // (World pressed by the code rather than a person — here, or favorites.js going back to World to go to a place — is
  // for tools.js, to go back to its mode, so the panel goes; only a real press opens the window)
  if (button === worldButton && !e.isTrusted) setShown('w3-no-panel', false);
  else if (button === worldButton) { e.stopPropagation(); toggleWorld(); }
  else if (panelShown() && button.classList.contains('active')) { e.stopPropagation(); hidePanel(); }
  else setShown('w3-no-panel', true);
}, true);
function worldModeHidesPanel() { if (wide.matches && S.interactionMode === 'move') setShown('w3-no-panel', false); }
worldModeHidesPanel();

// The active window: like Windows 3.0, only the window you're working in has a navy title bar; the rest go white. A card
// (for a building, a person, a car…) takes it when it's opened on something — even if it was open already — or clicked,
// and keeps it while it's open, however the view's clicked about to look round or to pick someone else (they're what's
// being followed, so the card is what you're working in). A window like Sound levels takes it while it's clicked in,
// and the card gets it back when anything else is; only with no card open does the Kallipolis window take it back.
const WINDOWS = '.entity-card, .w3-window'; // (the cards, and windows like Sound levels: ui/sound-levels.js)
let activeCard = null;
let lastCard = null; // the entity card last opened or clicked
function trackedCard() {
  if (lastCard && !lastCard.hidden) return lastCard;
  return [...document.querySelectorAll('.entity-card')].find(c => !c.hidden) ?? null;
}
function setActive(card) {
  if (card?.matches('.entity-card')) lastCard = card;
  activeCard = card && !card.hidden ? card : trackedCard();
  document.querySelectorAll(WINDOWS).forEach(c => c.classList.toggle('w3-inactive', c !== activeCard));
  frame.classList.toggle('w3-inactive', !!activeCard);
}
new MutationObserver(records => {
  for (const { target } of records) {
    if (!target.matches(WINDOWS)) continue;
    if (target.hidden && target === activeCard) setActive(null);
    if (target.hidden && target.id === 'settings-world') worldButton.classList.remove('w3-open');
  }
}).observe(document.body, { subtree:true, attributes:true, attributeFilter:['hidden'] });
document.addEventListener('card-show', e => setActive(e.target));
document.addEventListener('pointerdown', e => {
  if (e.target.closest('.w3-dropdown, .w3-modal')) return;
  setActive(e.target.closest(WINDOWS));
}, true);
const placed = () => { placeModeButtons(); worldModeHidesPanel(); };
wide.addEventListener('change', placed);

// ---- the keyboard: Alt+letter opens a menu; arrows, Enter, Esc and the underlined letters work it; Ctrl+S and Ctrl+O
window.addEventListener('keydown', e => {
  if (document.querySelector('.w3-modal')) return;
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase();
  if (open) {
    const titleIndex = titles.indexOf(open.anchor);
    const hit = letter && !e.ctrlKey && !e.metaKey && open.rows.find(r => r.item.key === letter && !r.row.disabled);
    let used = true;
    if (e.key === 'Escape') closeMenus();
    else if (e.key === 'ArrowDown') highlight(step(open.index, 1));
    else if (e.key === 'ArrowUp') highlight(step(open.index < 0 ? 0 : open.index, -1));
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && titleIndex >= 0) {
      const j = (titleIndex + (e.key === 'ArrowRight' ? 1 : -1) + titles.length) % titles.length;
      openMenu(MENUS[j], titles[j], true);
    } else if (e.key === 'Enter' && open.index >= 0) open.rows[open.index].row.click();
    else if (hit) hit.row.click();
    else if (e.altKey && letter) used = false; // (falls through to open another menu below)
    else used = e.key !== 'Shift' && e.key !== 'Alt';
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  }
  if (!frame.getClientRects().length) return; // (a phone: no menu bar)
  if (e.altKey && !e.ctrlKey && !e.metaKey && letter) {
    const i = MENUS.findIndex(m => m.key === letter);
    if (i >= 0) { e.preventDefault(); e.stopImmediatePropagation(); openMenu(MENUS[i], titles[i], true); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (letter === 's' || letter === 'o') && !typingIn(document.activeElement)) {
    e.preventDefault(); e.stopImmediatePropagation();
    $(letter === 's' ? 'btn-save-project' : 'btn-load-project').click();
  }
}, true);
