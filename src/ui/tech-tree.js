import { App, S } from '../core/shared.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Tech tree (toolbar button left of Quests): fills everything under the toolbar, the world paused and hidden behind it
// (S.techOpen: main.js, quests.js, css/win3.css). Four tabs, each its own tree; one unlock researching per tab at a time,
// switching keeps what's left. Real time (Date.now), so it runs on while closed. Kept with the project (progress 'tech').
// Placeholder data: unlocks do nothing yet.
const TABS = [['main', 'Main'], ['ideology', 'Ideology'], ['graces', 'Graces'], ['wrath', 'Wrath']];
// x/y: grid cell; req: the unlock before it; secs 0: instant; cost: {energy}
const TECH = {
  main: [
    { key: 'trees', name: 'Trees', icon: 'leafl', x: 0, y: 0, secs: 60, cost: { energy: 1 }, text: 'Plant trees along the streets. Shade, birds and somewhere for dogs to go.' },
    { key: 'farm', name: 'Farm', icon: 'cactus', x: 0, y: 1, req: 'trees', secs: 120, cost: { energy: 2 }, text: 'Fields of veg on the edge of town. Fewer peds go hungry.' },
    { key: 'road', name: 'Road', icon: 'jogging', x: 1, y: 1, req: 'trees', secs: 0, cost: { energy: 5 }, text: 'Better roads. Cars get where they are going, mostly.' },
  ],
  ideology: [
    { key: 'creed', name: 'Creed', icon: 'sheet', x: 0, y: 0, secs: 45, cost: { energy: 1 }, text: 'Write down what the city believes. Nobody reads it.' },
    { key: 'zeal', name: 'Zeal', icon: 'trumpet', x: 0, y: 1, req: 'creed', secs: 90, cost: { energy: 2 }, text: 'Peds preach on street corners.' },
    { key: 'dogma', name: 'Dogma', icon: 'confused', x: 1, y: 1, req: 'creed', secs: 150, cost: { energy: 3 }, text: 'Questions are discouraged.' },
  ],
  graces: [
    { key: 'mercy', name: 'Mercy', icon: 'heartpill', x: 0, y: 0, secs: 30, cost: { energy: 1 }, text: 'The wounded heal a little faster.' },
    { key: 'luck', name: 'Luck', icon: 'lucky', x: 0, y: 1, req: 'mercy', secs: 0, cost: { energy: 2 }, text: 'Things go right slightly more often.' },
    { key: 'calm', name: 'Calm', icon: 'relax', x: 1, y: 1, req: 'mercy', secs: 120, cost: { energy: 3 }, text: 'Tempers cool across the city.' },
  ],
  wrath: [
    { key: 'smite', name: 'Smite', icon: 'itburns', x: 0, y: 0, secs: 40, cost: { energy: 1 }, text: 'Lightning hits harder.' },
    { key: 'plague', name: 'Plague', icon: 'sick', x: 0, y: 1, req: 'smite', secs: 180, cost: { energy: 4 }, text: 'Sickness spreads further.' },
    { key: 'toads', name: 'Toads', icon: 'toad', x: 1, y: 1, req: 'smite', secs: 60, cost: { energy: 2 }, text: 'It rains toads.' },
  ],
};
const ALL = Object.entries(TECH).flatMap(([tab, list]) => list.map(t => ({ ...t, tab })));
const techOf = key => ALL.find(t => t.key === key);
const iconSrc = t => `assets/icons/status/${t.icon}.png`;
const COL = 300, ROW = 170, PAD = 40; // tree grid, px

// ---- state: { items: {key: {left, ends?, done?, paid?}}, running: {tab: key} } (ends: epoch ms while running)
const fresh = v => ({ items: { ...v?.items }, running: { ...v?.running } });
let s = fresh(getProgress('tech'));
const save = () => setProgress('tech', s);
onProgress('tech', v => { s = fresh(v); render(); });

const item = t => s.items[t.key] ??= { left: t.secs };
const leftOf = t => { const i = item(t); return i.done ? 0 : i.ends ? Math.max(0, (i.ends - Date.now())/1000) : i.left; };
const isDone = t => !!s.items[t.key]?.done;
const isLocked = t => t.req && !isDone(techOf(t.req));
const fmt = secs => {
  if (secs <= 0) return 'Instant';
  secs = Math.ceil(secs);
  const h = Math.floor(secs/3600), m = Math.floor(secs/60)%60, sec = secs%60;
  return h ? `${h} hr${m ? ` ${m} m` : ''}` : m ? `${m} m${sec ? ` ${sec} s` : ''}` : `${sec} s`;
};
const costText = t => Object.entries(t.cost).map(([k, n]) => k === 'energy' ? `${n} <img class="meter-icon" src="assets/icons/energy.png" alt="energy">` : `${n} ${k}`).join(' ');

function pause(tab) {
  const t = techOf(s.running[tab]); if (!t) return;
  const i = item(t); i.left = leftOf(t); delete i.ends; delete s.running[tab];
}
function start(t) {
  if (isDone(t) || isLocked(t)) return;
  const i = item(t);
  if (!i.paid) { if (!App.spendEnergy?.(t.cost.energy ?? 0)) return; i.paid = true; } // (paid once; resuming's free)
  if (s.running[t.tab] === t.key) { pause(t.tab); save(); render(); return; }
  pause(t.tab);
  i.ends = Date.now() + i.left*1000; s.running[t.tab] = t.key;
  save(); if (!i.left) finish(t); render();
}
function finish(t) {
  const i = item(t); i.done = true; i.left = 0; delete i.ends; delete s.running[t.tab];
  notify(`${t.name} is ready`);
  save();
}

// ---- DOM
const panel = document.createElement('div');
panel.id = 'tech-tree'; panel.hidden = true;
panel.innerHTML = `<div class="tt-tabs">${TABS.map(([k, l]) => `<button class="tt-tab" data-tab="${k}"><span>${l}</span></button>`).join('')}</div>
  <div class="tt-body"><div class="tt-tree"></div><div class="tt-side" hidden></div></div>`;
document.body.append(panel);
const treeEl = panel.querySelector('.tt-tree'), side = panel.querySelector('.tt-side');
let tab = 'main', picked = null;

function nodeHtml(t) {
  const left = leftOf(t), on = s.running[t.tab] === t.key, frac = t.secs ? 1 - left/t.secs : isDone(t) ? 1 : 0;
  const cls = ['tt-node', picked === t.key ? 'on' : '', isDone(t) ? 'done' : '', isLocked(t) ? 'locked' : '', on ? 'running' : ''].join(' ');
  return `<div class="${cls}" data-key="${t.key}" style="left:${PAD + t.x*COL}px;top:${PAD + t.y*ROW}px">
    <div class="tt-titlebar">${t.name}</div>
    <div class="tt-node-body"><div class="tt-icon"><img src="${iconSrc(t)}" alt=""></div>
      <div class="tt-info"><div class="tt-time">${isDone(t) ? 'Done' : fmt(left)}</div><div class="tt-cost">${costText(t)}</div></div></div>
    ${item(t).paid || isDone(t) ? `<div class="tt-bar"><div style="width:${frac*100}%"></div></div>` : ''}</div>`;
}
// dashed elbow from each parent's bottom to the child's top
function linksSvg(list) {
  const W = 220, H = 74; // node size (css)
  const paths = list.filter(t => t.req).map(t => {
    const p = techOf(t.req), x1 = PAD + p.x*COL + 40, y1 = PAD + p.y*ROW + H, x2 = PAD + t.x*COL + 40, y2 = PAD + t.y*ROW, my = (y1 + y2)/2;
    return `<path d="M${x1} ${y1}V${my}H${x2}V${y2}"/>`;
  }).join('');
  const w = PAD*2 + Math.max(...list.map(t => t.x))*COL + W, h = PAD*2 + Math.max(...list.map(t => t.y))*ROW + H + 10;
  return `<svg class="tt-links" width="${w}" height="${h}">${paths}</svg>`;
}
function sideHtml(t) {
  const left = leftOf(t), on = s.running[t.tab] === t.key, frac = t.secs ? 1 - left/t.secs : isDone(t) ? 1 : 0;
  const label = isDone(t) ? 'Unlocked' : isLocked(t) ? `Needs ${techOf(t.req).name}` : on ? 'Pause' : item(t).paid ? 'Resume' : 'Get';
  return `<div class="tt-pic"><img src="${iconSrc(t)}" alt=""></div>
    <div class="tt-name">${t.name}</div><div class="tt-side-cost">${costText(t)}</div>
    <p class="tt-text">${t.text}</p>
    <button class="btn tt-get" ${isDone(t) || isLocked(t) ? 'disabled' : ''}>${label}</button>
    <div class="tt-side-time">${isDone(t) ? 'Ready' : fmt(left) + (item(t).paid ? ' left' : '')}</div>
    <div class="tt-bar"><div style="width:${frac*100}%"></div></div>`;
}
function render() {
  if (panel.hidden) return;
  panel.querySelectorAll('.tt-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const list = TECH[tab].map(t => ({ ...t, tab }));
  treeEl.innerHTML = linksSvg(list) + list.map(nodeHtml).join('');
  const t = list.find(x => x.key === picked);
  side.hidden = !t;
  if (t) side.innerHTML = sideHtml(t);
}

panel.querySelector('.tt-tabs').addEventListener('click', e => {
  const b = e.target.closest('.tt-tab'); if (!b) return;
  tab = b.dataset.tab; picked = null; render();
});
treeEl.addEventListener('click', e => {
  const n = e.target.closest('.tt-node');
  picked = n ? n.dataset.key : null; render();
});
side.addEventListener('click', e => { if (e.target.closest('.tt-get')) start(techOf(picked)); });

// ---- ticking (open or not, so it finishes and tells you either way)
function tick() {
  let changed = false;
  Object.values(s.running).forEach(key => { const t = techOf(key); if (t && leftOf(t) <= 0) { finish(t); changed = true; } });
  if (changed) render(); else refresh();
}
// just the running ones' times and bars (no rebuild, so a click isn't lost)
function refresh() {
  if (panel.hidden) return;
  Object.values(s.running).forEach(key => {
    const t = techOf(key); if (t.tab !== tab) return;
    const left = leftOf(t), pct = (t.secs ? 1 - left/t.secs : 0)*100 + '%';
    const n = treeEl.querySelector(`[data-key="${key}"]`);
    if (n) { n.querySelector('.tt-time').textContent = fmt(left); const b = n.querySelector('.tt-bar > div'); if (b) b.style.width = pct; }
    if (picked === key) { side.querySelector('.tt-side-time').textContent = fmt(left) + ' left'; side.querySelector('.tt-bar > div').style.width = pct; }
  });
}
setInterval(tick, 500);

// ---- notifications: a little window under the toolbar for a few seconds
function notify(text) {
  const n = document.createElement('div');
  n.className = 'tt-notice';
  n.innerHTML = `<div class="tt-titlebar">Tech Tree</div><div class="tt-notice-body">${text}</div>`;
  n.addEventListener('click', () => { n.remove(); if (panel.hidden) toggle(); });
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

// ---- open / close
const button = document.getElementById('btn-tech');
function toggle() {
  if (panel.hidden) App.closeCardTech?.(); // (one at a time: ui/card-tech.js)
  panel.hidden = !panel.hidden;
  S.techOpen = !panel.hidden;
  document.body.classList.toggle('tech-open', S.techOpen);
  button?.classList.toggle('on', S.techOpen);
  render();
}
button?.addEventListener('click', toggle);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.defaultPrevented) toggle(); });
export const openTechTree = () => { if (panel.hidden) toggle(); };
