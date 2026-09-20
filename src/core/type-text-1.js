import { mulberry32 } from './math.js';
import { entryOf, plainEntry, weighted, combineTraits, pickCounts, addEntries } from './entries.js';

// ============================================================ what a kind of thing is like
// The reader for the files saying what each kind of thing is like on its card (see ui/entity-card.js): assets/cars.txt by
// vehicle type, assets/buildings.txt by kind of building, assets/trains.txt by carriage. They're all one format, so
// they're all read here: a [section] per kind, with `attribute = value` lines under it, any of which can be given several
// times to have each thing of that kind pick one. A kind falls back along a chain — itself, then whatever `fallbacks`
// says it belongs to, then [default] — so a section need only say what it does differently.
// Attribute values are entries (see core/entries.js): they can carry [traits], `limit` rules and `choiceweight`.
//
// `attributes` are the row keys the file fills in (see TEXT_ROWS), `settings` any lines that aren't card text (buildings'
// `enterable`), and `placeholder` what to use until the file has loaded, or if it can't be. Any trait in core/traits.js
// can go on a value; `of` returns the combined traits of what a thing picked, as `traits`.
//
// `counted` lists attributes that can have several values at once (a car loving two things, say). Each is then returned
// as a list, and the file sets how many with rows of `a, b @ weight` (one number per counted attribute, in `counted`
// order; the weight is relative and defaults to 1). Rows go under a [distribution] section for every kind, or as
// `counts = a, b @ weight` lines in a kind's own section to override it: `1, 1 @ 6` and `2, 0 @ 1` make one in seven
// things love two and hate none. With no rows every counted attribute has one value. A thing can only have as many of an
// attribute as its kind lists.
export function loadTypeText(url, { attributes, settings = [], fallbacks = {}, placeholder = {}, counted = [] }) {
  const file = url.split('/').pop();
  const known = attributes.concat(settings, counted.length ? ['counts'] : []);
  let types = Object.fromEntries(Object.entries(placeholder).map(([kind, type]) => [
    kind, Object.fromEntries(Object.entries(type).map(([key, values]) => [key, attributes.includes(key) ? values.map(plainEntry) : values])),
  ]));

  // "1, 1 @ 6" as [1, 1, 6], or null if it isn't one number per counted attribute and an optional weight
  function parseCounts(value) {
    const match = value.match(/^([\d\s,]+?)\s*(?:@\s*(\d*\.?\d+))?$/);
    const numbers = match ? match[1].split(',').map(part => parseInt(part, 10)) : [];
    return numbers.length === counted.length && numbers.every(Number.isInteger) ? [...numbers, match[2] ? parseFloat(match[2]) : 1] : null;
  }
  const warnCounts = line => console.warn(`Blockout: in ${file}, "${line}" needs ${counted.length} whole numbers${counted.length > 1 ? ' separated by commas' : ''}, then optionally @ and a weight`);
  function parse(text) {
    const parsed = {};
    let current = null;
    text.split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const heading = line.match(/^\[([^[\]]+)\]$/);
      if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = parsed[current] || {}; return; }
      if (current === 'distribution' && counted.length) {
        const row = parseCounts(line);
        if (row) (parsed[current].counts = parsed[current].counts || []).push(row); else warnCounts(line);
        return;
      }
      const pair = line.match(/^([^=]+?)\s*=\s*(.+)$/);
      const key = pair && pair[1].toLowerCase();
      if (!current || !known.includes(key)) {
        console.warn(`Blockout: in ${file}, "${line}" isn't an "attribute = value" line (${known.join(', ')}) under a [section]`);
        return;
      }
      const values = parsed[current][key] = parsed[current][key] || [];
      if (attributes.includes(key)) values.push(...weighted(entryOf(pair[2], { file })));
      else if (key === 'counts') {
        const row = parseCounts(pair[2]);
        if (row) values.push(row); else warnCounts(line);
      } else values.push(pair[2]);
    });
    return parsed;
  }
  fetch(url)
    .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
    .then(text => { types = parse(text); })
    .catch(err => console.warn(`Blockout: ${url} failed to load; those get placeholder cards`, err));

  // what a kind falls back to, nearest first
  function chainFor(kind) {
    const key = (kind || '').toLowerCase();
    return [types[key], types[fallbacks[key]], types.default, types.distribution].filter(Boolean);
  }
  return {
    // What a thing's card says: `kind` is what it is, and `number` its own number among others of its kind, which decides
    // which it gets of an attribute given several times. A kind nothing names falls back to being called by its own name.
    // Counted attributes come back as lists of text, the rest as text; `traits` is the combined traits of what was picked.
    of(kind, number = 1) {
      const chain = chainFor(kind);
      const entriesFor = attribute => chain.map(t => t[attribute]).find(v => v && v.length);
      const firstFor = attribute => { const entries = entriesFor(attribute); return entries && entries[(number - 1) % entries.length]; };
      const picked = [], said = {};
      attributes.filter(attribute => !counted.includes(attribute)).forEach(attribute => {
        const entry = firstFor(attribute);
        said[attribute] = entry ? entry.text : attribute === 'name' && kind ? kind : '';
        if (entry) picked.push(entry);
      });
      if (counted.length) {
        const countRows = entriesFor('counts');
        const rng = mulberry32(number*104729 + 31);
        const counts = countRows ? pickCounts(countRows, rng()) : counted.map(() => 1);
        const chosen = counted.map((attribute, i) => (counts[i] >= 1 && firstFor(attribute)) ? [firstFor(attribute)] : []);
        counted.forEach((attribute, i) => { if (entriesFor(attribute)) addEntries(chosen[i], entriesFor(attribute), counts[i], rng, chosen); });
        counted.forEach((attribute, i) => { said[attribute] = chosen[i].map(entry => entry.text); picked.push(...chosen[i]); });
      }
      return { ...said, traits: combineTraits(picked) };
    },
    // A yes/no setting (see `settings`): whether the nearest thing in the chain that says anything says yes. Nothing
    // said is no, so a setting only turns on where it's been thought about.
    says(kind, setting) {
      const said = chainFor(kind).map(t => t[setting]).find(v => v && v.length);
      return !!said && /^(yes|true|on|1)$/i.test(said[said.length - 1].trim());
    },
  };
}
