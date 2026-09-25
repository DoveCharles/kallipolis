import { S } from '../core/shared.js';
import { TRAITS } from '../core/traits.js';
import { moralityLevel } from '../ui/morality.js';
import { roomLayoutOf } from '../buildings/footprints.js';
import { tessellateClosedPath } from '../core/splines.js';
import { peopleNav } from './people/people.js';

// ============================================================ what people say
// The categories in assets/text/speech/ and people/ (the format's in speech/about.txt): each file is one category, named
// by its file wherever it sits (found through assets/text/index.txt). Loading starts from dialogue.txt, thoughts.txt
// and reactions.txt and fetches every category they name, and every one those name, and so on. A
// category is compiled once into a flat list (includes followed MAX_DEPTH deep, loops skipped, doubles merged); picks
// lean toward entries whose {tags} fit the speaker's traits and the world, and a speaker's own loves (or hates, in a
// [x: hated] call) are picked half the time.
const TEXT_DIR = 'assets/text/';
const INDEX_URL = TEXT_DIR + 'index.txt'; // every .txt under assets/text/, one path a line (kept up to date by serve.py)
// the folders whose files are categories, at any depth, named by file (so a file can move between subfolders freely);
// people/'s lists (boynames, surnames...) come too, their [trait] brackets dropped, and about.txt files never do
const CATEGORY_DIRS = ['speech/', 'people/'];
const ROOTS = ['dialogue', 'thoughts', 'reactions', 'closers'];
const MAX_DEPTH = 8;         // how deep includes (and placeholders within placeholders) are followed
const LEAN = 2;              // how hard a tag leans: × (1 + LEAN × tag × trait), trait measured -1 to +1 from its neutral
const MIN_LEAN = 0.05;       // the least a leaning can bring an entry's weight down to (× its weight)
const LOVED_CHANCE = 0.5;    // the chance of picking from the speaker's loves (hates, in a hated call) when any are there
const TRIES = 6;             // lines tried before giving up, when placeholders can't be filled
export const SEEN_TIME = 60; // seconds someone remembers what they saw or felt, for {seen} and {felt} (p.seen / p.felt: see witness, notice and feel in people/people.js)
const DEATHS = ['killedbycar', 'beatentodeath', 'smited', 'drowned', 'exploded'];
const SIGHTS = [...DEATHS, 'death', 'punch', 'knockedbycar', 'resurrected', 'waterwalking', 'smelly']; // ('death': any of DEATHS)
const FEELINGS = ['punched', 'hitbycar', 'revenge', 'watchedtv'];
const PLACES = ['park', 'plaza', 'beach', 'roadside', 'path', 'bridge', 'crossing']; // (here.<place>: see placeOf)
// here.<zone>: standing in a zone of that type (zoneOf); city is the 'buildings' zone
const ZONES = { plain: 'plain', park: 'park', water: 'water', beach: 'beach', farmland: 'farmland', suburbs: 'suburbs',
  town: 'town', plaza: 'plaza', city: 'buildings', buildings: 'buildings', industrial: 'industrial', airport: 'airport' };
const NAMED = /^(me|other|seen|felt)\.(name|by)$/; // [me.name], [other.name], [seen.name], [seen.by], [felt.by]
const WEATHERS = { rain: () => S.weatherRain > 0.05, snow: () => S.weatherSnow > 0.05, cloud: () => S.weatherClouds > 0.05,
  clear: () => !(S.weatherRain > 0.05 || S.weatherSnow > 0.05 || S.weatherClouds > 0.05) };

const files = {};            // category → parsed file ({ forms, nodes }), or null if it failed to load
const pathOf = {};           // category → its path under assets/text/, from the index
let speakingTo = null;       // who the speaker's talking to, for other. tags (set by each pick)
const compiled = {};         // category → its flat list of items
let ready = false;
const warned = new Set();
const warnOnce = message => { if (!warned.has(message)) { warned.add(message); console.warn(`Kallipolis: ${message}`); } };

// ---------------------------------------------------------- reading the files
const PLACEHOLDER = /\[([^\]]+)\]/g, HAS_PLACEHOLDER = /\[[^\]]+\]/;
const nameOf = inner => inner.split(':')[0].split('#')[0].trim().toLowerCase();

// A tag list, {weight = 2, evil, patience = -1, world.hour 22-5, world.morality < -0.3, world.weather = rain}.
function parseTags(text, where) {
  const tags = { weight: 1, traits: {}, world: [], end: null };
  text.split(',').map(part => part.trim()).filter(Boolean).forEach(part => {
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
    else if ((m = part.match(/^(other\.)?([a-z]+)\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i)) && TRAITS[m[2].toLowerCase()])
      tags.world.push({ kind: 'trait', other: !!m[1], trait: m[2].toLowerCase(), op: m[3], value: +m[4] });
    else if ((m = part.match(/^other\.([a-z]+)\s*(?:=\s*(-?\d+(?:\.\d+)?))?$/i)) && TRAITS[m[1].toLowerCase()])
      tags.world.push({ kind: 'otherLean', trait: m[1].toLowerCase(), value: m[2] == null ? 1 : +m[2] });
    else if ((m = part.match(/^end(?:\s*=\s*(good|bad))?$/i))) tags.end = (m[1] ?? 'good').toLowerCase();
    else if ((m = part.match(/^weight\s*=\s*(\d+(?:\.\d+)?)$/i))) tags.weight = +m[1];
    else if ((m = part.match(/^([a-z]+)\s*(?:=\s*(-?\d+(?:\.\d+)?))?$/i)) && TRAITS[m[1].toLowerCase()]) tags.traits[m[1].toLowerCase()] = m[2] == null ? 1 : +m[2];
    else warnOnce(`in ${where}, "{${part}}" isn't a tag this reads (see speech/about.txt)`);
  });
  return tags;
}

// One file: `forms:` names, then its lines as a tree — each `>` deeper is a reply to the line above it one level up.
function parseFile(name, text, path = `speech/${name}.txt`) {
  const file = { forms: null, nodes: [] }, where = path, stack = [], plainList = path.startsWith('people/');
  text.split(/\r?\n/).forEach(raw => {
    let line = raw.trim();
    if (plainList) line = line.replace(/\[[^\]]*\]/g, '').trim(); // (people's lists: their [traits] aren't placeholders)
    if (!line || line.startsWith('#')) return;
    const formsLine = line.match(/^forms\s*:\s*(.+)$/i);
    if (formsLine && !file.forms && !file.nodes.length) { file.forms = formsLine[1].split('|').map(f => f.trim().toLowerCase()); return; }
    const depth = line.match(/^>*/)[0].length;
    line = line.slice(depth).trim();
    let tags = parseTags('', where);
    const tagged = line.match(/\{([^{}]*)\}\s*$/);
    if (tagged) { tags = parseTags(tagged[1], where); line = line.slice(0, tagged.index).trim(); }
    const include = line.match(/^\[([^\]:#]+)\]$/);
    const node = { tags, replies: [], where };
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
// the singular); "-" means it has none.
function wordForms(given, names) {
  const forms = {};
  names.forEach((name, i) => { if (given[i] && given[i] !== '-') forms[name] = given[i]; else if (given[i] === '-') forms[name] = null; });
  if (names.includes('plural') && forms.plural === undefined && forms.singular) forms.plural = pluralOf(forms.singular);
  if (names.includes('general') && !forms.general) forms.general = forms.plural || forms.singular;
  Object.keys(forms).forEach(key => { if (forms[key] == null) delete forms[key]; });
  forms.first = given[0];
  return forms;
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
  let wanted = ROOTS.slice();
  while (wanted.length) {
    const paths = wanted.map(name => pathOf[name] ?? `speech/${name}.txt`);
    const texts = await Promise.all(paths.map((path, i) => fetch(TEXT_DIR + path)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); })
      .catch(() => { warnOnce(`${path} failed to load; [${wanted[i]}] is left empty`); return null; })));
    const next = new Set();
    wanted.forEach((name, i) => {
      files[name] = texts[i] == null ? null : parseFile(name, texts[i], paths[i]);
      if (files[name]) walk(files[name].nodes, node => {
        if (node.include) next.add(node.include);
        if (node.text) for (const m of node.text.matchAll(PLACEHOLDER)) if (!NAMED.test(nameOf(m[1]))) next.add(nameOf(m[1]));
      });
    });
    wanted = [...next].filter(name => !(name in files));
  }
  ready = true;
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
        ...inner, weight: inner.weight*node.tags.weight, end: node.tags.end ?? inner.end,
        traits: addTraits(inner.traits, node.tags.traits), world: inner.world.concat(node.tags.world),
      }));
      return;
    }
    const key = (node.forms ? node.forms.first : node.text).toLowerCase().trim();
    add({ key, forms: node.forms, text: node.text, replies: node.replies, weight: node.tags.weight, end: node.tags.end,
      traits: { ...node.tags.traits }, world: node.tags.world.slice(), where: node.where });
  });
  return [...items.values()];
}
const addTraits = (a, b) => { const out = { ...a }; Object.entries(b).forEach(([k, v]) => { out[k] = (out[k] ?? 0) + v; }); return out; };

function categoryItems(name, depth = 0, path = []) {
  if (compiled[name]) return compiled[name];
  const file = files[name];
  if (file === undefined) { warnOnce(`[${name}] isn't a category (no ${name}.txt in speech/ or people/)`); return []; }
  const items = file ? compileNodes(file.nodes, depth, path.concat(name), pathOf[name] ?? `speech/${name}.txt`) : [];
  if (!path.length || items.length) compiled[name] = items; // (a partial list, cut short by a loop, isn't kept)
  return items;
}

// ---------------------------------------------------------- picking
// A trait's value from -1 (its min) through 0 (its neutral) to +1 (its max); traits that multiply are measured by ratio.
function traitLevel(trait, value) {
  const { base, min, max, combine } = TRAITS[trait];
  if (value == null) return 0;
  if (value >= base) {
    if (max <= base) return 0;
    return Math.min(1, combine ? (value - base)/(max - base) : Math.log(value/base)/Math.log(max/base));
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
  if (person.mode === 'line') { const line = peopleNav?.lines?.[person.li]; return !line ? null : line.ring ? 'roadside' : line.raised ? 'bridge' : 'path'; }
  return null;
}

// the type of the zone someone's standing in (the last drawn, where zones overlap), else null; outlines cached per zone
const outlines = new WeakMap();
function zoneOf(person) {
  let found = null;
  (S.zones || []).forEach(zone => {
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
  if (w.kind === 'place') return placeOf(person) === w.is || (!!ZONES[w.is] && !buildingOf(person) && zoneOf(person) === ZONES[w.is]);
  if (w.kind === 'indoors') return !!buildingOf(person) === w.is;
  if (w.kind === 'building') { const b = buildingOf(person); return !!b && (b.kind === w.is || roomLayoutOf(b.kind, b.number) === w.is); }
  if (w.kind === 'trait') {
    const who = w.other ? speakingTo : person;
    if (!who?.traits) return false;
    const level = traitLevel(w.trait, who.traits[w.trait]);
    return w.op === '<' ? level < w.value : w.op === '>' ? level > w.value : w.op === '<=' ? level <= w.value : level >= w.value;
  }
  if (w.kind === 'seen') { const seen = seenFresh(person); return !!seen && (!w.what || seen.what === w.what || (w.what === 'death' && DEATHS.includes(seen.what))); }
  if (w.kind === 'felt') { const felt = feltFresh(person); return !!felt && (!w.what || felt.what === w.what); }
  if (w.kind === 'hour') { const h = S.timeOfDay ?? 12; return w.from <= w.to ? h >= w.from && h < w.to + 1 : h >= w.from || h < w.to + 1; }
  if (w.kind === 'weather') return WEATHERS[w.is]();
  if (w.kind === 'morality') { const m = moralityLevel(); return w.op === '<' ? m < w.value : w.op === '>' ? m > w.value : w.op === '<=' ? m <= w.value : m >= w.value; }
  return true;
});

function weightOf(item, person, hated) {
  const flip = hated ? -1 : 1;
  let weight = item.weight;
  Object.entries(item.traits).forEach(([trait, tag]) => {
    weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*tag*traitLevel(trait, person?.traits?.[trait]));
  });
  item.world.forEach(w => {
    if (w.kind === 'moralityLean') weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*w.value*moralityLevel());
    if (w.kind === 'otherLean') weight *= Math.max(MIN_LEAN, 1 + LEAN*flip*w.value*traitLevel(w.trait, speakingTo?.traits?.[w.trait]));
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
  let r = Math.random()*total;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
}

// An entry from a list of items for this speaker: world limits kept to, the form asked for (if any) there, never one
// they hate (love, in a hated call), and half the time one they love (hate) if any are there.
function pickItem(items, person, { form = null, hated = false } = {}) {
  const liked = hated ? person?.hates : person?.loves, disliked = hated ? person?.loves : person?.hates;
  const open = items.filter(item => worldAllows(item.world, person) && (!form || !item.forms || item.forms[form]) && !matches(item, disliked));
  const favourites = open.filter(item => matches(item, liked));
  const from = favourites.length && Math.random() < LOVED_CHANCE ? favourites : open;
  return weightedPick(from, item => weightOf(item, person, hated));
}

// ---------------------------------------------------------- saying
// A person's name for [me.name], [other.name], [seen.name] (who it happened to), [seen.by] (who did it), [felt.by]
// (who did it to the speaker; for revenge, who they got back at) — null if there's nobody.
function nameIn(key, person) {
  const [whose, part] = key.split('.');
  const who = whose === 'me' ? person : whose === 'other' ? speakingTo
    : whose === 'seen' ? (part === 'by' ? seenFresh(person)?.by : seenFresh(person)?.who) : feltFresh(person)?.by;
  return who?.name ?? null;
}
// A line's text with its [placeholders] filled; `vars` holds #n picks for the whole conversation. Null if one can't be.
function fill(text, person, vars, depth = 0) {
  let failed = false;
  const out = text.replace(PLACEHOLDER, (_, inner) => {
    if (failed) return '';
    const [head, ...rest] = inner.split(':');
    const [rawName, tag] = head.split('#').map(s => s.trim());
    const name = rawName.toLowerCase(), options = rest.join(':').split(',').map(o => o.trim().toLowerCase()).filter(Boolean);
    if (NAMED.test(name)) { const said = nameIn(name, person); if (!said) failed = true; return said ?? ''; }
    const hated = options.includes('hated'), article = options.includes('a');
    const form = options.find(o => o !== 'hated' && o !== 'a') || null;
    const held = tag ? vars[`${name}#${tag}`] : null;
    const item = held || pickItem(categoryItems(name), person, { form, hated });
    if (!item) { failed = true; return ''; }
    if (tag) vars[`${name}#${tag}`] = item;
    let said = item.forms ? (form && item.forms[form]) || item.forms.first : item.text;
    if (!item.forms && depth < MAX_DEPTH) said = fill(said, person, vars, depth + 1);
    if (said == null) { failed = true; return ''; }
    return article ? `${/^[aeiou]/i.test(said) ? 'an' : 'a'} ${said}` : said;
  });
  return failed ? null : out.replace(/\s+/g, ' ').trim();
}
// (the first letter, and the first after a sentence's end — . ! ? — wherever it came from, a picked word included)
const capitalise = text => text.replace(/(^|[.!?]+\s+)([a-z])/g, (_, before, letter) => before + letter.toUpperCase());

// A line picked from these items and filled in, with the replies it can get: { text, replies, vars } or null.
function sayFrom(items, person, vars = {}) {
  const tried = new Set();
  for (let i = 0; i < TRIES; i++) {
    const item = pickItem(items.filter(it => !tried.has(it)), person);
    if (!item) return null;
    tried.add(item);
    const held = { ...vars };
    const text = item.forms ? item.forms.first : fill(item.text, person, held);
    if (text) return { text: capitalise(text), replies: item.replies ? compileNodes(item.replies, 0, [], item.where) : [], vars: held, end: item.end };
  }
  return null;
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
  if (!ready || !news.length) return null;
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
