import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { isOpenWater, WATER_LEVEL } from '../../water/water.js';
import { splashCar, splashUp } from '../giblets.js';
import { exclaim } from '../../audio/voices.js';
import { isFavoritePerson } from '../../ui/favorites.js';
import { possession } from '../possession.js';
import { clipNamed, drownedPerson, voiceOfPerson } from './people.js';
import { endActivity } from './peopleActivities.js';
import { unpossessPerson } from './peopleTracking.js';
import { canRespawn } from '../revive.js';
import { strikeLightning } from '../lightning.js';

const FALL_GRAVITY = 20, FALL_DRAG = 1.5, FALL_SPEED_MAX = 8; // (units a second squared; the share of their speed the water takes each second; the fastest they go in)
const TIP = 0.9, TIP_RATE = 3; // (how far forward they tip going in, in radians, and how fast)
const RISE_RATE = 12, RISE_ROLL = 0.08, RISE_SHAKES_PER_SECOND = 9, RISE_DONE = 0.005; // (as the car's, in driving.js)
const UNDER_TIME = 0.8, SURFACE_TIME = 1.2, FLOAT_TIME = 3; // (seconds under; seconds coming up; seconds floating)
// (at people size 1 and height 1, scaled by both: how far the back of someone floating face down is above the surface —
// about half of them showing; how far they bob, and how often; how fast the body sinks away, units a second; and how far
// below the surface it's gone once counted)
const FLOAT_LIFT = 0.14, BOB_HEIGHT = 0.03, BOB_PERIOD = 2.5, SETTLE_SPEED = 0.035, SETTLED_DEPTH = 0.05;
const BANK_REACH = 30, BANK_STEP = 0.5, BANK_IN = 0.6; // (how far a hearted person is looked for a bank from, in what steps, and how far onto it they're put)
const ABOVE_WATER = ['line', 'wander', 'leaving', 'possessed']; // (the modes someone can walk or be knocked into the water from)

const decks = () => [S.roadFootprint, S.pathFootprint];
const overOpenWater = (x, z) => isOpenWater(x, z, decks());
const sizeOf = p => p.height*S.peopleSize, heightOf = p => 1.7*sizeOf(p);
/** Whether someone is in the water and not their own master: going in, or drowned. */
export const inWater = p => !!p.water && p.water.stage !== 'rising';
/** Whether someone could go in from where they are: walking about at ground level, not raised, aboard or indoors. */
const canFallIn = p => ABOVE_WATER.includes(p.mode) && !p.footing && !p.traits.aqua && p.y < 1;

/**
 * Move someone's time in the water on a frame, or start it if they've just gone over open water. Called after they've
 * moved this frame, with where they were before, for how fast they were going in.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {number} dt - seconds since the last frame
 * @param {number} wasX - where they were at the start of the frame
 * @param {number} wasZ
 * @returns {void}
 */
export function updateWater(p, i, dt, wasX, wasZ) {
  const w = p.water;
  if (w && (w.drowned ? p.mode !== 'drowning' : !ABOVE_WATER.includes(p.mode))) p.water = null; // (reseated, spawned again or killed some other way)
  if (!p.water) {
    if (dt > 0 && canFallIn(p) && overOpenWater(p.x, p.z)) fallIn(p, (p.x - wasX)/dt, (p.z - wasZ)/dt);
    return;
  }
  if (dt <= 0) return;
  if (p.water.drowned) stillBody(p);
  ({ falling, rising, under, surfacing, floating, settling })[p.water.stage](p, i, dt);
}

/** Start someone going in, at the speed they were moving (capped), from the ground they're on. */
function fallIn(p, vx, vz) {
  const speed = Math.hypot(vx, vz), k = speed > FALL_SPEED_MAX ? FALL_SPEED_MAX/speed : 1;
  const was = p.water; // (part-risen: carry on from where they'd got to)
  p.water = { stage: 'falling', drop: was?.drop ?? 0, fall: 0, pitch: was?.pitch ?? 0, roll: 0, vx: vx*k, vz: vz*k, baseY: was?.baseY ?? p.y, splashed: false };
  p.push = null; p.punched = null; p.oneShot = null;
  p.crossStage = null; p.jc = null; // (a car yielding to them stops)
  if (!was) exclaim({ x: p.x, y: p.y + heightOf(p)*0.9, z: p.z }, voiceOfPerson(p));
}

/** Going in: carried on as the water slows them, falling faster and tipping forward; out again if they're carried back over land in time. */
function falling(p, i, dt) {
  const w = p.water, slowing = 1 - Math.min(1, FALL_DRAG*dt), height = heightOf(p), surface = w.baseY - WATER_LEVEL;
  w.vx *= slowing; w.vz *= slowing;
  p.x += w.vx*dt; p.z += w.vz*dt;
  w.fall += FALL_GRAVITY*dt;
  w.drop += w.fall*dt;
  w.pitch += Math.max(-TIP_RATE*dt, Math.min(TIP_RATE*dt, TIP - w.pitch));
  p.y = w.baseY - w.drop;
  p.moving = false;
  if (!w.splashed && w.drop >= surface) { w.splashed = true; splashCar({ x: p.x, y: WATER_LEVEL, z: p.z }, height); }
  if (w.drop >= surface + height) goUnder(p, i);
  else if (w.drop < surface && !overOpenWater(p.x, p.z)) Object.assign(w, { stage: 'rising', fall: 0, from: Math.max(w.drop, 1e-3), shakeTime: 0 });
}

/** Climbing back out: walking as usual again, while their drop and tip ease out quickly and they rock side to side. */
function rising(p, i, dt) {
  const w = p.water;
  if (canFallIn(p) && overOpenWater(p.x, p.z)) { fallIn(p, 0, 0); return; }
  const k = 1 - Math.exp(-RISE_RATE*dt);
  w.drop -= w.drop*k;
  w.pitch -= w.pitch*k;
  w.shakeTime += dt;
  w.roll = RISE_ROLL*Math.sqrt(w.drop/w.from)*Math.sin(w.shakeTime*RISE_SHAKES_PER_SECOND*Math.PI*2);
  p.y = w.baseY - w.drop;
  if (w.drop < RISE_DONE) p.water = null;
}

/**
 * Gone under: the hearted come up again on the nearest bank; anyone with a respawn left is struck back onto it
 * (respawnOnBank); anyone else has drowned — out of whatever they were doing
 * and out of the player's hands (though the camera stays on them), lying face down to float back up.
 */
function goUnder(p, i) {
  const w = p.water;
  if (isFavoritePerson(p.id)) { climbOut(p); return; }
  if (canRespawn(p) && respawnOnBank(p)) return;
  if (possession.index === i) { p.mode = 'drowning'; unpossessPerson(); } // (let go without being put back on a walkway: see unpossessPerson)
  endActivity(p);
  p.mode = 'drowning';
  p.fright = p.stun = p.please = p.attack = null;
  p.faceTo = null; p.lookAt = null;
  const fallen = clipNamed('Fallen');
  if (fallen) { p.clipA = p.clipB = fallen; p.fade = 1; }
  p.pose = 'Fallen';
  Object.assign(w, { stage: 'under', drowned: true, flip: true, pitch: 0, roll: 0, timer: UNDER_TIME, depth: p.y, x: p.x, z: p.z, heading: p.heading });
  stillBody(p);
}

/** Keep a drowned body where and how it went under, whatever else would move it: in the Fallen pose, not blending out of it. */
function stillBody(p) {
  const w = p.water, fallen = clipNamed('Fallen');
  p.x = w.x; p.z = w.z; p.heading = w.heading;
  p.push = null; p.oneShot = null; p.moving = false; p.faceTo = null; p.lookAt = null;
  p.pose = 'Fallen';
  if (fallen) { p.clipA = p.clipB = fallen; p.fade = 1; }
}

/**
 * Pause a drowned body's animation, once its frame's rows are written (see updatePeople): the Fallen pose's last frame
 * in both blended rows, no blink, and the head and face at rest.
 * @param {number} o - their offset into the arrays (their index times 4)
 * @param {Float32Array} anim - instanceAnim's array
 * @param {Float32Array} look - instanceLook's array
 * @returns {void}
 */
export function holdDrowned(o, anim, look) {
  const fallen = clipNamed('Fallen');
  if (fallen) anim[o] = anim[o+1] = fallen.start + fallen.frames - 1;
  anim[o+2] = 1; anim[o+3] = 0;
  look[o] = look[o+1] = look[o+2] = 0;
}

/** Put a hearted person on the nearest bank, rising out of the water there. */
function climbOut(p) {
  const bank = nearestBank(p.x, p.z);
  if (bank) { p.x = bank.x; p.z = bank.z; }
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 1; }
  const drop = p.water.baseY - WATER_LEVEL;
  p.water = { stage: 'rising', drop, fall: 0, pitch: 0, roll: 0, baseY: p.water.baseY, from: drop, shakeTime: 0 };
  p.y = p.water.baseY - drop;
  splashUp({ x: p.x, y: WATER_LEVEL, z: p.z }, heightOf(p));
}

/**
 * The respawn trait, going under: gone from the water in a splash and stood straight up on the nearest bank as a bolt
 * of lightning strikes there (see life/revive.js). False where there's no bank in reach: they drown after all.
 */
function respawnOnBank(p) {
  const bank = nearestBank(p.x, p.z);
  if (!bank) return false;
  splashUp({ x: p.x, y: WATER_LEVEL, z: p.z }, heightOf(p));
  p.x = bank.x; p.z = bank.z;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 1; }
  p.y = p.water.baseY;
  p.water = null;
  p.revived = true;
  strikeLightning({ x: p.x, y: p.y, z: p.z });
  return true;
}

/** The nearest point not over open water, a little way onto the land, or null if there's none in reach. */
function nearestBank(x, z) {
  for (let r = BANK_STEP; r <= BANK_REACH; r += BANK_STEP) {
    const steps = Math.max(8, Math.ceil(2*Math.PI*r/BANK_STEP));
    for (let k = 0; k < steps; k++) {
      const a = k/steps*Math.PI*2, dx = Math.sin(a), dz = Math.cos(a);
      if (!overOpenWater(x + dx*r, z + dz*r)) return { x: x + dx*(r + BANK_IN), z: z + dz*(r + BANK_IN) };
    }
  }
  return null;
}

/** Under a moment, then coming up. */
function under(p, i, dt) {
  const w = p.water;
  if ((w.timer -= dt) <= 0) Object.assign(w, { stage: 'surfacing', timer: 0 });
}

/** Coming up to the surface, face down, eased in; a small splash as they break it. */
function surfacing(p, i, dt) {
  const w = p.water, top = WATER_LEVEL + FLOAT_LIFT*sizeOf(p);
  w.timer = Math.min(SURFACE_TIME, w.timer + dt);
  const u = w.timer/SURFACE_TIME, eased = u*u*(3 - 2*u);
  p.y = w.depth + (top - w.depth)*eased;
  if (u >= 1) { splashUp({ x: p.x, y: WATER_LEVEL, z: p.z }, heightOf(p)*0.3); Object.assign(w, { stage: 'floating', timer: 0 }); }
}

/** Floating a while, bobbing. */
function floating(p, i, dt) {
  const w = p.water;
  w.timer += dt;
  p.y = WATER_LEVEL + (FLOAT_LIFT + Math.sin(w.timer/BOB_PERIOD*Math.PI*2)*BOB_HEIGHT)*sizeOf(p);
  if (w.timer >= FLOAT_TIME) Object.assign(w, { stage: 'settling' });
}

/** Sinking slowly away; counted once they're gone from sight. */
function settling(p, i, dt) {
  p.y -= SETTLE_SPEED*sizeOf(p)*dt;
  if (p.y < WATER_LEVEL - SETTLED_DEPTH*sizeOf(p)) drownedPerson(i);
}

const tipping = new THREE.Quaternion(), rocking = new THREE.Quaternion();
const sideways = new THREE.Vector3(1, 0, 0), lengthways = new THREE.Vector3(0, 0, 1);
/**
 * Turn someone's model for the water, on top of their heading: tipped forward going in, rocked climbing out, and face
 * down once drowned. Returns whether they're face down, when the model sits at p.y itself (its back at the surface)
 * rather than stood on it.
 * @param {Person} p - the person
 * @param {THREE.Quaternion} rotation - their heading, turned further in place
 * @returns {boolean} whether they're face down
 */
export function turnInWater(p, rotation) {
  const w = p.water;
  if (!w) return false;
  if (w.pitch) rotation.multiply(tipping.setFromAxisAngle(sideways, w.pitch));
  if (w.roll || w.flip) rotation.multiply(rocking.setFromAxisAngle(lengthways, (w.roll ?? 0) + (w.flip ? Math.PI : 0)));
  return !!w.flip;
}
