import { isFavorite, toggleFavorite, onFavoritesChanged } from './favorites.js';
import { dragByTitle } from './w3-window.js';
import { healthOf, healthFraction, onHealthChanged } from '../core/health.js';
import { EFFECTS, statusLines } from '../life/statuseffects.js';

// ============================================================ the card for whatever's being followed
// The card at the bottom right saying what the camera's following: a person (life/person-card.js), a car
// (life/car-card.js), a carriage (trains/trains.js), an aircraft (zones/airport.js), a building
// (buildings/building-card.js), or a bee or its hive (life/bees.js). They're all this one card with different rows filled
// in — they differ only in their title, their picture, and whether there's a Smite button.
//
// ROWS below is the whole list of rows a card can have, in the order they come in. A card doesn't say which it wants: a
// row shows when it's been given something to say and stays out of the way when it hasn't, so a car simply has no Age and
// a person no Inhabitants (which a hive renames to Bees, since that's what's inside one). That means a row added here reaches every card at once, including kinds of thing that don't
// exist yet — which is the point of the file.
export const ROWS = [
  { key: 'name',      label: 'Name',         cls: 'pc-name',   top: true },
  { key: 'age',       label: 'Age',                            top: true },
  { key: 'mood',      label: 'Current mood', cls: 'pc-mood',   top: true },
  { key: 'status',    label: 'Status',       cls: 'pc-status', top: true },
  { key: 'loves',     label: 'Loves',     gap: true, marked: true },
  { key: 'hates',     label: 'Hates',                marked: true },
  { key: 'occupants', label: 'Inhabitants', gap: true, list: true },
];
// `top`: up beside the picture, rather than below it. `gap`: a rule above it. `list`: several names, one a line (see
// setList) rather than one value. `marked`: each entry carries a mark at its right (+ legendary, - terrible, * has
// modifiers: see markOf), those with modifiers opening a drop-down of them (see addDrop).
// Any row accepts either one string or a list of strings (see `set`); each extra entry gets its own row below, classed
// with the row's key (pc-row-loves). A counted row (Loves, Hates) can also carry a tier per entry — see `set`'s tierValue.

// the rows a .txt file fills in (see core/type-text.js) — the rest are worked out as the world runs
export const TEXT_ROWS = ['name', 'mood', 'loves', 'hates'];

// every card there is, in the order they were made — so the things that treat them all alike (the Windows 3.0 look in
// ui/win3.js, the phone layout in ui/mobile.js) can go through them rather than each naming all four
export const cards = [];
// what each card's status column is doing just now, by its element: for the console, through src/main.js's `status`
export const inspected = new Map();

// `title` is the name in its title bar; `onClose` is what the × (and the control-menu box, under the Windows 3.0 look)
// does. `thumb` is { title, onClick } for the picture — leave out onClick and it's just a picture. `kill`, if given, is
// { title, onClick } for a Smite button under it. `action`, if given, is { text, title, onClick } for a plain button in the
// same place (a building's Enter: see buildings/interior.js), its wording changed later with setAction and hidden with
// showAction. `labels` renames rows for this card ({ occupants: 'Passengers' }). `health` adds a thin bar under the
// picture: bindHealth(entity, kind) makes it follow that entity's health (core/health.js); setHealth sets it by hand.
// `tabs`: sheet tabs under the title bar (the first is the card's own rows; the rest get empty panes: tabPane(key), keys
// lower-cased); onTab(listener) hears selectTab. `effects`: a column of status-effect icons right of the picture, empty
// until there are any (see setEffects, and life/statuseffects.js).
export function makeCard({ id, title, onClose, thumb = {}, kill = null, action = null, labels = {}, health = false, tabs = null, effects = false }) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'entity-card';
  el.hidden = true;

  // the title bar (only drawn by the Windows 3.0 look), and the × for every other look
  // the card's own wording — its title, the Smite button and the row headings — as [element, text], for relabel below
  const fixedText = [];
  const titlebar = document.createElement('div');
  titlebar.className = 'win3-titlebar';
  const sysbox = document.createElement('button');
  sysbox.className = 'win3-sysbox';
  sysbox.title = 'Close';
  const titleText = document.createElement('div');
  titleText.className = 'win3-title';
  titleText.textContent = title;
  const titleEntry = [titleText, title];
  fixedText.push(titleEntry);
  titlebar.append(sysbox, titleText);
  const close = document.createElement('button');
  close.className = 'card-close';
  close.title = 'Stop following';
  close.textContent = '×';
  sysbox.addEventListener('click', () => onClose());
  close.addEventListener('click', () => onClose());

  // the heart, at its top right: hearts whatever it's showing into the favorites (ui/favorites.js), with its name and
  // picture as they are right now. Only there once whoever opened the card has said what it's showing (see setFavorite).
  const heart = document.createElement('button');
  heart.className = 'card-heart';
  heart.hidden = true;
  let favorite = null;
  function drawHeart() {
    const on = !!favorite && isFavorite(favorite.key);
    heart.classList.toggle('on', on);
    heart.title = on ? 'Unfavorite' : 'Favorite';
    // (something hearted that the favorites spare can't be killed, so there's no Smite button for it: see ui/favorites.js)
    if (killButton) killButton.hidden = on && !!favorite.spares;
    heart.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
      + '<path d="M12 20.5s-7.6-4.6-9.4-9.3C1.2 7.6 3.5 4 7.2 4c2.1 0 3.6 1.1 4.8 2.9C13.2 5.1 14.7 4 16.8 4c3.7 0 6 3.6 4.6 7.2-1.8 4.7-9.4 9.3-9.4 9.3z"/></svg>';
  }
  heart.addEventListener('click', () => {
    if (!favorite) return;
    toggleFavorite({ ...favorite, kindLabel: titleEntry[1] }, rows.name.value.textContent || titleEntry[1], canvas.hidden ? null : canvas.toDataURL());
  });
  onFavoritesChanged(drawHeart);

  // the picture, and the Smite button under it
  const canvas = document.createElement('canvas');
  canvas.className = 'pc-thumb';
  canvas.width = canvas.height = 120;
  if (thumb.title) canvas.title = thumb.title;
  if (thumb.onClick) {
    canvas.classList.add('pc-thumb-click');
    canvas.addEventListener('click', () => thumb.onClick());
  }
  const shot = document.createElement('div');
  shot.className = 'pc-shot';
  // the picture and its health bar, joined as one frame
  const portrait = document.createElement('div');
  portrait.className = 'pc-portrait';
  portrait.append(canvas);
  shot.append(portrait);
  let healthFill = null;
  if (health) {
    portrait.classList.add('pc-has-health');
    const bar = document.createElement('div');
    bar.className = 'pc-health';
    healthFill = document.createElement('div');
    healthFill.className = 'pc-health-fill';
    bar.append(healthFill);
    portrait.append(bar);
  }
  let killButton = null;
  if (kill) {
    const button = killButton = document.createElement('button');
    button.className = 'btn danger pc-kill';
    button.title = kill.title || '';
    button.textContent = 'Smite';
    fixedText.push([button, 'Smite']);
    button.addEventListener('click', () => kill.onClick());
    shot.append(button);
  }
  let actionText = null;
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn pc-kill pc-action';
    button.title = action.title || '';
    button.textContent = action.text;
    actionText = [button, action.text];
    fixedText.push(actionText);
    button.addEventListener('click', () => action.onClick());
    shot.append(button);
  }

  // the rows themselves, all of them made now and shown as they're given something to say
  const rows = {};
  const top = document.createElement('div'), body = document.createElement('div');
  top.className = 'pc-rows';
  body.className = 'pc-body';
  ROWS.forEach(row => {
    const rowEl = document.createElement('div');
    // Classed by key (pc-row-loves) so CSS can target individual rows.
    rowEl.className = 'pc-row pc-row-' + row.key + (row.gap ? ' pc-gap' : '');
    rowEl.hidden = true;
    const label = document.createElement('span');
    label.className = 'pc-label';
    label.textContent = labels[row.key] || row.label;
    fixedText.push([label, label.textContent]);
    const value = document.createElement('span');
    value.className = 'pc-value' + (row.cls ? ' ' + row.cls : '');
    rowEl.append(label, value);
    (row.top ? top : body).append(rowEl);
    rows[row.key] = { el: rowEl, value, row, extras: [], drops: [] };
  });
  const topSection = document.createElement('div');
  topSection.className = 'pc-top';
  topSection.append(top, shot);
  let effectsEl = null;
  if (effects) {
    effectsEl = document.createElement('div');
    effectsEl.className = 'pc-effects';
    topSection.append(effectsEl);
  }
  el.append(titlebar, heart, close);
  const panes = {}, tabButtons = {}, tabListeners = [];
  let activeTab = null;
  if (tabs) {
    el.classList.add('pc-has-tabs');
    const strip = document.createElement('div');
    strip.className = 'pc-tabs';
    tabs.forEach((label, i) => {
      const key = label.toLowerCase(), button = document.createElement('button');
      button.className = 'pc-tab';
      const text = document.createElement('span');
      text.textContent = label;
      fixedText.push([text, label]);
      button.append(text);
      button.addEventListener('click', () => selectTab(key));
      strip.append(button);
      tabButtons[key] = button;
      if (i === 0) { activeTab = key; button.classList.add('on'); return; }
      const pane = panes[key] = document.createElement('div');
      pane.className = 'pc-pane pc-pane-' + key;
      pane.hidden = true;
    });
    el.append(strip);
  }
  el.append(topSection, body, ...Object.values(panes));
  document.body.append(el);
  // Shows tab `key`, the card easing to its new height (see resizeSmoothly).
  function selectTab(key) {
    if (!tabButtons[key] || key === activeTab) return;
    const own = !panes[key];
    resizeSmoothly(() => {
      topSection.style.display = body.style.display = own ? '' : 'none';
      Object.entries(panes).forEach(([k, pane]) => { pane.hidden = k !== key; });
    });
    Object.entries(tabButtons).forEach(([k, button]) => button.classList.toggle('on', k === key));
    activeTab = key;
    if (own) layoutDrops();
    tabListeners.forEach(listener => listener(key));
  }
  // Runs `change`, then slides the card's top edge from its old height to its new one over RESIZE_TIME. Only `translate`
  // and `clip-path` animate (no layout per frame), so it stays smooth while the scene is busy: the card is laid out once
  // at the taller size, shifted down by the difference and clipped at its bottom anchor. (`translate`, not `transform`,
  // which dragging uses.)
  const RESIZE_TIME = 180, CLIP_SPARE = '-6px'; // (the spare keeps the Win3 outline unclipped)
  let resizeAnim = null;
  const endResize = () => { resizeAnim = null; el.style.height = el.style.boxSizing = ''; };
  function resizeSmoothly(change) {
    if (resizeAnim) { resizeAnim.cancel(); endResize(); }
    const from = el.offsetHeight;
    change();
    const to = el.offsetHeight;
    if (el.hidden || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const shift = Math.abs(to - from);
    if (to < from) { el.style.boxSizing = 'border-box'; el.style.height = from + 'px'; } // (held tall until the slide's done)
    const tall = { translate: '0 0', clipPath: `inset(${CLIP_SPARE})` };
    const short = { translate: `0 ${shift}px`, clipPath: `inset(${CLIP_SPARE} ${CLIP_SPARE} ${shift}px ${CLIP_SPARE})` };
    const anim = resizeAnim = el.animate(to > from ? [short, tall] : [tall, short], { duration: RESIZE_TIME, easing: 'ease-out' });
    anim.onfinish = () => { if (resizeAnim === anim) endResize(); };
  }
  // ---- the status column, and the tip its icons open.
  // `list` is what someone's under: [{ status, left }], top to bottom, soonest to run out first, `left` a function giving
  // how many seconds that status has left *now*. `slots` is how many places the column has in all, so a slot no status has
  // taken stands empty with a dash in it — the column reads as a column of slots whether anyone is under anything or not.
  // Each icon is drawn from its own effect in life/statuseffects.js, which also says what it's doing to them: the pointer
  // resting within one's place in the column brings that up in a tip of its own (see below), which asks the status what it
  // has left as it is now, so a countdown in it runs.
  //
  // The column is *edited*, never rebuilt: an icon is a slot element that keeps its place, and what changes about it — the
  // bitmap, the status behind it, where it sits in the column — is what's written. A status's clock ticks over every
  // second, and a column torn down and rebuilt that often would put a new, unrelated element under the pointer each time:
  // the tip would blink out with it, and an icon that shifted places would drag the pointer off its own status.
  const statusLinesOf = new Map(); // a status icon in the column → how to say what it's doing, just now
  function setEffects(list, slots = 0) {
    if (!effectsEl) return;
    const column = effectsEl, want = Math.max(list.length, slots);
    for (let i = 0; i < want; i++) {
      const slot = column.children[i] ?? document.createElement('div');
      const entry = list[i] ?? null;
      const classes = 'pc-effect' + (entry ? '' : ' pc-effect-empty');
      if (slot.className !== classes) slot.className = classes;
      if (entry) {
        // (a slot that stood empty has to be emptied of its dash before its picture goes in, leaving nothing of the old
        // status behind either way — and the slot keeps its place in the column, so it's still the element the pointer is on)
        const icon = `assets/icons/status/${EFFECTS[entry.status]?.icon ?? 'sick'}.png`;
        const image = slot.querySelector('img');
        if (!image) slot.replaceChildren(statusIcon());
        const picture = slot.querySelector('img');
        if (picture && picture.getAttribute('src') !== icon) picture.setAttribute('src', icon);
        const left = typeof entry.left === 'function' ? entry.left : () => entry.left;
        statusLinesOf.set(slot, { left, lines: () => statusLines(entry.status, null, left()) });
      } else {
        if (slot.querySelector('img') || slot.textContent !== '–') slot.replaceChildren('–');
        statusLinesOf.delete(slot);
      }
      // (moved into place only where it isn't already: moving an element takes it out of the document and puts it back,
      // which is the same thing to a pointer resting on it as replacing it)
      if (column.children[i] !== slot) column.insertBefore(slot, column.children[i] ?? null);
    }
    while (column.children.length > want) column.lastElementChild.remove();
  }
  /** The picture on a status slot: the hand-drawn bitmap at its own size, as pixel-icons.js draws the icons it swaps in. */
  function statusIcon() {
    const image = document.createElement('img');
    image.width = 16;
    image.height = 15;
    image.alt = '';
    return image;
  }
  // ---- the tip: what a status effect is doing, while the pointer is within that icon's place in the column.
  // The pointer is tested against each icon's own rectangle every time the mouse moves — `e.clientX/Y` inside the icon's
  // `getBoundingClientRect()` — and the tip is put at the pointer, so it comes up wherever the pointer is and however the
  // card has moved or been drawn again since (the column is drawn again as the countdown ticks over a second, which is
  // exactly what a hover that lives on the element can't survive). The box is one of the card's own drop-downs, classed
  // `pc-mods pc-mods-status` for its look (see css/base.css and the win3 look) and `pc-tip` to take it out of that
  // machinery's hands: it's placed by position, not by layoutDrops, and a click never pins it the way a row's menu pins.
  const TIP_GAP = 14; // px between the pointer and the tip
  const TIP_TICK = 1000; // ms between the tip's own redraws: what's left of a status counts down while the tip is up
  const tip = document.createElement('div');
  tip.className = 'pc-mods pc-mods-status pc-tip';
  tip.hidden = true;
  el.append(tip);
  let tipShown = null, tipSaid = '', tipAt = null, tipRead = null, tipTick = null;
  // Puts the tip up over the pointer, its lines read from `read` — which asks the status how long it has left as it is
  // now, so the countdown in them is live. Nothing is written to the screen until the box is filled and measured, so it
  // comes up already in its place rather than showing at the pointer for a frame first.
  function showTip(icon, at, read) {
    if (tipShown !== icon) tipSaid = ''; // (a different status: everything it says is new)
    tipShown = icon;
    tipAt = at;
    tipRead = read;
    if (!fillTip()) return;
    placeTip();
    tip.hidden = false;
  }
  // Fills the tip with what its status says now, and says whether there's anything to show. Only the text is touched, so
  // a tick costs a few strings rather than a relayout of the card. A status with no time left is one that's over: the tip
  // goes, rather than sitting there saying "0 secs".
  function fillTip() {
    const left = tipRead?.left?.();
    if (left != null && left <= 0) return false;
    const lines = tipRead?.lines?.() ?? [];
    const said = lines.join('\n');
    if (!said) return false;
    if (said !== tipSaid) {
      tip.replaceChildren(...lines.map(text => {
        const line = document.createElement('div');
        line.className = 'pc-mod';
        line.textContent = text;
        return line;
      }));
      tipSaid = said;
    }
    return true;
  }
  // (measured as it is now, so the box is placed to the right of the pointer where there's room and over to its left where
  // there isn't — out across the card, which is where the room is — and never off the top or bottom of the screen)
  function placeTip() {
    const room = innerWidth - tipAt.x - TIP_GAP;
    const right = room > tip.offsetWidth ? room - tip.offsetWidth : Math.max(SCREEN_MARGIN, innerWidth - tipAt.x + TIP_GAP);
    const top = Math.max(SCREEN_MARGIN, Math.min(tipAt.y - 8, innerHeight - tip.offsetHeight - SCREEN_MARGIN));
    tip.style.right = `${right}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() {
    tip.hidden = true;
    tipShown = null;
    tipSaid = '';
    tipAt = null;
    tipRead = null;
    if (tipTick) { clearInterval(tipTick); tipTick = null; }
  }
  // (the tip's countdown runs whether or not the pointer moves: someone resting on an icon and watching the time left
  // should see it go down. Left to the pointer's own moves, a still pointer would leave it frozen. It's up on its own
  // timer, and goes when its status runs out or the icon it belonged to is drawn over.)
  function tickTip() {
    if (tip.hidden) return;
    if (!tipShown?.isConnected) { hideTip(); return; }
    if (fillTip()) placeTip(); else hideTip();
  }
  el.addEventListener('mousemove', e => {
    if (el.hidden) { if (!tip.hidden) hideTip(); return; }
    const at = { x: e.clientX, y: e.clientY };
    const over = [...statusLinesOf.keys()].find(icon => {
      const r = icon.getBoundingClientRect();
      return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom;
    });
    if (over) {
      showTip(over, at, statusLinesOf.get(over));
      tipTick ??= setInterval(tickTip, TIP_TICK);
    } else if (!tip.hidden) hideTip();
  });
  el.addEventListener('mouseleave', hideTip);
  // (the card's own click still pins a love's or hate's menu open, as it always has: the tip isn't in `dropByEl`, so a
  // click on an icon does nothing to it)
  // ---- modifier drop-downs: an entry with modifiers (`<key>Mods`, see set) opens a list of them beneath it when clicked,
  // until clicked again — so several can be open at once.
  // Each floats over the rows below it, as a menu drops down, so opening one never resizes the card: MOD_LINES lines at
  // most, scrolling for the rest.
  const MOD_LINES = 4;
  const SCREEN_MARGIN = 8; // px kept clear at the bottom of the screen, and above the card's own top edge
  const dropByEl = new Map(); // entry row or its drop-down → { entryEl, drop, count, pinned, row }
  const dropAt = target => { const found = target?.closest?.('.pc-has-mods, .pc-mods:not(.pc-tip)'); return found ? dropByEl.get(found) : null; };
  // (a click pins a love's or hate's menu open, as it always has; a status icon's tip is the pointer's doing, and a click
  // on one changes nothing)
  el.addEventListener('click', e => { const drop = dropAt(e.target); if (drop) { drop.pinned = !drop.pinned; layoutDrops(); } });
  window.addEventListener('resize', () => { if (!el.hidden) layoutDrops(); });
  // A drop-down of `lines` hung on `entryEl`, until it's cleared or the card's drawn again: a menu dropping down over
  // the rows below it, so opening one never resizes the card. `row` is the row it belongs to, so its entries can be
  // cleared together. Returns the state it's kept as.
  function makeDrop(entryEl, lines, row) {
    const drop = document.createElement('div');
    drop.className = 'pc-mods' + (row?.row ? ' pc-mods-' + row.row.key : '');
    drop.hidden = true;
    lines.forEach(text => {
      const line = document.createElement('div');
      line.className = 'pc-mod';
      line.textContent = text;
      drop.append(line);
    });
    entryEl.classList.add('pc-has-mods');
    entryEl.after(drop);
    const state = { entryEl, drop, count: lines.length, pinned: false, shown: false, row };
    dropByEl.set(entryEl, state).set(drop, state);
    row?.drops.push(state);
    return state;
  }
  // Gives `entryEl` (one of a love/hate row's entries, already in place) a drop-down of `lines`, placed right under it.
  function addDrop(row, entryEl, lines) {
    if (lines && lines.length) makeDrop(entryEl, lines, row);
  }
  function clearDrops(row) {
    row.drops.forEach(state => {
      state.drop.remove();
      state.entryEl.classList.remove('pc-has-mods', 'pc-mods-open');
      dropByEl.delete(state.entryEl);
      dropByEl.delete(state.drop);
    });
    row.drops = [];
  }
  // Shows the open drop-downs: one hanging off a love/hate entry, pinned there, runs the width of its entry's text and sits
  // under it — a table of the trait lines it opened to show — a row shorter (scrolling) for each that would come within
  // SCREEN_MARGIN of the bottom of the screen. (A status effect's tip isn't one of these: it's placed by the pointer — see
  // the tip above.)
  //
  // A drop hangs on the whole row (`entryEl`), so it's that row's `.pc-value` — the text and its mark, in the row's second
  // grid column — that says where the menu goes: its own left, its own width. Measuring the row instead would put the menu
  // out over the Loves/Hates label, a column to the left of the entry it belongs to.
  function layoutDrops() {
    Object.values(rows).flatMap(row => row.drops).forEach(state => {
      const isOpen = state.pinned;
      state.drop.hidden = !isOpen;
      state.entryEl.classList.toggle('pc-mods-open', isOpen);
      if (!isOpen) return;
      const value = state.entryEl.querySelector('.pc-value');
      state.drop.style.top = state.entryEl.offsetTop + state.entryEl.offsetHeight + 'px';
      state.drop.style.left = (value ?? state.entryEl).offsetLeft + 'px';
      state.drop.style.right = 'auto';
      state.drop.style.width = (value ?? state.entryEl).offsetWidth + 'px';
      let lines = Math.min(state.count, MOD_LINES);
      state.drop.style.setProperty('--mod-lines', lines);
      while (lines > 1 && state.drop.getBoundingClientRect().bottom > innerHeight - SCREEN_MARGIN) {
        state.drop.style.setProperty('--mod-lines', --lines);
      }
    });
  }

  // Marks the visible rows below the picture: `pc-alt` on every other one, `pc-lead` on the first. Done here rather than with
  // :nth-child because hidden rows still count as children in CSS. Call after any change to which rows are shown.
  function restripe() {
    [...body.children].filter(rowEl => !rowEl.hidden && rowEl.classList.contains('pc-row')).forEach((rowEl, i) => {
      rowEl.classList.toggle('pc-alt', i % 2 === 1);
      rowEl.classList.toggle('pc-lead', i === 0);
    });
  }
  // A row's tier classes (see setTier below): none of them, so a freshly-shown or hidden row never keeps an old one.
  const TIERS = ['legendary', 'terrible'];
  function setTier(el, tier) { TIERS.forEach(t => el.classList.toggle('pc-tier-' + t, t === tier)); }
  // An entry's mark (see `marked` in ROWS): + legendary, - terrible, * any other entry with modifiers to show, else none.
  const markOf = (tier, mods) => tier === 'legendary' ? '+' : tier === 'terrible' ? '-' : mods && mods.length ? '*' : '';
  // Sets a row to a string or a list of strings. The first entry goes in the row, the rest in unlabelled rows beneath it.
  // null, '' and an empty list hide the row; empty entries are skipped. `tierValue`, alongside (see `<attribute>Tier` in
  // core/type-text.js), is 'legendary' or 'terrible' or null per entry, kept lined up with `value` as both are filtered —
  // that entry's row (its own if it's the first, else the little row below) is coloured gold or dark reddish-brown for it
  // (see the --trait-legendary-*/--trait-terrible-* rules in css/base.css). `modsValue`, likewise lined up (see
  // `<attribute>Mods` in core/type-text.js), is a list of modifier lines per entry, for its drop-down (see addDrop).
  function set(key, value, tierValue = null, modsValue = null) {
    const row = rows[key];
    if (!row) return;
    const values = Array.isArray(value) ? value : [value], tierValues = Array.isArray(tierValue) ? tierValue : [];
    const modValues = Array.isArray(modsValue) ? modsValue : [];
    const said = [], tiers = [], mods = [];
    values.forEach((item, i) => {
      if (item == null || item === '') return;
      said.push(String(item)); tiers.push(tierValues[i] ?? null); mods.push(modValues[i] ?? null);
    });
    row.value.textContent = said[0] || '';
    row.el.hidden = !said.length;
    setTier(row.el, tiers[0]);
    clearDrops(row);
    row.extras.forEach(extra => extra.remove());
    row.extras = [];
    said.slice(1).forEach((text, i) => {
      const extra = document.createElement('div');
      extra.className = 'pc-row pc-row-' + row.row.key + ' pc-extra';
      setTier(extra, tiers[i + 1]);
      const value = document.createElement('span');
      value.className = 'pc-value' + (row.row.cls ? ' ' + row.row.cls : '');
      value.textContent = text;
      extra.append(document.createElement('span'), value);
      (row.extras.length ? row.extras[row.extras.length - 1] : row.el).after(extra);
      row.extras.push(extra);
    });
    // (drop-downs go in once every entry is placed, so each sits right under its own)
    if (said.length) [row.el, ...row.extras].forEach((entryEl, i) => {
      if (row.row.marked) entryEl.querySelector('.pc-value').dataset.mark = markOf(tiers[i], mods[i]);
      addDrop(row, entryEl, mods[i]);
    });
    restripe();
    layoutDrops();
  }
  // A list row (see ROWS): the names, one a line, the one at `tracked` (whoever the camera's leaving with, if anyone)
  // highlighted — 'None' when there's nobody, so the row still says so rather than vanishing.
  // `pick`, if given, is { title, onClick } for the names themselves: a click hands onClick which of them it was, and
  // whoever put the list there takes it from there — for all three of these lists, by marking that one as the one to
  // follow out (see setBuildingCardInhabitants, setTrainCardPassengers and setHiveCardBees).
  function setList(key, names, tracked = -1, pick = null) {
    const row = rows[key];
    if (!row) return;
    row.el.hidden = false;
    restripe();
    row.value.textContent = names.length ? '' : 'None';
    names.forEach((name, i) => {
      const line = document.createElement(pick ? 'button' : 'div');
      line.className = 'pc-line' + (i === tracked ? ' pc-tracked' : '') + (pick ? ' pc-pick' : '');
      line.textContent = name;
      if (pick) {
        if (pick.title) line.title = pick.title;
        line.addEventListener('click', () => pick.onClick(i));
      }
      row.value.append(line);
    });
  }
  // Opens the card on `values`, a row key to what it says for whichever rows are known at the time — the rest are left
  // out until something sets them (a person going indoors, say, or who's aboard a train). A card is handed whatever a
  // kind's reader returns, traits included; the card has no row for those, so it ignores them.
  function show(values) {
    Object.keys(rows).forEach(key => set(key, values[key], values[key + 'Tier'], values[key + 'Mods']));
    setFavorite(null);
    el.hidden = false;
    el.dispatchEvent(new Event('card-show', { bubbles:true })); // (for the Windows 3.0 look's active window: ui/win3-menu.js)
  }
  // What the card's showing, for its heart: { key, kind, follow } as a favorite takes them (see ui/favorites.js) — or null
  // for no heart. show() takes the heart away, so this comes after it.
  function setFavorite(entry) {
    favorite = entry;
    heart.hidden = !entry;
    drawHeart();
  }
  function hide() { el.hidden = true; resetPlace(); }
  // dragged about by its title bar (not on phones, where it spans the screen: css/phone.css), and back where it started
  // once closed — or, for all of them, once out of a building's room (see leaveBuilding in buildings/interior.js)
  function resetPlace() { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; }
  // the health bar's fill, 0 to 1, green to red (no-op on a card without one)
  function setHealth(fraction) {
    if (!healthFill) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    healthFill.style.width = clamped*100 + '%';
    healthFill.style.background = `hsl(${Math.round(120*clamped)}, 70%, 45%)`;
  }
  // follows `entity`'s health until bound to another (null for none)
  let healthEntity = null;
  function bindHealth(entity, kind) {
    healthEntity = entity;
    if (entity) healthOf(entity, kind);
    setHealth(healthFraction(entity));
  }
  if (health) onHealthChanged(entity => { if (entity === healthEntity) setHealth(healthFraction(entity)); });
  // Rewrites the card's own wording (title, Smite button, row headings such as "Loves") through `transform`, which is given
  // each as written. null puts it all back.
  let relabelling = null;
  function relabel(transform = null) {
    relabelling = transform;
    fixedText.forEach(([textEl, text]) => { textEl.textContent = transform ? transform(text) : text; });
  }

  // the title bar's wording, for a card that names what it's showing there (a Pub, a Police car) rather than a fixed title
  function setTitle(text) {
    titleEntry[1] = text;
    titleText.textContent = relabelling ? relabelling(text) : text;
  }

  // the action button's wording (and tooltip), as `action` in makeCard gave them first
  function setAction(text, tooltip) {
    if (!actionText) return;
    actionText[1] = text;
    actionText[0].textContent = relabelling ? relabelling(text) : text;
    if (tooltip != null) actionText[0].title = tooltip;
  }
  // the action button there or not (a building's Enter only on those people go into)
  function showAction(shown) {
    if (actionText) actionText[0].style.display = shown ? '' : 'none';
  }

  dragByTitle(el, () => !matchMedia('(max-width: 760px)').matches);

  const card = { el, canvas, show, hide, resetPlace, set, setList, relabel, setTitle, setFavorite, setAction, showAction, setHealth, bindHealth,
    setEffects, selectTab, tabPane: key => panes[key] ?? null, activeTab: () => activeTab, onTab: listener => { tabListeners.push(listener); } };
  cards.push(card);
  // What this card's status column is doing, for the console (see the `status` handle in src/main.js): read live off the
  // card, so a redraw between a hover and reading it doesn't leave a stale answer.
  inspected.set(el, { column: () => effectsEl, tip: () => tip, lines: () => statusLinesOf });
  return card;
}
