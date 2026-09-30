import { S, buildingHolders } from '../core/shared.js';
import { TRAITS } from '../core/traits.js';
import { entryOf, limitsOf } from '../core/entries.js';
import { setEntryFiller } from './profiles.js';
import { feelingFor, introduced } from './people/peopleRelations.js';
import { moralityLevel } from '../ui/morality.js';
import { capitalisedWords } from '../ui/garble.js';
import { roomLayoutOf, pubStyleOf } from '../buildings/footprints.js';
import { tessellateClosedPath } from '../core/splines.js';
import { peopleNav } from './people/people.js';

// ============================================================ what people say
// The categories in assets/text/speech/ and people/ (the format's in speech/about.txt): each file is one category, named
// by its file wherever it sits (found through assets/text/index.txt, all loaded at once), plus any entry anywhere tagged
// <that name>. A category is compiled once into a flat list (includes followed MAX_DEPTH deep, loops skipped, doubles merged); picks
// lean toward entries whose {tags} fit the speaker's traits and the world, and a speaker's own loves (or hates, in a
// [x: hated] call) are picked half the time.
const TEXT_DIR = 'assets/text/';
const INDEX_URL = TEXT_DIR + 'index.txt'; // every .txt under assets/text/, one path a line (kept up to date by serve.py)
// the folders whose files are categories, at any depth, named by file (so a file can move between subfolders freely);
// people/'s lists (boynames, loves...) come too, their {traits} read as tags (tagsOfTraits), and about.txt files never do
const CATEGORY_DIRS = ['speech/', 'people/'];
const ROOTS = ['dialogue', 'thoughts', 'reactions', 'closers', 'fleeing', 'greetings'];
const MAX_DEPTH = 8;         // how deep includes are followed
const FILL_DEPTH = 5;        // how deep placeholders within placeholders go: the last level only picks words with none
const LEAN = 2;              // how hard a tag leans: × (1 + LEAN × tag × trait), trait measured -1 to +1 from its neutral
const MIN_LEAN = 0.05;       // the least a leaning can bring an entry's weight down to (× its weight)
const FRIEND_ABOVE = 20, ENEMY_BELOW = -20; // how someone feels about another (peopleRelations) to count as {other.friend} / {other.enemy}
const SCORE_FULL = 3;        // a conversation score (see {score}) that counts fully for {talk.score = n}
const LOVE_APPEAL = 0.3, HATE_APPEAL = -0.3; // appeal of people/'s loves and hates that don't give their own
const AGREE_FLOOR = 0.2;     // {likes = n}: the least it can make a reply's weight, so the unlikely still happens now and then
const LOVED_CHANCE = 0.5;    // the chance of picking from the speaker's loves (hates, in a hated call) when any are there
const TRIES = 6;             // lines tried before giving up, when placeholders can't be filled
const REACTION_GAP = 0.5;    // seconds between any two reactions starting, city-wide (a crowd reacts one after another, not at once)
const REACTION_KEEP = 8;     // seconds a reaction can wait its turn before it's dropped (it'd be stale)
let lastReaction = -Infinity;
export const SEEN_TIME = 60; // seconds someone remembers what they saw or felt, for {seen} and {felt} (p.seen / p.felt: see witness, notice and feel in people/people.js)
const DEATHS = ['killedbycar', 'beatentodeath', 'smited', 'drowned', 'exploded', 'crashedinto'];
const SIGHTS = [...DEATHS, 'death', 'punch', 'knockedbycar', 'resurrected', 'healed', 'waterwalking', 'smelly']; // ('death': any of DEATHS)
const FEELINGS = ['punched', 'hitbycar', 'revenge', 'watchedtv', 'fellover', 'gaveup', 'drunk', 'bloodlust', 'bloodsoaked', 'bloodclean', 'haircut', 'newclothes', 'gifted', 'cheered', 'party', 'healed', 'dined', 'carcrash'];
const MOOD_SHOWS = 0.3;       // how far their face (p.emotion, -1 to 1) has to be from neutral for is = sad / happy
const HURT_BELOW = 0.7;       // share of full health under which they're hurt
const STATES = { // {is = …}: how the speaker (or other.is: who they're talking to) is right now
  drunk: person => !!person?.traits?.drunk || (person?.pints ?? 0) >= 1, // (the drunk trait, or a pint or more in them)
  bloodlusting: person => !!person?.lusting,
  bloody: person => (person?.blood ?? 0) > 0,
  sick: person => !!person?.traits?.sick, // (the traits the 🤢 and 🧟 moods give them: their skin's gone green, or a dead blue-grey)
  zombie: person => !!person?.traits?.zombie,
  crying: person => (person?.traits?.crying ?? 0) > 0 || (person?.traits?.welling ?? 0) > 0, // (the moods that show beyond the eyes: tears, a blush, a red face and smoke — see people/peopleEmotes.js)
  blushing: person => (person?.traits?.blushing ?? 0) > 0,
  fuming: person => (person?.traits?.fuming ?? 0) > 0 || (person?.traits?.huffing ?? 0) > 0,
  sleepy: person => (person?.traits?.drowsy ?? 0) > 0,
  sweating: person => (person?.traits?.sweating ?? 0) > 0 || (person?.traits?.panicking ?? 0) > 0,
  panicking: person => (person?.traits?.panicking ?? 0) > 0,
  freezing: person => (person?.traits?.freezing ?? 0) > 0,
  starstruck: person => (person?.traits?.starstruck ?? 0) > 0,
  partying: person => (person?.traits?.partying ?? 0) > 0,
  singing: person => (person?.traits?.singing ?? 0) > 0,
  upsidedown: person => !!person?.traits?.upsidedown,
  drooling: person => (person?.traits?.drooling ?? 0) > 0,
  skeptical: person => (person?.traits?.skeptical ?? 0) > 0,
  goofy: person => (person?.traits?.goofy ?? 0) > 0,
  sad: person => (person?.emotion ?? 0) < -MOOD_SHOWS,
  happy: person => (person?.emotion ?? 0) > MOOD_SHOWS,
  scared: person => person?.fright?.stage === 'flee' || ((person?.blood ?? 0) > 0 && !person?.traits?.bloodlust),
  hurt: person => !!person?.health && person.health.hp < person.health.max*HURT_BELOW,
  // (sat down: on a bench, in a circle on the grass, on a seat indoors — as isSeated in people/peopleActivities.js)
  walking: person => person?.act === 'walk', // (walking along beside someone, talking: see "walking together" in people/peopleActivities.js)
  sitting: person => ((person?.act === 'bench' || person?.act === 'circle') && person.stage === 'sit') || (!!person?.inRoom?.seat && person.inRoom.stage === 'sit'),
};
const PLACES = ['park', 'plaza', 'beach', 'foodcourt', 'roadside', 'path', 'bridge', 'crossing']; // (here.<place>: see placeOf)
// here.<zone>: standing in a zone of that type (zoneOf); city is the 'buildings' zone
const ZONES = { plain: 'plain', park: 'park', water: 'water', beach: 'beach', farmland: 'farmland', suburbs: 'suburbs',
  town: 'town', plaza: 'plaza', city: 'buildings', buildings: 'buildings', industrial: 'industrial', airport: 'airport', mall: 'mall' };
// sex, read as a trait (-1 to 1): {man}, {woman = -1}, {other.man > 0}; 0 for anyone without one (the cuboid people)
const SEXES = { man: person => person?.isMan == null ? 0 : person.isMan ? 1 : -1, woman: person => -SEXES.man(person) };
// age, read as a trait for leans (-1 at AGE_YOUNG or under, 1 at AGE_OLD or over): {age}, {age = -1}; comparisons are in years
const AGE_YOUNG = 18, AGE_OLD = 80;
const AGED = { age: person => person?.age == null ? 0 : Math.max(-1, Math.min(1, (person.age - (AGE_YOUNG + AGE_OLD)/2)/((AGE_OLD - AGE_YOUNG)/2))) };
const PSEUDO = { ...SEXES, ...AGED };
const isTrait = name => !!(TRAITS[name] || PSEUDO[name]);
const NAMED = /^(me|other|seen|felt)\.(name|by)$/; // [me.name], [other.name], [seen.name], [seen.by], [felt.by]
const PERSONAL = /^(me|other)\.(loves|hates)$|^both\.(loves|hates|clash)$/; // [me.loves], [other.hates], [both.loves]...
const WEATHERS = { rain: () => S.weatherRain > 0.05, snow: () => S.weatherSnow > 0.05, cloud: () => S.weatherClouds > 0.05,
  clear: () => !(S.weatherRain > 0.05 || S.weatherSnow > 0.05 || S.weatherClouds > 0.05) };

const members = {};           // category → entries from other files tagged <category>
const files = {};            // category → parsed file ({ forms, nodes }), or null if it failed to load
const pathOf = {};           // category → its path under assets/text/, from the index
let speakingTo = null;       // who the speaker's talking to, for other. tags (set by each pick)
const compiled = {};         // category → its flat list of items
let ready = false;
let random = Math.random; // (swapped for a person's own seeded one while their loves and hates are filled: fillEntry)
const warned = new Set();
const warnOnce = message => { if (!warned.has(message)) { warned.add(message); console.warn(`Kallipolis: ${message}`); } };

// ---------------------------------------------------------- reading the files
const PLACEHOLDER = /\[([^\]]+)\]/g, HAS_PLACEHOLDER = /\[[^\]]+\]/;
const nameOf = inner => inner.split(':')[0].split('#')[0].trim().toLowerCase();

// A tag list, {weight = 2, evil, patience = -1, world.hour 22-5, world.morality < -0.3, world.weather = rain}.
function parseTags(text, where) {
  const tags = { weight: 1, traits: {}, world: [], end: null, thought: false, appeal: 0, score: 0, effects: [], limits: [] };
  text.split(',').map(part => part.trim().replace(/:/g, '=')).filter(Boolean).forEach(part => { // (weight: 4 reads as weight = 4)
    let m;
    if ((m = part.match(/^world\.hour\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'hour', from: +m[1], to: +m[2] });
    else if ((m = part.match(/^world\.weather\s*=\s*(\w+)$/i))) {
      if (WEATHERS[m[1].toLowerCase()]) tags.world.push({ kind: 'weather', is: m[1].toLowerCase() });
      else warnOnce(`in ${where}, unknown weather "${m[1]}" (${Object.keys(WEATHERS).join(', ')})`);
    }
    else if ((m = part.match(/^world\.morality\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'morality', op: m[1], value: +m[2] });
    else if ((m = part.match(/^world\.morality\s*=\s*(-?\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'moralityLean', value: +m[1] });
    else if ((m = part.match(/^here\.(indoors|outdoors)$/i))) tags.world.push({ kind: 'indoors', is: m[1].toLowerCase() === 'indoors' });
    else if ((m = part.match(/^here\.building\s*=\s*(\w+)$/i))) tags.world.push({ kind: 'building', is: m[1].toLowerCase() });
    else if ((m = part.match(/^here\.(\w+)$/i)) && (PLACES.includes(m[1].toLowerCase()) || ZONES[m[1].toLowerCase()]))
      tags.world.push({ kind: 'place', is: m[1].toLowerCase() });
    else if ((m = part.match(/^(seen|felt)(?:\s*=\s*(\w+))?$/i))) {
      const kind = m[1].toLowerCase(), what = m[2]?.toLowerCase() ?? null, known = kind === 'seen' ? SIGHTS : FEELINGS;
      if (what && !known.includes(what)) warnOnce(`in ${where}, "${kind} = ${m[2]}" isn't one of: ${known.join(', ')}`);
      else tags.world.push({ kind, what });
    }
    else if ((m = part.match(/^(other\.)?age\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'age', other: !!m[1], op: m[2], value: +m[3] });
    else if ((m = part.match(/^(other\.)?is\s*(!?=)\s*(\w+)$/i))) {
      if (STATES[m[3].toLowerCase()]) tags.world.push({ kind: 'is', other: !!m[1], not: m[2] === '!=', is: m[3].toLowerCase() });
      else warnOnce(`in ${where}, "is = ${m[3]}" isn't one of: ${Object.keys(STATES).join(', ')}`);
    }
    else if ((m = part.match(/^(other\.)?([a-z]+)\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i)) && isTrait(m[2].toLowerCase()))
      tags.world.push({ kind: 'trait', other: !!m[1], trait: m[2].toLowerCase(), op: m[3], value: +m[4] });
    else if ((m = part.match(/^other\.([a-z]+)\s*(?:=\s*(-?\d+(?:\.\d+)?))?$/i)) && isTrait(m[1].toLowerCase()))
      tags.world.push({ kind: 'otherLean', trait: m[1].toLowerCase(), value: m[2] == null ? 1 : +m[2] });
    else if ((m = part.match(/^likes(?:\s*#\s*(\w+))?\s*(?:(=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?))?$/i)))
      tags.world.push(!m[2] || m[2] === '=' ? { kind: 'likes', ref: m[1] ?? null, value: m[3] == null ? 1 : +m[3] }
        : { kind: 'likesLimit', ref: m[1] ?? null, op: m[2], value: +m[3] });
    else if ((m = part.match(/^(other|seen|felt)\.(friend|enemy|introduced|stranger)$/i))) tags.world.push({ kind: 'relation', whose: m[1].toLowerCase(), is: m[2].toLowerCase() });
    else if ((m = part.match(/^talk\.score\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'talkScore', op: m[1], value: +m[2] });
    else if ((m = part.match(/^talk\.score\s*=\s*(-?\d+(?:\.\d+)?)$/i))) tags.world.push({ kind: 'talkLean', value: +m[1] });
    else if ((m = part.match(/^effect\.([a-z]+)(?:\s*=\s*(-?\d+(?:\.\d+)?))?$/i))) {
      if (TRAITS[m[1].toLowerCase()]) tags.effects.push([m[1].toLowerCase(), m[2] == null ? 1 : +m[2]]);
      else warnOnce(`in ${where}, "{${part}}": ${m[1]} isn't a trait (see core/traits.js)`);
    }
    else if ((m = part.match(/^limit\s*=\s*(\w+?)([ab])$/i))) tags.limits.push({ rule: m[1], polarity: m[2].toLowerCase() });
    else if ((m = part.match(/^appeal\s*=\s*(-?\d+(?:\.\d+)?)$/i))) tags.appeal = +m[1];
    else if ((m = part.match(/^score\s*=\s*(-?\d+(?:\.\d+)?)$/i))) tags.score = +m[1];
    else if (/^thought$/i.test(part)) tags.thought = true;
    else if ((m = part.match(/^end(?:\s*=\s*(good|bad))?$/i))) tags.end = (m[1] ?? 'good').toLowerCase();
    else if ((m = part.match(/^weight\s*=\s*(\d+(?:\.\d+)?)$/i))) tags.weight = +m[1];
    else if ((m = part.match(/^([a-z]+)\s*(?:=\s*(-?\d+(?:\.\d+)?))?$/i)) && isTrait(m[1].toLowerCase())) tags.traits[m[1].toLowerCase()] = m[2] == null ? 1 : +m[2];
    else warnOnce(`in ${where}, "{${part}}" isn't a tag this reads (see speech/about.txt)`);
  });
  return tags;
}

// people/ lists said with a small first letter ("I love energy drinks") unless given a spoken wording after a |
const LOWERED = ['loves', 'hates'];
const lowerFirst = text => text.charAt(0).toLowerCase() + text.slice(1);
// What a [category: …] call can ask for besides a form, which is any other word it names (see fill): [animals: a] with
// a/an in front, [loves: lower] with its first letter made small, [colours: capitalise] with every word's raised,
// [interests: hated] for the negative pick.
const CALL_OPTIONS = ['a', 'lower', 'capitalise', 'hated'];
// An entry's {traits} (people/'s lists) as tags: each trait's effect on someone starting at its base, measured -1 to 1 as
// for the speaker's traits (see traitLevel), softened by a square root so a small effect still leans. They say who holds
// it: taken the other way round (a hate said as a love, or picked for someone's loves) they're read backwards, bar any
// that persist (see sideSign).
function tagsOfTraits(traits) {
  const tags = {};
  traits.forEach(([trait, value]) => {
    const t = TRAITS[trait];
    if (!t) return;
    const effect = t.combine === 'add' ? t.base + value : t.combine === 'on' ? (value > 0 ? t.max : t.base) : t.base*value;
    const level = traitLevel(trait, Math.max(t.min, Math.min(t.max, effect)));
    if (level) tags[trait] = Math.max(-1, Math.min(1, (tags[trait] ?? 0) + Math.sign(level)*Math.sqrt(Math.abs(level))));
  });
  return tags;
}

// One file: `forms:` names, then its lines as a tree — each `>` deeper is a reply to the line above it one level up.
function parseFile(name, text, path = `speech/${name}.txt`) {
  const file = { forms: null, nodes: [] }, where = path, stack = [], plainList = path.startsWith('people/');
  const lowered = plainList && LOWERED.includes(name);
  text.split(/\r?\n/).forEach(raw => {
    let line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (plainList) {
      // (people's lists: {traits} become tags, and it's the spoken wording, after any |, that's said)
      const entry = entryOf(line, { file: where });
      if (!entry.text) return;
      // (its speech.… tags as any line's; its {traits} as leans on top; appeal by default by which list it's in)
      const spoken = entry.speech.join(', '), tags = parseTags(spoken, where);
      tags.traits = { ...tagsOfTraits(entry.traits), ...tags.traits };
      if (!/(^|,)\s*appeal\b/i.test(spoken)) tags.appeal = entry.appeal ?? (name === 'loves' ? LOVE_APPEAL : name === 'hates' ? HATE_APPEAL : 0);
      tags.limits = [...limitsOf(entry), ...tags.limits];
      const side = name === 'loves' ? 1 : name === 'hates' ? -1 : 0;
      const node = { tags, replies: [], where, text: entry.said ?? (lowered ? lowerFirst(entry.text) : entry.text), categories: entry.categories,
        side, persist: entry.persist, persists: entry.persists, flips: entry.flips, noflip: entry.noflip, noflips: entry.noflips, personTraits: side ? entry.traits : null };
      file.nodes.push(node);
      return;
    }
    const formsLine = line.match(/^forms\s*:\s*(.+)$/i);
    if (formsLine && !file.forms && !file.nodes.length) { file.forms = formsLine[1].split('|').map(f => f.trim().toLowerCase()); return; }
    const depth = line.match(/^>*/)[0].length;
    line = line.slice(depth).trim();
    let tags = parseTags('', where), group;
    const categories = [];
    while ((group = line.match(/(?:\{([^{}]*)\}|<([a-z0-9_,\s]*)>)\s*$/i))) {
      if (group[2] != null) categories.unshift(...group[2].split(',').map(c => c.trim().toLowerCase()).filter(Boolean));
      else tags = parseTags(group[1], where);
      line = line.slice(0, group.index).trim();
    }
    const include = line.match(/^\[([^\]:#]+)\]$/);
    const node = { tags, replies: [], where, categories: depth === 0 ? categories : [] };
    if (depth && categories.length) warnOnce(`in ${where}, "${raw.trim()}": <categories> on a reply are ignored`);
    if (include) node.include = include[1].trim().toLowerCase();
    else if (file.forms && !HAS_PLACEHOLDER.test(line)) node.forms = wordForms(line.split('|').map(f => f.trim()), file.forms);
    else node.text = line;
    if (depth === 0) file.nodes.push(node);
    else if (stack[depth - 1]) stack[depth - 1].replies.push(node);
    else warnOnce(`in ${where}, "${raw.trim()}" is a reply with nothing above it to reply to`);
    stack[depth] = node;
    stack.length = depth + 1;
  });
  return file;
}

// An entry's forms by name, with the ones left out worked out: plural from the singular, general from the plural (else
// the singular); a verb's third ("she bites") from its base, its first word taking the -s; an adjective's comparative
// and superlative from its base (-er/-est for one syllable or two ending in y, else "more"/"most"); "-" means it has none.
function wordForms(given, names) {
  const forms = {};
  names.forEach((name, i) => { if (given[i] && given[i] !== '-') forms[name] = given[i]; else if (given[i] === '-') forms[name] = null; });
  if (names.includes('plural') && forms.plural === undefined && forms.singular) forms.plural = pluralOf(forms.singular);
  if (names.includes('general') && !forms.general) forms.general = forms.plural || forms.singular;
  if (names.includes('third') && forms.third === undefined && forms.base) forms.third = forms.base.replace(/^\S+/, first => pluralOf(first));
  if (names.includes('comparative') && forms.comparative === undefined && forms.base) forms.comparative = compared(forms.base, 'er', 'more');
  if (names.includes('superlative') && forms.superlative === undefined && forms.base) forms.superlative = compared(forms.base, 'est', 'most');
  Object.keys(forms).forEach(key => { if (forms[key] == null) delete forms[key]; });
  forms.first = given[0];
  return forms;
}
function compared(word, ending, many) {
  const syllables = (word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length;
  if (/\s/.test(word) || (syllables > 1 && !/y$/i.test(word)) || syllables > 2) return `${many} ${word}`; // (two syllables take -er only ending in y)
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'i' + ending;
  if (/e$/i.test(word)) return word + ending.slice(1);
  if (/^[^aeiou]*[aeiou][bdgmnpt]$/i.test(word)) return word + word.slice(-1) + ending; // (one syllable: big → bigger)
  return word + ending;
}
function pluralOf(word) {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
}

// Find each category's file in the index, then fetch the roots' categories, and whatever they name, till nothing new
// turns up. (Without the index, a category is looked for as speech/<name>.txt.)
async function loadAll() {
  const index = await fetch(INDEX_URL).then(r => r.ok ? r.text() : '').catch(() => '');
  if (!index) warnOnce(`${INDEX_URL} is missing (run serve.py, or python3 serve.py --index); only speech/*.txt is found`);
  index.split(/\r?\n/).map(line => line.trim()).filter(path => path.endsWith('.txt') && CATEGORY_DIRS.some(dir => path.startsWith(dir)))
    .forEach(path => {
      const name = path.split('/').pop().slice(0, -4).toLowerCase();
      if (name === 'about') return;
      if (pathOf[name]) warnOnce(`two files make [${name}]: ${pathOf[name]} and ${path}; the first is used`);
      else pathOf[name] = path;
    });
  let wanted = index ? Object.keys(pathOf) : ROOTS.slice();
  while (wanted.length) {
    const paths = wanted.map(name => pathOf[name] ?? `speech/${name}.txt`);
    const texts = await Promise.all(paths.map((path, i) => fetch(TEXT_DIR + path)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); })
      .catch(() => { warnOnce(`${path} failed to load; [${wanted[i]}] is left empty`); return null; })));
    const next = new Set();
    wanted.forEach((name, i) => {
      files[name] = texts[i] == null ? null : parseFile(name, texts[i], paths[i]);
      if (files[name]) files[name].nodes.forEach(node => node.categories?.forEach(category => (members[category] ??= []).push(node)));
      if (files[name] && !index) walk(files[name].nodes, node => {
        if (node.include) next.add(node.include);
        if (node.text) for (const m of node.text.matchAll(PLACEHOLDER)) if (!NAMED.test(nameOf(m[1])) && !PERSONAL.test(nameOf(m[1]))) next.add(nameOf(m[1]));
      });
    });
    wanted = [...next].filter(name => !(name in files));
  }
  ready = true;
  setEntryFiller(fillEntry);
}
function walk(nodes, visit) { nodes.forEach(node => { visit(node); walk(node.replies, visit); }); }
loadAll();

/** Whether the speech files have all loaded. @returns {boolean} */
export const speechReady = () => ready;

// ---------------------------------------------------------- compiling
// A flat list of items from some nodes: includes opened (their tags added to everything reached through them, their
// weight multiplying it), and the same entry reached twice kept once — its highest weight, and each tag at its strongest.
function compileNodes(nodes, depth, path, where) {
  const items = new Map();
  const add = item => {
    const had = items.get(item.key);
    if (!had) { items.set(item.key, item); return; }
    had.weight = Math.max(had.weight, item.weight);
    if (Math.abs(item.appeal) > Math.abs(had.appeal)) had.appeal = item.appeal;
    if (!had.effects?.length && item.effects?.length) had.effects = item.effects;
    if (item.limits?.length) had.limits = [...(had.limits ?? []), ...item.limits];
    Object.entries(item.traits).forEach(([trait, value]) => {
      const old = had.traits[trait] ?? 0;
      if (old && Math.sign(old) !== Math.sign(value)) warnOnce(`${trait} is tagged both ways on "${item.key}" (${where}); the stronger wins`);
      if (Math.abs(value) > Math.abs(old)) had.traits[trait] = value;
    });
    if (item.forms && Object.keys(item.forms).length > Object.keys(had.forms || {}).length) had.forms = item.forms;
  };
  nodes.forEach(node => {
    if (node.include) {
      if (path.includes(node.include)) { warnOnce(`[${node.include}] includes itself (via ${path.join(' → ')}); skipped`); return; }
      if (depth >= MAX_DEPTH) { warnOnce(`[${node.include}] is past MAX_DEPTH (${MAX_DEPTH}) includes deep; skipped`); return; }
      categoryItems(node.include, depth + 1, path).forEach(inner => add({
        ...inner, weight: inner.weight*node.tags.weight, end: node.tags.end ?? inner.end, thought: node.tags.thought || inner.thought,
        traits: addTraits(inner.traits, node.tags.traits), world: inner.world.concat(node.tags.world),
        appeal: inner.appeal + node.tags.appeal, score: inner.score || node.tags.score, effects: [...(inner.effects ?? []), ...node.tags.effects],
        limits: [...(inner.limits ?? []), ...node.tags.limits],
      }));
      return;
    }
    // (a love and a hate with the same words stay two entries: each leans its own way)
    const key = (node.forms ? node.forms.first : node.text).toLowerCase().trim() + (node.where?.startsWith('people/') ? `@${node.where}` : '');
    add({ key, forms: node.forms, text: node.text, replies: node.replies, weight: node.tags.weight, end: node.tags.end, thought: node.tags.thought,
      appeal: node.tags.appeal, score: node.tags.score, effects: node.tags.effects, limits: node.tags.limits,
      side: node.side ?? 0, persist: node.persist, persists: node.persists, flips: node.flips, noflip: node.noflip, noflips: node.noflips, personTraits: node.personTraits,
      traits: { ...node.tags.traits }, world: node.tags.world.slice(), where: node.where });
  });
  return [...items.values()];
}
const addTraits = (a, b) => { const out = { ...a }; Object.entries(b).forEach(([k, v]) => { out[k] = (out[k] ?? 0) + v; }); return out; };

function categoryItems(name, depth = 0, path = []) {
  if (compiled[name]) return compiled[name];
  const file = files[name], extra = members[name] ?? [];
  if (file === undefined && !extra.length) { warnOnce(`[${name}] isn't a category (no ${name}.txt in speech/ or people/, and nothing tagged <${name}>)`); return []; }
  const items = compileNodes((file?.nodes ?? []).concat(extra), depth, path.concat(name), pathOf[name] ?? `<${name}>`);
  if (!path.length || items.length) compiled[name] = items; // (a partial list, cut short by a loop, isn't kept)
  return items;
}

// ---------------------------------------------------------- picking
// A trait's value from -1 (its min) through 0 (its neutral) to +1 (its max); traits that multiply are measured by ratio.
const levelOf = (person, trait) => PSEUDO[trait] ? PSEUDO[trait](person) : traitLevel(trait, person?.traits?.[trait]);
function traitLevel(trait, value) {
  const { base, min, max, combine } = TRAITS[trait];
  if (value == null) return 0;
  if (value >= base) {
    if (max <= base) return 0;
    return Math.min(1, combine || base <= 0 ? (value - base)/(max - base) : Math.log(value/base)/Math.log(max/base));
  }
  return Math.max(-1, min < base ? -(base - value)/(base - min) : 0);
}

// the building someone's inside (their room shown or not), else null
const buildingOf = person => person?.mode === 'indoors' && person.indoors?.stage === 'inside' ? person.indoors.building : null;
const fresh = memory => memory && performance.now()/1000 - memory.at < SEEN_TIME ? memory : null;
const seenFresh = person => fresh(person?.seen), feltFresh = person => fresh(person?.felt);

// where someone is out and about: in a park, plaza or beach (a hangout), crossing a road, by one (on a sidewalk ring), on
// a bridge (a raised path) or on another path — else null (indoors, riding a train...)
function placeOf(person) {
  if (!person || buildingOf(person)) return null;
  if (person.crossStage) return 'crossing';
  if (person.mode === 'wander' || person.mode === 'leaving') return peopleNav?.areas?.[person.area]?.kind ?? null;
  if (person.mode === 'line') { const line = peopleNav?.lines?.[person.li]; return !line ? null : line.ring ? 'roadside' : line.raised && !line.indoor ? 'bridge' : 'path'; }
  return null;
}

// the type of the zone someone's standing in (the last drawn, where zones overlap), else null; outlines cached per zone
const outlines = new WeakMap();
function zoneOf(person) {
  let found = null;
  buildingHolders().forEach(zone => { // (a mall's outline too: see roads/mall.js)
    if (zone.drawing || !zone.points || zone.points.length < 3) return;
    let cached = outlines.get(zone);
    if (!cached || cached.points !== zone.points || cached.count !== zone.points.length) outlines.set(zone, cached = { points: zone.points, count: zone.points.length, poly: tessellateClosedPath(zone.points) });
    if (insidePoly(cached.poly, person.x, person.z)) found = zone.zoneType || 'buildings';
  });
  return found;
}
function insidePoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x)*(z - a.z)/(b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const worldAllows = (world, person) => world.every(w => {
  if (w.kind === 'age') {
    const age = (w.other ? speakingTo : person)?.age;
    return age != null && (w.op === '<' ? age < w.value : w.op === '>' ? age > w.value : w.op === '<=' ? age <= w.value : age >= w.value);
  }
  if (w.kind === 'is') { const who = w.other ? speakingTo : person; return !!who && STATES[w.is](who) !== w.not; }
  if (w.kind === 'place') return placeOf(person) === w.is || (!!ZONES[w.is] && !buildingOf(person) && zoneOf(person) === ZONES[w.is]);
  if (w.kind === 'indoors') return !!buildingOf(person) === w.is;
  if (w.kind === 'building') { const b = buildingOf(person); const layout = b && roomLayoutOf(b.kind, b.number);
    // (a craft beer bar's a pub too, and `craftpub` only one of those: see pubStyleOf; and every home has a
    // bedroom and `ensuite` through the living room: see homeSuiteOf)
    return !!b && (b.kind === w.is || layout === w.is || (w.is === 'craftpub' && layout === 'pub' && pubStyleOf(b.key) === 'craft')
      || (w.is === 'ensuite' && layout === 'home')); }
  if (w.kind === 'trait') {
    const who = w.other ? speakingTo : person;
    if (!who?.traits) return false;
    const level = levelOf(who, w.trait);
    return w.op === '<' ? level < w.value : w.op === '>' ? level > w.value : w.op === '<=' ? level <= w.value : level >= w.value;
  }
  if (w.kind === 'seen') { const seen = seenFresh(person); return !!seen && (!w.what || seen.what === w.what || (w.what === 'death' && DEATHS.includes(seen.what))); }
  if (w.kind === 'felt') { const felt = feltFresh(person); return !!felt && (!w.what || felt.what === w.what); }
  if (w.kind === 'relation') {
    const who = w.whose === 'other' ? speakingTo : w.whose === 'seen' ? seenFresh(person)?.who : feltFresh(person)?.by;
    if (!who || !person) return false;
    const met = introduced(person, who), feeling = feelingFor(person, who) ?? 0;
    return w.is === 'introduced' ? met : w.is === 'stranger' ? !met : w.is === 'friend' ? feeling > FRIEND_ABOVE : feeling < ENEMY_BELOW;
  }
  if (w.kind === 'talkScore') { const v = person?.group?.score ?? 0; return w.op === '<' ? v < w.value : w.op === '>' ? v > w.value : w.op === '<=' ? v <= w.value : v >= w.value; }
  if (w.kind === 'hour') { const h = S.timeOfDay ?? 12; return w.from <= w.to ? h >= w.from && h < w.to + 1 : h >= w.from || h < w.to + 1; }
  if (w.kind === 'weather') return WEATHERS[w.is]();
  if (w.kind === 'morality') { const m = moralityLevel(); return w.op === '<' ? m < w.value : w.op === '>' ? m > w.value : w.op === '<=' ? m <= w.value : m >= w.value; }
  return true;
});

// the word a {likes} tag means: the #n pick, else the last word picked in the line being replied to
const wordFor = (ref, vars) => ref == null ? vars?.$last : Object.entries(vars ?? {}).find(([key]) => key.endsWith(`#${ref}`))?.[1];
// How much a person likes a word, -1 to 1: 1 for one of their loves, -1 for a hate, else its own tags read against their
// traits (as if they were picking it); 0 for no word, or one without tags.
function liking(word, person) {
  if (!word) return 0;
  if (matches(word, lovesOf(person))) return 1;
  if (matches(word, hatesOf(person))) return -1;
  if (limitClash(word, person, false)) return -1; // (the other side of a limit they hold)
  const sum = Object.entries(word.traits).reduce((total, [trait, tag]) => total + tag*levelOf(person, trait)*sideSign(word), word.appeal ?? 0);
  return Math.max(-1, Math.min(1, sum));
}

// {likes > n} and the like: hard limits on how much they like the word
const likesAllow = (world, person, vars) => world.every(w => {
  if (w.kind !== 'likesLimit') return true;
  const level = liking(wordFor(w.ref, vars), person);
  return w.op === '<' ? level < w.value : w.op === '>' ? level > w.value : w.op === '<=' ? level <= w.value : level >= w.value;
});

// Which way a love or hate's traits lean who says they like it: a love's as written, a hate's backwards (the fast hate
// slow walkers, so the slow are who'd say they love them). persist doesn't come into it — it's only for traits a love or
// hate brings when drawn into the other list (see fillEntry); a hard rule on who says it is a speech.… tag.
// (persist: every trait; persist = trait: that one; flip = trait: that one turns round after all, under a bare persist)
const inert = (item, trait) => item.noflip || !!item.noflips?.includes(trait);
const persists = (item, trait) => !item.flips?.includes(trait) && (item.persist || !!item.persists?.includes(trait));
const sideSign = item => (item.side ?? 0) < 0 ? -1 : 1;
function weightOf(item, person, hated, vars = null) {
  const flip = hated ? -1 : 1;
  let weight = item.weight;
  // (appeal, and each trait tag read against the speaker, add into one lean: {appeal = -1, evil} is shunned by all but the
  // evil; in a hated call it all points the other way)
  const lean = Object.entries(item.traits).reduce((sum, [trait, tag]) => sum + tag*levelOf(person, trait)*sideSign(item), item.appeal ?? 0);
  weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*lean);
  item.world.forEach(w => {
    if (w.kind === 'moralityLean') weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*w.value*moralityLevel());
    if (w.kind === 'otherLean') weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*w.value*levelOf(speakingTo, w.trait));
    if (w.kind === 'talkLean') weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*w.value*Math.max(-1, Math.min(1, (person?.group?.score ?? 0)/SCORE_FULL)));
    if (w.kind === 'likes') weight *= Math.max(AGREE_FLOOR, 1 + LEAN*w.value*liking(wordFor(w.ref, vars), person));
  });
  return weight;
}

const plain = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// whether an item is one of `list` (loves or hates) — any of its forms, or its text, the same words
function matches(item, list) {
  if (!list?.length) return false;
  const names = item.forms ? Object.values(item.forms) : [item.text];
  return names.some(name => list.some(entry => plain(entry) === plain(name)));
}

function weightedPick(items, weigh) {
  const weights = items.map(weigh), total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let r = random()*total;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
}

// An entry from a list of items for this speaker: world limits kept to, the form asked for (if any) there, never one
// they hate (love, in a hated call), and half the time one they love (hate) if any are there.
// (someone's loves or hates as said, and the words filled into them: "my [pets]" filled with cats counts cats)
const lovesOf = person => person && [...(person.loves ?? []), ...(person.lovedWords ?? [])];
const hatesOf = person => person && [...(person.hates ?? []), ...(person.hatedWords ?? [])];
// Limits (limit = 1a / 1b: see clash in core/entries.js) as hard limits on what someone says: nobody says they like
// something on the other side of a limit they hold (a vampire, 1a, never loves the sun, 1b); in a hated call it's the
// other way round — nothing on their own side (they'd never say they hate what makes them what they are).
const limitClash = (item, person, hated) => !!person?.limits?.length && !!item.limits?.length
  && item.limits.some(l => person.limits.some(x => x.rule === l.rule && (x.polarity === l.polarity) === hated));
function pickItem(items, person, { form = null, hated = false, vars = null, plainOnly = false, avoid = null } = {}) {
  if (plainOnly) items = items.filter(item => item.forms || !HAS_PLACEHOLDER.test(item.text));
  if (avoid?.length) items = items.filter(item => !matches(item, avoid));
  const liked = hated ? hatesOf(person) : lovesOf(person), disliked = hated ? lovesOf(person) : hatesOf(person);
  const open = items.filter(item => worldAllows(item.world, person) && likesAllow(item.world, person, vars) && (!form || !item.forms || item.forms[form])
    && !matches(item, disliked) && !limitClash(item, person, hated));
  const favourites = open.filter(item => matches(item, liked));
  const from = favourites.length && random() < LOVED_CHANCE ? favourites : open;
  return weightedPick(from, item => weightOf(item, person, hated, vars));
}

// ---------------------------------------------------------- saying
// A person's name for [me.name], [other.name], [seen.name] (who it happened to), [seen.by] (who did it), [felt.by]
// (who did it to the speaker; for revenge, who they got back at) — null if there's nobody.
function nameIn(key, person) {
  const [whose, part] = key.split('.');
  const who = whose === 'me' ? person : whose === 'other' ? speakingTo
    : whose === 'seen' ? (part === 'by' ? seenFresh(person)?.by : seenFresh(person)?.who) : feltFresh(person)?.by;
  if (!who) return null;
  if (who === person || introduced(person, who)) return who.name ?? null;
  // (someone they've not been introduced to: "that man" — but never to their face)
  return whose === 'other' ? null : who.isMan === true ? 'that man' : who.isMan === false ? 'that woman' : 'that person';
}
// One of someone's own loves or hates for [me.loves] etc. (as they say it: p.loves), matched to a speech entry with
// the same words if there is one (its forms and tags), else as written. Null if they've none.
let wordIndex = null, indexedFrom = 0;
function personalItem(key, person) {
  const [whose, list] = key.split('.'), known = (who, side) => (who?.[side] ?? []).filter(entry => entry && entry !== '(UNKNOWN)');
  // (both: one the speaker and whoever they're talking to share; clash: one the speaker loves and the other hates)
  const entries = whose !== 'both' ? known(whose === 'me' ? person : speakingTo, list)
    : known(person, list === 'clash' ? 'loves' : list).filter(entry => known(speakingTo, list === 'clash' ? 'hates' : list).some(theirs => plain(theirs) === plain(entry)));
  if (!entries.length) return null;
  categoryItems('loves'); categoryItems('hates'); // (so a love matches its own entry, tags and all)
  if (!wordIndex || indexedFrom !== Object.keys(compiled).length) {
    wordIndex = new Map(); indexedFrom = Object.keys(compiled).length;
    Object.values(compiled).forEach(items => items.forEach(item => (item.forms ? Object.values(item.forms) : [item.text])
      .forEach(name => { if (name && !wordIndex.has(plain(name))) wordIndex.set(plain(name), item); })));
  }
  const entry = entries[Math.floor(random()*entries.length)];
  return wordIndex.get(plain(entry)) ?? { text: entry, weight: 1, traits: {}, world: [] };
}
// A line's text with its [placeholders] filled; `vars` holds #n picks for the whole conversation. Null if one can't be.
// A call takes a form and any of CALL_OPTIONS with it: [animals: plural], [animals: a], [loves: lower], [colours:
// capitalise], [interests: hated].
function fill(text, person, vars, depth = 0, picks = null, avoid = null) {
  let failed = false;
  const counts = {};
  const out = text.replace(PLACEHOLDER, (_, inner) => {
    if (failed) return '';
    const [head, ...rest] = inner.split(':');
    const [rawName, tag] = head.split('#').map(s => s.trim());
    const name = rawName.toLowerCase(), options = rest.join(':').split(',').map(o => o.trim().toLowerCase()).filter(Boolean);
    if (NAMED.test(name)) { const said = nameIn(name, person); if (!said) failed = true; return said ?? ''; }
    const hated = options.includes('hated'), article = options.includes('a'), lower = options.includes('lower'), everyWord = options.includes('capitalise');
    const form = options.find(o => !CALL_OPTIONS.includes(o)) || null;
    const held = tag ? vars[`${name}#${tag}`] : null;
    // (picks: the card's words, reused in order by the spoken wording — see fillEntry)
    const nth = counts[name] = (counts[name] ?? -1) + 1, reused = !tag && picks?.reuse ? picks.reuse[name]?.[nth] : null;
    // (FILL_DEPTH down, only a word with no placeholders of its own will do, so nothing recurses for ever)
    const item = held || reused || (PERSONAL.test(name) ? personalItem(name, person)
      : pickItem(categoryItems(name), person, { form, hated, plainOnly: depth >= FILL_DEPTH - 1, avoid }));
    if (picks?.record && !tag && !PERSONAL.test(name)) (picks.record[name] ??= []).push(item);
    if (!item) { failed = true; return ''; }
    if (tag) vars[`${name}#${tag}`] = item;
    let said = item.forms ? (form && item.forms[form]) || item.forms.first : item.text;
    if (!item.forms && depth < FILL_DEPTH - 1) said = fill(said, person, vars, depth + 1, null, avoid);
    vars.$last = item; // (for {likes} on the replies)
    if (said == null) { failed = true; return ''; }
    if (lower) said = said.charAt(0).toLowerCase() + said.slice(1); // (a list written with capitals, like people/loves.txt)
    else if (everyWord) said = capitalisedWords(said); // (one written small, like colours.txt: a capital on every word)
    return article ? `${/^[aeiou]/i.test(said) ? 'an' : 'a'} ${said}` : said;
  });
  return failed ? null : out.replace(/\s+/g, ' ').trim();
}
/**
 * An entry's [placeholders] filled for one person's card (see profileOf in profiles.js), with `rng` so the same person
 * always gets the same: the card wording, the spoken one (after a |, its own placeholders taking the card's picks in
 * order, and #n picks shared), and the words filled in, so speech knows them as loved or hated too.
 * @param {{text: string, said: ?string}} entry
 * @param {Function} rng - 0 to 1
 * @param {number} [side] - 1 filling a love, -1 a hate
 * @param {object[]} [held] - the entries they hold already (loves and hates), not to be picked again
 * @returns {{card: string, said: string, words: string[], effects: Array<[string, number]>, limits: object[], failed: boolean}} (effects: what the filled words do to them; failed: nothing would fill it)
 */
// A trait effect the other way round: added amounts negated, multipliers inverted (×0 — none of it — to as much as it
// goes: its max; any other kept to its range when the traits are combined); a switch can't be switched off, so none.
// Crazy and normal are each other's reverse, on one scale: normal = NORMAL_MAX^crazy (crazy 1 ↔ normal ×20, 0.5 ↔ ×4.5).
function reversed(trait, value) {
  const normalMax = TRAITS.normal?.max ?? 20;
  if (trait === 'crazy' && TRAITS.normal) return value > 0 ? ['normal', Math.pow(normalMax, value)] : null;
  if (trait === 'normal' && TRAITS.crazy) return value > 1 ? ['crazy', Math.log(value)/Math.log(normalMax)] : null;
  const { combine, base, max } = TRAITS[trait];
  if (combine === 'add') return [trait, -value];
  if (combine === 'on') return null;
  return [trait, value ? 1/value : max/(base || 1)];
}
function fillEntry(entry, rng, side = 1, held = []) {
  const said = entry.said ?? lowerFirst(entry.text);
  if (!HAS_PLACEHOLDER.test(entry.text) && !HAS_PLACEHOLDER.test(said)) return { card: entry.text, said, words: [], effects: [], limits: [] };
  random = rng;
  try {
    // (never a word they already hold, either way: nobody loves and hates slow walkers — held, from profileOf)
    const vars = {}, record = {}, avoid = held.map(e => e.said ?? e.text);
    const filled = fill(entry.text, null, vars, 0, { record }, avoid), card = filled ?? entry.text;
    const spoken = fill(said, null, vars, 0, { reuse: record }, avoid) ?? card;
    const picked = [...new Set([...Object.values(record).flat(), ...Object.entries(vars).filter(([key]) => key !== '$last').map(([, item]) => item)])].filter(Boolean);
    const words = picked.map(item => item.forms ? item.forms.first : item.text);
    // (what the words bring: a speech word its {effect.…} traits, as written; a love or hate — "Conversely, [hates]" —
    // its own {traits}, turned round if it's from the other list, bar any that persist; its limits likewise)
    const effects = picked.flatMap(item => {
      if (!item.side) return item.effects ?? [];
      const across = item.side !== side;
      // (noflip / noflip = trait: dropped altogether rather than turned round)
      return (item.personTraits ?? []).map(([trait, value]) => !across ? [trait, value] : inert(item, trait) ? null : persists(item, trait) ? [trait, value] : reversed(trait, value));
    }).filter(Boolean);
    const limits = picked.flatMap(item => (item.side && item.side !== side ? (item.limits ?? []).map(l => ({ ...l, polarity: l.polarity === 'a' ? 'b' : 'a' })) : item.side ? item.limits ?? [] : []));
    return { card, said: entry.said ? spoken : lowerFirst(spoken), words, effects, limits, failed: filled == null };
  } finally { random = Math.random; }
}

// (the first letter, and the first after a sentence's end — . ! ? — wherever it came from, a picked word included; not
// after an ellipsis, which carries the sentence on)
const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1)
  .replace(/([.!?]+)(\s+)([a-z])/g, (all, marks, space, letter) => /^\.{2,}$/.test(marks) ? all : marks + space + letter.toUpperCase());

// A line picked from these items and filled in, with the replies it can get: { text, replies, vars } or null.
function sayFrom(items, person, vars = {}, tried = new Set()) {
  for (let i = 0; i < TRIES; i++) {
    const item = pickItem(items.filter(it => !tried.has(it)), person, { vars });
    if (!item) return null;
    tried.add(item);
    const held = { ...vars, $last: null };
    const text = item.forms ? item.forms.first : fill(item.text, person, held);
    if (text) return { text: capitalise(text), replies: item.replies ? compileNodes(item.replies, 0, [], item.where) : [], vars: held, end: item.end, thought: item.thought, score: item.score ?? 0 };
  }
  return null;
}

/**
 * Up to `max` different replies someone could give (Options > Game > Dialogue Choices), each as pickReply's.
 * @param {object[]} replies
 * @param {object} person
 * @param {object} vars
 * @param {?object} [other]
 * @param {number} [max]
 * @returns {object[]}
 */
export function pickReplyChoices(replies, person, vars, other = null, max = 4) {
  if (!ready || !replies.length) return [];
  speakingTo = other;
  const tried = new Set(), out = [];
  while (out.length < max) {
    const said = sayFrom(replies, person, vars, tried);
    if (!said) break;
    if (!out.some(o => o.text === said.text)) out.push(said);
  }
  return out;
}

/**
 * A line to open a conversation with, from dialogue.txt, for this speaker.
 * @param {object} person - the speaker (traits, loves, hates)
 * @param {?object} [other] - who they're talking to, for other. tags
 * @returns {?{text: string, replies: object[], vars: object}}
 */
export const pickCall = (person, other = null) => ready ? (speakingTo = other, sayFrom(categoryItems('dialogue'), person)) : null;

/**
 * A reply to the line just said, picked for whoever's replying.
 * @param {object[]} replies - as the line before it came with
 * @param {object} person - the replier
 * @param {object} vars - the conversation's #n picks, carried on
 * @param {?object} [other] - who said the line being replied to, for other. tags
 * @returns {?{text: string, replies: object[], vars: object}}
 */
export const pickReply = (replies, person, vars, other = null) => ready && replies.length ? (speakingTo = other, sayFrom(replies, person, vars)) : null;

/**
 * A thought, from thoughts.txt, for someone on their own.
 * @param {object} person
 * @returns {?{text: string}}
 */
export const pickThought = person => ready ? (speakingTo = null, sayFrom(categoryItems('thoughts'), person)) : null;

/**
 * Something to say (or think) about what they've just seen or felt (reactions.txt, whose lines are limited by {seen} and
 * {felt}), once each: null if they've already reacted, or nothing's happened lately.
 * @param {object} person
 * @param {?object} [other] - who they're with, if anyone, for other. tags
 * @returns {?{text: string, replies: object[], vars: object}}
 */
export function pickReaction(person, other = null) {
  const now = performance.now()/1000;
  const news = [feltFresh(person), seenFresh(person)].filter(m => m && !m.reacted && !(m.after > now)); // (after: see notice in people.js)
  news.forEach(m => { if (now - (m.after ?? m.at) > REACTION_KEEP) m.reacted = true; });
  if (!ready || !news.some(m => !m.reacted) || now - lastReaction < REACTION_GAP) return null;
  lastReaction = now;
  news.forEach(m => { m.reacted = true; });
  speakingTo = other;
  return sayFrom(categoryItems('reactions'), person);
}

/**
 * A line to close a conversation whose time's up (closers.txt — tag them {end}, or {end = bad} for rude ones).
 * @param {object} person
 * @param {?object} [other] - who they're talking to, for other. tags
 * @returns {?{text: string, replies: object[], vars: object, end: ?string}}
 */
export const pickCloser = (person, other = null) => ready ? (speakingTo = other, sayFrom(categoryItems('closers'), person)) : null;

/**
 * A line to call out on its own, outside any conversation, from the named category (fleeing.txt, as someone runs).
 * @param {object} person
 * @param {string} category
 * @returns {?{text: string, replies: object[], vars: object, end: ?string}}
 */
/**
 * A line greeting someone who's just joined (greetings.txt), `other` being them.
 * @param {object} person
 * @param {object} other - who's joined
 * @returns {?{text: string, replies: object[], vars: object, end: ?string}}
 */
export const pickGreeting = (person, other) => ready ? (speakingTo = other, sayFrom(categoryItems('greetings'), person)) : null;

export const pickShout = (person, category) => ready ? (speakingTo = null, sayFrom(categoryItems(category), person)) : null;

/**
 * A word or phrase from a category, for naming something that isn't a person — an office tower's company, from
 * [corpTitle] and [corpType] (see officeName in buildings/building-types.js). The entry's first form, its
 * [placeholders] filled in, and nobody's traits leaning the pick: every pick, placeholders included, comes from `rng`,
 * so one seed always names the same thing the same. Null while the files are still loading, or if the category has
 * nothing whose placeholders can be filled (an entry naming an empty category, say).
 * @param {string} category - As a line writes it: [corpTitle] and "corpTitle.txt" both mean the category `corptitle`.
 * @param {Function} rng - 0 to 1
 * @returns {?string}
 */
export function pickWord(category, rng) {
  if (!ready) return null;
  // (categories are keyed by their file's name made small — see loadAll and nameOf — so the name is taken as it's
  // written anywhere else, [corpTitle]'s capitals and all)
  const name = String(category).toLowerCase();
  const was = random, wasTo = speakingTo; // (put back afterwards: this isn't a line, and nobody's saying it)
  random = rng; speakingTo = null;
  try {
    const tried = new Set();
    for (let i = 0; i < TRIES; i++) {
      const item = pickItem(categoryItems(name).filter(it => !tried.has(it)), null);
      if (!item) return null;
      tried.add(item);
      const said = item.forms ? item.forms.first : fill(item.text, null, {});
      if (said) return said;
    }
    return null;
  } finally { random = was; speakingTo = wasTo; }
}

/**
 * Whether someone has something they've just seen or felt still to react to (see pickReaction).
 * @param {object} person
 * @returns {boolean}
 */
export function hasNews(person) {
  const now = performance.now()/1000;
  return [feltFresh(person), seenFresh(person)].some(m => m && !m.reacted && !(m.after > now));
}
