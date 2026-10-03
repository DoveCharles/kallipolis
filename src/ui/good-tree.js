import { App, S } from '../core/shared.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Good tree (View > Good Tree; a draft, kept beside the tech tree): fills everything under the toolbar, the world paused
// and hidden behind it as under the tech tree (S.techOpen, body.tech-open: main.js, quests.js, css/win3.css). One radial tree, Plato's ascent: particulars on the rim (ring 4) feed
// kinds (3), kinds the Forms (2), Forms the highest Forms (1: the Philebus' Truth, Beauty, Measure, plus the One), those
// the Good (0, centre). Unlocked from the rim inward. One researching per ring at a time, switching keeps what's left.
// Real time (Date.now), so it runs on while closed. Kept with the project (progress 'goodTree').
// Placeholder data: unlocks do nothing yet (Forms are meant to give Good points).
const RADIUS = [0, 120, 230, 345, 460], SIZE = [88, 66, 54, 46, 40]; // px per ring
const SECS = [1200, 600, 300, 120, 30], ENERGY = [10, 6, 4, 2, 1];
const NEED = ring => ring === 3 ? 1 : ring === 0 ? Infinity : 2; // of its feeders done (Infinity: all)
const RING_NAMES = ['The Good', 'Highest Form', 'Form', 'Kind', 'Particular'];
// [key, name, icon, angle (deg, 0 = right, clockwise), feeds, text]
const HIGHEST = [
  ['truth', 'Truth', 'sheet', -90], ['measure', 'Measure', 'relax', 0], ['beauty', 'Beauty', 'sweetie', 90], ['one', 'The One', 'gift', 180],
].map(([k, n, i, a]) => [k, n, i, a, ['good'], `${n} itself. Adds to the Good.`]);
const FORMS = [
  ['knowledge', 'Knowledge', 'sheet', -112.5, ['truth'], 'Knowing what is so.'],
  ['wisdom', 'Wisdom', 'confused', -67.5, ['truth', 'measure'], 'Knowing what to do with it.'],
  ['piety', 'Piety', 'poppy', -22.5, ['measure'], 'What is owed to the gods. That\'s you.'],
  ['justice', 'Justice', 'itburns', 22.5, ['measure'], 'Each part doing its own job.'],
  ['courage', 'Courage', 'jogging', 67.5, ['measure', 'beauty'], 'Standing firm when it counts.'],
  ['temperance', 'Temperance', 'coffeel', 112.5, ['beauty', 'measure'], 'Enough, and no more.'],
  ['love', 'Love', 'heartpill', 157.5, ['beauty', 'one'], 'The climb toward Beauty.'],
  ['concord', 'Concord', 'gift', 202.5, ['one'], 'One city, not two.'],
];
const KINDS = [
  ['library', 'Library', 'sheet', -123.75, ['knowledge'], 'Somewhere to keep what people know.'],
  ['school', 'School', 'confused', -101.25, ['knowledge', 'wisdom'], 'Strangers\' children learn together.'],
  ['council', 'Council', 'trumpet', -78.75, ['wisdom'], 'The wise get a say.'],
  ['temple', 'Temple', 'poppy', -56.25, ['wisdom', 'piety'], 'A house for the god.'],
  ['shrine', 'Shrine', 'mushroom', -33.75, ['piety'], 'A small place to pray.'],
  ['courthouse', 'Courthouse', 'trumpet', -11.25, ['justice'], 'Villains tried, not just smitten.'],
  ['watch', 'Watch', 'stealth', 11.25, ['justice'], 'Citizens who chase muggers and thieves.'],
  ['rescue', 'Rescue', 'jogging', 33.75, ['justice', 'courage'], 'People pull others out of trouble.'],
  ['gymnasium', 'Gymnasium', 'energydrink', 56.25, ['courage'], 'Bodies trained, nerves steadied.'],
  ['clinic', 'Clinic', 'heartpill', 78.75, ['courage', 'temperance'], 'The hurt and the hooked get help.'],
  ['teahouse', 'Teahouse', 'coffeel', 101.25, ['temperance'], 'Somewhere to go that isn\'t the pub.'],
  ['garden', 'Garden', 'leafl', 123.75, ['temperance', 'love'], 'Quiet green places.'],
  ['gallery', 'Gallery', 'sweetie', 146.25, ['love'], 'Things worth looking at.'],
  ['plaza', 'Plaza', 'relax', 168.75, ['love', 'concord'], 'Where crowds gather.'],
  ['festival', 'Festival', 'gift', 191.25, ['concord'], 'A city-wide party day.'],
  ['townhall', 'Town hall', 'trumpet', 213.75, ['concord'], 'Everyone\'s business, in one place.'],
];
const THINGS = [
  ['book', 'Book', 'sheet', -127.5, ['library', 'school'], 'Words that outlive whoever wrote them.'],
  ['desk', 'Desk', 'confused', -112.5, ['school'], 'Somewhere to learn at.'],
  ['chalkboard', 'Chalkboard', 'confused', -97.5, ['school'], 'Wiped clean every day.'],
  ['scroll', 'Scroll', 'sheet', -82.5, ['council'], 'Minutes of the meeting.'],
  ['ballot', 'Ballot', 'sheet', -67.5, ['council'], 'A say, on paper.'],
  ['altar', 'Altar', 'poppy', -52.5, ['temple'], 'Where the offerings go.'],
  ['candle', 'Candle', 'hotaf', -37.5, ['shrine', 'temple'], 'A small light, left burning.'],
  ['offering', 'Offering', 'choc', -22.5, ['shrine'], 'Something given up.'],
  ['gavel', 'Gavel', 'trumpet', -7.5, ['courthouse'], 'Order in court.'],
  ['smite', 'Smite', 'itburns', 7.5, ['courthouse', 'watch'], 'Lightning hits harder.'],
  ['lamppost', 'Lamp post', 'lucky', 22.5, ['watch'], 'Fewer dark corners.'],
  ['whistle', 'Whistle', 'trumpet', 37.5, ['watch', 'rescue'], 'Someone always hears.'],
  ['ladder', 'Ladder', 'jogging', 52.5, ['rescue', 'gymnasium'], 'Up and over.'],
  ['weights', 'Weights', 'energydrink', 67.5, ['gymnasium'], 'Heavy things to lift.'],
  ['bandage', 'Bandage', 'heartpill', 82.5, ['clinic', 'rescue'], 'The wounded heal a little faster.'],
  ['medbot', 'MedBot', 'painkiller', 97.5, ['clinic'], 'A robot that patches people up.'],
  ['teapot', 'Teapot', 'coffeel', 112.5, ['teahouse'], 'Something warm that isn\'t beer.'],
  ['chair', 'Chair', 'relax', 127.5, ['teahouse', 'garden', 'plaza'], 'Somewhere to sit. Plato\'s favourite.'],
  ['tree', 'Tree', 'leafl', 142.5, ['garden'], 'Shade, birds and somewhere for dogs to go.'],
  ['statue', 'Statue', 'stealth', 157.5, ['gallery', 'plaza'], 'Someone remembered in stone.'],
  ['painting', 'Painting', 'sweetie', 172.5, ['gallery'], 'A copy of a copy.'],
  ['fountain', 'Fountain', 'thedrink', 187.5, ['plaza', 'festival'], 'Water for the sake of it.'],
  ['bunting', 'Bunting', 'gift', 202.5, ['festival'], 'Flags on string.'],
  ['longtable', 'Long table', 'hotdog', 217.5, ['festival', 'townhall'], 'Strangers eat together.'],
];
const node = ring => ([key, name, icon, a, feeds, text]) =>
  ({ key, name, icon, a, feeds, text, ring, secs: SECS[ring], cost: { energy: ENERGY[ring] } });
const ALL = [node(0)(['good', 'The Good', 'lucky', 0, [], 'What every Form is a Form of. Leave the cave.']),
  ...HIGHEST.map(node(1)), ...FORMS.map(node(2)), ...KINDS.map(node(3)), ...THINGS.map(node(4))];
const techOf = key => ALL.find(t => t.key === key);
const feeders = t => ALL.filter(x => x.feeds.includes(t.key));
const needOf = t => Math.min(NEED(t.ring), feeders(t).length);
const iconSrc = t => `assets/icons/status/${t.icon}.png`;
const C = RADIUS[4] + 80; // canvas centre, px (canvas is 2C square)
const posOf = t => { const r = RADIUS[t.ring], a = t.a*Math.PI/180; return [C + r*Math.cos(a), C + r*Math.sin(a)]; };

// ---- state: { items: {key: {left, ends?, done?, paid?}}, running: {ring: key} } (ends: epoch ms while running)
const fresh = v => ({ items: { ...v?.items }, running: Object.fromEntries(Object.entries(v?.running ?? {}).filter(([r, k]) => techOf(k)?.ring === +r)) });
let s = fresh(getProgress('goodTree'));
const save = () => setProgress('goodTree', s);
onProgress('goodTree', v => { s = fresh(v); render(); });

const item = t => s.items[t.key] ??= { left: t.secs };
const leftOf = t => { const i = item(t); return i.done ? 0 : i.ends ? Math.max(0, (i.ends - Date.now())/1000) : i.left; };
const fracOf = t => t.secs ? 1 - leftOf(t)/t.secs : isDone(t) ? 1 : 0;
const isDone = t => !!s.items[t.key]?.done;
const isLocked = t => feeders(t).filter(isDone).length < needOf(t);
const fmt = secs => {
  if (secs <= 0) return 'Instant';
  secs = Math.ceil(secs);
  const h = Math.floor(secs/3600), m = Math.floor(secs/60)%60, sec = secs%60;
  return h ? `${h} hr${m ? ` ${m} m` : ''}` : m ? `${m} m${sec ? ` ${sec} s` : ''}` : `${sec} s`;
};
const costText = t => Object.entries(t.cost).map(([k, n]) => k === 'energy' ? `${n} <img class="meter-icon" src="assets/icons/energy.png" alt="energy">` : `${n} ${k}`).join(' ');
const needText = t => {
  const n = needOf(t), names = feeders(t).map(x => x.name).join(', ');
  return n === feeders(t).length ? `Needs ${names}` : `Needs ${n === 1 ? 'one' : n} of ${names}`;
};

function pause(ring) {
  const t = techOf(s.running[ring]); if (!t) return;
  const i = item(t); i.left = leftOf(t); delete i.ends; delete s.running[ring];
}
function start(t) {
  if (isDone(t) || isLocked(t)) return;
  const i = item(t);
  if (!i.paid) { if (!App.spendEnergy?.(t.cost.energy ?? 0)) return; i.paid = true; } // (paid once; resuming's free)
  if (s.running[t.ring] === t.key) { pause(t.ring); save(); render(); return; }
  pause(t.ring);
  i.ends = Date.now() + i.left*1000; s.running[t.ring] = t.key;
  save(); if (!i.left) finish(t); render();
}
function finish(t) {
  const i = item(t); i.done = true; i.left = 0; delete i.ends; delete s.running[t.ring];
  notify(`${t.name} is ready`);
  save();
}

// ---- DOM
const panel = document.createElement('div');
panel.id = 'good-tree'; panel.hidden = true;
panel.innerHTML = `<div class="tt-body"><div class="tt-tree"><div class="tt-radial" style="width:${2*C}px;height:${2*C}px"></div></div><div class="tt-side" hidden></div></div><button class="btn tt-close">Close</button>`;
document.body.append(panel);
const treeEl = panel.querySelector('.tt-tree'), radial = panel.querySelector('.tt-radial'), side = panel.querySelector('.tt-side');
let picked = null, hovered = null;

function orbHtml(t) {
  const [x, y] = posOf(t), d = SIZE[t.ring], on = s.running[t.ring] === t.key;
  const cls = ['tt-orb', `ring${t.ring}`, picked === t.key ? 'on' : '', isDone(t) ? 'done' : '', isLocked(t) ? 'locked' : '', on ? 'running' : ''].join(' ');
  return `<div class="${cls}" data-key="${t.key}" style="left:${x - d/2}px;top:${y - d/2}px;width:${d}px;height:${d}px;--p:${fracOf(t)*100}%">
    <img src="${iconSrc(t)}" alt=""><div class="tt-orb-name">${t.name}<span class="tt-time">${isDone(t) ? '' : on || item(t).paid ? fmt(leftOf(t)) : ''}</span></div></div>`;
}
function linksSvg() {
  const rings = RADIUS.slice(1).map(r => `<circle cx="${C}" cy="${C}" r="${r}"/>`).join('');
  const lines = ALL.flatMap(t => t.feeds.map(f => {
    const [x1, y1] = posOf(t), [x2, y2] = posOf(techOf(f));
    return `<line data-a="${t.key}" data-b="${f}" class="r${t.ring}${isDone(t) ? ' done' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  })).join('');
  return `<svg class="tt-links" width="${2*C}" height="${2*C}"><g class="tt-rings">${rings}</g>${lines}</svg>`;
}
function sideHtml(t) {
  const on = s.running[t.ring] === t.key;
  const label = isDone(t) ? 'Unlocked' : isLocked(t) ? 'Locked' : on ? 'Pause' : item(t).paid ? 'Resume' : 'Get';
  return `<div class="tt-pic"><img src="${iconSrc(t)}" alt=""></div>
    <div class="tt-name">${t.name}</div><div class="tt-ring">${RING_NAMES[t.ring]}</div><div class="tt-side-cost">${costText(t)}</div>
    <p class="tt-text">${t.text}</p>
    ${isLocked(t) ? `<p class="tt-text tt-needs">${needText(t)}</p>` : ''}
    <button class="btn tt-get" ${isDone(t) || isLocked(t) ? 'disabled' : ''}>${label}</button>
    <div class="tt-side-time">${isDone(t) ? 'Ready' : fmt(leftOf(t)) + (item(t).paid ? ' left' : '')}</div>
    <div class="tt-bar"><div style="width:${fracOf(t)*100}%"></div></div>`;
}
function render() {
  if (panel.hidden) return;
  radial.innerHTML = linksSvg() + ALL.map(orbHtml).join('');
  const t = techOf(picked);
  side.hidden = !t;
  if (t) side.innerHTML = sideHtml(t);
  light(hovered);
}

// ---- hover: light a node's whole path, inward to the Good and outward to every particular under it
function light(key) {
  hovered = key;
  radial.classList.toggle('lit', !!key);
  const keep = new Set();
  if (key) {
    const up = k => { if (keep.has(k)) return; keep.add(k); techOf(k).feeds.forEach(up); };
    const down = k => { keep.add(k); feeders(techOf(k)).forEach(x => down(x.key)); };
    up(key); down(key);
  }
  radial.querySelectorAll('.tt-orb').forEach(n => n.classList.toggle('path', keep.has(n.dataset.key)));
  radial.querySelectorAll('line').forEach(l => l.classList.toggle('path', keep.has(l.dataset.a) && keep.has(l.dataset.b)));
}
radial.addEventListener('mouseover', e => { const n = e.target.closest('.tt-orb'); if (n && n.dataset.key !== hovered) light(n.dataset.key); });
radial.addEventListener('mouseleave', () => light(null));
treeEl.addEventListener('click', e => {
  const n = e.target.closest('.tt-orb');
  picked = n ? n.dataset.key : null; render();
});
side.addEventListener('click', e => { if (e.target.closest('.tt-get')) start(techOf(picked)); });

// ---- ticking (open or not, so it finishes and tells you either way)
function tick() {
  let changed = false;
  Object.values(s.running).forEach(key => { const t = techOf(key); if (t && leftOf(t) <= 0) { finish(t); changed = true; } });
  if (changed) render(); else refresh();
}
// just the running ones' times and rings (no rebuild, so a click isn't lost)
function refresh() {
  if (panel.hidden) return;
  Object.values(s.running).forEach(key => {
    const t = techOf(key), left = leftOf(t), pct = fracOf(t)*100 + '%';
    const n = radial.querySelector(`[data-key="${key}"]`);
    if (n) { n.querySelector('.tt-time').textContent = fmt(left); n.style.setProperty('--p', pct); }
    if (picked === key) { side.querySelector('.tt-side-time').textContent = fmt(left) + ' left'; side.querySelector('.tt-bar > div').style.width = pct; }
  });
}
setInterval(tick, 500);

// ---- notifications: a little window under the toolbar for a few seconds
function notify(text) {
  const n = document.createElement('div');
  n.className = 'tt-notice';
  n.innerHTML = `<div class="tt-titlebar">Good Tree</div><div class="tt-notice-body">${text}</div>`;
  n.addEventListener('click', () => { n.remove(); if (panel.hidden) toggle(); });
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

// ---- open / close
function toggle() {
  panel.hidden = !panel.hidden;
  S.techOpen = !panel.hidden;
  document.body.classList.toggle('tech-open', S.techOpen);
  render();
  if (S.techOpen) treeEl.scrollTo((treeEl.scrollWidth - treeEl.clientWidth)/2, (treeEl.scrollHeight - treeEl.clientHeight)/2);
}
panel.querySelector('.tt-close').addEventListener('click', toggle);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.defaultPrevented) toggle(); });
export const goodTreeShown = () => !panel.hidden;
export const toggleGoodTree = toggle;
