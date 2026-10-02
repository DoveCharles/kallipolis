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
// Clicking one follows who it's about if they're still about, else looks at where it happened. At 07:00 each in-game day
// the morning edition comes out ('chronicleEd' its number): the front page (frontPage) leads with the night's worst.
const MAX = 100, REPEAT = 60; // (headlines kept; seconds before the same thing about the same person makes news again)
const headlines = {};
const MORNING = 7; // (the hour the paper comes out)
// what leads the front page, worst first; and what each counts as in its summary
const LEAD = ['planecrash', 'beatentodeath', 'exploded', 'orbsmited', 'smited', 'killedbycar', 'crashedinto', 'drowned', 'fell', 'punchedfence', 'resurrected', 'couple', 'feud', 'healed', 'bestfriends', 'friends'];
const FRIENDSHIP = ['friendship', 'friendships'];
const TALLY = { planecrash: ['plane crash', 'plane crashes'], resurrected: ['resurrection', 'resurrections'], healed: ['rescue', 'rescues'],
  friends: FRIENDSHIP, bestfriends: FRIENDSHIP, couple: ['romance', 'romances'], feud: ['feud', 'feuds'] };
const DEATH = ['death', 'deaths'];
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

let news = [], edition = 0, win = null, paper = null;
const last = new Map(); // kind+id → worldNow() it was last news
onProgress('chronicle', saved => { news = saved ?? []; render(); });
onProgress('chronicleEd', saved => { edition = saved ?? 0; });

App.chronicle = (who, what, by) => {
  const lines = (headlines[what] ?? []).filter(l => by?.name || !l.includes('{by}'));
  if (!lines.length) return;
  const key = what + ' ' + (who.id ?? Math.round(who.x) + ',' + Math.round(who.z)) + ' ' + (by?.id ?? ''), now = worldNow();
  if (now - (last.get(key) ?? -Infinity) < REPEAT) return;
  last.set(key, now);
  const text = lines[Math.floor(Math.random()*lines.length)]
    .replace(/\{name\}/g, who.name ?? 'Someone').replace(/\{by\}/g, by?.name ?? '').replace(/\{city\}/g, worldName() || 'Kallipolis');
  const minutes = Math.floor(S.timeOfDay*60) % 1440;
  news = [...news, { text, kind: what, ed: edition + 1, time: String(Math.floor(minutes/60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
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
  list.replaceChildren(...(news.length ? [...news].reverse().map(storyRow) : [Object.assign(document.createElement('p'), { textContent: 'No news yet.' })]));
}
// ---- the morning edition: everything since the last, under the city's masthead
let hourWas = S.timeOfDay;
setInterval(() => {
  const h = S.timeOfDay, wrapped = hourWas - h > 12; // (round midnight; a smaller step back is the time being set)
  if (wrapped ? hourWas < MORNING || h >= MORNING : hourWas < MORNING && h >= MORNING) printEdition();
  hourWas = h;
}, 500);
function printEdition() {
  if (S.netGuest) return;
  edition++;
  setProgress('chronicleEd', edition);
  frontPage();
}
const pick = list => list[Math.floor(Math.random()*list.length)];
/** The front page of the latest edition (or `ed`). @param {number} [ed] @returns {void} */
export function frontPage(ed = edition) {
  const city = worldName() || 'Kallipolis', stories = news.filter(item => item.ed === (ed || 1)); // (before the first edition: what will be in it)
  const rank = item => { const r = LEAD.indexOf(item.kind); return r < 0 ? LEAD.length : r; };
  const sorted = [...stories].sort((a, b) => rank(a) - rank(b)), lead = sorted[0];
  const counts = new Map();
  stories.forEach(item => { const t = TALLY[item.kind] ?? DEATH; counts.set(t, (counts.get(t) ?? 0) + 1); });
  const tally = [...counts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(', ');
  paper?.close();
  paper = openWindow({ id: 'front-page', title: `${city} Chronicle`, width: 340, noOk: true, onClose: () => { paper = null; },
    fill: body => {
      body.innerHTML = `<div class="w3-paper"><div class="w3-paper-mast"></div><div class="w3-paper-date"></div>
        <div class="w3-paper-lead"></div><div class="w3-paper-tally"></div><div class="w3-chronicle"></div></div>`;
      body.querySelector('.w3-paper-mast').textContent = `The ${city} Chronicle`;
      body.querySelector('.w3-paper-date').textContent = ed ? `No. ${ed} · Morning edition` : 'Special edition';
      const leadEl = body.querySelector('.w3-paper-lead');
      leadEl.textContent = lead ? lead.text : pick(headlines.quiet ?? ['All quiet in {city}']).replace(/\{city\}/g, city);
      if (lead) leadEl.addEventListener('click', () => goTo(lead));
      body.querySelector('.w3-paper-tally').textContent = tally ? `Since the last edition: ${tally}.` : '';
      body.querySelector('.w3-chronicle').replaceChildren(...sorted.slice(1).map(storyRow));
    } });
}
function storyRow(item) {
  const row = document.createElement('button');
  row.className = 'w3-chronicle-item';
  row.innerHTML = `<span class="w3-chronicle-time"></span><span></span>`;
  row.firstChild.textContent = item.time;
  row.lastChild.textContent = item.text;
  row.addEventListener('click', () => goTo(item));
  return row;
}

/** View > Chronicle. @returns {void} */
export function openChronicle() {
  win = openWindow({ id: 'chronicle', title: 'Chronicle', width: 320, resizable: true, noOk: true, onClose: () => { win = null; },
    fill: body => {
      body.innerHTML = '<div class="w3-dialog-buttons"><button class="btn">Front Page</button></div><div class="w3-chronicle"></div>';
      body.querySelector('button').addEventListener('click', () => frontPage());
    } });
  render();
}
