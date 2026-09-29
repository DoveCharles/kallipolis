import { modifiersOf, tierOf } from '../core/entries.js';
import { onProfilesLoaded, peopleListsLoaded, peopleTraitEntries } from '../life/profiles.js';
import { openWindow } from './w3-window.js';

// Identified love/hate traits (1 energy each: see set in entity-card.js). Per trait, not per person: identifying one on
// anybody reveals it on everyone. Kept in localStorage as lowercase 'love:<text>' / 'hate:<text>' keys; any no longer in
// people/loves.txt or hates.txt are dropped once those have loaded. The toolbar's identify button lists them.
const KEY = 'kallipolis.traitsKnown';
const known = new Map(); // key → when it was identified (Date.now; 0 for ones saved before that was kept)
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (Array.isArray(saved)) saved.forEach(k => known.set(String(k).toLowerCase(), 0));
  else if (saved) Object.entries(saved).forEach(([k, t]) => known.set(k.toLowerCase(), Number(t) || 0));
} catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(known))); } catch {} };
const listeners = [];
let win = null; // (the window's parts, while it's open)

/** @param {'love'|'hate'} side @param {string} text @returns {string} */
export const traitKey = (side, text) => `${side}:${String(text).toLowerCase()}`;
/** @param {string} key @returns {boolean} */
export const isTraitKnown = key => known.has(key);
/** @param {(key: string) => void} fn - called with each newly identified trait's key */
export function onTraitDiscovered(fn) { listeners.push(fn); }
/** @param {string} key @returns {void} */
export function discoverTrait(key) {
  if (!key || known.has(key)) return;
  known.set(key, Date.now()); save();
  listeners.forEach(fn => fn(key));
  refreshWindow();
}

// the entry a key stands for, from the people files
let byKey = new Map();
function indexEntries() {
  const lists = peopleTraitEntries();
  byKey = new Map();
  lists.love.forEach(e => byKey.set(traitKey('love', e.text), e));
  lists.hate.forEach(e => byKey.set(traitKey('hate', e.text), e));
}
function prune() {
  if (!peopleListsLoaded()) return; // (not the placeholders: they'd drop everything)
  indexEntries();
  let dropped = false;
  [...known.keys()].forEach(key => { if (!byKey.has(key)) { known.delete(key); dropped = true; } });
  if (dropped) save();
  refreshWindow();
}
onProfilesLoaded(prune);
prune();

// ---------------------------------------------------------- the window
// Two columns of identified traits, banded as a card's loves and hates, PAGE_SIZE a page: searched, sorted A–Z or most
// recent first, optionally grouped loves then hates. Clicking one opens its effects under it.
const PAGE_SIZE = 60;
const view = { query: '', sort: 'alpha', group: false, page: 0 };
const opened = new Set();
function refreshWindow() {
  if (!win) return;
  const q = view.query.trim().toLowerCase();
  let found = [...known].map(([key, at]) => ({ key, at, side: key.startsWith('love:') ? 'love' : 'hate', entry: byKey.get(key) }))
    .filter(f => f.entry && (!q || f.entry.text.toLowerCase().includes(q)));
  found.sort(view.sort === 'recent' ? (a, b) => b.at - a.at || a.entry.text.localeCompare(b.entry.text) : (a, b) => a.entry.text.localeCompare(b.entry.text));
  if (view.group) found = [...found.filter(f => f.side === 'love'), ...found.filter(f => f.side === 'hate')];
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
  view.page = Math.max(0, Math.min(view.page, pages - 1));
  const shown = found.slice(view.page*PAGE_SIZE, (view.page + 1)*PAGE_SIZE);
  win.pageText.textContent = `${view.page + 1} / ${pages}`;
  win.prev.disabled = view.page <= 0; win.next.disabled = view.page >= pages - 1;
  win.count.textContent = `${found.length} identified`;
  if (!shown.length) { win.list.innerHTML = `<div class="tk-empty">${known.size ? 'No matches.' : 'Nothing identified yet.'}</div>`; return; }
  const cells = [];
  let side = null;
  shown.forEach(({ key, side: s, entry }, i) => {
    if (view.group && s !== side) {
      const h = document.createElement('div');
      h.className = 'tk-group tk-' + s;
      h.textContent = s === 'love' ? 'Loves' : 'Hates';
      cells.push(h);
    }
    side = s;
    const tier = tierOf(entry), lines = modifiersOf(entry);
    const cell = document.createElement('div');
    cell.className = `tk-cell tk-${s}${Math.floor(i / 2) % 2 ? ' tk-alt' : ''}${tier ? ' tk-tier-' + tier : ''}${opened.has(key) ? ' tk-open' : ''}`;
    const head = document.createElement('button');
    head.className = 'tk-head';
    // (text too long for its cell scrolls along while hovered, snapping back and going again)
    const text = document.createElement('span'), inner = document.createElement('span');
    text.className = 'tk-text'; inner.className = 'tk-scroll';
    inner.textContent = entry.text;
    text.append(inner);
    head.addEventListener('pointerenter', () => {
      const d = inner.scrollWidth - text.clientWidth;
      if (d <= 0) return;
      inner.style.setProperty('--tk-d', -d + 'px');
      inner.style.setProperty('--tk-t', (d / 40 + 0.8).toFixed(2) + 's');
      inner.classList.add('tk-marquee');
    });
    head.addEventListener('pointerleave', () => inner.classList.remove('tk-marquee'));
    head.append(text);
    if (tier) { // (no identify mark: everything here has effects to open)
      const mark = document.createElement('span');
      mark.className = 'tk-mark tk-mark-' + (tier === 'legendary' ? 'plus' : 'minus');
      head.append(mark);
    }
    const mods = document.createElement('div');
    mods.className = 'tk-mods';
    mods.hidden = !opened.has(key);
    (lines.length ? lines : ['No effect']).forEach(t => { const line = document.createElement('div'); line.textContent = t; mods.append(line); });
    head.addEventListener('click', () => {
      if (opened.has(key)) opened.delete(key); else opened.add(key);
      mods.hidden = !opened.has(key); cell.classList.toggle('tk-open', opened.has(key));
    });
    cell.append(head, mods);
    cells.push(cell);
  });
  win.list.replaceChildren(...cells);
}
/** Open the list of identified traits. @returns {void} */
export function openTraitsKnown() {
  openWindow({ id: 'traits-known', title: 'Identified Traits', width: 580, resizable: true,
    fill: body => {
      body.innerHTML = `<div class="tk-bar"><input type="search" class="tk-search" placeholder="Search">
        <select class="select-input tk-sort"><option value="alpha">A–Z</option><option value="recent">Recent</option></select>
        <label class="tk-group-toggle"><input type="checkbox"> Group</label></div>
        <div class="tk-list"></div>
        <div class="tk-foot"><span class="tk-count"></span><span class="tk-pager"><button class="btn tk-prev">&lt;</button> <span class="tk-page"></span> <button class="btn tk-next">&gt;</button></span></div>`;
      const $ = sel => body.querySelector(sel);
      win = { list: $('.tk-list'), pageText: $('.tk-page'), prev: $('.tk-prev'), next: $('.tk-next'), count: $('.tk-count') };
      const search = $('.tk-search'), sort = $('.tk-sort'), group = $('.tk-group-toggle input');
      search.value = view.query; sort.value = view.sort; group.checked = view.group;
      search.addEventListener('input', () => { view.query = search.value; view.page = 0; refreshWindow(); });
      sort.addEventListener('change', () => { view.sort = sort.value; view.page = 0; refreshWindow(); });
      group.addEventListener('change', () => { view.group = group.checked; view.page = 0; refreshWindow(); });
      win.prev.addEventListener('click', () => { view.page--; refreshWindow(); });
      win.next.addEventListener('click', () => { view.page++; refreshWindow(); });
      refreshWindow();
    },
    onClose: () => { win = null; } });
}
document.getElementById('btn-identify')?.addEventListener('click', openTraitsKnown);
