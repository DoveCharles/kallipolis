import { camera } from '../core/scene.js';
import { playBufferAt, zzfxBuffer } from './sfx.js';

// ============================================================ typing
// A click for every key struck by anyone typing at a desk (see the Typing clip in life/people/peopleModel.js, whose
// strikes people.js hears as they come round): a sharp tick of noise over a short hollow knock, the plastic of the key and
// the thud of it bottoming out, built once by ZzFX (see sfx.js) and picked from at random. The space bar is a longer,
// lower clack. Only heard close by, which in practice means in the room with them, and only so many a second, so an
// office full of typists is a busy patter, not a hailstorm.
const KEY = [
  [.35, .3, 2600, 0, .001, .012, 4, 1, , , , , , 2, , , , , , , 1800],
  [.3, .2, 420, 0, .002, .02, 1, 2, -30, , , , , .3, , , , .5, .01, , -2500],
];
const SPACE = [
  [.3, .2, 1400, 0, .003, .02, 4, 1, , , , , , 1.5, , , , , , , 900],
  [.4, .1, 190, 0, .004, .04, 1, 2, -20, , , , , .4, , , , .5, .02, , -1500],
];
const VARIANTS = 5;
const HEAR_DISTANCE = 9, REF_DISTANCE = 1.5;
const KEY_VOLUME = 0.22, SPACE_VOLUME = 0.26;
const CLICKS_MAX_PER_SECOND = 30; // past this many a second, the rest go unheard
const PITCH_SPREAD = 0.12;        // each pitched up or down by as much as this, so no two keys sound quite alike

let buffers = null; // { key, space } -> [variant -> [layer -> AudioBuffer]]
let budget = CLICKS_MAX_PER_SECOND, budgetAt = 0;

/**
 * One key struck at `at` (the keyboard).
 * @param {{x: number, y: number, z: number}} at
 * @param {boolean} [space=false] - the space bar, rather than a key
 * @returns {void}
 */
export function keyClick(at, space = false) {
  const { x, y, z } = camera.position;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return;
  const now = performance.now()/1000;
  budget = Math.min(CLICKS_MAX_PER_SECOND, budget + (now - budgetAt)*CLICKS_MAX_PER_SECOND);
  budgetAt = now;
  if (budget < 1) return;
  budget--;
  buffers ??= {
    key: Array.from({ length: VARIANTS }, () => KEY.map(zzfxBuffer)),
    space: Array.from({ length: VARIANTS }, () => SPACE.map(zzfxBuffer)),
  };
  const set = buffers[space ? 'space' : 'key'], layers = set[Math.floor(Math.random()*set.length)];
  const rate = 1 + (Math.random()*2 - 1)*PITCH_SPREAD;
  for (const buffer of layers) playBufferAt(buffer, at, space ? SPACE_VOLUME : KEY_VOLUME, REF_DISTANCE, HEAR_DISTANCE, rate, [], 'peds');
}
