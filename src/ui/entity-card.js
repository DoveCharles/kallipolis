// ============================================================ the card for whatever's being followed
// The card at the bottom right saying what the camera's following: a person (life/person-card.js), a car
// (life/car-card.js), a carriage (trains/train-card.js), a building (buildings/building-card.js), or a bee or its hive
// (life/bee-card.js). They're all this one card with different rows filled in — they differ only in their title, their
// picture, and whether there's a Kill button.
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

// the rows a .txt file fills in (see core/type-text.js) — the rest are worked out as the world runs
export const TEXT_ROWS = ['name', 'mood', 'loves', 'hates'];

// every card there is, in the order they were made — so the things that treat them all alike (the Windows 3.0 look in
// ui/win3.js, the phone layout in ui/mobile.js) can go through them rather than each naming all four
export const cards = [];

// `title` is the name in its title bar; `onClose` is what the × (and the control-menu box, under the Windows 3.0 look)
// does. `thumb` is { title, onClick } for the picture — leave out onClick and it's just a picture. `kill`, if given, is
// { title, onClick } for a Kill button under it. `labels` renames rows for this card ({ occupants: 'Passengers' }).
export function makeCard({ id, title, onClose, thumb = {}, kill = null, labels = {} }) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'entity-card';
  el.hidden = true;

  // the title bar (only drawn by the Windows 3.0 look), and the × for every other look
  const titlebar = document.createElement('div');
  titlebar.className = 'win3-titlebar';
  const sysbox = document.createElement('button');
  sysbox.className = 'win3-sysbox';
  sysbox.title = 'Close';
  const titleText = document.createElement('div');
  titleText.className = 'win3-title';
  titleText.textContent = title;
  titlebar.append(sysbox, titleText);
  const close = document.createElement('button');
  close.className = 'card-close';
  close.title = 'Stop following';
  close.textContent = '×';
  sysbox.addEventListener('click', () => onClose());
  close.addEventListener('click', () => onClose());

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
  if (kill) {
    const button = document.createElement('button');
    button.className = 'btn danger pc-kill';
    button.title = kill.title || '';
    button.textContent = 'Kill';
    button.addEventListener('click', () => kill.onClick());
    shot.append(button);
  }

  // the rows themselves, all of them made now and shown as they're given something to say
  const rows = {};
  const top = document.createElement('div'), body = document.createElement('div');
  top.className = 'pc-rows';
  body.className = 'pc-body';
  ROWS.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'pc-row' + (row.gap ? ' pc-gap' : '');
    rowEl.hidden = true;
    const label = document.createElement('span');
    label.className = 'pc-label';
    label.textContent = labels[row.key] || row.label;
    const value = document.createElement('span');
    value.className = 'pc-value' + (row.cls ? ' ' + row.cls : '');
    rowEl.append(label, value);
    (row.top ? top : body).append(rowEl);
    rows[row.key] = { el: rowEl, value, row };
  });
  const topSection = document.createElement('div');
  topSection.className = 'pc-top';
  topSection.append(top, shot);
  el.append(titlebar, close, topSection, body);
  document.body.append(el);

  // one row: what it says, or null/'' to take it away again
  function set(key, value) {
    const row = rows[key];
    if (!row) return;
    const said = value == null || value === '' ? null : String(value);
    row.value.textContent = said || '';
    row.el.hidden = said == null;
  }
  // a list row (see ROWS): the names, one a line, the one at `tracked` (whoever the camera came in with, if any)
  // highlighted — 'None' when there's nobody, so the row still says so rather than vanishing
  function setList(key, names, tracked = -1) {
    const row = rows[key];
    if (!row) return;
    row.el.hidden = false;
    row.value.textContent = names.length ? '' : 'None';
    names.forEach((name, i) => {
      const line = document.createElement('div');
      line.textContent = name;
      if (i === tracked) line.className = 'pc-tracked';
      row.value.append(line);
    });
  }
  // Opens the card on `values`, a row key to what it says for whichever rows are known at the time — the rest are left
  // out until something sets them (a person going indoors, say, or who's aboard a train).
  function show(values) {
    Object.keys(rows).forEach(key => set(key, values[key]));
    el.hidden = false;
  }
  function hide() { el.hidden = true; }

  const card = { el, canvas, show, hide, set, setList };
  cards.push(card);
  return card;
}
