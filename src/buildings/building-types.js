import { loadTypeText } from '../core/type-text.js';
import { TEXT_ROWS } from '../ui/entity-card.js';

// ============================================================ what buildings are like
// Each kind of building's name, mood, and what it loves and hates, for its card (building-card.js) — from
// assets/buildings.txt, to be edited freely: a [section] per kind. The file is read by the shared reader in
// core/type-text.js, which the vehicles and the trains use too; see there for the format.
// what every kind of building falls back to: the zone type that puts it up (see buildingKindOf below)
const ZONE_OF_KIND = {
  landmark: 'buildings',
  warehouse: 'industrial', factory: 'industrial', tankfarm: 'industrial', containeryard: 'industrial',
  farmstead: 'farmland',
  house: 'suburbs',
  terminal: 'airport', hangar: 'airport', controltower: 'airport',
};
const buildings = loadTypeText('assets/buildings.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per building, like people: see [distribution] in buildings.txt
  settings: ['enterable'], // not card text: whether people go into one (see "going indoors" in people.js)
  fallbacks: ZONE_OF_KIND,
  // this stands in until buildings.txt has loaded, or if it can't be
  placeholder: { default: { name: ['Building'], mood: ['🏢'], loves: ['Having people inside them'], hates: ['Strong winds'] } },
});

// What kind a building is: whatever put it up said so (see the zone types in zones/), or else its zone's own type.
export function buildingKindOf(group, zone) {
  return (group && group.userData.buildingKind) || (zone && zone.zoneType) || 'buildings';
}
// Whether people go into buildings of this kind (see "going indoors" in people.js): `enterable = yes` in buildings.txt.
// Anything that doesn't say so stays shut, so a kind is only enterable if it's been thought about — which is the way
// round we want it: somewhere ambiguous (a container yard, say) shouldn't swallow people just because nobody said not to.
export const buildingEnterable = kind => buildings.says(kind, 'enterable');
// A building's card details: `kind` is what it is (see buildingKindOf) and `number` its own number (see buildingNumber
// in footprints.js).
export const buildingTypeOf = (kind, number = 1) => buildings.of(kind, number);
