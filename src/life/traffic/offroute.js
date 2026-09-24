import { weave } from './drunk.js';
import { pullOf } from './pullover.js';

// An AI car drawn off its route this frame: a drunk one's weave (drunk.js) plus pulling over for a smelly one
// (pullover.js), sideways and turned. Put on after the car's placed on its route and taken off again before its next step
// (unsway), so the route itself is untouched. `car.sway` holds it: { x, z, turn, drunk }.

/**
 * Take last frame's offset back off a car, before it's moved along its route.
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
 * Put this frame's offset on a car just placed on its route.
 * @param {object} car - an AI car, not knocked
 * @param {number} dt
 * @returns {void}
 */
export function sway(car, dt) {
  if (car.kick) return;
  const drunk = weave(car, dt), pulled = pullOf(car);
  if (!drunk && !pulled) return;
  const off = (drunk?.off ?? 0) + (pulled?.off ?? 0), turn = (drunk?.turn ?? 0) + (pulled?.turn ?? 0);
  const x = Math.cos(car.heading)*off, z = -Math.sin(car.heading)*off;
  car.x += x; car.z += z; car.heading += turn;
  car.sway = { x, z, turn, drunk: !!drunk };
}
