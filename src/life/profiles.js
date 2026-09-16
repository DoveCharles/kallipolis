import { mulberry32 } from '../core/math.js';

// ============================================================ who people are
// Everyone in the crowd has a name, an age, a mood, one thing they enjoy and one they hate, picked from assets/people.txt
// (to be edited freely) — the same picks every time for the same place in the crowd — along with any traits those picks
// carry, which change how they go about (see the list at the top of people.txt, and people.js). The card saying who
// someone is is person-card.js.
const PEOPLE_TEXT_URL = 'assets/people.txt';
// The traits an entry can carry, as [trait = value] after it: the value everyone starts with, the range a value's kept to,
// and how several combine — multiplying together, or (mood) adding up, or (backwards) on if anything turns it on.
export const TRAITS = {
  walkspeed: { base: 1, min: 0.1, max: 6 },
  size:      { base: 1, min: 0.3, max: 3 },
  chatty:    { base: 1, min: 0, max: 10 },
  talkative: { base: 1, min: 0.05, max: 20 },
  lounging:  { base: 1, min: 0, max: 10 },
  patience:  { base: 1, min: 0.1, max: 10 },
  fidgety:   { base: 1, min: 0, max: 20 },
  nosy:      { base: 1, min: 0.05, max: 10 },
  blinks:    { base: 1, min: 0, max: 20 },
  parks:     { base: 1, min: 0, max: 8 },
  plazas:    { base: 1, min: 0, max: 8 },
  roadsafety:{ base: 1, min: 0.2, max: 3 },
  mood:      { base: 0, min: -1, max: 1, combine: 'add' },
  happy:     { base: 0, min: 0, max: 1, combine: 'add' },
  sad:       { base: 0, min: 0, max: 1, combine: 'add' },
  angry:     { base: 0, min: 0, max: 1, combine: 'add' },
  shock:     { base: 0, min: 0, max: 1, combine: 'add' },
  backwards: { base: 0, min: 0, max: 1, combine: 'on' },
  evil:      {base: 0, min: -1, max: 1, combine: 'add'},
  choiceweight: {base: 0, min: 1, max: Infinity}, //Increase how many times a line is added to lists, 
  //                                               set 0 to prevent auto assignment and allow manual setting only
  age: {base: 1, min: 0.1, max: Infinity}, //Inf limit to allow vampiric / immortal type shit
};
export const DEFAULT_TRAITS = Object.fromEntries(Object.entries(TRAITS).map(([key, trait]) => [key, trait.base]));

let version = 0; // counts up each time people.txt loads, so what was worked out from it can be worked out again
const listeners = [];
const warned = new Set();

// An entry: its text, and the traits in [brackets] at the end of it, as [trait, value] pairs — several to a pair of
// brackets separated by commas, or each in its own; a trait without a value is 1 (on).
function entryOf(line) {
  const traits = [];
  let text = line, group, weight = 1;
  while ((group = text.match(/\[([^[\]]*)\]\s*$/))) {
    text = text.slice(0, group.index).trimEnd();
    const found = [];
    group[1].split(/[,;]/).forEach(part => {
      if (!part.trim()) return;
      const [rawKey, rawValue] = part.split('=');
      const key = rawKey.trim().toLowerCase(), value = rawValue == null ? 1 : parseFloat(rawValue);
      if (key === 'choiceweight') {
        if (Number.isInteger(value) && value >= 0) {weight = value; return;}
        if (!warned.has(part.trim())) {
          warned.add(part.trim());
          console.warn(`Blockout: in people.txt, "${part.trim()}" (after "${text}") needs a whole number of 0 or more`);
        }
        return;
      }
      if (TRAITS[key] && Number.isFinite(value)) { found.push([key, value]); return; }
      if (!warned.has(part.trim())) {
        warned.add(part.trim());
        console.warn(`Blockout: in people.txt, "${part.trim()}" (after "${text}") isn't a trait people can have — see the list at the top of the file`);
      }
    });
    traits.unshift(...found);
  }
  return { text, traits, weight };
}
// the lists, by their headings in people.txt — these stand in until it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'moods': ['😐'], 'enjoys': ['A nice walk'], 'hates': ['Puddles'] };
Object.keys(lists).forEach(key => { lists[key] = lists[key].map(entryOf); });

// people.txt: a [heading] starts each list, one entry per line after it; blank lines and lines starting with # are skipped
function parsePeopleText(text) {
  const parsed = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[([^[\]]+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = []; return; }
    if (!current) return;
    const entry = entryOf(line);
    if (entry.text) for (let i = 0; i< entry.weight; i++) parsed[current].push(entry);
  });
  return parsed;
}
fetch(PEOPLE_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    const parsed = parsePeopleText(text);
    Object.keys(lists).forEach(key => { if (parsed[key] && parsed[key].length) lists[key] = parsed[key]; });
    version++;
    listeners.forEach(listener => listener());
  })
  .catch(err => console.warn('Blockout: assets/people.txt failed to load; people get placeholder names', err));

export const profilesVersion = () => version;
// `listener` is called whenever people.txt has loaded
export function onProfilesLoaded(listener) { listeners.push(listener); }

// the traits a person's picks give them, combined, and kept to each trait's range
function traitsOf(entries) {
  const traits = { ...DEFAULT_TRAITS };
  entries.forEach(entry => entry.traits.forEach(([key, value]) => {
    const { combine } = TRAITS[key];
    traits[key] = combine === 'add' ? traits[key] + value : combine === 'on' ? (value > 0 ? 1 : traits[key]) : traits[key]*value;
  }));
  Object.entries(TRAITS).forEach(([key, trait]) => { traits[key] = Math.max(trait.min, Math.min(trait.max, traits[key])); });
  return traits;
}
// Someone's name, age, mood, what they enjoy and hate, and the traits those give them — a man's name from the boy names and
// a woman's from the girl names (either, for the cuboid people, who have no sex). `index` is their place in the crowd.
export function profileOf(index, isMan) {
  const rng = mulberry32(48271 + index*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  const name = pick(lists[man ? 'boy names' : 'girl names']);
  let age = 18 + Math.floor(rng()*65);
  const mood = pick(lists.moods);
  let enjoys = pick(lists.enjoys), hates = pick(lists.hates)
  //unknown entities have hidden traits
  if (name.text === '(UNKNOWN)') {
    let oneEnsured = false;
    if (rng() > 0.5) {
      enjoys = { ...enjoys, text: '(UNKNOWN)'};
      oneEnsured = true;
    }
    if (!oneEnsured || rng() >0.5) hates = {...hates, text: '(UNKNOWN)'}
  }
  const traits = traitsOf([name, mood, enjoys, hates]);
  age = Math.max(18, age*traits.age) //no minors!
  return { name: name.text, age, mood: mood.text, enjoys: enjoys.text, hates: hates.text, traits: traits};
}
