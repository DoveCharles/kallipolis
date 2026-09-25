import { S } from '../../core/shared.js';

// Drunk AI cars weave about their lane: pushed sideways DRUNK_WIDTH × s³, where s is the average of three sines of the
// distance driven, with wavelengths that never line up. Cubed, it's mostly a gentle wander a fraction of DRUNK_WIDTH;
// only when all three peak together does it lurch the full width, over the kerb. The car's turned along the weave.
// Applied off its route with any other offset by offroute.js. It hits what it weaves into: anyone it reaches, pavement
// or not (runOverPeople), and cars and walls (swayCrash in collisions.js), which knock it back to find its lane again.
const DRUNK_WIDTH = 3.5*0.65, WAVELENGTHS = [40, 67, 109]; // (at people size 1)
const wave = (car, u) => (WAVELENGTHS.reduce((sum, length, k) => sum + Math.sin(2*Math.PI*u/length + car.swayPhase[k]), 0)/WAVELENGTHS.length)**3;

const REDIRECT_TRIES = 30, REDIRECT_CLEAR = 30; // (random weaves tried; distance, at people size 1, the new one should keep off the side it hit)
/**
 * After a crash, give a drunk car a new weave that keeps off the side it hit (side: +1 right, -1 left of its route) for
 * REDIRECT_CLEAR ahead, or as nearly as REDIRECT_TRIES random ones manage — so it doesn't weave straight back into it.
 * @param {object} car
 * @param {number} side
 * @returns {void}
 */
export function redirectWeave(car, side) {
  if (!car.swayPhase || !side) return;
  let best = car.swayPhase, bestScore = Infinity;
  for (let k = 0; k < REDIRECT_TRIES && bestScore > 0; k++) {
    const trial = { swayPhase: WAVELENGTHS.map(() => Math.random()*Math.PI*2) };
    let score = 0;
    for (let d = 0; d <= REDIRECT_CLEAR; d += 2) score += Math.max(0, wave(trial, car.swayDist + d)*side);
    if (score < bestScore) { bestScore = score; best = trial.swayPhase; }
  }
  car.swayPhase = best;
}

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
