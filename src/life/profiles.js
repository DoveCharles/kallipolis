import { mulberry32 } from '../core/math.js';

const LETTERS = ['A.','B.','C.','D.','E.','F.','G.','H.','I.','J.','K.','L.','M.','N.','O.','P.','Q.','R.','S.','T.','U.','V.','W.','X.','Y.','Z.','Ñ.']
const ROMAN_NUMERALS = [ 'II', 'III','II', 'III', 'IV', 'V','VI','VII','VII','IX']

// ============================================================ who people are
// Everyone in the crowd has a name, an age, a mood, and loves and hates, picked from assets/people.txt. The picks are the same
// every time for the same place in the crowd, and any traits they carry change how that person behaves (see the list at the
// top of people.txt, and people.js). person-card.js displays a profile.
// Possible [loves, hates] counts per person, with their chances, which must add up to 1.
const LOVE_HATE_COUNTS = [[1, 1, 0.6], [2, 0, 0.1], [0, 2, 0.1], [2, 1, 0.1], [1, 2, 0.1]];
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
  aggression:{base: 1, min: 0, max: 100},
  choiceweight: {base: 0, min: 1, max: 1000}, //Increase how many times a line is added to lists, 
  //                                               set 0 to prevent auto assignment and allow manual setting only
  agemult: {base: 1, min: 0.1, max: 1000}, //Inf limit to allow vampiric / immortal type shit
  ageless: { base: 0, min: 0, max: 1, combine: 'on' },
  nickname: { base: 0, min: 0, max: 1, combine: 'on'},
  bleach: {base: 0, min: 0, max: 1, combine: 'on'},
  solo: {base: 0, min: 0, max: 1, combine: 'on'}, // On a love or hate: the only one of its kind that person has (see addMore).
};
const RULES = ['limit']
// the value everyone starts with, by trait: TRAITS' base until people.txt loads, then whatever its trait table's start
// column says (see parsePeopleText) — updated in place, so people holding it see the file's values
export const DEFAULT_TRAITS = Object.fromEntries(Object.entries(TRAITS).map(([key, trait]) => [key, trait.base]));

let version = 0; // counts up each time people.txt loads, so what was worked out from it can be worked out again
const listeners = [];
const warned = new Set();

// An entry: its text, and the traits in [brackets] at the end of it, as [trait, value] pairs — several to a pair of
// brackets separated by commas, or each in its own; a trait without a value is 1 (on).
function entryOf(line) {
  const traits = [];
  const rules = [];
  let text = line, group, weight = 1;
  while ((group = text.match(/\[([^[\]]*)\]\s*$/))) {
    text = text.slice(0, group.index).trimEnd();
    const found = [];
    const foundRules = [];
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
      if (RULES.includes(key)) { foundRules.push([key, rawValue == null ? '' : rawValue.trim()]); return; }
      if (TRAITS[key] && Number.isFinite(value)) { found.push([key, value]); return; }
      if (!warned.has(part.trim())) {
        warned.add(part.trim());
        console.warn(`Blockout: in people.txt, "${part.trim()}" (after "${text}") isn't a trait people can have — see the list at the top of the file`);
      }
    });
    traits.unshift(...found);
    rules.unshift(...foundRules);
  }
  return { text, traits, weight, rules };
}
// the lists, by their headings in people.txt — these stand in until it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'surnames': ['Smith'], 'nicknames': ['The Bug'], 'moods': ['😐'], 'enjoys': ['A nice walk'], 'hates': ['Puddles'] };
Object.keys(lists).forEach(key => { lists[key] = lists[key].map(entryOf); });

// people.txt: a [heading] starts each list, one entry per line after it; blank lines and lines starting with # are skipped,
// except the rows of the trait table at the top ("#   walkspeed   1   ..."), whose start column sets everyone's starting
// value (on/off for the switches). choiceweight isn't a trait anyone has, so its row is only there to explain it.
const TRAIT_ROW = /^#\s+([a-z]+)\s+(-?\d*\.?\d+|on|off)\s/i;
function parsePeopleText(text) {
  const parsed = {}, starts = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    const row = line.match(TRAIT_ROW), key = row && row[1].toLowerCase();
    if (row && TRAITS[key] && key !== 'choiceweight') {
      const value = row[2].toLowerCase(), trait = TRAITS[key];
      starts[key] = Math.max(trait.min, Math.min(trait.max, value === 'on' ? 1 : value === 'off' ? 0 : parseFloat(value)));
    }
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[([^[\]]+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = []; return; }
    if (!current) return;
    const entry = entryOf(line);
    if (entry.text) for (let i = 0; i< entry.weight; i++) parsed[current].push(entry);
  });
  return { lists: parsed, starts };
}
fetch(PEOPLE_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    const { lists: parsed, starts } = parsePeopleText(text);
    Object.assign(DEFAULT_TRAITS, starts);
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
// Someone's name, age, mood, loves and hates (lists; people.txt's "enjoys" section supplies the loves), and the traits those give them — a man's name from the boy names and
// a woman's from the girl names (either, for the cuboid people, who have no sex). `index` is their place in the crowd.
export function profileOf(index, isMan) {
  const rng = mulberry32(48271 + index*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  const name = pick(lists[man ? 'boy names' : 'girl names']);
  let age = 18 + Math.floor(rng()*65);
  const mood = pick(lists.moods);
  const enjoys = pick(lists.enjoys);

  const parseLimit = value => ({ rule: value.slice(0, -1), polarity: value.slice(-1) });
  const findLimits = rules => (rules ?? []).filter(([key]) => key === 'limit').map(([, value]) => parseLimit(value));
  // Two entries clash when they hold the same limit on opposite sides (1a and 1b).
  const clash = (a, b) => { const bLimits = findLimits(b.rules); return findLimits(a.rules).some(x => bLimits.some(y => x.rule === y.rule && x.polarity !== y.polarity)); };

  let hates, incompatible = true;
  while (incompatible) {
    hates = pick(lists.hates);
    incompatible = clash(enjoys, hates);
  }

  // The counts and any extra picks use their own random stream, so adding to the picks made on `rng` above does not change
  // the names, ages and moods of existing people. Keep new random draws for a profile on `extra`, not `rng`.
  const extra = mulberry32(90173 + index*6151);
  const countRoll = extra();
  let chance = 0;
  const [loveCount, hateCount] = LOVE_HATE_COUNTS.find(([, , odds]) => countRoll < (chance += odds)) ?? LOVE_HATE_COUNTS[0];
  const loves = loveCount >= 1 ? [enjoys] : [], hated = hateCount >= 1 ? [hates] : [];
  // Adds entries until `mine` has `count`, skipping any with the same text as, or a limit clashing with, an entry already
  // chosen. A solo entry is never added to a non-empty list, and a list holding one stops at that entry, so the count can
  // end lower than requested. Gives up after 50 tries, leaving fewer.
  const isSolo = entry => entry.traits.some(([key, value]) => key === 'solo' && value > 0);
  const addMore = (mine, list, count) => {
    const target = mine.some(isSolo) ? 1 : count;
    for (let tries = 0; mine.length < target && tries < 50; tries++) {
      const entry = list[Math.floor(extra()*list.length)];
      if (isSolo(entry) && mine.length) continue;
      if ([...loves, ...hated].every(other => other.text !== entry.text && !clash(entry, other))) mine.push(entry);
    }
  };
  addMore(loves, lists.enjoys, loveCount);
  addMore(hated, lists.hates, hateCount);

  const traits = traitsOf([name, mood, ...loves, ...hated]);

  const nameRoll = rng();

  let fullname = traits.nickname ? pick(lists['nicknames']).text :                                    //nickname only - requires trait
    nameRoll>0.9 ? `${name.text} '${pick(lists['nicknames']).text}' ${pick(lists['surnames']).text}`: //full name w/ nickname, 10%
    nameRoll>0.3 ? `${name.text} ${pick(lists['surnames']).text}`:                                    //full name no nickname, 60%
      nameRoll>0.2? `${name.text} ${pick(LETTERS)} ${pick(lists['surnames']).text}`:                 //full name, abr middle, 10%
        nameRoll>0.115?`'${pick(lists['nicknames']).text}' ${pick(lists['surnames']).text}`:           //nickname surname, 8.5%
          nameRoll>0.2?`${name.text} '${pick(lists['nicknames']).text}'`:                            //forename nickname, 8.5%
            `${name.text} ${pick(ROMAN_NUMERALS)}`;                                               //forename numeral, 2%

  //unknown entities have hidden traits
  // (UNKNOWN) people hide every love, every hate, or both — never neither. A hidden side that has no entries shows a single
  // (UNKNOWN).
  let loveTexts = loves.map(entry => entry.text), hateTexts = hated.map(entry => entry.text);
  if (name.text === '(UNKNOWN)') {
    fullname = '(UNKNOWN)';
    const hidden = texts => texts.length ? texts.map(() => '(UNKNOWN)') : ['(UNKNOWN)'];
    const lovesHidden = rng() > 0.5;
    const hatesHidden = !lovesHidden || rng() > 0.5;
    if (lovesHidden) loveTexts = hidden(loveTexts);
    if (hatesHidden) hateTexts = hidden(hateTexts);
  }

  age = Math.round(Math.max(18, age*traits.agemult)) //no minors!

  // `loves` and `hates` are lists of text; at most one is ever empty.
  return { name: fullname, age, mood: mood.text, loves: loveTexts, hates: hateTexts, traits: traits};
}
