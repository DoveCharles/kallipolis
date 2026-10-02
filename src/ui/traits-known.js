import { modifiersOf, tierOf } from '../core/entries.js';
import { App } from '../core/shared.js';
import { onProfilesLoaded, peopleListsLoaded, peopleTraitEntries, profileOf, sampleCardText } from '../life/profiles.js';
import { toUi } from './ui-scale.js';
import { openWindow } from './w3-window.js';
import { mulberry32 } from '../core/math.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Identified love/hate traits (1 energy each: see set in entity-card.js). Per trait, not per person: identifying one on
// anybody reveals it on everyone. Kept with the project (project/progress.js) as lowercase 'love:<text>' / 'hate:<text>' keys; any no longer in
// people/loves.txt or hates.txt are dropped once those have loaded. The toolbar's identify button lists them.
const known = new Map(); // key → when it was identified (Date.now; 0 for ones saved before that was kept)
function knownFrom(saved) {
  known.clear();
  if (Array.isArray(saved)) saved.forEach(k => known.set(String(k).toLowerCase(), 0));
  else if (saved) Object.entries(saved).forEach(([k, t]) => known.set(k.toLowerCase(), Number(t) || 0));
}
knownFrom(getProgress('traitsKnown'));
const save = () => setProgress('traitsKnown', Object.fromEntries(known));
const listeners = [];
// (a project's coming in: what it knows unlocked on any open card)
onProgress('traitsKnown', v => { knownFrom(v); prune(); known.forEach((_, key) => listeners.forEach(fn => fn(key))); refreshWindow(); });
let win = null; // (the window's parts, while it's open)
// entries with a [category] in them ("Conversely, [hates]"): shown cycling through VARY_COUNT fillings, one every VARY_MS
// — the same few each time (seeded by the trait), so it hints without giving the whole list away — their effects
// "Variable" (they hang on the fill); sorted by the raw text all the same
const VARY_MS = 3000, VARY_COUNT = 5, isVariable = entry => /\[[^\]]+\]/.test(entry.text);
let varying = [], varyTimer = null, varyStep = 0;
const fillings = new Map(); // key → its VARY_COUNT fillings (worked out once speech has loaded: see sampleCardText)
function fillingsOf(key, entry, side) {
  if (fillings.has(key)) return fillings.get(key);
  let seed = 0;
  for (const c of key) seed = (seed*31 + c.charCodeAt(0)) | 0;
  const rng = mulberry32(seed), list = [];
  for (let i = 0; i < VARY_COUNT*4 && list.length < VARY_COUNT; i++) { const t = sampleCardText(entry, side, rng); if (!list.includes(t)) list.push(t); }
  if (list[0] !== entry.text) fillings.set(key, list); // (not cached until it's really filled)
  return list;
}

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
  varying = [];
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
    const tier = tierOf(entry), variable = isVariable(entry), lines = variable ? ['Variable'] : modifiersOf(entry);
    const cell = document.createElement('div');
    cell.className = `tk-cell tk-${s}${Math.floor(i / 2) % 2 ? ' tk-alt' : ''}${tier ? ' tk-tier-' + tier : ''}${opened.has(key) ? ' tk-open' : ''}`;
    const head = document.createElement('button');
    head.className = 'tk-head';
    // (text too long for its cell scrolls along while hovered, snapping back and going again)
    const text = document.createElement('span'), inner = document.createElement('span');
    text.className = 'tk-text'; inner.className = 'tk-scroll';
    const texts = variable ? fillingsOf(key, entry, s === 'love' ? 1 : -1) : [entry.text];
    inner.textContent = texts[varyStep % texts.length];
    if (variable) varying.push({ inner, key, entry, side: s === 'love' ? 1 : -1 });
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
    head.dataset.energy = ''; // (a right click searches, for 1 energy: see findHolder)
    head.addEventListener('contextmenu', e => { e.preventDefault(); findHolder(key, e); });
    cell.append(head, mods);
    cells.push(cell);
  });
  win.list.replaceChildren(...cells);
}
// ---- right click: someone out and about holding the trait, the camera snapped to them for 1 energy — or "Nobody found!"
// by the pointer, for nothing; someone already found for that trait this session is free (a hidden (UNKNOWN) love or hate doesn't count: their card wouldn't show it). They're
// gone through in order of person id, each trait remembering who it was on last: right click the next, shift the one before.
const lastFound = new Map(); // key → the person id it last snapped to
const paidFor = new Set(); // 'key|id': found already this session, so going back to them is free
function findHolder(key, e) {
  const [side, ...rest] = key.split(':'), text = rest.join(':');
  const found = [];
  (App.people || []).forEach((p, i) => {
    if (!p || p.mode === 'none' || p.mode === 'dead' || p.indoors || p.train) return;
    const base = profileOf(p.id, p.isMan ?? null, p.moodNow)[side === 'love' ? 'lovesBase' : 'hatesBase'];
    if (base.some(t => t && t.toLowerCase() === text)) found.push({ i, id: p.id });
  });
  if (!found.length) { sayAt('Nobody found!', e); return; }
  found.sort((a, b) => a.id - b.id);
  const last = lastFound.get(key) ?? -Infinity;
  const pick = e.shiftKey
    ? [...found].reverse().find(f => f.id < last) ?? found[found.length - 1] // (the one before, round to the last)
    : found.find(f => f.id > last) ?? found[0];                              // (the next, round to the first)
  const paid = key + '|' + pick.id;
  if (!paidFor.has(paid)) { if (!App.spendEnergy?.()) return; paidFor.add(paid); } // (no energy: flashes it)
  lastFound.set(key, pick.id);
  App.followPerson(pick.i);
}
function sayAt(text, e) {
  const el = document.createElement('div');
  el.className = 'tk-nobody';
  el.textContent = text;
  el.style.left = toUi(e.clientX) + 'px'; el.style.top = toUi(e.clientY) + 'px';
  document.body.append(el);
  el.addEventListener('animationend', () => el.remove());
}
/** Open the list of identified traits. @returns {void} */
export function openTraitsKnown() {
  openWindow({ id: 'traits-known', title: 'Identified Traits', width: 580, resizable: true, noOk: true,
    fill: body => {
      body.innerHTML = `<div class="tk-bar"><input type="search" class="tk-search" placeholder="Search">
        <select class="select-input tk-sort"><option value="alpha">A–Z</option><option value="recent">Recent</option></select>
        <label class="tk-group-toggle"><input type="checkbox"> Group</label></div>
        <div class="tk-list"></div>
        <div class="tk-foot"><span class="tk-count"></span><span class="tk-pager"><button class="btn tk-prev">&lt;</button> <span class="tk-page"></span> <button class="btn tk-next">&gt;</button></span></div>
        <div class="tk-hint">Right click to search, shift for previous (1 <img class="meter-icon" src="assets/icons/energy.png" alt="energy">)</div>`;
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
    onClose: () => { win = null; clearInterval(varyTimer); varyTimer = null; varying = []; } });
  if (!varyTimer) varyTimer = setInterval(() => { varyStep++; varying.forEach(v => { const t = fillingsOf(v.key, v.entry, v.side); v.inner.textContent = t[varyStep % t.length]; }); }, VARY_MS);
}
document.getElementById('btn-identify')?.addEventListener('click', openTraitsKnown);
