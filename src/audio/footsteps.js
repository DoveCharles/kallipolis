import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { playBufferAt, zzfxBuffer } from './sfx.js';

// ============================================================ footsteps
// A scuff for each footfall of anyone walking near the camera (see the walk cycle in life/people/people.js): short bursts
// of filtered noise, built once by ZzFX (see sfx.js) and picked from at random. In snow they crunch and in rain they
// splash. Only those within HEAR_DISTANCE are heard at all, and only so many at once, so a crowd is a patter, not a roar.
const STEPS = {
  dry:  [.5, .25, 180, 0, .004, .035, 4, 1, , , , , , 3, , , , , , , -2500],
  snow: [.45, .3, 700, 0, .03, .06, 4, 2, , , , , , 5, , .2, , , , , -4000],
  wet:  [.45, .3, 380, 0, .012, .06, 4, 1, 20, , , , , 4, , , , , , , -3000],
};
const VARIANTS = 4;
const HEAR_DISTANCE = 35, REF_DISTANCE = 4;
const STEP_VOLUME = 0.2;
const STEPS_MAX_PER_SECOND = 24; // past this many footfalls a second, the rest go unheard

let buffers = null; // surface -> [AudioBuffer]
let budget = STEPS_MAX_PER_SECOND, budgetAt = 0;

/**
 * One footfall at `at` (the ground under the foot).
 * @param {{x: number, y: number, z: number}} at
 * @param {number} [weight=1] - their weight trait: heavier, louder
 * @returns {void}
 */
export function footstep(at, weight = 1) {
  const { x, y, z } = camera.position;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return;
  const now = performance.now()/1000;
  budget = Math.min(STEPS_MAX_PER_SECOND, budget + (now - budgetAt)*STEPS_MAX_PER_SECOND);
  budgetAt = now;
  if (budget < 1) return;
  budget--;
  buffers ??= Object.fromEntries(Object.entries(STEPS).map(([surface, layer]) => [surface, Array.from({ length: VARIANTS }, () => zzfxBuffer(layer))]));
  const surface = S.weatherSnow > 0.2 ? 'snow' : S.weatherRain > 0.2 ? 'wet' : 'dry';
  const set = buffers[surface];
  playBufferAt(set[Math.floor(Math.random()*set.length)], at, STEP_VOLUME*Math.min(1.4, 0.6 + 0.4*weight), REF_DISTANCE);
}
