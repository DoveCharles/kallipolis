import * as THREE from 'three';
import { Y_ROAD } from '../../core/scene.js';
import { mulberry32 } from '../../core/math.js';
import { terribleSmoke, sparkleFx } from '../giblets.js';
import { carHeight, carLength, carWidth } from './placing.js';

// ---- legendary and terrible cars (core/traits.js): legendary and terrible cancel out — a car's net level is legendary
// minus terrible, and only that net level ever shows (net 0, however it got there, is an ordinary car). A positive net
// gets a foil or polychrome sheen — a shine drawn by the shader itself (injectCarShader's applyCarHolo), from a
// per-instance strength/kind/seed (see carHoloOf, placeCar), so it shows even on a design with no paintable body. A
// negative net shows rust spots the same way (applyCarRust) and shakes and smokes, both worse the more negative it is.
// Neither steers a car anywhere; they're drawn on top of whatever it's already doing (see placeCar).
const LEGENDARY_SPARKLE_COLOR = 0xfff6c8, FOIL_SPARKLE_COLOR = 0xeaf6ff, LEGENDARY_SPARKLE_EVERY = 0.4; // (a net-1 glint's colour, a net-2 one's, and seconds between glints per net level)
export const TERRIBLE_RUST = new THREE.Color(0x9a4418); // the spots a terrible car's paint shows through, see applyCarRust — an orange rust, shaded darker in patches there
const TERRIBLE_BUMP_EVERY = 2.5, TERRIBLE_BUMP_RISE = 0.45, TERRIBLE_BUMP_HEIGHT = 0.12, TERRIBLE_BUMP_ROLL = 0.11/6, TERRIBLE_ROLL_DELAY = 0.5, TERRIBLE_ROLL_TIME = 0.25; // (seconds between hops; how long one takes, eased up and down rather than snapping; how high; how far it rocks side to side, in radians; how long after the hop starts it rocks, to line up with its smoke; how long one rock takes)
export const DEFAULT_HOLO = [0, 0, 0], DEFAULT_RUST = [0, 0]; // (no sheen, no rust spots — see carHoloOf/carRustOf, placeCar)
/**
 * A legendary or terrible car's own effects this frame, from its net level (legendary minus terrible — see the note
 * above): net > 0 gets a foil or polychrome sheen (car.holo, read by placeCar and drawn by the shader — see carHoloOf)
 * and an occasional sparkle glint; net < 0 gets rust spots (car.rust, likewise shader-drawn — see carRustOf) and a hop
 * on the spot (car.bumpY/car.bumpShake, read by placeCar) every TERRIBLE_BUMP_EVERY seconds, harder the more negative
 * the net, smoking from underneath while it's in the air; net === 0 gets neither, whatever legendary and terrible it
 * actually carries.
 * @param {object} car
 * @param {number} t - seconds since page load
 * @param {number} dt
 * @returns {void}
 */
export function updateSpecialTraits(car, t, dt) {
  const net = (car.legendaryCount ?? 0) - (car.terribleCount ?? 0);
  car.holo = net > 0 ? carHoloOf(car, net) : null;
  car.rust = net < 0 ? carRustOf(car, -net) : null;
  if (net > 0) legendarySparkle(car, net, t, dt);
  if (net < 0) terribleBump(car, -net, dt); else { car.bumpY = 0; car.bumpShake = 0; }
}
/** The shader's per-instance holo attribute for a car with a positive net legendary/terrible level (see updateSpecialTraits,
 * placeCar, applyCarHolo): [strength (0.5 at net 1, 1 at net 2, higher still beyond), kind (0 foil glint at net 1,
 * 1 rainbow polychrome at net 2 or more), seed (its own glint phase, so cars don't shimmer in step)]. Cached on the
 * car, since none of it changes. */
function carHoloOf(car, level) {
  return car.holoAttrs ??= [level/2, level >= 2 ? 1 : 0, mulberry32(car.number*911 + 7)()];
}
/** The shader's per-instance rust attribute for a car with a negative net legendary/terrible level (see
 * updateSpecialTraits, placeCar, applyCarRust): [strength (how much of the body rusts and how dirty the rest is, higher the more negative the net),
 * seed (so two cars' spots don't line up)]. Cached, like carHoloOf. */
function carRustOf(car, level) {
  return car.rustAttrs ??= [Math.min(0.95, 0.35 + level*0.2), mulberry32(car.number*613 + 53)()];
}
/** A sparkle glint somewhere on a net-legendary car, more often the higher its level; a net-2 car's (foil or polychrome
 * alike) is bigger and more brightly tinted than a plain net-1 foil's pale default. */
function legendarySparkle(car, level, t, dt) {
  const polychrome = level >= 2, bigger = level >= 2;
  if ((car.sparkleTimer = (car.sparkleTimer ?? 0) - dt) > 0) return;
  car.sparkleTimer = LEGENDARY_SPARKLE_EVERY/(level*(bigger ? 1.5 : 1));
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const along = (Math.random()*2 - 1)*carLength(car)*0.4, side = (Math.random()*2 - 1)*carWidth(car)*0.4, h = carHeight(car);
  const color = polychrome ? new THREE.Color().setHSL((t*0.35 + car.number*0.13) % 1, 0.9, 0.65)
    : bigger ? FOIL_SPARKLE_COLOR : LEGENDARY_SPARKLE_COLOR;
  sparkleFx({ x: car.x + sin*along + cos*side, y: Y_ROAD + h*(0.35 + Math.random()*0.55), z: car.z + cos*along - sin*side }, color, bigger ? 0.6 : 0.35);
}
/** A net-terrible car's hop this frame (car.bumpY) and side-to-side rock (car.bumpShake, a roll angle about its own
 * length axis, read by placeCar — like a plane rocking its wings on landing, not a lateral slide) — a smooth eased arc
 * rather than a snap, TERRIBLE_BUMP_RISE seconds up and down, harder and a touch quicker the more negative the net —
 * and its smoke from underneath while it's actually off the ground. The rock comes TERRIBLE_ROLL_DELAY after the hop
 * starts, so it lands with the smoke.
 * @param {object} car
 * @param {number} level - how far below zero the net legendary/terrible level is (1 or more)
 * @param {number} dt
 * @returns {void}
 */
function terribleBump(car, level, dt) {
  const cycle = TERRIBLE_BUMP_RISE/(1 + 0.15*(level - 1));
  car.terribleTimer = ((car.terribleTimer ?? 0) + dt) % TERRIBLE_BUMP_EVERY;
  const inAir = car.terribleTimer < cycle, phase = Math.min(1, car.terribleTimer/cycle);
  car.bumpY = inAir ? TERRIBLE_BUMP_HEIGHT*(1 + 0.25*(level - 1))*Math.sin(phase*Math.PI) : 0;
  const rollPhase = (car.terribleTimer - TERRIBLE_ROLL_DELAY)*(1 + 0.15*(level - 1))/TERRIBLE_ROLL_TIME;
  car.bumpShake = rollPhase > 0 && rollPhase < 1 ? TERRIBLE_BUMP_ROLL*(1 + 0.2*(level - 1))*Math.sin(rollPhase*Math.PI*2) : 0;
  if (inAir) terribleSmoke({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), carWidth(car), dt, level, car.heading, car.speed);
}
