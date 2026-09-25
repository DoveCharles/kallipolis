import { S } from '../../core/shared.js';
import { weave } from './drunk.js';
import { pullOf } from './pullover.js';
import { carsOverlap, forCarsNear } from './spacing.js';
import { carLength } from './placing.js';

// An AI car drawn off its route this frame: a drunk one's weave (drunk.js) plus pulling over for a smelly one
// (pullover.js), sideways and turned. Put on after the car's placed on its route and taken off again before its next step
// (unsway), so the route itself is untouched. `car.sway` holds it: { x, z, turn, off (right of route), drunk }.
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

/** Whether drawing a car off its route by (x, z) and `turn` would put it into a car it isn't touching on its route. */
function pullsIntoCar(car, x, z, turn) {
  const at = { ...car, x: car.x + x, z: car.z + z, heading: car.heading + turn };
  let hit = false;
  forCarsNear(at.x, at.z, carLength(car)*1.5 + 4*S.peopleSize, other => { if (!hit && other !== car && carsOverlap(at, other) && !carsOverlap(car, other)) hit = true; });
  return hit;
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
  const drunk = weave(car, dt);
  let pulled = pullOf(car);
  if (!pulled) car.pullDrawn = 0;
  if (!drunk && !pulled) return;
  const ease = car.offEase*car.offEase*(3 - 2*car.offEase);
  const offsetOf = () => {
    const off = ((drunk?.off ?? 0) + (pulled?.off ?? 0))*ease, turn = ((drunk?.turn ?? 0) + (pulled?.turn ?? 0))*ease;
    return { off, turn, x: Math.cos(car.heading)*off, z: -Math.sin(car.heading)*off };
  };
  let { off, turn, x, z } = offsetOf();
  // pulling over (not weaving drunk, which is meant to hit things) goes no further while it would pull into a car beside
  // it that it isn't already touching: it's held at the last pull that was clear (car.pullDrawn)
  if (pulled && !drunk) {
    if (pullsIntoCar(car, x, z, turn)) { car.pull = car.pullDrawn ?? 0; pulled = pullOf(car); if (!pulled) return; ({ off, turn, x, z } = offsetOf()); }
    else car.pullDrawn = car.pull;
  }
  car.x += x; car.z += z; car.heading += turn;
  car.sway = { x, z, turn, off, drunk: !!drunk };
}
