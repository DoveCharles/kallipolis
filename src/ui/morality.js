import { S, App } from '../core/shared.js';

// ============================================================ morality meter
// How good or evil the city is, in a meter at the top right: a bar growing from the middle, left (and redder) the more evil,
// right (and greener) the more good. It's everything in the world added up — each zone, path and building worth what
// assets/morality.txt says (to be edited freely) — along with things that happen, like people getting killed. The
// show/hide button lists what it's made of, and each change pops up next to the bar for a few seconds.
const MORALITY_TEXT_URL = 'assets/morality.txt';
const MORALITY_MAX = 100;
const NOTICE_LIFE = 3500, NOTICES_MAX = 6;
const QUIET_TICKS_TO_SETTLE = 1; // a change is only announced once the world's held still this many ticks (so a drag is one notice)
const TICK_MS = 400;

// what's counted, grouped as the details list shows it: `key` is the line in morality.txt under the group's [heading]
const GROUPS = [
  { id: 'zones', label: 'Zones', items: [
    { key: 'buildings', label: 'Buildings' }, { key: 'plain', label: 'Plain' }, { key: 'park', label: 'Parks' },
    { key: 'beach', label: 'Beaches' }, { key: 'water', label: 'Water' }, { key: 'plaza', label: 'Plazas' },
    { key: 'farmland', label: 'Farmland' }, { key: 'industrial', label: 'Industrial' },
  ] },
  { id: 'paths', label: 'Paths', items: [
    { key: 'roads', label: 'Roads' }, { key: 'walkways', label: 'Walkways' },
    { key: 'rivers', label: 'Rivers' }, { key: 'train lines', label: 'Train lines' },
  ] },
  { id: 'buildings', label: 'Buildings', items: [
    { key: 'commercial', label: 'Commercial' }, { key: 'industrial', label: 'Industrial' }, { key: 'farmhouses', label: 'Farmhouses' },
  ] },
];
const EVENTS = [
  { key: 'peds killed by player', label: 'Peds killed by player' },
  { key: 'peds killed by cars', label: 'Peds killed by cars' },
  { key: 'cars destroyed by player', label: 'Cars destroyed by player' },
];
const BUILDING_KIND_OF_ZONE = { buildings: 'commercial', industrial: 'industrial', farmland: 'farmhouses' };

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
    if (!current || !Number.isFinite(value)) { console.warn(`Blockout: in morality.txt, "${line}" isn't a "thing = score" line under a [heading]`); return; }
    parsed[current][pair[1].trim().toLowerCase()] = value;
  });
  return parsed;
}
const scoreOf = (group, key) => (scores[group] && scores[group][key]) || 0;

// ---------------------------------------------------------- counting
// how many of each thing there are, and what they're worth: { lines: {id: {count, score}}, groups: {...}, overall }
// (a line's id is `group/key`)
function tally() {
  const counts = {};
  const add = (group, key, n = 1) => { const id = group + '/' + key; counts[id] = (counts[id] || 0) + n; };
  S.zones.forEach(zone => {
    if (zone.drawing || !zone.closed) return; // (only finished zones count)
    const type = zone.zoneType || 'buildings';
    add('zones', type);
    const kind = BUILDING_KIND_OF_ZONE[type];
    if (kind && zone.buildingsGroup) add('buildings', kind, zone.buildingsGroup.children.filter(c => c.name === 'Building').length);
  });
  S.roadLines.forEach(line => {
    if (line.drawing) return;
    add('paths', line.kind === 'train' ? 'train lines' : line.roadType === 'walkway' ? 'walkways' : line.roadType === 'river' ? 'rivers' : 'roads');
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
const valueEl = document.getElementById('mor-value');
const fillEl = document.getElementById('mor-fill');
const toggleEl = document.getElementById('mor-toggle');
const detailsEl = document.getElementById('mor-details');
const noticesEl = document.getElementById('mor-notices');

const NEUTRAL = [146, 150, 160], EVIL = [229, 72, 77], GOOD = [61, 220, 151];
function meterColor(v) {
  const t = Math.min(1, Math.abs(v)/MORALITY_MAX), to = v < 0 ? EVIL : GOOD;
  return `rgb(${NEUTRAL.map((c, i) => Math.round(c + (to[i] - c)*t)).join(',')})`;
}
const round1 = n => Math.round(n*10)/10 || 0; // (|| 0: no "-0")
const signed = n => { const r = round1(n); return (r > 0 ? '+' : '') + r; };
const scoreClass = n => round1(n) > 0 ? 'good' : round1(n) < 0 ? 'evil' : '';

function renderMeter(t) {
  const v = t.overall, color = meterColor(v);
  valueEl.textContent = signed(v);
  valueEl.style.color = color;
  fillEl.style.background = color;
  fillEl.style.width = (Math.abs(v)/MORALITY_MAX*50) + '%';
  fillEl.style.left = v < 0 ? (50 - Math.abs(v)/MORALITY_MAX*50) + '%' : '50%';
  if (detailsEl.hidden) return;
  const row = (label, count, score, sub) =>
    `<div class="mor-row${sub ? ' sub' : ''}"><span class="mor-label">${sub ? '• ' : ''}${label}</span><span class="mor-count">${count}</span><span class="mor-score ${scoreClass(score)}">${signed(score)}</span></div>`;
  detailsEl.innerHTML =
    GROUPS.map(g => row(g.label, t.groups[g.id].count, t.groups[g.id].score, false) +
      g.items.map(item => { const l = t.lines[g.id + '/' + item.key]; return row(item.label, l.count, l.score, true); }).join('')).join('') +
    `<div class="mor-gap"></div>` +
    EVENTS.map(e => { const l = t.lines['events/' + e.key]; return row(e.label, l.count, l.score, false); }).join('');
}
// the details open and close from the show/hide button — or, in the Windows 3.0 look, from the window's title bar, just like
// the Splinetopia window (see win3.js): minimize folds them away, maximize (or the control-menu box, to toggle) opens them
const meterWindow = document.getElementById('stats');
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
meterWindow.classList.add('win3-minimized');

// ---------------------------------------------------------- notices
// a line as a notice names it: "Zones · Parks", "Paths · Roads", "Peds killed by player"…
const noticeLabels = {};
GROUPS.forEach(g => g.items.forEach(item => { noticeLabels[g.id + '/' + item.key] = `${g.label} · ${item.label}`; }));
EVENTS.forEach(e => { noticeLabels['events/' + e.key] = e.label; });

function notify(id, delta, countDelta) {
  if (!round1(delta)) return;
  const el = document.createElement('div');
  el.className = 'mor-notice ' + scoreClass(delta);
  el.innerHTML = `<span class="mor-notice-score">${signed(delta)}</span> ${noticeLabels[id]}` +
    (countDelta ? ` <span class="mor-notice-count">(${countDelta > 0 ? '+' : ''}${countDelta})</span>` : '');
  noticesEl.prepend(el);
  while (noticesEl.children.length > NOTICES_MAX) noticesEl.lastElementChild.remove();
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 400); }, NOTICE_LIFE);
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
export function recordMoralityEvent(key) {
  if (!(key in eventCounts)) return;
  eventCounts[key]++;
  notify('events/' + key, scoreOf('events', key), 1);
  const now = tally();
  if (announced) announced.lines['events/' + key] = now.lines['events/' + key];
  if (previous) previous.lines['events/' + key] = now.lines['events/' + key];
  renderMeter(now);
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
  .catch(err => console.warn('Blockout: assets/morality.txt failed to load; everything is worth 0 morality', err));

tick();
Object.assign(App, { recordMoralityEvent, hushMorality, refreshMorality: tick });
