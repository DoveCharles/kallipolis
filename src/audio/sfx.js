import * as THREE from 'three';
import { ZZFX } from 'zzfx';
import { camera } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';

// ============================================================ sound effects
// Every sound is synthesized (but for the pubs' music: audio/pub-music.js): ZzFX (https://killedbyapixel.github.io/ZzFX/ has a designer, whose parameter lists paste
// straight into SOUNDS below) builds the samples, and each play goes through a panner set down where it happened, so
// it's quieter far off and comes from the right side. The listener sits at the ear (placeEar, below). Sound travels at SPEED_OF_SOUND, so
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
  // a dropped coin picked up (see life/coins.js): a bright two-note ding
  coin: [
    [.5, .05, 1675, , .06, .24, 1, 1.82, , , 837, .06],
  ],
  // a dropped coin spinning on the ground (see life/coins.js): a faint high tink
  coinspin: [
    [.3, .15, 2400, , .005, .06, 0, 2, , , , , , , , , , .4],
  ],
  // a bee bursting (see explodeBee in life/giblets.js): a tiny pop
  pop: [
    [.8, .2, 500, 0, .01, .07, 4, 2, 60, , , , , .5],
  ],
  // a car going under water (see splashCar in life/giblets.js): a wet slap into a frothy hiss
  splash: [
    [.7, .2, 300, .01, .05, .2, 4, 1.8, -10, , , , , 1.4, , .3, , .5, .06],
    [.4, .3, 1400, .02, .12, .3, 4, 1, , , , , , .8, , .6, , .3, .12],
  ],
  // the driven car hitting a car or a wall (see bumpIntoCars and hitBuildings in life/traffic/collisions.js): a crunch, and a
  // clang of bent metal ringing under it
  crash: [
    [.6, .1, 80, 0, .04, .3, 4, 1.5, -10, , , , , 1.8, , .35, , .6, .06, , -2500],
    [.45, .1, 700, 0, .02, .4, 1, 2.5, , , , , , .4, 9, , , .3, .15, .3],
  ],
  // a car hitting someone (see runOverPeople in life/traffic/collisions.js): a dull thump
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
  // someone coming into or going out of the room the camera's in (see leaveRoom in life/people/peopleActivities.js): a
  // door swung open, a low wooden thud with the latch clicking over it
  door: [
    [.8, .05, 70, 0, .02, .22, 0, 1.5, -6, , , , , .5, , , , .6, .08, , -700],
    [.3, .05, 1600, 0, .004, .03, 1, 2, , , , , , .4, , , , .5, , , 2000],
  ],
  // the same door shut again: just a little click of the latch going home
  latch: [
    [.18, .05, 1900, 0, .003, .02, 1, 2, , , , , , .4, , , , .5, , , 2200],
  ],
  // the waiter bot pushing through the restaurant's kitchen doors (see buildings/waiterbot.js): a padded thump, a rush
  // of air; and a leaf flapping back past shut, a soft wooden knock
  swingdoor: [
    [.5, .05, 90, 0, .02, .18, 0, 1.5, -5, , , , , .4, , , , .6, .06, , -600],
    [.15, .1, 300, .04, .05, .1, 4, 1, 10, , , , , 0, , , , .5, , , -1500],
  ],
  flap: [
    [.8, .1, 240, .025, .005, .05, 0, 1.5, -10, , , , , .3, , , , .5, .02, , -2600],
  ],
  // the service bell rung in the kitchen once a table's food is up (see deliver in life/people/peopleWaiter.js): a
  // bright strike, ringing on with a fainter overtone
  service: [
    [.12, 0, 1760, 0, 0, 1, 0, 1, , , , , , , , , , , , , -1200],
    [.01, 0, 4860, 0, 0, .3, 0, 1, , , , , , , , , , , , , -1200],
    [.02, 0, 3500, 0, .002, .01, 1, 2, , , , , , , , , , , , , -1200],
  ],
  // a changing room's curtain drawn across or back (see drawCurtain in buildings/interior.js): a swish of cloth, the
  // rings rattling along the rail over it
  curtain: [
    [.3, .1, 900, .03, .08, .12, 4, 1, 8, , , , , 0, , , , .5, , , 1800],
    [.08, .2, 2600, 0, .01, .05, 1, 2, , , , , .03, , , , , .4],
  ],
  // a salon bot at work (see salonBotNoise in buildings/salonbot.js), all of it at once: scissors — the blades' rising
  // shing, ringing, shut with a click — a brush's bristly stroke, a spray bottle's trigger and pssht, a hairdryer's
  // whine over its rush of air (no randomness on the whine's pitch, or its two layers beat against each other), and
  // clippers buzzing
  snip: [
    [.3, .05, 6000, .03, .015, .015, 4, 1, 20, , , , , 1, , , , .5, , , 4000],
    [.1, .03, 4300, .025, 0, .1, 0, 1],
    [.1, .03, 6150, .025, 0, .07, 0, 1],
    [.35, .05, 1800, .04, 0, .006, 1, 2, , , , , , .3, , , , , , , 1200],
  ],
  brush: [
    [.3, .2, 1700, .03, .1, .08, 4, 1, 12, , , , , 2, , .1, , .5, , .5, 1200],
  ],
  spray: [
    [.5, .05, 1300, 0, .002, .015, 1, 2, , , , , , .4, , , , .5, , , 1500],
    [.32, .1, 3400, .008, .09, .12, 4, 1, , , , , , 1.5, , , , .6, , , 3500],
  ],
  hairdryer: [
    [.35, .05, 900, .1, 1, .25, 4, 1, , , , , , 3, , , , .8, , , -3500],
    [.14, 0, 440, .1, 1, .25, 1, 1, , , , , , , , , , .8],
    [.07, 0, 1320, .1, 1, .25, 0, 1, , , , , , , , , , .8],
  ],
  clippers: [
    [.14, .02, 125, .02, .5, .08, 2, 1, , , , , , .2, , .15, , .8, , .6, -3000],
  ],
};
// how near something has to be for each sound to be heard at full volume, falling away past it (REF_DISTANCE if not here)
// which sound level each is heard at (see LEVEL_KINDS): the rest go by the master level alone
const KIND_OF = { punch: 'peds', whoosh: 'peds', curtain: 'peds', swingdoor: 'peds', flap: 'peds', service: 'peds', snip: 'peds', brush: 'peds', spray: 'peds', hairdryer: 'peds', clippers: 'peds', crash: 'traffic', thump: 'traffic', thunder: 'ambience' };
const REACH = { coinspin: 2, crash: 12, thump: 6, punch: 4, whoosh: 2, door: 5, latch: 4, curtain: 4, swingdoor: 5, flap: 4, service: 3, snip: 3, brush: 3, spray: 3, hairdryer: 3, clippers: 3 };
// for the little sounds of people that'd otherwise be heard from right across town (a fight in every park): how far off
// they're heard at all, how fast they fade past their REACH, and how fast they're muffled (see muffler)
const NEAR_ONLY = { coinspin: { hear: 10, rolloff: 3, muffle: 1.4 }, punch: { hear: 40, rolloff: 2.5, muffle: 1.4 }, whoosh: { hear: 25, rolloff: 2.5, muffle: 1.4 } };
const VARIANTS = 3;
const SPEED_OF_SOUND = 343;      // units (metres) a second
const REF_DISTANCE = 25;         // how near something has to be to be heard at full volume, falling away past it
const VOICES_MAX = 32;           // sounds playing at once, past which new ones are dropped
const SAME_SOUND_GAP = 0.06, SAME_SOUND_NEAR = 30; // the same sound again this soon and this close (a bus's two ends) plays once

// (a 'playback' context's bigger buffer rides out CPU spikes — a stall, the pub music's synth — rather than crackling)
try { THREE.AudioContext.setContext(new AudioContext({ latencyHint: 'playback' })); } catch { /* the default, then */ }
export const listener = new THREE.AudioListener();
// The listener never moves: it stays at the origin, facing down -z as a camera does, and every panner's placed relative to
// the ear instead (placePanner), glided there each frame. Firefox can only move a listener in jumps (it has no AudioParams),
// each one re-panning every sound at once — a step in every loud sound's level a frame, crackling as the camera swoops.
// And where you hear from eases after the ear, EAR_EASE (seconds) behind, turning as a turn (slerp), so a refocus that
// flings the camera across the city is a quick glide, not a leap. (Every panner is placed this way: a panner given a
// world position of its own would be heard wrong.)
const EAR_EASE = 0.1, PAN_GLIDE = 0.05;
const earAt = new THREE.Vector3(), earTurn = new THREE.Quaternion(), earScale = new THREE.Vector3();
const heardAt = new THREE.Vector3(), heardTurn = new THREE.Quaternion(), unturn = new THREE.Quaternion(), relative = new THREE.Vector3();
let heardSince = 0;
const placed = new Map(); // panner → { x, y, z (in the world), until (context time it's let go, for a one-off) }
const relativeTo = (x, y, z) => relative.set(x, y, z).sub(heardAt).applyQuaternion(unturn);
/**
 * Put a panner at a place in the world (kept there, relative to the ear, as it moves: see above). Call it again to move it.
 * @param {PannerNode} panner
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [lasts=Infinity] - seconds to keep placing it, for a one-off that's gone by then
 * @returns {void}
 */
export function placePanner(panner, x, y, z, lasts = Infinity) {
  const p = placed.get(panner);
  if (p) { p.x = x; p.y = y; p.z = z; return; }
  placed.set(panner, { x, y, z, until: panner.context.currentTime + lasts });
  steer(panner, x, y, z, 0);
}
// A panner: a real PannerNode for HRTF; otherwise a stand-in — a gain for the distance and a stereo panner for the side,
// worked out here each frame with the same sums (the Web Audio spec's equal-power panning and distance models) and
// glided — because Firefox's PannerNode steps its level and pan every 128 samples, and a loud, long sound (thunder) moved
// quickly (a refocus) tears. It takes the same settings (distanceModel, refDistance, maxDistance, rolloffFactor), and
// connects and disconnects as a panner would; place it with placePanner.
export function makePanner(context, panningModel = 'equalpower') {
  if (panningModel === 'HRTF') return Object.assign(context.createPanner(), { panningModel });
  const level = context.createGain(), pan = context.createStereoPanner();
  AudioNode.prototype.connect.call(level, pan);
  level.connect = (...to) => pan.connect(...to);
  level.disconnect = (...to) => pan.disconnect(...to);
  return Object.assign(level, { panningModel, distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, pan, standIn: true });
}
function distanceGain({ distanceModel, refDistance: ref, maxDistance: max, rolloffFactor: rolloff }, d) {
  if (distanceModel === 'linear') {
    const r = Math.max(0, Math.min(1, rolloff));
    return 1 - r*(Math.max(ref, Math.min(max, d)) - ref)/Math.max(1e-6, max - ref);
  }
  if (distanceModel === 'exponential') return Math.pow(Math.max(d, ref)/ref, -rolloff);
  return ref/(ref + rolloff*(Math.max(d, ref) - ref));
}
// (to where it is relative to the ear: at once, or gliding there by `end`)
function steer(panner, x, y, z, end) {
  relativeTo(x, y, z);
  if (!panner.standIn) {
    if (!end) { panner.positionX.value = relative.x; panner.positionY.value = relative.y; panner.positionZ.value = relative.z; return; }
    panner.positionX.linearRampToValueAtTime(relative.x, end);
    panner.positionY.linearRampToValueAtTime(relative.y, end);
    panner.positionZ.linearRampToValueAtTime(relative.z, end);
    return;
  }
  const across = Math.hypot(relative.x, relative.z), gain = distanceGain(panner, relative.length());
  const side = across > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, relative.x/across)))/(Math.PI/2) : 0; // (the azimuth, folded to the front, as equal-power panning has it)
  if (!end) { panner.gain.value = gain; panner.pan.pan.value = side; return; }
  panner.gain.linearRampToValueAtTime(gain, end);
  panner.pan.pan.linearRampToValueAtTime(side, end);
}
/** Stop placing a panner (its sound's over). @param {PannerNode} panner */
export const letGoPanner = panner => { placed.delete(panner); };
listener.updateMatrixWorld = function (force) {
  THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
  const now = performance.now()/1000, dt = heardSince ? Math.min(0.2, now - heardSince) : 0;
  this.matrixWorld.decompose(earAt, earTurn, earScale);
  const ease = heardSince ? 1 - Math.exp(-Math.min(0.1, dt)/EAR_EASE) : 1;
  heardSince = now;
  heardAt.lerp(earAt, ease);
  heardTurn.slerp(earTurn, ease);
  unturn.copy(heardTurn).invert();
  // (glided over a frame or so, overlapping the next, so it's never held still and then stepped)
  const time = this.context.currentTime, end = time + Math.max(PAN_GLIDE, dt*1.2);
  for (const [panner, p] of placed) {
    if (time > p.until) { placed.delete(panner); continue; }
    steer(panner, p.x, p.y, p.z, end);
  }
};
// Where you hear from — the ear — is the camera, until it's zoomed in close on something (following someone, say, when it's
// usually right over somebody else): then what it's centred on, drawn over from the camera between EAR_FAR and EAR_NEAR
// of zoom. Every sound's distance goes from here (import `ear`); the listener's placed on it each frame (placeEar),
// facing the way the camera does.
const EAR_NEAR = 25, EAR_FAR = 80;
export const ear = new THREE.Vector3();
// (the listener isn't in the scene: placeEar updates its world matrix, which is what passes its place to the audio)
/**
 * Put the ear where it should be for this frame, once the camera's settled (see main.js).
 * @returns {void}
 */
export function placeEar() {
  const t = Math.max(0, Math.min(1, (controls.radius - EAR_NEAR)/(EAR_FAR - EAR_NEAR)));
  ear.copy(controls.target).lerp(camera.position, t);
  listener.position.copy(ear);
  listener.quaternion.copy(camera.quaternion);
  listener.updateMatrixWorld();
}
placeEar();
const context = listener.context;
// A gentle compressor over everything, holding a crowd of sounds together (not a brick wall: at 20:1 from -12dB it
// was, and every new sound ducked all the others, the lot swelling back a quarter-second later — sounds dropping in and
// out); HEADROOM in front of it, as its own make-up gain lifts everything back. Peaks are the limiter's, below.
const HEADROOM = 0.6;
const limiter = context.createDynamicsCompressor(), headroom = context.createGain();
limiter.threshold.value = -20; limiter.knee.value = 12; limiter.ratio.value = 3; limiter.attack.value = 0.01; limiter.release.value = 0.4;
headroom.gain.value = HEADROOM;
listener.setFilter(limiter);
listener.gain.disconnect();
listener.gain.connect(headroom).connect(limiter);
// (a compressor isn't a brick wall — a blast's first milliseconds get through before it clamps down, and its own make-up
// gain lifts the tail back up as it lets go — so after it, a lookahead limiter (limiter-processor.js) holding everything
// under LIMIT_CEILING; till that's loaded, or if it can't be, a soft clipper: untouched up to CLIP_KNEE, easing into the ceiling)
const LIMIT_CEILING = 0.9, LIMIT_RELEASE = 0.2;
const CLIP_KNEE = 0.8, CLIP_RANGE = 2; // (CLIP_RANGE: the loudest input shaped, past which it's held at the ceiling)
const clipIn = context.createGain(), clipper = context.createWaveShaper(), clipCurve = new Float32Array(4096);
for (let k = 0; k < clipCurve.length; k++) {
  const x = (k/(clipCurve.length - 1)*2 - 1)*CLIP_RANGE, over = Math.abs(x) - CLIP_KNEE, room = LIMIT_CEILING - CLIP_KNEE;
  clipCurve[k] = over <= 0 ? x : Math.sign(x)*(CLIP_KNEE + room*Math.tanh(over/room));
}
clipIn.gain.value = 1/CLIP_RANGE;
Object.assign(clipper, { curve: clipCurve, oversample: '4x' });
limiter.disconnect();
limiter.connect(clipIn).connect(clipper).connect(context.destination);
context.audioWorklet?.addModule(new URL('./limiter-processor.js', import.meta.url)).then(() => {
  const brickwall = new AudioWorkletNode(context, 'limiter', { outputChannelCount: [2], parameterData: { ceiling: LIMIT_CEILING, release: LIMIT_RELEASE } });
  limiter.disconnect();
  limiter.connect(brickwall).connect(context.destination);
}).catch(err => console.warn('Kallipolis: limiter failed, soft clipping instead', err));

// Inside a building (see buildings/interior.js), whatever's outside it is heard through the walls: everything out there —
// traffic, weather, the city — goes by way of `outdoors`, a lowpass and a drop in level that stand wide open until the
// room's entered, then close to MUFFLED_HZ and MUFFLED_LEVEL. What's in the room with you (someone talking, their steps)
// goes straight to the ear: a sound says where it is with heardFrom, which picks.
const MUFFLED_HZ = 450, MUFFLED_LEVEL = 0.55, OPEN_HZ = 22000, MUFFLE_TIME = 0.015;
const walls = context.createBiquadFilter(), wallsLevel = context.createGain();
walls.type = 'lowpass';
walls.frequency.value = OPEN_HZ;
walls.Q.value = 0.5;
/** Where anything outside goes on its way to the ear, muffled while you're indoors. */
export const outdoors = walls;
walls.connect(wallsLevel).connect(listener.getInput());
let inRoom = null; // (x, y, z) => whether that's in the room you're in; null while outdoors
/**
 * Go indoors, or back out: sounds outside muffled or not.
 * @param {?function(number, number, number): boolean} contains - whether a point's in the room with you; null to go out
 * @returns {void}
 */
export function setIndoors(contains) {
  inRoom = contains;
  const now = context.currentTime;
  walls.frequency.setTargetAtTime(contains ? MUFFLED_HZ : OPEN_HZ, now, MUFFLE_TIME);
  wallsLevel.gain.setTargetAtTime(contains ? MUFFLED_LEVEL : 1, now, MUFFLE_TIME);
}
/**
 * Where a sound at `at` should go: straight to the ear if it's in the room with you, through the walls if not.
 * @param {{x: number, y: number, z: number}} at
 * @returns {AudioNode}
 */
export const heardFrom = (at, kind) => inRoom?.(at.x, at.y, at.z) ? inside(kind) : outdoorsOf(kind);

// Sound levels (Options > Sound levels: see ui/sound-levels.js): each kind of sound — people, traffic, the city's
// ambience, music (the pubs': audio/pub-music.js) — goes by way of its own level, one for the room you're in and one through the walls; anything of no kind
// (a blast, a door) only has the master level over everything. Like mute, they're the browser's preference, remembered
// by ui/sound-levels.js rather than saved with the project.
export const LEVEL_KINDS = ['peds', 'traffic', 'ambience', 'music'];
const buses = Object.fromEntries(LEVEL_KINDS.map(kind => {
  const bus = { in: context.createGain(), out: context.createGain() };
  bus.in.connect(listener.getInput());
  bus.out.connect(walls);
  return [kind, bus];
}));
/** Where a sound of `kind` in the room with you goes (the ear itself, for a sound of no kind). */
export const inside = kind => buses[kind]?.in ?? listener.getInput();
/** Where a sound of `kind` outside goes, muffled while you're indoors (`outdoors`, for a sound of no kind). */
export const outdoorsOf = kind => buses[kind]?.out ?? walls;
let master = 1;
const levels = Object.fromEntries(LEVEL_KINDS.map(kind => [kind, 1]));
/**
 * Set how loud a kind of sound is, or 'master' for everything.
 * @param {'master'|'peds'|'traffic'|'ambience'|'music'} kind
 * @param {number} level - 0 to 1
 * @returns {void}
 */
export function setLevel(kind, level) {
  if (kind === 'master') { master = level; listener.setMasterVolume(muted ? 0 : master); return; }
  levels[kind] = level;
  buses[kind].in.gain.value = buses[kind].out.gain.value = level;
}
export const levelOf = kind => kind === 'master' ? master : levels[kind];

// Browsers keep audio suspended until the page has been interacted with: wake it on the first press.
function unlock() {
  if (context.state === 'suspended') context.resume();
  if (context.state === 'running') ['pointerdown', 'keydown'].forEach(type => window.removeEventListener(type, unlock, true));
}
['pointerdown', 'keydown'].forEach(type => window.addEventListener(type, unlock, true));

// Switched away to another tab, it goes quiet: the audio's suspended (which would otherwise leave the rain, the engines
// and the hum droning on unchanged, the frames that steer them having stopped too) and picked up again on coming back.
let hiddenAway = false; // (suspended by this rather than never woken, so coming back doesn't wake it before a press has)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (context.state === 'running') { hiddenAway = true; context.suspend(); }
  } else if (hiddenAway) { hiddenAway = false; context.resume(); }
});

// The Sound toggle in World settings (see ui/sound.js) mutes everything, the engine loop included, at the listener.
let muted = false;
/**
 * Mute or unmute every sound.
 * @param {boolean} on
 * @returns {void}
 */
export function setMuted(on) {
  muted = on;
  listener.setMasterVolume(on ? 0 : master);
}
export const isMuted = () => muted;

// A looping voice (an engine, a buzz…) handed from one thing to another fades out over HAND_OVER before it moves and
// takes up its new one's sound, rather than jumping there mid-note (a click; a burst of them as the camera swoops about).
const HAND_OVER = 0.03;
/** Start handing `voice` over: `gain` (its output) fades out, and handingOver holds it till then. */
export function handOver(voice, gain, now) { gain.setTargetAtTime(0, now, HAND_OVER/4); voice.movesAt = now + HAND_OVER; }
/** Whether `voice` is still fading out to be handed over (leave it be till then). */
export const handingOver = (voice, now) => now < (voice.movesAt ?? 0);

// ZzFX's own master volume would scale every sample down: the listener's gain sets the level instead.
ZZFX.volume = 1;
const buffers = {}; // name -> [variant -> [layer -> AudioBuffer]]
function variantsOf(name) {
  if (!buffers[name]) buffers[name] = Array.from({ length: VARIANTS }, () => SOUNDS[name].map(zzfxBuffer));
  return buffers[name];
}

// Directional sound (Options > Sound levels > Directional): 'off' pans left/right only (equalpower); 'hybrid' gives the
// HRTF_SLOTS nearest one-shots within HRTF_NEAR full 3D (HRTF) too; 'full' gives every sound HRTF (costly with many at once).
// The possessed person's own sounds are never panned (setSelf): they'd be left behind as they run.
export const DIRECTIONAL = ['off', 'hybrid', 'full'];
const HRTF_SLOTS = 6, HRTF_NEAR = 40, SELF_NEAR = 1.2;
let directional = 'hybrid', hrtfVoices = 0, self = null;
export const setDirectional = mode => { if (DIRECTIONAL.includes(mode)) directional = mode; };
export const directionalMode = () => directional;
/** The panning model for a sound that plays on (a loop): HRTF on 'full', and on 'hybrid' too if `few` (aircraft). */
export const loopPanning = (few = false) => directional === 'full' || (few && directional === 'hybrid') ? 'HRTF' : 'equalpower';
/** The possessed person (null when nobody is): sounds right by them are heard unpanned. */
export const setSelf = p => { self = p; };
const isSelf = at => self?.mode === 'possessed' && Math.hypot(at.x - self.x, at.z - self.z) < SELF_NEAR;
/**
 * A panner for a one-shot at `at` (by the directional setting), or a plain gain if it's the possessed person's own.
 * @param {{x: number, y: number, z: number}} at
 * @param {AudioScheduledSourceNode} source - what plays it, to free its HRTF slot when it ends
 * @param {{refDistance: number, maxDistance?: number, rolloff?: number}} options
 * @returns {AudioNode}
 */
export function oneShotPanner(at, source, { refDistance, maxDistance, rolloff = 1 }) {
  if (isSelf(at)) return context.createGain();
  const { x, y, z } = ear, hybrid = directional === 'hybrid' && hrtfVoices < HRTF_SLOTS && Math.hypot(at.x - x, at.y - y, at.z - z) < HRTF_NEAR;
  const panner = makePanner(context, hybrid || directional === 'full' ? 'HRTF' : 'equalpower');
  if (hybrid) { hrtfVoices++; source.addEventListener('ended', () => hrtfVoices--); }
  panner.distanceModel = maxDistance ? 'linear' : 'inverse';
  panner.refDistance = refDistance;
  panner.rolloffFactor = rolloff;
  if (maxDistance) panner.maxDistance = maxDistance;
  placePanner(panner, at.x, at.y, at.z);
  source.addEventListener('ended', () => letGoPanner(panner));
  return panner;
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
 * @param {number} [rate=1] - how fast it's played: above 1, higher and shorter; below, lower and longer
 * @param {AudioNode[]} [through=[]] - filters to pass it through on the way, in order
 * @param {string} [kind] - which sound level it goes by (see LEVEL_KINDS), if any
 * @returns {?AudioBufferSourceNode} what's playing it, to stop it early; or null, if it isn't played
 */
export function playBufferAt(buffer, at, volume, refDistance, maxDistance, rate = 1, through = [], kind) {
  if (muted || context.state !== 'running' || voices >= VOICES_MAX) return null;
  return startVoice(buffer, at, volume, refDistance, maxDistance, rate, through, kind);
}
function startVoice(buffer, at, volume, refDistance, maxDistance, rate = 1, through = [], kind, rolloff = 1, delay = 0) {
  const source = context.createBufferSource(), gain = context.createGain();
  const panner = oneShotPanner(at, source, { refDistance, maxDistance, rolloff });
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.value = volume;
  [...through, gain].reduce((from, to) => from.connect(to), source).connect(panner).connect(heardFrom(at, kind));
  voices++;
  source.onended = () => { voices--; panner.disconnect(); };
  source.start(context.currentTime + delay);
  return source;
}
/**
 * Builds a ZzFX sound's samples into an AudioBuffer (the layer lists as in SOUNDS).
 * @param {number[]} layer
 * @returns {AudioBuffer}
 */
export function zzfxBuffer(layer) {
  const made = prewarmed.get(layer);
  if (made?.length) return made.shift();
  return bufferOf(ZZFX.buildSamples(...layer), layer);
}
// ZzFX's bit crush holds each value for a while, and a layer's lowpass only runs once per hold: the steps put back the highs
// it was meant to take out (static), and the filter, run that slowly, holds a blast's rumble at full roar through its
// release, heaving far below hearing. So such a layer's lowpassed again here (a biquad at its own cutoff) and faded out
// over its release and echo as ZzFX meant (squared, so it tails off); every layer's highpassed at SUBSONIC_HZ twice over —
// what's under it isn't heard, but it drives speakers into distortion and the limiter into pumping everything else
// (tearing); and every end's faded over FADE_OUT, as some stop short (a pop).
const FADE_OUT = 0.01, SUBSONIC_HZ = 35;
function biquad(samples, type, hz, rate) {
  const w = 2*Math.PI*hz/rate, alpha = Math.sin(w)/(2*Math.SQRT1_2), cos = Math.cos(w), a0 = 1 + alpha;
  const b1 = (type === 'lowpass' ? 1 - cos : -(1 + cos))/a0, b0 = b1/2*(type === 'lowpass' ? 1 : -1), a1 = -2*cos/a0, a2 = (1 - alpha)/a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i], y = b0*x + b1*x1 + b0*x2 - a1*y1 - a2*y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    samples[i] = y;
  }
}
function tidy(samples, layer) {
  const crush = layer[15], cutoff = -(layer[20] ?? 0), rate = ZZFX.sampleRate;
  if (crush && cutoff > 0) {
    biquad(samples, 'lowpass', cutoff, rate);
    const tail = Math.min(samples.length, Math.round(((layer[5] ?? 0) + (layer[16] ?? 0))*rate));
    for (let k = 0; k < tail; k++) samples[samples.length - tail + k] *= (1 - k/tail)**2;
  }
  biquad(samples, 'highpass', SUBSONIC_HZ, rate);
  biquad(samples, 'highpass', SUBSONIC_HZ, rate);
  const fade = Math.min(samples.length, Math.round(FADE_OUT*rate));
  for (let k = 1; k <= fade; k++) samples[samples.length - k] *= (k - 1)/fade;
}
function bufferOf(samples, layer) {
  tidy(samples, layer);
  const buffer = context.createBuffer(1, samples.length, ZZFX.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}
// Making a sound's samples can take a while — thunder's three takes are a seventh of a second's work — and each sound is
// otherwise only made the first time it's heard, so the game would stall just as the first car blew up. Instead every
// sound is made ahead, in a worker (see zzfx-worker.js), as soon as the page is up: zzfxBuffer hands back one of those
// if it's there, and only makes one itself if it isn't yet.
const prewarmed = new Map(); // layer → AudioBuffers made ahead for it, each handed out once
let worker = null, workerFailed = false, jobs = 0;
const waiting = new Map(); // job id → the layer it's for
/**
 * Have `count` takes of each of some ZzFX layers made ahead, off the page (see zzfxBuffer), for a sound whose takes
 * are made with zzfxBuffer the first time it's heard.
 * @param {number[][]} layers - the same layer arrays zzfxBuffer will be called with
 * @param {number} count - how many takes of each it will want
 * @returns {void}
 */
export function prewarm(layers, count) {
  if (workerFailed) return;
  try {
    worker ??= Object.assign(new Worker(new URL('./zzfx-worker.js', import.meta.url), { type: 'module' }), {
      onmessage: ({ data: { id, samples } }) => {
        const layer = waiting.get(id);
        waiting.delete(id);
        if (!prewarmed.has(layer)) prewarmed.set(layer, []);
        prewarmed.get(layer).push(bufferOf(samples, layer));
      },
      onerror: () => { workerFailed = true; }, // (no worker: each sound's made when it's first heard, as it would be anyway)
    });
  } catch { workerFailed = true; return; }
  for (const layer of layers) for (let k = 0; k < count; k++) { waiting.set(++jobs, layer); worker.postMessage({ id: jobs, layer }); }
}
prewarm(Object.values(SOUNDS).flat(), VARIANTS);

let voices = 0;
const source = new THREE.Vector3();
const recent = []; // { name, x, z, at } of what's been played lately, for SAME_SOUND_GAP

/**
 * A lowpass for a sound at `at`, the lower the further it is from the camera past `near`: for a voice, the formants that
 * make it sound like words go first, then the voice itself, so talk across a park is a murmur and not a crowd of
 * conversations.
 * @param {{x: number, y: number, z: number}} at
 * @param {number} near - how near it's heard unmuffled
 * @param {number} rate - how fast the top comes off past that
 * @returns {BiquadFilterNode}
 */
export function muffler(at, near, rate) {
  const { x, y, z } = ear, distance = Math.hypot(at.x - x, at.y - y, at.z - z);
  const muffle = context.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.Q.value = 0.5;
  muffle.frequency.value = Math.min(20000, 9000*Math.pow(near/Math.max(near, distance), rate));
  return muffle;
}

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
  const distance = ear.distanceTo(source.set(at.x, at.y, at.z)), near = NEAR_ONLY[name];
  if (near && distance > near.hear) return;
  const delay = distance/SPEED_OF_SOUND;
  const through = near ? [muffler(at, REACH[name], near.muffle)] : [];
  for (const buffer of layers) startVoice(buffer, at, volume, REACH[name] ?? REF_DISTANCE, 0, 1, through, KIND_OF[name], near?.rolloff ?? 1, delay + after);
}
