// ============================================================ what buildings are like
// Each kind of building's name, mood, and what it loves and hates, for its card (building-card.js) — from
// assets/buildings.txt, to be edited freely: a [section] per kind, with `attribute = value` lines under it, any of which
// can be given several times to have each building pick one. A kind falls back to its zone's type ([industrial] for a
// warehouse, say), and then to [default], so a section need only say what it does differently.
const BUILDINGS_TEXT_URL = 'assets/buildings.txt';
const ATTRIBUTES = ['name', 'mood', 'loves', 'hates'];
const SETTINGS = ['enterable']; // not card text: whether people go into one (see "going indoors" in people.js)
// what every kind of building falls back to: the zone type that puts it up (see buildingKindOf below)
const ZONE_OF_KIND = {
  landmark: 'buildings',
  warehouse: 'industrial', factory: 'industrial', tankfarm: 'industrial', containeryard: 'industrial',
  farmstead: 'farmland',
};

// this stands in until buildings.txt has loaded, or if it can't be
let types = { default: { name: ['Building'], mood: ['🏢'], loves: ['Having people inside them'], hates: ['Strong winds'] } };

function parseBuildingsText(text) {
  const parsed = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[([^[\]]+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = parsed[current] || {}; return; }
    const pair = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    const key = pair && pair[1].toLowerCase();
    if (!current || !(ATTRIBUTES.includes(key) || SETTINGS.includes(key))) {
      console.warn(`Blockout: in buildings.txt, "${line}" isn't an "attribute = value" line (${ATTRIBUTES.concat(SETTINGS).join(', ')}) under a [building kind]`);
      return;
    }
    (parsed[current][key] = parsed[current][key] || []).push(pair[2]);
  });
  return parsed;
}
fetch(BUILDINGS_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => { types = parseBuildingsText(text); })
  .catch(err => console.warn('Blockout: assets/buildings.txt failed to load; buildings get placeholder cards', err));

// What kind a building is: whatever put it up said so (see the zone types in zones/), or else its zone's own type.
export function buildingKindOf(group, zone) {
  return (group && group.userData.buildingKind) || (zone && zone.zoneType) || 'buildings';
}
// what a kind falls back to, nearest first: itself, then its zone type, then [default]
function chainFor(kind) {
  const key = (kind || '').toLowerCase();
  return [types[key], types[ZONE_OF_KIND[key]], types.default].filter(Boolean);
}
// Whether people go into buildings of this kind (see "going indoors" in people.js): `enterable = yes` in buildings.txt.
// Anything that doesn't say so stays shut, so a kind is only enterable if it's been thought about — which is the way
// round we want it: somewhere ambiguous (a container yard, say) shouldn't swallow people just because nobody said not to.
export function buildingEnterable(kind) {
  const said = chainFor(kind).map(t => t.enterable).find(v => v && v.length);
  return !!said && /^(yes|true|on|1)$/i.test(said[said.length - 1].trim());
}
// A building's card details: `kind` is what it is (see buildingKindOf) and `number` its own number (see buildingNumber
// in footprints.js), which decides which it gets of an attribute with several values.
export function buildingTypeOf(kind, number = 1) {
  const chain = chainFor(kind);
  const pick = attribute => {
    const values = chain.map(t => t[attribute]).find(v => v && v.length) || [''];
    return values[(number - 1) % values.length];
  };
  return Object.fromEntries(ATTRIBUTES.map(attribute => [attribute, pick(attribute)]));
}
