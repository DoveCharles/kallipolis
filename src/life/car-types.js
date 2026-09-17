// ============================================================ what vehicles are like
// Each type of vehicle's name, mood, and what it loves and hates, for its card (car-card.js) — from assets/cars.txt, to be
// edited freely: a [section] per type (named as its model is in Cars.glb), with `attribute = value` lines under it, any
// of which can be given several times to have each vehicle pick one. A [default] section fills in whatever a type leaves
// out, and stands in for any type that isn't listed.
const CARS_TEXT_URL = 'assets/cars.txt';
const ATTRIBUTES = ['name', 'mood', 'loves', 'hates'];

// these stand in until cars.txt has loaded, or if it can't be
let types = {
  default: { name: ['Car'], mood: ['🚗'], loves: ['Beep beep'], hates: ['Honkkkk'] },
  ambulance: { mood: ['🚑'] }, bus: { mood: ['🚌'] }, canyonero: { mood: ['🚙'] }, taxi: { mood: ['🚕'] }, policecar: { mood: ['🚓'] },
  pickuptruck: { mood: ['🛻'] }, sportscar: { mood: ['🏎️'] }, truck: { mood: ['🚚'] }, van: { mood: ['🚐'] },
};

function parseCarsText(text) {
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
      console.warn(`Blockout: in cars.txt, "${line}" isn't an "attribute = value" line (${ATTRIBUTES.join(', ')}) under a [vehicle type]`);
      return;
    }
    (parsed[current][key] = parsed[current][key] || []).push(pair[2]);
  });
  return parsed;
}
fetch(CARS_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => { types = parseCarsText(text); })
  .catch(err => console.warn('Blockout: assets/cars.txt failed to load; vehicles get placeholder cards', err));

// A vehicle's card details: `design` is its model's name in Cars.glb (null for the plain box car) and `number` its own
// number among others of its type, which decides which it gets of an attribute with several values.
export function carTypeOf(design, number = 1) {
  const own = (design && types[design.toLowerCase()]) || {}, fallback = types.default || {};
  const pick = key => {
    const values = own[key] || fallback[key] || (key === 'name' && design ? [design] : ['']);
    return values[(number - 1) % values.length];
  };
  return Object.fromEntries(ATTRIBUTES.map(key => [key, pick(key)]));
}
