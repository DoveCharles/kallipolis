import * as THREE from 'three';
import { ZZFX } from 'zzfx';
import { scene, camera } from '../core/scene.js';

// ============================================================ sound effects
// Every sound is synthesized: ZzFX (https://killedbyapixel.github.io/ZzFX/ has a designer, whose parameter lists paste
// straight into SOUNDS below) builds the samples, and each play is a THREE.PositionalAudio set down where it happened, so
// it's quieter far off and comes from the right side. The listener rides the camera. Sound travels at SPEED_OF_SOUND, so
// a far-off blast is seen before it's heard, like the thunder after the lightning.
//
// Each sound is one or more layers played together (a crack over a rumble, say). ZzFX randomizes the pitch a little each
// time it builds a sound, so each is built VARIANTS times up front and one picked at random per play.
const SOUNDS = {
  // the Smite button's bolt (see life/lightning.js): a sharp crack, then thunder rolling after it
  thunder: [
    [1, .05, 1200, 0, .02, .35, 4, 2.5, -40, , , , , 2, , .15, .03, .5, .05],
    [1.1, .1, 45, .02, .3, 2.4, 4, .6, , , , , , 1, , .2, .25, .7, .4, .15, -600],
  ],
  // a car going up (see explodeCar in life/giblets.js): a hard bang into a long crunchy roar
  explosion: [
    [1, .1, 70, 0, .08, .25, 4, 1.5, -5, , , , , 1.5, , .4, , .8, .05],
    [1.1, .1, 40, .01, .4, 1.6, 4, .7, , , , , , 1, , .35, .15, .6, .3, , -900],
  ],
  // someone blowing up (see explode in life/giblets.js): a short wet burst
  gib: [
    [.9, .15, 130, 0, .04, .3, 4, 2, -20, , , , , 1.2, , .1, , .5, .05, , -1400],
  ],
  // a bee bursting (see explodeBee in life/giblets.js): a tiny pop
  pop: [
    [.8, .2, 500, 0, .01, .07, 4, 2, 60, , , , , .5],
  ],
  // the driven car hitting a car or a wall (see bumpIntoCars and hitBuildings in life/traffic.js): a crunch, and a
  // clang of bent metal ringing under it
  crash: [
    [.6, .1, 80, 0, .04, .3, 4, 1.5, -10, , , , , 1.8, , .35, , .6, .06, , -2500],
    [.45, .1, 700, 0, .02, .4, 1, 2.5, , , , , , .4, 9, , , .3, .15, .3],
  ],
  // a car hitting someone (see runOverPeople in life/traffic.js): a dull thump
  thump: [
    [.6, .1, 70, 0, .02, .16, 4, 1, -12, , , , , 1, , , , .5, .05, , -800],
    [.5, .05, 60, 0, .02, .15, 0, 1, -15],
  ],
  // a fist landing (see knockDown in life/people/peopleActivities.js): a slap over a low thud
  punch: [
    [.6, .1, 110, 0, .012, .08, 4, 1, -30, , , , , 1, , , , .6, .02, , -1400],
    [.5, .05, 75, 0, .01, .12, 0, 1, -25],
  ],
  // a fist swung (see swingSound in life/people/peopleActivities.js): a rush of air, rising
  whoosh: [
    [.35, .1, 200, .08, .03, .1, 4, 1, 25, , , , , 0, , , , .6, , , -2500],
  ],
};
// how near something has to be for each sound to be heard at full volume, falling away past it (REF_DISTANCE if not here)
const REACH = { crash: 12, thump: 6, punch: 4, whoosh: 2 };
const VARIANTS = 3;
const SPEED_OF_SOUND = 343;      // units (metres) a second
const REF_DISTANCE = 25;         // how near something has to be to be heard at full volume, falling away past it
const VOICES_MAX = 32;           // sounds playing at once, past which new ones are dropped
const SAME_SOUND_GAP = 0.06, SAME_SOUND_NEAR = 30; // the same sound again this soon and this close (a bus's two ends) plays once

export const listener = new THREE.AudioListener();
camera.add(listener);
const context = listener.context;
// a limiter after everything, so a pile-up of blasts close by squashes rather than clips
const limiter = context.createDynamicsCompressor();
limiter.threshold.value = -10; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.25;
listener.setFilter(limiter);

// Browsers keep audio suspended until the page has been interacted with: wake it on the first press.
function unlock() {
  if (context.state === 'suspended') context.resume();
  if (context.state === 'running') ['pointerdown', 'keydown'].forEach(type => window.removeEventListener(type, unlock, true));
}
['pointerdown', 'keydown'].forEach(type => window.addEventListener(type, unlock, true));

// The Sound toggle in World settings (see ui/sound.js) mutes everything, the engine loop included, at the listener.
let muted = false;
/**
 * Mute or unmute every sound.
 * @param {boolean} on
 * @returns {void}
 */
export function setMuted(on) {
  muted = on;
  listener.setMasterVolume(on ? 0 : 1);
}
export const isMuted = () => muted;

// ZzFX's own master volume would scale every sample down: the listener's gain sets the level instead.
ZZFX.volume = 1;
const buffers = {}; // name -> [variant -> [layer -> AudioBuffer]]
function variantsOf(name) {
  if (!buffers[name]) buffers[name] = Array.from({ length: VARIANTS }, () => SOUNDS[name].map(zzfxBuffer));
  return buffers[name];
}

/**
 * Plays an AudioBuffer once at `at`, through a bare panner rather than a THREE.PositionalAudio — for sounds as small and
 * frequent as footsteps, where an Object3D apiece would be too much. Counts toward VOICES_MAX like any other sound.
 * @param {AudioBuffer} buffer
 * @param {{x: number, y: number, z: number}} at
 * @param {number} volume
 * @param {number} refDistance - how near to be heard at full volume
 * @param {number} [maxDistance] - if given, it fades out evenly from refDistance to nothing at all here, rather than tailing
 *   off slowly and forever
 * @returns {void}
 */
export function playBufferAt(buffer, at, volume, refDistance, maxDistance) {
  if (muted || context.state !== 'running' || voices >= VOICES_MAX) return;
  const source = context.createBufferSource(), gain = context.createGain(), panner = context.createPanner();
  source.buffer = buffer;
  gain.gain.value = volume;
  panner.panningModel = 'equalpower';
  panner.distanceModel = maxDistance ? 'linear' : 'inverse';
  panner.refDistance = refDistance;
  if (maxDistance) panner.maxDistance = maxDistance;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  source.connect(gain).connect(panner).connect(listener.getInput());
  voices++;
  source.onended = () => { voices--; panner.disconnect(); };
  source.start();
}
/**
 * Builds a ZzFX sound's samples into an AudioBuffer (the layer lists as in SOUNDS).
 * @param {number[]} layer
 * @returns {AudioBuffer}
 */
export function zzfxBuffer(layer) {
  const samples = ZZFX.buildSamples(...layer);
  const buffer = context.createBuffer(1, samples.length, ZZFX.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

let voices = 0;
const ear = new THREE.Vector3(), source = new THREE.Vector3();
const recent = []; // { name, x, z, at } of what's been played lately, for SAME_SOUND_GAP

/**
 * Plays a sound where something happened.
 * @param {keyof SOUNDS} name
 * @param {{x: number, y: number, z: number}} at
 * @param {number} [volume=1]
 * @param {number} [after=0] - seconds from now it happens (it's heard later still, the further off it is)
 * @returns {void}
 */
export function playSound(name, at, volume = 1, after = 0) {
  if (!SOUNDS[name] || muted || context.state !== 'running') return;
  const now = context.currentTime;
  while (recent.length && now - recent[0].at > SAME_SOUND_GAP) recent.shift();
  if (recent.some(r => r.name === name && Math.hypot(r.x - at.x, r.z - at.z) < SAME_SOUND_NEAR)) return;
  recent.push({ name, x: at.x, z: at.z, at: now });

  const variants = variantsOf(name), layers = variants[Math.floor(Math.random()*variants.length)];
  if (voices + layers.length > VOICES_MAX) return;
  const delay = camera.getWorldPosition(ear).distanceTo(source.set(at.x, at.y, at.z))/SPEED_OF_SOUND;
  for (const buffer of layers) {
    const sound = new THREE.PositionalAudio(listener);
    sound.setBuffer(buffer);
    sound.setRefDistance(REACH[name] ?? REF_DISTANCE);
    sound.setRolloffFactor(1);
    sound.setVolume(volume);
    sound.position.set(at.x, at.y, at.z);
    scene.add(sound);
    sound.updateMatrixWorld();
    sound.onEnded = () => { voices--; sound.isPlaying = false; scene.remove(sound); sound.disconnect(); };
    voices++;
    sound.play(delay + after);
  }
}
