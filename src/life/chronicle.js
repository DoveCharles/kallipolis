import { App, S, worldNow } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { people } from './people/people.js';
import { followPerson } from './people/peopleTracking.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';
import { worldName } from '../project/world-name.js';
import { openWindow } from '../ui/w3-window.js';

// ============================================================ the chronicle
// The city's newspaper (View > Chronicle): a headline for each notable thing witnessed (App.chronicle, from witness in
// people/people.js), worded from assets/text/chronicle.txt. Kept in progress ('chronicle'), newest last, MAX of them.
// Clicking one follows who it's about if they're still about, else looks at where it happened.
const MAX = 100, REPEAT = 60; // (headlines kept; seconds before the same thing about the same person makes news again)
const headlines = {};
fetch('assets/text/chronicle.txt').then(r => r.text()).then(text => {
  let kind = null;
  text.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const head = line.match(/^\[(\w+)\]$/);
    if (head) kind = headlines[head[1]] = [];
    else kind?.push(line);
  });
}).catch(() => {});

let news = [], win = null;
const last = new Map(); // kind+id → worldNow() it was last news
onProgress('chronicle', saved => { news = saved ?? []; render(); });

App.chronicle = (who, what, by) => {
  const lines = (headlines[what] ?? []).filter(l => by?.name || !l.includes('{by}'));
  if (!lines.length) return;
  const key = what + ' ' + (who.id ?? Math.round(who.x) + ',' + Math.round(who.z)), now = worldNow();
  if (now - (last.get(key) ?? -Infinity) < REPEAT) return;
  last.set(key, now);
  const text = lines[Math.floor(Math.random()*lines.length)]
    .replace(/\{name\}/g, who.name ?? 'Someone').replace(/\{by\}/g, by?.name ?? '').replace(/\{city\}/g, worldName() || 'Kallipolis');
  const minutes = Math.floor(S.timeOfDay*60) % 1440;
  news = [...news, { text, time: String(Math.floor(minutes/60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
    id: who.id ?? null, x: who.x, z: who.z }].slice(-MAX);
  setProgress('chronicle', news);
  render();
};

function goTo(item) {
  const i = item.id == null ? -1 : people.findIndex(p => p.id === item.id && p.mode !== 'dead');
  if (i >= 0) followPerson(i);
  else controls.goalTarget.set(item.x, controls.goalTarget.y, item.z);
}
function render() {
  if (!win) return;
  win.querySelector('.win3-title').textContent = (worldName() || 'Kallipolis') + ' Chronicle';
  const list = win.querySelector('.w3-chronicle');
  list.replaceChildren(...(news.length ? [...news].reverse().map(item => {
    const row = document.createElement('button');
    row.className = 'w3-chronicle-item';
    row.innerHTML = `<span class="w3-chronicle-time"></span><span></span>`;
    row.firstChild.textContent = item.time;
    row.lastChild.textContent = item.text;
    row.addEventListener('click', () => goTo(item));
    return row;
  }) : [Object.assign(document.createElement('p'), { textContent: 'No news yet.' })]));
}
/** View > Chronicle. @returns {void} */
export function openChronicle() {
  win = openWindow({ id: 'chronicle', title: 'Chronicle', width: 320, resizable: true, noOk: true, onClose: () => { win = null; },
    fill: body => { body.innerHTML = '<div class="w3-chronicle"></div>'; } });
  render();
}
