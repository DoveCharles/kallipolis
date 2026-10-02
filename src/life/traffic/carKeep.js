import { cars } from './state.js';
import { carMeshes, designNumbers } from './models.js';
import { carPlate, platePacked } from './materials.js';
import { isFavorite } from '../../ui/favorites.js';
import { carTypeOf, pinCarType } from '../car-types.js';

// ============================================================ the traffic kept between sessions
// Every car on the roads, in order, saved as { v, cars: [{ design, number, paint, width, height, kept? }], numbers }: its
// design by name, its number within it (so its card and plate come back the same), and its paint. Destroyed cars aren't in
// it, so they never come back; `numbers` keeps each design's count, so new cars never reuse a number. Cars thinned off the
// roads wait at the front to come back first. The hearted also carry `kept`: their card and plate as they were, so
// cars.txt updates don't change them. Saved with the crowd (project/autosave.js, and `traffic` in project files).

let waiting = []; // saved cars not yet back on the roads, in order
let reset = false; // a saved traffic's come in: clear the current one first
let savedNumbers = {}; // design name → how many numbers it had given out
const pinnedPlates = new Map(); // 'design#number' → plate text

export const carKeyOf = (design, number) => `car:${design}#${number}`;
/** The key a car's favorite goes by: its design and number, which is who it is — or the car itself before it has a design. */
export const carKey = car => car.design != null ? carKeyOf(carMeshes[car.design].name, car.number) : car;
/** The car with this design and number on the roads, or null. */
export const carNamed = (design, number) => cars.find(car => car.design != null && car.number === number && carMeshes[car.design].name === design) ?? null;

const round = v => Math.round(v*1e4)/1e4;
function entryOf(car) {
  const design = car.design != null ? carMeshes[car.design].name : car.keptDesign ?? null;
  const number = car.design != null ? car.number : car.keptNumber ?? null;
  const entry = { design, number, paint: car.paint.map(round), width: round(car.width), height: round(car.height) };
  if (car.design != null && isFavorite(carKeyOf(design, number))) {
    const { traits, baseTraits, ...type } = carTypeOf(design, number);
    entry.kept = { type: { ...type, traits, baseTraits }, plate: car.plate?.text ?? null };
  } else if (car.keptPin) entry.kept = car.keptPin; // (hearted, still waiting for its design: as it came in)
  return entry;
}

export function serializeCars() {
  const numbers = { ...savedNumbers };
  carMeshes.forEach((cm, d) => { numbers[cm.name] = Math.max(numbers[cm.name] || 0, designNumbers[d] || 0); });
  return { v: 1, cars: [...cars.map(entryOf), ...waiting], numbers };
}

/** Put back saved traffic (null: leave the current one). */
export function restoreCars(data) {
  if (!data || !Array.isArray(data.cars)) return;
  const ok = c => c && typeof c === 'object' && (c.design == null || typeof c.design === 'string');
  waiting = data.cars.filter(ok);
  waiting.sort((a, b) => !!b.kept - !!a.kept); // (the hearted first, so they're always on the roads)
  savedNumbers = data.numbers && typeof data.numbers === 'object' ? { ...data.numbers } : {};
  waiting.forEach(c => {
    if (!c.kept || c.design == null || !Number.isInteger(c.number)) return;
    if (c.kept.type) pinCarType(c.design, c.number, c.kept.type);
    if (c.kept.plate) pinnedPlates.set(c.design + '#' + c.number, c.kept.plate);
  });
  reset = true;
}
/** Whether the current traffic should be cleared for saved traffic that's come in (once). */
export const takeCarReset = () => { const r = reset; reset = false; return r; };

/** Give a new car the next saved car's design, number and paint, if there is one. */
export function keptCar(car) {
  const c = waiting.shift();
  if (!c) return car;
  if (Array.isArray(c.paint) && c.paint.length === 3 && c.paint.every(Number.isFinite)) car.paint = c.paint;
  if (Number.isFinite(c.width)) car.width = c.width;
  if (Number.isFinite(c.height)) car.height = c.height;
  car.keptDesign = c.design; car.keptNumber = c.number; car.keptPin = c.kept;
  return car;
}
/** Cars thinned off the roads: back to the front of the queue, to come back first. */
export function benchCars(list) { waiting.unshift(...list.map(entryOf)); }

/** A design for a car without one: its saved one where that design's still there, else `roll`'s. */
export function giveDesign(car, roll) {
  const was = car.keptDesign != null ? carMeshes.findIndex(cm => cm.name === car.keptDesign) : -1;
  car.design = was >= 0 ? was : Math.floor(roll*carMeshes.length);
  const name = carMeshes[car.design].name;
  designNumbers[car.design] = Math.max(designNumbers[car.design], savedNumbers[name] || 0);
  car.number = was >= 0 && Number.isInteger(car.keptNumber) && car.keptNumber > 0 ? car.keptNumber : ++designNumbers[car.design];
  designNumbers[car.design] = Math.max(designNumbers[car.design], car.number);
  car.length = carMeshes[car.design].length;
  const plate = was >= 0 ? pinnedPlates.get(name + '#' + car.number) : null;
  car.plate = plate ? { text: plate, packed: platePacked(plate) } : carPlate(car);
  car.keptDesign = car.keptNumber = car.keptPin = undefined;
}
