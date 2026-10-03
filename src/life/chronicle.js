import { App, S, worldNow } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { people } from './people/people.js';
import { followPerson } from './people/peopleTracking.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';
import { worldName } from '../project/world-name.js';
import { openWindow } from '../ui/w3-window.js';

// ============================================================ the chronicle
// The city's newspaper (View > Daily Chronicle): a headline for each notable thing witnessed (App.chronicle, from witness
// in people/people.js) or felt between two people (peopleRelations.js), worded from assets/text/chronicle.txt. Kept in
// progress ('chronicle'), newest last, MAX of them, each with the edition it's in (`ed`). At 07:00 each in-game day an
// edition comes out ('chronicleEd' its number) and pops up: its front page leads with the worst since the last, then the
// rest in columns, In other news (filler), and on the latest a Stop press of what's happened since. ‹ › turn back through
// past editions. Clicking a story follows who it's about if they're still about, else looks at where it happened.
const MAX = 300, REPEAT = 60; // (headlines kept; seconds before the same thing about the same person makes news again)
const headlines = {};
const MORNING = 7; // (the hour the paper comes out)
// what leads the front page, worst first; and what each counts as in its summary
const LEAD = ['planecrash', 'beatentodeath', 'exploded', 'orbsmited', 'smited', 'roundup', 'killedbycar', 'crashedinto', 'drowned', 'fell', 'punchedfence', 'resurrected', 'couple', 'feud', 'healed', 'bestfriends', 'friends'];
const FRIENDSHIP = ['friendship', 'friendships'];
const TALLY = { planecrash: ['plane crash', 'plane crashes'], resurrected: ['resurrection', 'resurrections'], healed: ['rescue', 'rescues'],
  friends: FRIENDSHIP, bestfriends: FRIENDSHIP, couple: ['romance', 'romances'], feud: ['feud', 'feuds'] };
const DEATH = ['death', 'deaths'];
// deaths go in the obituaries, as how they died; only NOTABLE ones make a headline too. ROUNDUP_AT road deaths in an
// edition make a [roads] headline of their own ({n} of them)
const OBIT = { killedbycar: 'hit by a car', crashedinto: 'in a crash', fell: 'in a fall', drowned: 'drowned', punchedfence: 'fighting a fence',
  beatentodeath: 'beaten to death', exploded: 'exploded', smited: 'struck by lightning', orbsmited: 'judged by the Seraphorb' };
const NOTABLE = ['beatentodeath', 'exploded', 'smited', 'orbsmited'];
const ROADS = ['killedbycar', 'crashedinto'], ROUNDUP_AT = 3;
const isObit = item => item.obit || (item.kind in OBIT && !NOTABLE.includes(item.kind)); // (older saves: routine deaths as headlines)
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

let news = [], edition = 0, paper = null, shown = 0;
const last = new Map(); // kind+id → worldNow() it was last news
onProgress('chronicle', saved => { news = saved ?? []; fillPaper(); });
onProgress('chronicleEd', saved => { edition = shown = saved ?? 0; fillPaper(); });

App.chronicle = (who, what, by) => {
  const lines = (headlines[what] ?? []).filter(l => by?.name || !l.includes('{by}'));
  const obit = OBIT[what] && who.name, headline = lines.length && (!OBIT[what] || NOTABLE.includes(what));
  if (!obit && !headline) return;
  const key = what + ' ' + (who.id ?? Math.round(who.x) + ',' + Math.round(who.z)) + ' ' + (by?.id ?? ''), now = worldNow();
  if (now - (last.get(key) ?? -Infinity) < REPEAT) return;
  last.set(key, now);
  const minutes = Math.floor(S.timeOfDay*60) % 1440;
  const item = { kind: what, ed: edition + 1, time: String(Math.floor(minutes/60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
    id: who.id ?? null, x: who.x, z: who.z };
  if (obit) news.push({ ...item, obit: true, text: `${who.name}${who.age ? ', ' + Math.round(who.age) : ''} — ${OBIT[what]}` });
  if (headline) news.push({ ...item, text: pick(lines)
    .replace(/\{name\}/g, who.name ?? 'Someone').replace(/\{by\}/g, by?.name ?? '').replace(/\{city\}/g, worldName() || 'Kallipolis') });
  news = news.slice(-MAX);
  setProgress('chronicle', news);
  fillPaper();
};

// for speech (speech-text.js nameIn): [news.headline] a story from the latest edition or since (null if none),
// [news.paper] the paper's name, [world.city] the city's
App.speechNews = key => {
  const city = worldName() || 'Kallipolis';
  if (key === 'world.city') return city;
  if (key === 'news.paper') return `the ${city} Chronicle`;
  const recent = news.filter(item => item.ed >= edition && !isObit(item));
  return recent.length ? pick(recent).text : null;
};

function goTo(item) {
  const i = item.id == null ? -1 : people.findIndex(p => p.id === item.id && p.mode !== 'dead');
  if (i >= 0) followPerson(i);
  else controls.goalTarget.set(item.x, controls.goalTarget.y, item.z);
}
const pick = list => list[Math.floor(Math.random()*list.length)];

// ---- the morning edition
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
  printFiller();
  openChronicle(edition);
}
// "In other news": FILLER lines from [filler] (one more on a day with no news), {someone} a random passer-by
const FILLER = 2;
function printFiller() {
  const living = people.filter(p => p.mode !== 'dead' && p.name), city = worldName() || 'Kallipolis';
  let lines = (headlines.filler ?? []).filter(l => living.length || !l.includes('{someone}'));
  const quiet = !news.some(item => item.ed === edition && item.kind !== 'filler');
  for (let n = FILLER + (quiet ? 1 : 0); n > 0 && lines.length; n--) {
    const line = pick(lines), who = line.includes('{someone}') ? pick(living) : null;
    lines = lines.filter(l => l !== line);
    news.push({ text: line.replace(/\{city\}/g, city).replace(/\{someone\}/g, who?.name ?? ''), kind: 'filler', ed: edition, time: '',
      id: who?.id ?? null, x: who?.x ?? 0, z: who?.z ?? 0 });
  }
  news = news.slice(-MAX);
  setProgress('chronicle', news);
}

// ---- the paper
const rank = item => { const r = LEAD.indexOf(item.kind); return r < 0 ? LEAD.length : r; };
const el = (className, text = '') => Object.assign(document.createElement('div'), { className, textContent: text });
/** View > Daily Chronicle, or a new edition coming out: the paper, at edition `ed` (the latest by default). @returns {void} */
export function openChronicle(ed = edition) {
  shown = ed;
  if (!paper) paper = openWindow({ id: 'front-page', title: 'Daily Chronicle', width: 540, noOk: true, onClose: () => { paper = null; },
    fill: body => { body.append(el('w3-paper')); } });
  fillPaper();
}
function fillPaper() {
  if (!paper) return;
  const ed = shown, city = worldName() || 'Kallipolis', first = Math.min(edition, ...news.map(item => item.ed ?? edition));
  const of = n => news.filter(item => item.ed === n);
  // (no edition out yet: what's happened so far, as a special edition)
  const all = of(ed || 1), obits = all.filter(isObit), stories = all.filter(item => item.kind !== 'filler' && !isObit(item));
  const roads = obits.filter(item => ROADS.includes(item.kind)).length, roundup = headlines.roads ?? ['{n} killed on {city} roads'];
  if (roads >= ROUNDUP_AT) stories.push({ kind: 'roundup', text: roundup[ed % roundup.length].replace(/\{n\}/g, roads).replace(/\{city\}/g, city),
    x: obits[0].x, z: obits[0].z });
  stories.sort((a, b) => rank(a) - rank(b));
  const lead = stories[0];
  const filler = of(ed).filter(item => item.kind === 'filler'), stop = ed && ed === edition ? of(ed + 1).filter(item => !isObit(item)).reverse() : [];
  const counts = new Map();
  if (obits.length) counts.set(DEATH, obits.length);
  stories.forEach(item => { const t = TALLY[item.kind]; if (t) counts.set(t, (counts.get(t) ?? 0) + 1); });
  const tally = [...counts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(', ');

  const page = paper.querySelector('.w3-paper');
  page.replaceChildren();
  const strip = el('w3-paper-strip'), back = document.createElement('button'), on = document.createElement('button');
  back.textContent = '‹'; on.textContent = '›';
  back.disabled = ed <= Math.max(1, first); on.disabled = ed >= edition;
  back.onclick = () => { shown--; fillPaper(); };
  on.onclick = () => { shown++; fillPaper(); };
  const no = el('', ed ? `No. ${ed}` : 'Special edition');
  no.prepend(back); no.append(on);
  strip.append(no, el('', ed ? (ed === edition ? 'Morning edition' : 'Back issue') : 'Before the first edition'), el('', 'One penny'));
  page.append(strip, el('w3-paper-mast', `The ${city} Chronicle`), el('w3-paper-motto', `All the news that's fit to witness · ${city}'s own newspaper`));

  const quiet = headlines.quiet ?? ['All quiet in {city}'];
  const leadEl = el('w3-paper-lead', lead ? lead.text : quiet[ed % quiet.length].replace(/\{city\}/g, city));
  if (lead) leadEl.onclick = () => goTo(lead);
  page.append(leadEl);
  if (tally) page.append(el('w3-paper-tally', `${ed ? 'Since the last edition' : 'So far'}: ${tally}.`));

  const cols = el('w3-paper-cols');
  cols.append(...stories.slice(1).map(paperStory));
  if (filler.length) cols.append(el('w3-paper-other', 'In other news'), ...filler.map(paperStory));
  if (obits.length) cols.append(el('w3-paper-other', 'Obituaries'), ...obits.map(item => Object.assign(paperStory(item), { className: 'w3-paper-story obit' })));
  if (cols.childElementCount) page.append(cols);
  if (stop.length) {
    const box = el('w3-paper-stop');
    box.append(el('w3-paper-other', 'Stop press'), ...stop.map(paperStory));
    page.append(box);
  }
}
// a story: its headline, and when (none for filler); an obituary's text is who and how
function paperStory(item) {
  const story = document.createElement('button');
  story.className = 'w3-paper-story' + (item.kind === 'filler' ? ' filler' : '');
  story.textContent = item.text;
  if (item.time && !isObit(item)) story.prepend(Object.assign(document.createElement('span'), { className: 'w3-paper-time', textContent: item.time + ' — ' }));
  story.onclick = () => goTo(item);
  return story;
}
