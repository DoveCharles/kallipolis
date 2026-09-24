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
import { boostMax, stopDriving } from './driving.js';
import { carMeshes } from './models.js';
import { carHeight, carLength, carModelOf, carScale, placing } from './placing.js';
import { blasts, cars, EXPLOSIVE_SCALE } from './state.js';

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
 * The car whose screen-space line from its wheels to its roof lies nearest (clientX, clientY) — within 35% of that line's
 * length or 10 pixels, whichever is greater — and of those the one nearest the camera, or -1 if there is none.
 * @param {number} clientX
 * @param {number} clientY
 * @param {{distance: number}} [out] - given the picked car's distance from the camera, for comparing across kinds
 * @returns {number} the car's index in cars, or -1
 */
export function pickCar(clientX, clientY, out) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), roof = new THREE.Vector3();
  let best = -1, bestDepth = Infinity;
  cars.forEach((car, i) => {
    if (car.li < 0) return;
    foot.set(car.x, Y_ROAD, car.z).project(camera);
    roof.set(car.x, Y_ROAD + carHeight(car), car.z).project(camera);
    if (Math.abs(foot.z) > 1 || Math.abs(roof.z) > 1) return;
    const ax = (foot.x + 1)/2*width, ay = (1 - foot.y)/2*height, bx = (roof.x + 1)/2*width, by = (1 - roof.y)/2*height;
    const lengthSq = (bx - ax)**2 + (by - ay)**2;
    const k = lengthSq > 0 ? Math.max(0, Math.min(1, ((clientX - ax)*(bx - ax) + (clientY - ay)*(by - ay))/lengthSq)) : 0;
    const off = Math.hypot(clientX - (ax + (bx - ax)*k), clientY - (ay + (by - ay)*k));
    if (off <= Math.max(10, Math.sqrt(lengthSq)*0.35) && foot.z < bestDepth) { best = i; bestDepth = foot.z; }
  });
  if (out && best >= 0) out.distance = camera.position.distanceTo(foot.set(cars[best].x, Y_ROAD, cars[best].z));
  return best;
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
/**
 * Explode a car where it stands, in its own paint, through explodeCar (bigger, and a blast killing what's around it, if
 * explosive) — and take it out of cars, so a replacement spawns in elsewhere as usual.
 * @param {number} i - index in cars
 * @returns {void}
 */
export function killCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  App.recordMoralityEvent?.('cars destroyed by player', car.plate ? car.plate.text : undefined);
  if (followedCar === i) stopFollowingCar();
  const paint = new THREE.Color(...(carModelOf(car)?.bodyColor ?? car.paint));
  // its body in blocks and its wheels, where it has a design (see car-wrecks.js); explodeCar adds its glass and flecks
  const { matrix, rotation, scale, position, up } = placing;
  position.set(car.x, Y_ROAD - (car.sinking?.drop ?? 0) - (car.floatDrop ?? 0) + (car.bumpY ?? 0), car.z);
  matrix.compose(position, rotation.setFromAxisAngle(up, car.heading), scale.setScalar(carScale(car)));
  throwCarWreck(carModelOf(car)?.wreck, matrix, car.paint);
  const wrecked = true, blastScale = car.traits?.explosive ? EXPLOSIVE_SCALE : 1;
  if (blastScale > 1) blasts.push({ x: car.x, y: Y_ROAD, z: car.z, scale: blastScale }); // (explosive: kills what's around it too, next update)
  if (/bus/i.test(carModelOf(car)?.name ?? '')) { // (a bus goes up in two blasts, one at each end)
    const offset = carLength(car)*0.25;
    [-1, 1].forEach(end => explodeCar({ x: car.x + Math.sin(car.heading)*offset*end, y: Y_ROAD, z: car.z + Math.cos(car.heading)*offset*end }, carHeight(car), { paint, wrecked }, blastScale));
  } else explodeCar({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), { paint, wrecked }, blastScale);
  cars.splice(i, 1);
  if (followedCar > i) followedCar--; // (a car ahead of it in the array, still being followed, keeps its place)
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
