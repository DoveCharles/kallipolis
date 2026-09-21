import { isFavorite, toggleFavorite, onFavoritesChanged } from './favorites.js';

// ============================================================ the card for whatever's being followed
// The card at the bottom right saying what the camera's following: a person (life/person-card.js), a car
// (life/car-card.js), a carriage (trains/trains.js), an aircraft (zones/airport.js), a building
// (buildings/building-card.js), or a bee or its hive (life/bees.js). They're all this one card with different rows filled
// in — they differ only in their title, their picture, and whether there's a Kill button.
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
  { key: 'loves',     label: 'Loves',     gap: true },
  { key: 'hates',     label: 'Hates' },
  { key: 'occupants', label: 'Inhabitants', gap: true, list: true },
];
// `top`: up beside the picture, rather than below it. `gap`: a rule above it. `list`: several names, one a line (see
// setList) rather than one value.
// Any row accepts either one string or a list of strings (see `set`); each extra entry gets its own row below, classed
// with the row's key (pc-row-loves).

// the rows a .txt file fills in (see core/type-text.js) — the rest are worked out as the world runs
export const TEXT_ROWS = ['name', 'mood', 'loves', 'hates'];

// every card there is, in the order they were made — so the things that treat them all alike (the Windows 3.0 look in
// ui/win3.js, the phone layout in ui/mobile.js) can go through them rather than each naming all four
export const cards = [];

// `title` is the name in its title bar; `onClose` is what the × (and the control-menu box, under the Windows 3.0 look)
// does. `thumb` is { title, onClick } for the picture — leave out onClick and it's just a picture. `kill`, if given, is
// { title, onClick } for a Kill button under it. `action`, if given, is { text, title, onClick } for a plain button in the
// same place (a building's Enter: see buildings/interior.js), its wording changed later with setAction. `labels` renames
// rows for this card ({ occupants: 'Passengers' }).
export function makeCard({ id, title, onClose, thumb = {}, kill = null, action = null, labels = {} }) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'entity-card';
  el.hidden = true;

  // the title bar (only drawn by the Windows 3.0 look), and the × for every other look
  // the card's own wording — its title, the Kill button and the row headings — as [element, text], for relabel below
  const fixedText = [];
  const titlebar = document.createElement('div');
  titlebar.className = 'win3-titlebar';
  const sysbox = document.createElement('button');
  sysbox.className = 'win3-sysbox';
  sysbox.title = 'Close';
  const titleText = document.createElement('div');
  titleText.className = 'win3-title';
  titleText.textContent = title;
  fixedText.push([titleText, title]);
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
    // (something hearted that the favorites spare can't be killed, so there's no Kill button for it: see ui/favorites.js)
    if (killButton) killButton.hidden = on && !!favorite.spares;
    heart.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
      + '<path d="M12 20.5s-7.6-4.6-9.4-9.3C1.2 7.6 3.5 4 7.2 4c2.1 0 3.6 1.1 4.8 2.9C13.2 5.1 14.7 4 16.8 4c3.7 0 6 3.6 4.6 7.2-1.8 4.7-9.4 9.3-9.4 9.3z"/></svg>';
  }
  heart.addEventListener('click', () => {
    if (!favorite) return;
    toggleFavorite({ ...favorite, kindLabel: title }, rows.name.value.textContent || title, canvas.hidden ? null : canvas.toDataURL());
  });
  onFavoritesChanged(drawHeart);

  // the picture, and the Kill button under it
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
  shot.append(canvas);
  let killButton = null;
  if (kill) {
    const button = killButton = document.createElement('button');
    button.className = 'btn danger pc-kill';
    button.title = kill.title || '';
    button.textContent = 'Kill';
    fixedText.push([button, 'Kill']);
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
    rows[row.key] = { el: rowEl, value, row, extras: [] };
  });
  const topSection = document.createElement('div');
  topSection.className = 'pc-top';
  topSection.append(top, shot);
  el.append(titlebar, heart, close, topSection, body);
  document.body.append(el);

  // Marks the visible rows below the picture: `pc-alt` on every other one, `pc-lead` on the first. Done here rather than with
  // :nth-child because hidden rows still count as children in CSS. Call after any change to which rows are shown.
  function restripe() {
    [...body.children].filter(rowEl => !rowEl.hidden).forEach((rowEl, i) => {
      rowEl.classList.toggle('pc-alt', i % 2 === 1);
      rowEl.classList.toggle('pc-lead', i === 0);
    });
  }
  // Sets a row to a string or a list of strings. The first entry goes in the row, the rest in unlabelled rows beneath it.
  // null, '' and an empty list hide the row; empty entries are skipped.
  function set(key, value) {
    const row = rows[key];
    if (!row) return;
    const said = (Array.isArray(value) ? value : [value]).filter(item => item != null && item !== '').map(String);
    row.value.textContent = said[0] || '';
    row.el.hidden = !said.length;
    row.extras.forEach(extra => extra.remove());
    row.extras = [];
    said.slice(1).forEach(text => {
      const extra = document.createElement('div');
      extra.className = 'pc-row pc-row-' + row.row.key + ' pc-extra';
      const value = document.createElement('span');
      value.className = 'pc-value' + (row.row.cls ? ' ' + row.row.cls : '');
      value.textContent = text;
      extra.append(document.createElement('span'), value);
      (row.extras.length ? row.extras[row.extras.length - 1] : row.el).after(extra);
      row.extras.push(extra);
    });
    restripe();
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
    Object.keys(rows).forEach(key => set(key, values[key]));
    setFavorite(null);
    el.hidden = false;
  }
  // What the card's showing, for its heart: { key, kind, follow } as a favorite takes them (see ui/favorites.js) — or null
  // for no heart. show() takes the heart away, so this comes after it.
  function setFavorite(entry) {
    favorite = entry;
    heart.hidden = !entry;
    drawHeart();
  }
  function hide() { el.hidden = true; }
  // Rewrites the card's own wording (title, Kill button, row headings such as "Loves") through `transform`, which is given
  // each as written. null puts it all back.
  let relabelling = null;
  function relabel(transform = null) {
    relabelling = transform;
    fixedText.forEach(([textEl, text]) => { textEl.textContent = transform ? transform(text) : text; });
  }

  // the action button's wording (and tooltip), as `action` in makeCard gave them first
  function setAction(text, tooltip) {
    if (!actionText) return;
    actionText[1] = text;
    actionText[0].textContent = relabelling ? relabelling(text) : text;
    if (tooltip != null) actionText[0].title = tooltip;
  }

  const card = { el, canvas, show, hide, set, setList, relabel, setFavorite, setAction };
  cards.push(card);
  return card;
}
