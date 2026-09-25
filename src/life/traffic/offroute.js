import { weave } from './drunk.js';
import { pullOf } from './pullover.js';

// An AI car drawn off its route this frame: a drunk one's weave (drunk.js) plus pulling over for a smelly one
// (pullover.js), sideways and turned. Put on after the car's placed on its route and taken off again before its next step
// (unsway), so the route itself is untouched. `car.sway` holds it: { x, z, turn, drunk }.
// A knock (kickCar in collisions.js) takes the offset into car.kick, so the car's knocked from where it's drawn; once it's
// back on its route the offset eases in from nothing over OFF_EASE_TIME (car.offEase), so it never jumps.
const OFF_EASE_TIME = 1.5; // (seconds)

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
 * @param {object} car - an AI car
 * @param {number} dt
 * @returns {void}
 */
export function sway(car, dt) {
  if (car.kick) { car.offEase = 0; return; }
  car.offEase = Math.min(1, (car.offEase ?? 1) + dt/OFF_EASE_TIME);
  const drunk = weave(car, dt), pulled = pullOf(car);
  if (!drunk && !pulled) return;
  const ease = car.offEase*car.offEase*(3 - 2*car.offEase);
  const off = ((drunk?.off ?? 0) + (pulled?.off ?? 0))*ease, turn = ((drunk?.turn ?? 0) + (pulled?.turn ?? 0))*ease;
  const x = Math.cos(car.heading)*off, z = -Math.sin(car.heading)*off;
  car.x += x; car.z += z; car.heading += turn;
  car.sway = { x, z, turn, drunk: !!drunk };
}
