import { S } from '../../core/shared.js';

// Drunk AI cars weave about their lane: pushed sideways DRUNK_WIDTH × s³, where s is the average of three sines of the
// distance driven, with wavelengths that never line up. Cubed, it's mostly a gentle wander a fraction of DRUNK_WIDTH;
// only when all three peak together does it lurch the full width, over the kerb. The car's turned along the weave.
// Applied off its route with any other offset by offroute.js. It hits what it weaves into: anyone it reaches, pavement
// or not (runOverPeople), and cars and walls (swayCrash in collisions.js), which knock it back to find its lane again.
const DRUNK_WIDTH = 3.5*0.65, WAVELENGTHS = [40, 67, 109]; // (at people size 1)
const wave = (car, u) => (WAVELENGTHS.reduce((sum, length, k) => sum + Math.sin(2*Math.PI*u/length + car.swayPhase[k]), 0)/WAVELENGTHS.length)**3;

/**
 * A drunk car's weave this frame, by how far it's driven.
 * @param {object} car - an AI car
 * @param {number} dt
 * @returns {?{off: number, turn: number}} how far right of its route it is, and how far it's turned right; null if sober
 */
export function weave(car, dt) {
  if (!car.traits?.drunk) return null;
  car.swayPhase ??= WAVELENGTHS.map(() => Math.random()*Math.PI*2);
  car.swayDist = (car.swayDist ?? 0) + Math.abs(car.speed)*dt/S.peopleSize;
  const width = DRUNK_WIDTH*S.peopleSize, off = width*wave(car, car.swayDist), next = width*wave(car, car.swayDist + 1);
  return { off, turn: Math.atan((next - off)/S.peopleSize) };
}
