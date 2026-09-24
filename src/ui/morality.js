import { S, App } from '../core/shared.js';
import { toUi } from './ui-scale.js';

// ============================================================ morality meter
// How good or evil the city is, in a meter at the top right: a bar growing from the middle, left (and redder) the more evil,
// right (and greener) the more good. It's everything in the world added up — each zone, path and building worth what
// assets/morality.txt says (to be edited freely) — along with things that happen, like people getting killed. The
// show/hide button lists what it's made of, and each change pops up next to the bar for a few seconds.
const MORALITY_TEXT_URL = 'assets/morality.txt';
const MORALITY_MAX = 2500, MORALITY_KNEE = 500;   // max value & value that should land at the halfway point of that half-bar;
const MORALITY_EXP = Math.log(0.5) / Math.log(MORALITY_KNEE / MORALITY_MAX); 
const NOTICE_LIFE = 3500, NOTICES_MAX = 6;
const NOTICE_EXIT_MS = 300;         // how long a notice takes to be gone once it's over
const NOTICE_EXIT_SPREAD = 14;      // how far either side of its own line it can drift on the way out, in pixels
const QUIET_TICKS_TO_SETTLE = 1; // a change is only announced once the world's held still this many ticks (so a drag is one notice)
const TICK_MS = 400;

// the "x3" on a notice, and the jolt it lands with
const COUNT_START = 3;      // the count the lurch starts at: below this it doesn't move at all, it only darkens
const COUNT_KNEE = 8;       // the count it has found its feet by: it's COUNT_KNEE_WORTH of the way in at x8
const COUNT_KNEE_WORTH = 0.2;
const COUNT_EXTREME = 20;   // the count it's going as hard as it would at the top end
const COUNT_CLIMB = 0.15;   // past that it keeps getting harder, by this much per square root of the count over
const COUNT_TURN = -100;    // where a full lurch starts, in degrees: counter-clockwise of where it ends
const COUNT_DIP = 0.25;     // how far it drops at its lowest, as a fraction of the chip's own line height
const COUNT_GROW = 0.75;    // how much it swells at that same point, as a fraction of its resting size
// Its colour: a dim grey down to black over the counts that don't move, then dark purple, violet, blue, red and the reddish
// magenta it lands on, all by x20. Past that it goes round the colour wheel, a whole rainbow every COUNT_CYCLE counts, so a
// count in the hundreds is a thing to behold.
const COUNT_SHADES = ['#3a3a3a', '#101010', '#4c2a86', '#8b5cf6', '#4f7bf7', '#e0473f'];
const COUNT_END = '#e0317e';    // the reddish magenta at the end of the run
const COUNT_CYCLE = 10;         // counts per turn of the colour wheel past it
const colorBytes = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// Two colours blended, `t` of the way from `a` to `b`.
function mixColors(a, b, t) {
  const [ar, ag, ab] = colorBytes(a), [br, bg, bb] = colorBytes(b);
  const byte = value => Math.round(value).toString(16).padStart(2, '0');
  return `#${byte(ar + (br - ar)*t)}${byte(ag + (bg - ag)*t)}${byte(ab + (bb - ab)*t)}`;
}
// How hard a count lurches, as a fraction of the full throw. Nothing at all up to COUNT_START; then it eases in to
// COUNT_KNEE_WORTH of the way by COUNT_KNEE, so the first few past the start are a nudge; a straight run from there to
// COUNT_EXTREME, where it's going as hard as a lurch gets; and past that it still creeps up, by less and less each time,
// so a count in the hundreds is enormous without ever being so big it leaves the notice behind.
function countJolt(count) {
  if (count <= COUNT_START) return 0;
  const knee = (count - COUNT_START)/(COUNT_KNEE - COUNT_START);
  // up to the knee it comes off the mark gently, into a run: a soft start rather than a straight line
  if (count < COUNT_KNEE) return COUNT_KNEE_WORTH*(knee*knee/ (1 + knee*knee));
  const climbed = COUNT_KNEE_WORTH + (1 - COUNT_KNEE_WORTH)*Math.min((count - COUNT_KNEE)/(COUNT_EXTREME - COUNT_KNEE), 1);
  return count <= COUNT_EXTREME ? climbed : climbed + COUNT_CLIMB*Math.sqrt(count - COUNT_EXTREME);
}
// One colour of the wheel, `hue` in degrees, at full saturation and middling lightness.
function wheelColor(hue) {
  const h = ((hue % 360) + 360) % 360/60, x = Math.round(255*(1 - Math.abs(h % 2 - 1)));
  const [r, g, b] = h < 1 ? [255, x, 0] : h < 2 ? [x, 255, 0] : h < 3 ? [0, 255, x] : h < 4 ? [0, x, 255] : h < 5 ? [x, 0, 255] : [255, 0, x];
  const byte = value => value.toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
// A count's colour. Up to COUNT_START the counts only darken, dim grey at x1 to black at x3; from there the run of
// colours, reaching the reddish magenta at COUNT_EXTREME. Past that it goes round the wheel, a whole rainbow every
// COUNT_CYCLE counts, so a big count is never the same colour twice in a row.
function countColor(count) {
  if (count <= COUNT_START) return mixColors(COUNT_SHADES[0], COUNT_SHADES[1], (count - 1)/(COUNT_START - 1));
  if (count > COUNT_EXTREME) return wheelColor((count - COUNT_EXTREME)/COUNT_CYCLE*360 + 330); // a cycle lands back on that reddish magenta
  const shades = [...COUNT_SHADES, COUNT_END], span = COUNT_EXTREME - COUNT_START;
  const at = Math.min((count - COUNT_START)/span, 1)*(shades.length - 1);
  const i = Math.min(shades.length - 2, Math.floor(at));
  return mixColors(shades[i], shades[i + 1], at - i);
}
// The jolt: a count lands by swinging in out of counter-clockwise, dipping and swelling on the way, and rocking back level.
// `--count-turn` and `--count-dip` carry how hard it does it, and both grow with the count, so the first few land with a
// shove and the twentieth one is thrown at the notice. Restarting is the point: the animation is taken off, the layout
// forced, and put back, so an x5 that becomes an x6 lurches again rather than sitting there.
function joltCount(chip, count) {
  const weight = countJolt(count);
  chip.style.setProperty('--count-color', countColor(count));
  chip.style.setProperty('--count-turn', (COUNT_TURN*weight).toFixed(1) + 'deg');
  chip.style.setProperty('--count-dip', (COUNT_DIP*weight).toFixed(3) + 'em');
  chip.style.setProperty('--count-grow', (1 + COUNT_GROW*weight).toFixed(3));
  chip.classList.add('meter-count-jolt'); // (the chip is new each time, so its animation starts by itself)
}

// what's counted, grouped as the details list shows it: `key` is the line in morality.txt under the group's [heading]
const GROUPS = [
  { id: 'zones', label: 'Zones', items: [
    { key: 'buildings', label: 'Cities' }, { key: 'plain', label: 'Plain' }, { key: 'park', label: 'Parks' },
    { key: 'beach', label: 'Beaches' }, { key: 'water', label: 'Water' }, { key: 'plaza', label: 'Plazas' },
    { key: 'farmland', label: 'Farmland' }, { key: 'industrial', label: 'Industrial' },
    { key: 'suburbs', label: 'Suburbs' }, { key: 'town', label: 'Towns' }, { key: 'airport', label: 'Airports' },
  ] },
  { id: 'paths', label: 'Paths', items: [
    { key: 'roads', label: 'Roads' }, { key: 'walkways', label: 'Walkways' },
    { key: 'rivers', label: 'Rivers' }, { key: 'train lines', label: 'Train lines' },
  ] },
  { id: 'buildings', label: 'Buildings', items: [
    { key: 'commercial', label: 'Commercial' }, { key: 'industrial', label: 'Industrial' }, { key: 'farmhouses', label: 'Farmhouses' },
    { key: 'houses', label: 'Houses' }, { key: 'townhouses', label: 'Townhouses' }, { key: 'terminals', label: 'Terminals' },
  ] },
];
const EVENTS = [
  { key: 'innocent peds killed by player', label: 'Innocents killed by player' },
  { key: 'innocent peds killed by cars', label: 'Innocents killed by cars' },
  { key: 'guilty peds killed by player', label: 'Guilty killed by player' },
  { key: 'guilty peds killed by cars', label: 'Guilty killed by cars' },
  { key: 'villainous peds killed by player', label: 'Villains killed by player' },
  { key: 'villainous peds killed by cars', label: 'Villains killed by cars' },
  { key: 'cars destroyed by player', label: 'Cars destroyed by player' },
];
const BUILDING_KIND_OF_ZONE = { buildings: 'commercial', industrial: 'industrial', farmland: 'farmhouses', suburbs: 'houses', town: 'townhouses', airport: 'terminals' };

// scores from morality.txt, by [heading] then line — all 0 until it's loaded (or if it can't be)
let scores = {};
let multiplier = 1;
const eventCounts = Object.fromEntries(EVENTS.map(e => [e.key, 0]));

function parseMoralityText(text) {
  const parsed = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[([^[\]]+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = parsed[current] || {}; return; }
    const pair = line.match(/^(.+?)\s*=\s*(\S+)$/);
    const value = pair ? parseFloat(pair[2]) : NaN;
    if (!current || !Number.isFinite(value)) { console.warn(`Splinetopia: in morality.txt, "${line}" isn't a "thing = score" line under a [heading]`); return; }
    parsed[current][pair[1].trim().toLowerCase()] = value;
  });
  return parsed;
}
const scoreOf = (group, key) => (scores[group] && scores[group][key]) || 0;

// ---------------------------------------------------------- counting
// how many of each thing there are, and what they're worth: { lines: {id: {count, score}}, groups: {...}, overall }
// (a line's id is `group/key`)
// How many buildings a zone's group holds, counted again only when the group is a different one or holds a different number of
// things: counting walks every child, and tally runs on a timer and at every kill.
const buildingCounts = new WeakMap();
function buildingsIn(group) {
  const seen = buildingCounts.get(group);
  if (seen && seen.length === group.children.length) return seen.count;
  const count = group.children.filter(c => c.name === 'Building').length;
  buildingCounts.set(group, { length: group.children.length, count });
  return count;
}
function tally() {
  const counts = {};
  const add = (group, key, n = 1) => { const id = group + '/' + key; counts[id] = (counts[id] || 0) + n; };
  S.zones.forEach(zone => {
    if (zone.drawing || !zone.closed) return; // (only finished zones count)
    const type = zone.zoneType || 'buildings';
    add('zones', type);
    const kind = BUILDING_KIND_OF_ZONE[type];
    if (kind && zone.buildingsGroup) add('buildings', kind, buildingsIn(zone.buildingsGroup));
  });
  S.roadLines.forEach(line => {
    if (line.drawing) return;
    add('paths', line.kind === 'train' ? 'train lines' : line.roadType === 'walkway' || line.roadType === 'raised' ? 'walkways' : line.roadType === 'river' ? 'rivers' : 'roads');
  });
  const lines = {}, groups = {};
  let total = 0;
  GROUPS.forEach(g => {
    groups[g.id] = { count: 0, score: 0 };
    g.items.forEach(item => {
      const count = counts[g.id + '/' + item.key] || 0, score = count*scoreOf(g.id, item.key);
      lines[g.id + '/' + item.key] = { count, score };
      groups[g.id].count += count; groups[g.id].score += score;
    });
    total += groups[g.id].score;
  });
  EVENTS.forEach(e => {
    const count = eventCounts[e.key], score = count*scoreOf('events', e.key);
    lines['events/' + e.key] = { count, score };
    total += score;
  });
  const overall = Math.max(-MORALITY_MAX, Math.min(MORALITY_MAX, total*multiplier));
  return { lines, groups, overall };
}

// ---------------------------------------------------------- the meter
// The reusable meter component (src/ui/meter.css) is styled by class, not id, so a second meter elsewhere in the menu
// can reuse this exact markup under its own container id. Its pieces are found within that one container below,
// rather than by a global id, for the same reason — see meterWindow further down.
const meterWindow = document.getElementById('morality-meter');
const valueEl = meterWindow.querySelector('.meter-value');
const fillEl = meterWindow.querySelector('.meter-fill');
const toggleEl = meterWindow.querySelector('.meter-toggle');
const detailsEl = meterWindow.querySelector('.meter-details');
const noticesEl = meterWindow.querySelector('.meter-notices');

const NEUTRAL = [146, 150, 160], EVIL = [229, 72, 77], GOOD = [61, 220, 151];

function meterColor(v) {
  const t = meterFrac(v); // same non-linear curve as the bar fill
  const to = v < 0 ? EVIL : GOOD;
  return `rgb(${NEUTRAL.map((c, i) => Math.round(c + (to[i] - c) * t)).join(',')})`;
}
const round1 = n => Math.round(n*10)/10 || 0; // (|| 0: no "-0")
const signed = n => { const r = round1(n); return (r > 0 ? '+' : '') + r; };
const scoreClass = n => round1(n) > 0 ? 'pos' : round1(n) < 0 ? 'neg' : '';

function meterFrac(v) {
  const clamped = Math.min(Math.abs(v), MORALITY_MAX);
  return Math.pow(clamped / MORALITY_MAX, MORALITY_EXP); // 0..1, non-linear
}


function renderMeter(t) {
  const v = t.overall, color = meterColor(v);
  valueEl.textContent = signed(v);
  valueEl.style.color = color;
  fillEl.style.background = color;

  const frac = meterFrac(v); // 0..1
  fillEl.style.width = (frac * 50) + '%';
  fillEl.style.left = v < 0 ? (50 - frac * 50) + '%' : '50%';

  if (detailsEl.hidden) return;
  const row = (label, count, score, sub) =>
    `<div class="meter-row${sub ? ' sub' : ''}"><span class="meter-label">${sub ? '• ' : ''}${label}</span><span class="meter-count">${count}</span><span class="meter-score ${scoreClass(score)}">${signed(score)}</span></div>`;
  detailsEl.innerHTML =
    GROUPS.map(g => row(g.label, t.groups[g.id].count, t.groups[g.id].score, false) +
      g.items.map(item => { const l = t.lines[g.id + '/' + item.key]; return row(item.label, l.count, l.score, true); }).join('')).join('') +
    `<div class="meter-gap"></div>` +
    EVENTS.map(e => { const l = t.lines['events/' + e.key]; return row(e.label, l.count, l.score, false); }).join('');
}
// the details open and close from the show/hide button — or, in the Windows 3.0 look, from the window's title bar, just like
// the Splinetopia window (see win3.js): minimize folds them away, maximize (or the control-menu box, to toggle) opens them
function setDetailsOpen(open) {
  detailsEl.hidden = !open;
  toggleEl.textContent = open ? 'hide' : 'show';
  meterWindow.classList.toggle('win3-minimized', !open);
  renderMeter(tally());
}
toggleEl.addEventListener('click', () => setDetailsOpen(detailsEl.hidden));
meterWindow.querySelector('.win3-min').addEventListener('click', () => setDetailsOpen(false));
meterWindow.querySelector('.win3-max').addEventListener('click', () => setDetailsOpen(true));
meterWindow.querySelector('.win3-sysbox').addEventListener('click', () => setDetailsOpen(detailsEl.hidden));
// (and from the bar itself, which is all that shows of it in the Windows 3.0 window's toolbar — see css/win3.css)
const readoutEl = meterWindow.querySelector('.meter-readout');
readoutEl.title = 'Morality: click for the breakdown';
readoutEl.addEventListener('click', () => setDetailsOpen(detailsEl.hidden));
meterWindow.classList.add('win3-minimized');

// ---------------------------------------------------------- notices
// a line as a notice names it: "Zones · Parks", "Paths · Roads", "Villains killed by player"…
const noticeLabels = {};
GROUPS.forEach(g => g.items.forEach(item => { noticeLabels[g.id + '/' + item.key] = `${g.label} · ${item.label}`; }));
EVENTS.forEach(e => { noticeLabels['events/' + e.key] = e.label; });

// The notices on show, by what they're about: another of the same kind adds to the one already up — its tally, and
// the name of whoever it was — rather than stacking a second copy, and gives it its full life again. Each is
// { el, score, label, count, names, timer }.
const liveNotices = new Map();
const NOTICE_NAMES_MAX = 3;
// The notices are stacked in the order they're shown, which is the order they're in here — by how many of it there have
// been, the most first, so what's been happening most often is the one at the top. Two on the same count keep the order
// they came up in.
//
// Moving an element is what makes a notice flicker, so the ones already in the right place are left alone: the current
// order is walked against the ranked one, and only an element sitting where another belongs is put in front of it. When
// they're already ranked nothing is touched at all, which is the usual case — most updates change a count without changing
// the order.
function rankNotices() {
  const ranked = [...liveNotices.entries()].sort((a, b) => b[1].count - a[1].count);
  // the higher up the stack, the further forward it sits (see --notice-z in src/ui/meter.css); set on every call, since a notice
  // coming or going moves everyone's place even when the order stays the same
  ranked.forEach(([, live], i) => live.el.style.setProperty('--notice-z', String(ranked.length - i)));
  const order = [...noticesEl.children];
  if (ranked.length === order.length && ranked.every(([, live], i) => live.el === order[i])) return;
  ranked.forEach(([id, live]) => liveNotices.set(id, live)); // the map's order is the stack's, so it's put right too
  ranked.forEach(([, live], i) => {
    if (order[i] === live.el) return;
    noticesEl.insertBefore(live.el, order[i] || null);
    order.splice(order.indexOf(live.el), 1);
    order.splice(i, 0, live.el);
  });
}
// A notice that's over doesn't blink out: it's let go of — taken out of the stack so what's left is what's on show — and
// sent up from where it was sitting, with a little drift to one side or the other so a few going at once don't leave in a
// straight line. It's put where it was first, since out of the stack it would otherwise jump to the corner.
function dropNotice(id) {
  const live = liveNotices.get(id);
  if (!live) return;
  liveNotices.delete(id);
  clearTimeout(live.timer);
  const box = live.el.getBoundingClientRect();
  live.el.style.left = toUi(box.left) + 'px';
  live.el.style.top = toUi(box.top) + 'px';
  live.el.style.width = toUi(box.width) + 'px';
  live.el.style.setProperty('--notice-exit-x', (Math.random()*NOTICE_EXIT_SPREAD*2 - NOTICE_EXIT_SPREAD).toFixed(1) + 'px');
  live.el.style.setProperty('--notice-rise', Math.round(toUi(box.bottom) + 20) + 'px'); // clear of the top of the screen
  live.el.style.zIndex = -100; // behind the ones still sitting there
  live.el.classList.add('meter-notice-leaving'); // (it stays inside the meter: that's a stacking context of its own, and out on the body it would draw over everything in it)
  setTimeout(() => live.el.remove(), NOTICE_EXIT_MS);
}
// Page work (notices, the meter) is done in a batch on the next frame rather than where it's asked for, which may be in the
// middle of the simulation: layout it forces there would come on top of drawing the frame.
const pageWork = [];
let pageWorkQueued = false;
function laterOnPage(work) {
  pageWork.push(work);
  if (pageWorkQueued) return;
  pageWorkQueued = true;
  requestAnimationFrame(() => { pageWorkQueued = false; pageWork.splice(0).forEach(run => run()); });
}
const notify = (...args) => laterOnPage(() => showNotice(...args));
/**
 * Show that something happened: worth `delta` morality, `countDelta` of it, and — for an event — the name of
 * whoever it was. The same thing happening again within the notice's life folds into the notice already up.
 * @param {string} id - what it's about, as noticeLabels names it
 * @param {number} delta - what one is worth
 * @param {number} countDelta - how many happened
 * @param {string} [name] - whose name it was, for an event
 * @returns {void}
 */
function showNotice(id, delta, countDelta, name) {
  // A notice for anything worth something at all — and for events, which are worth announcing even when they're
  // worth nothing: a guilty person's death costs no morality, but the player should still be told it happened.
  const isEvent = id.startsWith('events/');
  if (!round1(delta) && !(isEvent && countDelta)) return;
  let live = liveNotices.get(id);
  if (!live) {
    const el = document.createElement('div');
    el.className = 'meter-notice ' + scoreClass(delta);
    live = { el, score: delta, label: noticeLabels[id], count: 0, names: [], timer: null };
    liveNotices.set(id, live);
    noticesEl.append(el); // (where it belongs among the others is rankNotices' job, below)
  }
  live.count += countDelta || 0;
  if (name) {
    live.names.unshift(name);                      // most recent first
    if (live.names.length > NOTICE_NAMES_MAX) live.names.length = NOTICE_NAMES_MAX;
  }
  // the score follows its label ("Innocents killed by player +5"), and nothing is shown for a score of 0: "Guilty killed by
  // player x3", not "0 …"
  const scoreChip = round1(live.score) ? ` <span class="meter-notice-score">${signed(live.score)}</span>` : '';
  // how many of them that is, in the same run: "x3", and no chip at all for a single one
  const countChip = live.count > 1 ? ` <span class="meter-notice-count">x${live.count}</span>` : '';
  // one line each, most recent first, under a rule across the notice
  const names = live.names.length
    ? `<div class="meter-notice-names">${live.names.map(n => `<div>${n}</div>`).join('')}</div>`
    : '';
  live.el.innerHTML = `${live.label}${scoreChip}${countChip}${names}`;
  const chip = live.el.querySelector('.meter-notice-count');
  if (chip) joltCount(chip, live.count);
  rankNotices();
  // more than fit: the ones with the least to them go, last of the ranking first, by the same swipe as one that timed out.
  // The one just shown stays, however little it has.
  const byRank = [...liveNotices.entries()].sort((a, b) => b[1].count - a[1].count).map(([key]) => key).filter(key => key !== id);
  while (liveNotices.size > NOTICES_MAX && byRank.length) dropNotice(byRank.pop());

  clearTimeout(live.timer);
  live.timer = setTimeout(() => dropNotice(id), NOTICE_LIFE); // each one gives it its full life again
}

// What was last announced, and what the world looked like last tick: a change is announced (as the difference from what was
// last announced) once it's settled, so a zone being dragged about doesn't announce every building that comes and goes.
let announced = null, previous = null, stillTicks = 0, quietUntil = performance.now() + 2500;
const sameLines = (a, b) => Object.keys(a.lines).every(id => a.lines[id].count === b.lines[id].count && round1(a.lines[id].score) === round1(b.lines[id].score));

function tick() {
  const now = tally();
  renderMeter(now);
  if (!announced || performance.now() < quietUntil) { announced = previous = now; return; } // (loading: take it all as it is)
  stillTicks = previous && sameLines(now, previous) ? stillTicks + 1 : 0;
  previous = now;
  if (stillTicks < QUIET_TICKS_TO_SETTLE || sameLines(now, announced)) return;
  Object.keys(now.lines).forEach(id => {
    const a = announced.lines[id], b = now.lines[id];
    notify(id, b.score - a.score, b.count - a.count);
  });
  announced = now;
}
setInterval(tick, TICK_MS);

// something happening that counts, like someone being killed: counted, and announced straight away
/**
 * @param {string} key - which event, as morality.txt lists it
 * @param {string} [name] - whose name it was, shown under the notice
 * @returns {void}
 */
export function recordMoralityEvent(key, name) {
  if (!(key in eventCounts)) return;
  eventCounts[key]++;
  notify('events/' + key, scoreOf('events', key), 1, name);
  const now = tally();
  if (announced) announced.lines['events/' + key] = now.lines['events/' + key];
  if (previous) previous.lines['events/' + key] = now.lines['events/' + key];
  laterOnPage(() => renderMeter(now));
}
// a whole project being loaded in isn't something the player did: take the world as it comes for a moment, unannounced
export function hushMorality(ms = 1500) { quietUntil = Math.max(quietUntil, performance.now() + ms); }

fetch(MORALITY_TEXT_URL, { cache: 'no-cache' })
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    const parsed = parseMoralityText(text);
    multiplier = parsed.overall && Number.isFinite(parsed.overall.multiplier) ? parsed.overall.multiplier : 1;
    scores = parsed;
    // (the scores changing isn't the player's doing either)
    const now = tally();
    announced = previous = now;
    renderMeter(now);
  })
  .catch(err => console.warn('Splinetopia: assets/morality.txt failed to load; everything is worth 0 morality', err));

tick();
Object.assign(App, { recordMoralityEvent, hushMorality, refreshMorality: tick });
