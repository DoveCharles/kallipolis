import * as THREE from 'three';
import { S, App } from '../../core/shared.js';
import { camera, Y_ROAD } from '../../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../../core/camera-controls.js';
import { WATER_LEVEL } from '../../water/water.js';
import { strikeLightning } from '../lightning.js';
import { explodeCar, splashCar } from '../giblets.js';
import { throwCarWreck } from '../car-wrecks.js';
import { carTypeOf } from '../car-types.js';
import { driving, controlInput } from '../possession.js';
import { boostMax, drivenCar, overOpenWater, stopDriving } from './driving.js';
import { canRespawn, REVIVE_SHAKE_TIME } from '../revive.js';
import { carMeshes } from './models.js';
import { carHeight, carLength, carWidth, carModelOf, carScale, placing } from './placing.js';
import { blasts, cars, EXPLOSIVE_SCALE } from './state.js';
import { buildingHit, lightFuse } from './collisions.js';
import { registerHealthKind, resetHealth } from '../../core/health.js';

// The followed car (camera, card, thumbnail) and taking a car out (killCar, drownCar, smiteCar).

// ============================================================ CAR CAMERA  ============================================================
// The view stays on the car clicked in World mode, and the car card (car-card.js,
// App.showCarCard) names it, its mood, and what it loves and hates from assets/cars.txt by its type (carTypeOf in
// car-types.js).
export let followedCar = -1;
/**
 * What a car's called, for its card and for the morality notices: its registration, and its type and number within it
 * — "AB12 CDE (Taxi #3)" — or just the type while its model is still loading.
 * @param {object} car
 * @returns {string}
 */
function carLabel(car) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  const type = carTypeOf(cm ? cm.name : null, car.number);
  return cm ? `${car.plate.text} (${type.name} #${car.number})` : type.name;
}
/**
 * The nearest car whose box (see rayHitsCar) the ray through (clientX, clientY) passes through, or -1 if there is none.
 * @param {number} clientX
 * @param {number} clientY
 * @param {{distance: number}} [out] - given the picked car's distance from the camera, for comparing across kinds
 * @returns {number} the car's index in cars, or -1
 */
export function pickCar(clientX, clientY, out) {
  if (!S.peopleEnabled) return -1;
  pickRay.setFromCamera(pickPoint.set(clientX/window.innerWidth*2 - 1, 1 - clientY/window.innerHeight*2), camera);
  const { origin, direction } = pickRay.ray;
  let best = -1, bestT = Infinity;
  cars.forEach((car, i) => {
    if (car.li < 0) return;
    const t = rayHitsCar(car, origin, direction);
    if (t < bestT) { best = i; bestT = t; }
  });
  if (out && best >= 0) out.distance = bestT;
  return best;
}
const pickRay = new THREE.Raycaster(), pickPoint = new THREE.Vector2();
const PICK_PAD = 0.005; // (padding round a car's box, per unit of distance from the camera — keeps far cars clickable)
/**
 * Where a ray first meets a car's box (its length, width and height, turned to its heading, sat where placeCar draws it).
 * @param {object} car
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} direction - normalised
 * @returns {number} distance along the ray, or Infinity if it misses
 */
function rayHitsCar(car, origin, direction) {
  const baseY = Y_ROAD - (car.sinking?.drop ?? 0) - (car.floatDrop ?? 0) + (car.bumpY ?? 0);
  const h = carHeight(car);
  const pad = Math.hypot(car.x - origin.x, baseY + h*0.5 - origin.y, car.z - origin.z)*PICK_PAD;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const ox = origin.x - car.x, oz = origin.z - car.z;
  const o = [ox*c - oz*s, origin.y - baseY, ox*s + oz*c], d = [direction.x*c - direction.z*s, direction.y, direction.x*s + direction.z*c];
  const halfWidth = carWidth(car)/2 + pad, halfLength = carLength(car)/2 + pad;
  const lo = [-halfWidth, -pad, -halfLength], hi = [halfWidth, h + pad, halfLength];
  let near = 0, far = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return Infinity; continue; }
    let t1 = (lo[a] - o[a])/d[a], t2 = (hi[a] - o[a])/d[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1); far = Math.min(far, t2);
    if (near > far) return Infinity;
  }
  return near > 0 ? near : Infinity; // (the camera inside a car's box isn't a click on it)
}
/**
 * Follow the car pickCar finds at a point on the screen: the camera's radius limits are set from the car's height, and its
 * card is shown with its type's name, plate and number. With no car there it stops following.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {void}
 */
export function followCarAt(clientX, clientY) {
  const i = pickCar(clientX, clientY);
  if (i < 0) { stopFollowingCar(); return; }
  followCar(cars[i]);
}
/**
 * Follow a car, as a click on it would (see followCarAt) — for the favorites (ui/favorites.js), which keep hold of the
 * car itself, since its place in cars shifts as others are blown up.
 * @param {object} car
 * @returns {boolean} false if it's gone (blown up, or the traffic thinned out)
 */
export function followCar(car) {
  const i = cars.indexOf(car);
  if (i < 0) return false;
  followedCar = i;
  const h = carHeight(cars[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9));
  const type = carTypeOf(car.design != null ? carMeshes[car.design].name : null, car.number);
  App.showCarCard(i, { ...type, name: carLabel(car) }, car);
  const max = boostMax(car);
  App.setCarBoost(car.boostLeft ??= max, max, car.boostLocked); // (its level as it already stands — full, unless it's spent some since last driven)
  return true;
}
/**
 * Stop driving and following (stopDriving), reset the camera's radius limits and hide the card.
 * @returns {void}
 */
export function stopFollowingCar() {
  if (followedCar < 0) return;
  stopDriving();
  followedCar = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hideCarCard();
}
const CHASE_HOLD = 1500, CHASE_EASE = 0.3, CHASE_PHI = 1.25; // (ms; the share of the way back it's asked for each frame)
/**
 * Ease the camera round behind a driven car and a little above it (CHASE_PHI), unless the mouse has swung it somewhere
 * within the last CHASE_HOLD ms, or the car is standing still.
 * @param {object} car - the driven car
 * @returns {void}
 */
export function chaseCamera(car) {
  if (performance.now() - driving.lookedAt < CHASE_HOLD || (Math.abs(car.speed) < 1 && driving.lookedAt > -Infinity)) return;
  const behind = car.speed < -0.5 && controlInput().forward < 0 ? car.heading : car.heading + Math.PI; // (reversing on purpose, it looks back over the boot — but not when it's been thrown back)
  controls.goalTheta = controls.theta + CHASE_EASE*Math.atan2(Math.sin(behind - controls.theta), Math.cos(behind - controls.theta));
  controls.goalPhi = controls.phi + CHASE_EASE*(CHASE_PHI - controls.phi);
}
// A car whose health runs out is set burning (lightFuse): it blows up when the fuse is out (see burnFuse and updateTraffic),
// or, with a respawn left, shakes and comes back (killCar → startCarRevive, which puts its health back to full).
registerHealthKind('car', { max: 800, die: car => {
  if (car.fuse != null || car.reviving) return;
  if (car === drivenCar) { // (the driver is thrown out, and it burns where it is — not where stopDriving respawns it, when it can't be seated back on a lane)
    const at = { x: car.x, z: car.z, heading: car.heading };
    stopDriving();
    if (!car.kick) Object.assign(car, at);
  }
  lightFuse(car);
} });
/**
 * Explode a car where it stands, in its own paint, through explodeCar (bigger, and a blast killing what's around it, if
 * explosive) — and take it out of cars (unless it has a respawn left: startCarRevive), so a replacement spawns in elsewhere as usual.
 * @param {number} i - index in cars
 * @returns {void}
 */
export function killCar(i) {
  const car = cars[i];
  if (!car || car.li < 0 || car.reviving) return;
  const survives = canRespawn(car); // (it still blows up, but stays whole: see startCarRevive)
  if (!survives) {
    App.recordMoralityEvent?.('cars destroyed by player', car.plate ? car.plate.text : undefined);
    if (followedCar === i) stopFollowingCar();
  }
  const paint = new THREE.Color(...(carModelOf(car)?.bodyColor ?? car.paint));
  // its body in blocks and its wheels, where it has a design (see car-wrecks.js); explodeCar adds its glass and flecks
  const { matrix, rotation, scale, position, up } = placing;
  position.set(car.x, Y_ROAD - (car.sinking?.drop ?? 0) - (car.floatDrop ?? 0) + (car.bumpY ?? 0), car.z);
  matrix.compose(position, rotation.setFromAxisAngle(up, car.heading), scale.setScalar(carScale(car)));
  if (!survives) throwCarWreck(carModelOf(car)?.wreck, matrix, car.paint);
  const wrecked = !survives, blastScale = car.traits?.explosive ? EXPLOSIVE_SCALE : 1;
  if (blastScale > 1) blasts.push({ x: car.x, y: Y_ROAD, z: car.z, scale: blastScale }); // (explosive: kills what's around it too, next update)
  if (/bus/i.test(carModelOf(car)?.name ?? '')) { // (a bus goes up in two blasts, one at each end)
    const offset = carLength(car)*0.25;
    [-1, 1].forEach(end => explodeCar({ x: car.x + Math.sin(car.heading)*offset*end, y: Y_ROAD, z: car.z + Math.cos(car.heading)*offset*end }, carHeight(car), { paint, wrecked }, blastScale));
  } else explodeCar({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), { paint, wrecked }, blastScale);
  if (survives) { startCarRevive(car); return; }
  cars.splice(i, 1);
  if (followedCar > i) followedCar--; // (a car ahead of it in the array, still being followed, keeps its place)
}
/**
 * A car with a respawn left, just blown up: whole, stopped where it is (its driver thrown out), shaking (see placeCar)
 * for REVIVE_SHAKE_TIME until updateCarRevive's bolt brings it back.
 * @param {object} car
 * @returns {void}
 */
function startCarRevive(car) {
  if (car === drivenCar) stopDriving();
  car.revived = true;
  car.reviving = { timer: REVIVE_SHAKE_TIME };
  car.fuse = null; car.speed = 0; car.stall = 0;
  resetHealth(car, 'car');
}
/**
 * A reviving car, each frame: once it's shaken long enough, lightning strikes it and it drives on as it was.
 * @param {object} car
 * @param {number} dt
 * @returns {void}
 */
export function updateCarRevive(car, dt) {
  if ((car.reviving.timer -= dt) > 0) return;
  car.reviving = null;
  strikeLightning({ x: car.x, y: Y_ROAD + carHeight(car), z: car.z });
}
const LAND_REACH = 60, LAND_STEP = 1; // (how far a car gone under looks for land to respawn on, in what steps)
/**
 * The respawn trait, gone under: out of the water in a splash and onto the nearest land (clear of the water by most of
 * its length), where lightning strikes it — a knocked car then drives back to its lane, a driven one carries on driven.
 * @param {object} car
 * @returns {boolean} false without a respawn left or land in reach: it drowns after all (drownCar)
 */
export function respawnFromWater(car) {
  if (!canRespawn(car)) return false;
  const land = nearestLand(car, carLength(car)*0.6);
  if (!land) return false;
  splashCar({ x: car.x, y: WATER_LEVEL, z: car.z }, carHeight(car));
  if (car.kick) { car.kick.x += land.x - car.x; car.kick.z += land.z - car.z; } // (a knocked car's place is its kick off its lane: see sinkKnockedCar)
  car.x = land.x; car.z = land.z;
  car.sinking = null; car.speed = 0;
  car.revived = true;
  strikeLightning({ x: car.x, y: Y_ROAD + carHeight(car), z: car.z });
  return true;
}
/** The nearest point off open water, `inset` further onto the land, where `car` fits without touching a building (buildingHit); null if there's none in reach. */
function nearestLand(car, inset) {
  const { x, z } = car;
  for (let r = LAND_STEP; r <= LAND_REACH; r += LAND_STEP) {
    const steps = Math.max(8, Math.ceil(2*Math.PI*r/LAND_STEP));
    for (let k = 0; k < steps; k++) {
      const a = k/steps*Math.PI*2, dx = Math.sin(a), dz = Math.cos(a);
      if (overOpenWater(x + dx*r, z + dz*r)) continue;
      const spot = { x: x + dx*(r + inset), z: z + dz*(r + inset) };
      if (!overOpenWater(spot.x, spot.z) && !buildingHit({ ...car, ...spot })) return spot;
    }
  }
  return null;
}
/**
 * Take a car under the water out at the surface, quietly rather than blowing up: a burst of its own splash
 * (splashCar) instead of a fireball. Otherwise just as killCar — out of cars, so a replacement spawns in elsewhere.
 * @param {number} i - index in cars
 * @returns {void}
 */
export function drownCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  App.recordMoralityEvent?.('cars destroyed by player', car.plate ? car.plate.text : undefined);
  if (followedCar === i) stopFollowingCar();
  splashCar({ x: car.x, y: WATER_LEVEL, z: car.z }, carHeight(car));
  cars.splice(i, 1);
  if (followedCar > i) followedCar--;
}
/**
 * The car card's Smite button: a bolt of lightning down on the car, and it blows up (killCar).
 * @param {number} i - index in cars
 * @returns {void}
 */
export function smiteCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  strikeLightning({ x: car.x, y: Y_ROAD + carHeight(car), z: car.z });
  // (and the cars around it go as they would round a burnt-out wreck; an explosive car's own bigger blast covers that)
  if (!car.traits?.explosive) blasts.push({ x: car.x, y: Y_ROAD, z: car.z, scale: 1 });
  killCar(i);
}
/**
 * The card's thumbnail: a followed car's design mesh and framing camera, with the paint and plate uniforms set to that
 * car's.
 * @param {number} i - index in cars
 * @returns {object|null} null for a car with no design yet, or while the models are still loading
 */
export function carThumbnailScene(i) {
  const car = cars[i];
  if (!car || car.design == null || !carMeshes[car.design]) return null;
  const cm = carMeshes[car.design];
  cm.thumbPaint.value.setRGB(car.paint[0], car.paint[1], car.paint[2]);
  cm.thumbPlate.value.fromArray(car.plate.packed);
  return { mesh: cm.thumbMesh, camera: cm.thumbCamera };
}
