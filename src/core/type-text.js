// ============================================================ what a kind of thing is like
// The reader for the files saying what each kind of thing is like on its card (see ui/entity-card.js): assets/cars.txt by
// vehicle type, assets/buildings.txt by kind of building, assets/trains.txt by carriage. They're all one format, so
// they're all read here: a [section] per kind, with `attribute = value` lines under it, any of which can be given several
// times to have each thing of that kind pick one. A kind falls back along a chain — itself, then whatever `fallbacks`
// says it belongs to, then [default] — so a section need only say what it does differently.
//
// `attributes` are the row keys the file fills in (see TEXT_ROWS), `settings` any lines that aren't card text (buildings'
// `enterable`), and `placeholder` what to use until the file has loaded, or if it can't be.
export function loadTypeText(url, { attributes, settings = [], fallbacks = {}, placeholder = {} }) {
  const file = url.split('/').pop();
  const known = attributes.concat(settings);
  let types = placeholder;

  function parse(text) {
    const parsed = {};
    let current = null;
    text.split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const heading = line.match(/^\[([^[\]]+)\]$/);
      if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = parsed[current] || {}; return; }
      const pair = line.match(/^([^=]+?)\s*=\s*(.+)$/);
      const key = pair && pair[1].toLowerCase();
      if (!current || !known.includes(key)) {
        console.warn(`Blockout: in ${file}, "${line}" isn't an "attribute = value" line (${known.join(', ')}) under a [section]`);
        return;
      }
      (parsed[current][key] = parsed[current][key] || []).push(pair[2]);
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
    return [types[key], types[fallbacks[key]], types.default].filter(Boolean);
  }
  return {
    // What a thing's card says: `kind` is what it is, and `number` its own number among others of its kind, which decides
    // which it gets of an attribute given several times. A kind nothing names falls back to being called by its own name.
    of(kind, number = 1) {
      const chain = chainFor(kind);
      const pick = attribute => {
        const values = chain.map(t => t[attribute]).find(v => v && v.length)
          || (attribute === 'name' && kind ? [kind] : ['']);
        return values[(number - 1) % values.length];
      };
      return Object.fromEntries(attributes.map(attribute => [attribute, pick(attribute)]));
    },
    // A yes/no setting (see `settings`): whether the nearest thing in the chain that says anything says yes. Nothing
    // said is no, so a setting only turns on where it's been thought about.
    says(kind, setting) {
      const said = chainFor(kind).map(t => t[setting]).find(v => v && v.length);
      return !!said && /^(yes|true|on|1)$/i.test(said[said.length - 1].trim());
    },
  };
}
