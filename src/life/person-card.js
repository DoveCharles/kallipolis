import { App } from '../core/shared.js';
import { mulberry32 } from '../core/math.js';

// ============================================================ person card
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age and mood, and one thing they enjoy and one they hate. What those are picked from is in assets/people.txt, to be
// edited freely; each person's picks are fixed by their place in the crowd, so they're the same person every time.
const PEOPLE_TEXT_URL = 'assets/people.txt';
// the lists, by their headings in people.txt — these stand in until it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'moods': ['🙂'], 'enjoys': ['A nice walk'], 'hates': ['Puddles'] };
let shown = null; // { index, isMan } of whoever the card is showing
const card = document.getElementById('person-card');
document.getElementById('person-card-close').addEventListener('click', () => App.stopFollowingPerson());

// people.txt: a [heading] starts each list, one entry per line after it; blank lines and lines starting with # are skipped
function parsePeopleText(text) {
  const parsed = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = []; return; }
    if (current) parsed[current].push(line);
  });
  return parsed;
}
fetch(PEOPLE_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    const parsed = parsePeopleText(text);
    Object.keys(lists).forEach(key => { if (parsed[key] && parsed[key].length) lists[key] = parsed[key]; });
    if (shown) showPersonCard(shown.index, shown.isMan);
  })
  .catch(err => console.warn('Blockout: assets/people.txt failed to load; people get placeholder names', err));

// someone's name, age, mood, and what they enjoy and hate — a man's name from the boy names and a woman's from the girl names
// (either, for the cuboid people, who have no sex)
function profileOf(index, isMan) {
  const rng = mulberry32(48271 + index*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  return { name: pick(lists[man ? 'boy names' : 'girl names']), age: 18 + Math.floor(rng()*65), mood: pick(lists.moods),
    enjoys: pick(lists.enjoys), hates: pick(lists.hates) };
}
function showPersonCard(index, isMan) {
  shown = { index, isMan };
  const profile = profileOf(index, isMan);
  ['name', 'age', 'mood', 'enjoys', 'hates'].forEach(key => { document.getElementById('pc-' + key).textContent = profile[key]; });
  card.hidden = false;
}
function hidePersonCard() {
  shown = null;
  card.hidden = true;
}

Object.assign(App, { showPersonCard, hidePersonCard });
