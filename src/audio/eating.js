import { camera } from '../core/scene.js';
import { playBufferAt, zzfxBuffer } from './sfx.js';

// ============================================================ eating
// What a meal sounds like (see the Eating clip in life/people/peopleModel.js, whose cues people.js plays as they come
// round): the tink of a fork on a plate, the soft sound of a mouthful going in, and the chewing after it. All built once
// by ZzFX (see sfx.js) and picked from at random, pitched a little differently each time so a table of diners doesn't
// sound like one person. Only heard close by — in the room with them — and only so many a second.
const CLINK = [
  [.3, .2, 2400, 0, .002, .06, 1, 2.5, , , , , , .2, , .1, , .6, .02, , 2200],
  [.25, .2, 900, 0, .001, .02, 4, 1, , , , , , 1.8, , , , .4, .01, , 1400],
];
const BITE = [
  [.3, .3, 260, 0, .01, .05, 4, 1.2, -8, , , , , 1.4, , , .01, .5, .03, , 900],
];
const CHEW = [
  [.25, .35, 180, 0, .012, .07, 4, 1, -5, , , , , 1.6, , , , .45, .04, , 700],
];
const SOUNDS = { clink: CLINK, bite: BITE, chew: CHEW };
const VOLUME = { clink: 0.2, bite: 0.16, chew: 0.13 };
const VARIANTS = 4;
const HEAR_DISTANCE = 9, REF_DISTANCE = 1.5;
const SOUNDS_MAX_PER_SECOND = 14; // past this many a second, the rest go unheard
const PITCH_SPREAD = 0.18;

let buffers = null; // name -> [variant -> [layer -> AudioBuffer]]
let budget = SOUNDS_MAX_PER_SECOND, budgetAt = 0;

/**
 * One sound of someone eating, at the plate or the mouth.
 * @param {{x: number, y: number, z: number}} at - where it comes from
 * @param {string} name - 'clink' (the fork on the plate), 'bite' (a mouthful) or 'chew'
 * @returns {void}
 */
export function eatingSound(at, name) {
  if (!SOUNDS[name]) return;
  const { x, y, z } = camera.position;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return;
  const now = performance.now()/1000;
  budget = Math.min(SOUNDS_MAX_PER_SECOND, budget + (now - budgetAt)*SOUNDS_MAX_PER_SECOND);
  budgetAt = now;
  if (budget < 1) return;
  budget--;
  buffers ??= Object.fromEntries(Object.entries(SOUNDS).map(([key, layers]) =>
    [key, Array.from({ length: VARIANTS }, () => layers.map(zzfxBuffer))]));
  const set = buffers[name], layers = set[Math.floor(Math.random()*set.length)];
  const rate = 1 + (Math.random()*2 - 1)*PITCH_SPREAD;
  for (const buffer of layers) playBufferAt(buffer, at, VOLUME[name], REF_DISTANCE, HEAR_DISTANCE, rate);
}
