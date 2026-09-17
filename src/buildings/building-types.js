// ============================================================ what buildings are like
// Each kind of building's name, mood, and what it loves and hates, for its card (building-card.js) — from
// assets/buildings.txt, to be edited freely: a [section] per kind, with `attribute = value` lines under it, any of which
// can be given several times to have each building pick one. A kind falls back to its zone's type ([industrial] for a
// warehouse, say), and then to [default], so a section need only say what it does differently.
const BUILDINGS_TEXT_URL = 'assets/buildings.txt';
const ATTRIBUTES = ['name', 'mood', 'loves', 'hates'];
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
    if (!current || !ATTRIBUTES.includes(key)) {
      console.warn(`Blockout: in buildings.txt, "${line}" isn't an "attribute = value" line (${ATTRIBUTES.join(', ')}) under a [building kind]`);
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
// A building's card details: `kind` is what it is (see buildingKindOf) and `number` its own number (see buildingNumber
// in footprints.js), which decides which it gets of an attribute with several values.
export function buildingTypeOf(kind, number = 1) {
  const key = (kind || '').toLowerCase();
  const chain = [types[key], types[ZONE_OF_KIND[key]], types.default].filter(Boolean);
  const pick = attribute => {
    const values = chain.map(t => t[attribute]).find(v => v && v.length) || [''];
    return values[(number - 1) % values.length];
  };
  return Object.fromEntries(ATTRIBUTES.map(attribute => [attribute, pick(attribute)]));
}
