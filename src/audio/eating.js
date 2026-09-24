import { camera } from '../core/scene.js';
import { playBufferAt, zzfxBuffer } from './sfx.js';

// ============================================================ eating
// What a meal sounds like (see the Eating clip in life/people/peopleModel.js, whose cues people.js plays as they come
// round, and the snacks in life/people/peopleHolding.js): the tink of a fork on a plate, one soft sound of a mouthful
// taken, or a sip of coffee — nothing after, since chewing close-miked is a noise nobody wants. All built once by ZzFX (see sfx.js) and picked from at random, pitched a little
// differently each time so a table of diners doesn't sound like one person. Only heard close by — in the room with them
// — and only so many a second.
const CLINK = [
  [.3, .2, 2400, 0, .002, .06, 1, 2.5, , , , , , .2, , .1, , .6, .02, , 2200],
  [.25, .2, 900, 0, .001, .02, 4, 1, , , , , , 1.8, , , , .4, .01, , 1400],
];
// the mouthful: a soft, dry little tap of lips and fork, gone almost before it starts
const BITE = [
  [.3, .06, 520, .004, .008, .03, 4, .5, , , , , , .7, , , .015, .4, .01, , 1800],
];
// a sip of coffee: a short, breathy draw through the lid
const SIP = [
  [.25, .1, 260, .03, .06, .07, 4, 1, 3, , , , , 1.4, , , , .5, .03, .25, 1100],
];
const SOUNDS = { clink: CLINK, bite: BITE, sip: SIP };
const VOLUME = { clink: 0.2, bite: 0.13, sip: 0.1 };
const VARIANTS = 4;
const HEAR_DISTANCE = 9, REF_DISTANCE = 1.5;
const SOUNDS_MAX_PER_SECOND = 14; // past this many a second, the rest go unheard
const PITCH_SPREAD = 0.18;

let buffers = null; // name -> [variant -> [layer -> AudioBuffer]]
let budget = SOUNDS_MAX_PER_SECOND, budgetAt = 0;

/**
 * One sound of someone eating, at the plate or the mouth.
 * @param {{x: number, y: number, z: number}} at - where it comes from
 * @param {string} name - 'clink' (the fork on the plate), 'bite' (a mouthful) or 'sip' (of a coffee)
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
  for (const buffer of layers) playBufferAt(buffer, at, VOLUME[name], REF_DISTANCE, HEAR_DISTANCE, rate, [], 'peds');
}
