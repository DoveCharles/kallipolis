import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { S } from '../../core/shared.js';
import { breathFx, confettiFx, fumeFx, heartFx, noteFx, starFx, sweatFx, tearFx, zedFx } from '../giblets.js';
import { personModel } from './people.js';
import { headPointOf } from './peopleTracking.js';

// ============================================================ moods on show
// What some moods (people/moods.txt) show beyond the eyes, by the traits they give: tears welling up under both eyes and
// falling (crying) or welled up under them and staying put (welling: see beginEmotes), love hearts floating off the top of the head now and then (lovestruck), white puffs of steam blowing
// off it in bursts (fuming) or snorted out of the nose (huffing), Zs drifting up (drowsy — whose eyes are held half shut:
// see updatePeople), a drop of sweat running down from the temple (sweating) or sweat flung off all round from the middle of the head (panicking),
// breath fogging in front of the mouth (freezing), sparkles round the head (starstruck), confetti bursting out all round (partying) and
// music notes floating off (singing). The blush (blushing) and a red or blue face are the skin's: see tintSkin in people.js.
// Tears, angry steam (fuming's and huffing's) and cold breath are carried along as they walk; the rest drifts off behind them. Each is as much as the trait (0 to 1) says. Only for someone drawn and near enough to make out their face (updatePeople).

const TEARS_PER_SECOND = 6;   // from each eye, crying 1 (😭): a stream, flung out (see spill below)
const TEAR_OUT = 0.5, TEAR_DOWN = 0.6; // how far in front of the eye a running tear wells up (so it doesn't sink into it), and below its bottom edge, in eye half-widths (a flung one leaves from the eye)
const HEARTS_PER_SECOND = 0.8; // lovestruck 1 (🥰)
// fuming 1 (😠): FUME_PUFFS_PER_SECOND while a burst lasts, bursts FUME_EVERY seconds apart, each FUME_BURST of that long
const FUME_PUFFS_PER_SECOND = 14, FUME_EVERY = 2.2, FUME_BURST = 0.35;
// huffing 1 (😤): HUFF_PUFFS_PER_SECOND from each nostril, in snorts HUFF_EVERY seconds apart, each HUFF_BURST long
const HUFF_PUFFS_PER_SECOND = 20, HUFF_EVERY = 1.6, HUFF_BURST = 0.25;
const ZEDS_EVERY = 0.9;              // drowsy 1 (😴): one Z this often, in a steady trail
const SWEAT_PER_SECOND = 0.5;        // sweating 1: a drop from one temple or the other
const PANIC_PER_SECOND = 14;         // panicking 1 (😱): drops flung off
// freezing 1 (🥶): BREATH_PUFFS_PER_SECOND while breathing out, one breath every BREATH_EVERY seconds, BREATH_OUT of that long
const BREATH_PUFFS_PER_SECOND = 16, BREATH_EVERY = 2.4, BREATH_OUT = 0.7;
const STARS_PER_SECOND = 5;          // starstruck 1 (🤩)
const CONFETTI_EVERY = 3, CONFETTI_POP = 30; // partying 1 (🥳): a pop of CONFETTI_POP scraps every CONFETTI_EVERY seconds
const NOTES_PER_SECOND = 0.9;        // singing 1 (🎵)
const EMOTE_TRAITS = ['crying', 'welling', 'lovestruck', 'fuming', 'huffing', 'drowsy', 'sweating', 'panicking', 'freezing', 'starstruck', 'partying', 'singing'];

const spot = new THREE.Vector3(), eye = new THREE.Vector3(), at = new THREE.Vector3(), ahead = new THREE.Vector3(), forward = new THREE.Vector3();
const count = (rate, dt) => Math.floor(rate*dt + Math.random());

// welling 1 (🥺): a squashed blue block of tear sat under each eye, WELL_SIZE of the eye's half-width across, as tall and deep as
// WELL_SQUASH says (each of those, times the trait)
const WELL_MAX = 256, WELL_SIZE = 0.55, WELL_SQUASH = new THREE.Vector3(1, 0.45, 0.6);
const wells = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x7cc8ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.85 }), WELL_MAX);
wells.name = 'WellFx'; wells.count = 0; wells.frustumCulled = false; wells.renderOrder = 2;
scene.add(wells);
const across = new THREE.Vector3(), upward = new THREE.Vector3(), outward = new THREE.Vector3(), wellMatrix = new THREE.Matrix4();

/**
 * Start a frame of moods on show: clear last frame's welled-up tears (updateEmotes puts back those still seen).
 * @returns {void}
 */
export function beginEmotes() {
  wells.count = 0;
}

/**
 * Show what someone's mood gives them for the `dt` seconds since the last frame.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {number} dt - seconds since the last frame
 * @param {number} t - the time now, in seconds
 * @returns {void}
 */
export function updateEmotes(p, i, dt, t) {
  const tr = p.traits;
  if (!EMOTE_TRAITS.some(name => tr[name] > 0) || !personModel || p.mode === 'dead' || p.water?.drowned) return;
  const face = personModel.face, height = 1.7*p.height*S.peopleSize;
  // (bursts at a time of their own for each person, so a crowd don't all puff together)
  const during = (every, burst, shift = 0) => (t/every + p.id*0.37 + shift) % 1 < burst/every;
  // (whether one of their beats `every` seconds apart has just come, in the `dt` since the last frame)
  const passed = (every, dt, t) => Math.floor(t/every + p.id*0.37) !== Math.floor((t - dt)/every + p.id*0.37);
  // the way their face looks, from the head spot `from` (in `at` once done)
  const facing = from => { headPointOf(i, from, at); headPointOf(i, spot.copy(from).setZ(from.z + 1), ahead); return forward.subVectors(ahead, at).normalize(); };
  if (tr.crying > 0) {
    const spill = Math.max(0, tr.crying*2 - 1), drip = 1 - spill; // (sobbing flings them out; below half, they just run down)
    for (const side of [1, -1]) {
      for (let k = count(TEARS_PER_SECOND*tr.crying, dt); k > 0; k--) {
        tearFx(at, facing(eye.set(side*face.eyeX, face.eyeLow - face.eyeHalf*TEAR_DOWN*drip, face.eyeFront + face.eyeHalf*TEAR_OUT*drip)), height, p, spill);
      }
    }
  }
  if (tr.welling > 0) {
    const size = face.eyeHalf*WELL_SIZE*Math.min(1, tr.welling);
    for (const side of [1, -1]) {
      if (wells.count >= WELL_MAX) break;
      const x = side*face.eyeX, y = face.eyeLow + size*WELL_SQUASH.y*0.5, z = face.eyeFront;
      headPointOf(i, eye.set(x, y, z), at);
      // (the head's own axes, as far across a head unit goes in the world: the block turns and tips with it)
      headPointOf(i, spot.set(x + 1, y, z), across).sub(at).multiplyScalar(size*WELL_SQUASH.x);
      headPointOf(i, spot.set(x, y + 1, z), upward).sub(at).multiplyScalar(size*WELL_SQUASH.y);
      headPointOf(i, spot.set(x, y, z + 1), outward).sub(at).multiplyScalar(size*WELL_SQUASH.z);
      wells.setMatrixAt(wells.count++, wellMatrix.makeBasis(across, upward, outward).setPosition(at));
    }
    wells.instanceMatrix.needsUpdate = true;
  }
  if (tr.lovestruck > 0 && count(HEARTS_PER_SECOND*tr.lovestruck, dt) > 0) heartFx(headPointOf(i, face.top, at), height);
  if (tr.fuming > 0 && during(FUME_EVERY, FUME_BURST)) {
    for (let k = count(FUME_PUFFS_PER_SECOND*tr.fuming, dt); k > 0; k--) fumeFx(headPointOf(i, face.top, at), height, p);
  }
  if (tr.huffing > 0 && during(HUFF_EVERY, HUFF_BURST)) {
    for (const side of [1, -1]) {
      for (let k = count(HUFF_PUFFS_PER_SECOND*tr.huffing, dt); k > 0; k--) {
        facing(eye.set(side*face.eyeHalf*0.25, face.nose.y - face.eyeHalf*0.2, face.nose.z));
        forward.y -= 0.5; forward.x += side*0.25*forward.z; forward.z -= side*0.25*forward.x; // (down and a little out, as a snort goes)
        breathFx(at, forward.normalize(), height, true, p);
      }
    }
  }
  if (tr.drowsy > 0 && passed(ZEDS_EVERY, dt, t) && Math.random() < tr.drowsy) {
    zedFx(headPointOf(i, eye.copy(face.top).setX(face.eyeX), at), height);
  }
  if (tr.sweating > 0 && count(SWEAT_PER_SECOND*tr.sweating, dt) > 0) {
    const side = Math.random() < 0.5 ? 1 : -1;
    sweatFx(headPointOf(i, eye.set(side*face.eyeX*1.3, face.eyeLow + face.eyeHalf*0.8, face.eyeFront - face.eyeHalf*1.2), at), forward.set(0, 0, 0), height);
  }
  if (tr.panicking > 0) {
    for (let k = count(PANIC_PER_SECOND*tr.panicking, dt); k > 0; k--) {
      const angle = Math.random()*Math.PI*2;
      sweatFx(headPointOf(i, eye.set(0, face.eyeLow + face.eyeHalf, face.top.z), at), forward.set(Math.cos(angle), 0, Math.sin(angle)), height, 1);
    }
  }
  if (tr.freezing > 0 && during(BREATH_EVERY, BREATH_OUT, 0.5)) {
    for (let k = count(BREATH_PUFFS_PER_SECOND*tr.freezing, dt); k > 0; k--) {
      facing(face.mouth); forward.y -= 0.2;
      breathFx(at, forward.normalize(), height, false, p);
    }
  }
  if (tr.starstruck > 0) {
    for (let k = count(STARS_PER_SECOND*tr.starstruck, dt); k > 0; k--) starFx(headPointOf(i, eye.set(0, face.eyeLow + face.eyeHalf, 0), at), height);
  }
  if (tr.partying > 0 && passed(CONFETTI_EVERY, dt, t)) {
    headPointOf(i, eye.set(0, face.top.y*0.5, face.top.z), at);
    for (let k = Math.round(CONFETTI_POP*tr.partying); k > 0; k--) confettiFx(at, height);
  }
  if (tr.singing > 0 && count(NOTES_PER_SECOND*tr.singing, dt) > 0) {
    noteFx(headPointOf(i, face.top, at), height);
  }
}
