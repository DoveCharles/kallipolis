import { S } from '../../core/shared.js';

// Drunk AI cars weave about their lane: pushed sideways DRUNK_WIDTH × s³, where s is the average of three sines of the
// distance driven, with wavelengths that never line up. Cubed, it's mostly a gentle wander a fraction of DRUNK_WIDTH;
// only when all three peak together does it lurch the full width, over the kerb. The car's turned along the weave.
// Put on after the car's placed on its route and taken off before its next step (unsway), so its route is untouched.
// It hits what it weaves into: anyone it reaches, pavement or not (runOverPeople), and cars and walls (swayCrash in
// collisions.js), which knock it back off them to find its lane again.
const DRUNK_WIDTH = 3.5*0.65, WAVELENGTHS = [40, 67, 109]; // (at people size 1)
const weave = (car, u) => (WAVELENGTHS.reduce((sum, length, k) => sum + Math.sin(2*Math.PI*u/length + car.swayPhase[k]), 0)/WAVELENGTHS.length)**3;

/**
 * Take last frame's weave back off a car, before it's moved along its route.
 * @param {object} car
 * @returns {void}
 */
export function unsway(car) {
  const w = car.sway;
  if (!w) return;
  car.x -= w.x; car.z -= w.z; car.heading -= w.turn;
  car.sway = null;
}

/**
 * Weave a drunk car off its route for this frame, by how far it's driven.
 * @param {object} car - an AI car just placed on its route, not knocked
 * @param {number} dt
 * @returns {void}
 */
export function sway(car, dt) {
  if (!car.traits?.drunk || car.kick) return;
  car.swayPhase ??= WAVELENGTHS.map(() => Math.random()*Math.PI*2);
  car.swayDist = (car.swayDist ?? 0) + Math.abs(car.speed)*dt/S.peopleSize;
  const width = DRUNK_WIDTH*S.peopleSize, off = width*weave(car, car.swayDist), next = width*weave(car, car.swayDist + 1);
  const turn = Math.atan((next - off)/S.peopleSize), x = Math.cos(car.heading)*off, z = -Math.sin(car.heading)*off;
  car.x += x; car.z += z; car.heading += turn;
  car.sway = { x, z, turn };
}
