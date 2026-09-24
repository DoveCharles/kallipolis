import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { camera, Y_ROAD } from '../../core/scene.js';
import { carHitbox } from './collisions.js';
import { drivenCar, goingUnder } from './driving.js';
import { BOX_CAR_LENGTH, BOX_CAR_WIDTH, carMeshes, carParts } from './models.js';
import { DEFAULT_HOLO, DEFAULT_RUST } from './special.js';
import { cars } from './state.js';
import { CAR_SHAKE, shake } from '../revive.js';
import { carHitboxDebugMesh } from './traffic.js';

// Drawing a car where it is: wheels, body sway and its instance (placeCar); its size (carScale, carLength, carWidth,
// carHeight), engine (engineOf) and headlights (forEachHeadlight).

const WHEEL_STEER_MAX = 0.6; // (radians)
/**
 * Roll a car's wheels by the distance it has covered (wheelSpin), and steer its steering wheels: the driven car by
 * steerHeld (so they turn standing still too), any other by the angle a wheelbase this long needs to turn as fast as the
 * car is going. Both are eased toward, so a jolt — being re-seated, say — doesn't flick them.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function turnWheels(car, dt) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  const turned = car.lastHeading == null ? 0 : Math.atan2(Math.sin(car.heading - car.lastHeading), Math.cos(car.heading - car.lastHeading));
  car.lastHeading = car.heading;
  if (!cm || !cm.wheelRadius || dt <= 0) return;
  car.wheelSpin = (car.wheelSpin + car.speed*dt/(cm.wheelRadius*carScale(car))) % (Math.PI*2);
  let steer = 0;
  if (car === drivenCar) steer = -car.steerHeld*WHEEL_STEER_MAX;
  else if (Math.abs(car.speed) > 0.5 && cm.wheelbase) steer = Math.atan(turned/dt*cm.wheelbase*carScale(car)/car.speed);
  steer = Math.max(-WHEEL_STEER_MAX, Math.min(WHEEL_STEER_MAX, steer));
  car.wheelSteer += (steer - car.wheelSteer)*Math.min(1, dt*10);
  swayBody(car, turned, dt);
}
// the body on its springs (see swayBody): how stiff they are and how much they damp (a lightly damped spring, so a lean
// overshoots and wobbles a little before it settles); radians of pitch per unit/s² of acceleration and of roll per unit/s²
// of cornering, and the most of each; and the extra nose-up of the driven car's throttle held right down, even standing
// still
const SUSPENSION_STIFFNESS = 90, SUSPENSION_DAMPING = 7;
const SWAY_PITCH_PER_ACCEL = 0.0035, SWAY_ROLL_PER_CORNERING = 0.007, SWAY_PITCH_MAX = 0.045, SWAY_ROLL_MAX = 0.1, SWAY_REV_PITCH = 0.015;
/**
 * Spring a car's body toward the lean of how it's being driven: its nose up about the rear axle while it speeds up (and
 * while the driven car is revving) and down as it brakes, and rolled out of a turn. The shader leans the body, not the wheels (see carBodySway).
 * @param {object} car
 * @param {number} turned - radians it turned this frame
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function swayBody(car, turned, dt) {
  const accel = Math.max(-40, Math.min(40, (car.speed - car.lastSpeed)/dt));
  car.lastSpeed = car.speed;
  car.accel += (accel - car.accel)*Math.min(1, dt*8); // (eased, so a single jolty frame doesn't kick it)
  const clampSway = (a, most) => Math.max(-most, Math.min(most, a));
  const pitchGoal = clampSway(car.accel*SWAY_PITCH_PER_ACCEL + (car === drivenCar ? (car.throttle ?? 0)*SWAY_REV_PITCH : 0), SWAY_PITCH_MAX);
  const rollGoal = clampSway(car.speed*turned/dt*SWAY_ROLL_PER_CORNERING, SWAY_ROLL_MAX);
  for (let left = Math.min(dt, 0.1); left > 0; left -= 0.02) { // (small steps, for the spring to stay steady)
    const step = Math.min(left, 0.02);
    car.bodyPitchRate += (SUSPENSION_STIFFNESS*(pitchGoal - car.bodyPitch) - SUSPENSION_DAMPING*car.bodyPitchRate)*step;
    car.bodyPitch += car.bodyPitchRate*step;
    car.bodyRollRate += (SUSPENSION_STIFFNESS*(rollGoal - car.bodyRoll) - SUSPENSION_DAMPING*car.bodyRollRate)*step;
    car.bodyRoll += car.bodyRollRate*step;
  }
}
export const placing = { matrix: new THREE.Matrix4(), rotation: new THREE.Quaternion(), scale: new THREE.Vector3(), position: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
const tilting = new THREE.Quaternion(), sideways = new THREE.Vector3(1, 0, 0); // (a sinking car's pitch, about its own sideways axis)
const rolling = new THREE.Quaternion(), forward = new THREE.Vector3(0, 0, 1); // (a terrible car's rock side to side while it hops, about its own length axis — see updateSpecialTraits)
/**
 * Put car `i` where it is: at Y_ROAD (plus its bumpY, sunk by its sinking.drop and/or its floatDrop), turned to its heading and scaled by
 * S.peopleSize and its own size trait (see carScale). It goes into its design's mesh at the next free instance slot (counted up in designCounts), with its
 * paint and wheel angles and plate packed alongside, or into the box car when it has no design; its place in the other
 * mesh is zeroed either way. Also writes its debug hitbox.
 * @param {object} car
 * @param {number} i - the car's index, for the box car's instance slot
 * @param {number[]} designCounts - one running instance count per design
 * @returns {void}
 */
export function placeCar(car, i, designCounts) {
  const { matrix, rotation, scale, position, up } = placing;
  rotation.setFromAxisAngle(up, car.heading);
  if (car.sinking) rotation.multiply(tilting.setFromAxisAngle(sideways, car.sinking.pitch)); // (nose down, into the water)
  if (car.sinking?.roll) rotation.multiply(rolling.setFromAxisAngle(forward, car.sinking.roll)); // (shaking as it climbs back out — see riseCar)
  if (car.bumpShake) rotation.multiply(rolling.setFromAxisAngle(forward, car.bumpShake)); // (rocking side to side while it hops, like a plane landing — see updateSpecialTraits)
  // (floatDrop: an aqua car settled into water — see updateFloating; bumpY: a terrible car hopping — see updateSpecialTraits)
  position.set(car.x, Y_ROAD - (car.sinking?.drop ?? 0) - (car.floatDrop ?? 0) + (car.bumpY ?? 0), car.z);
  if (car.reviving) shake(position, rotation, CAR_SHAKE*carScale(car)); // (blown up, before the bolt: see startCarRevive in follow.js)
  if (car.design != null && carMeshes[car.design]) {
    const cm = carMeshes[car.design], idx = designCounts[car.design]++;
    const holo = car.holo ?? DEFAULT_HOLO; // (a legendary car's foil/polychrome sheen, drawn by the shader itself — see carHoloOf)
    const rust = car.rust ?? DEFAULT_RUST; // (a terrible car's rust spots, likewise — see carRustOf)
    scale.setScalar(carScale(car));
    matrix.compose(position, rotation, scale);
    cm.mesh.setMatrixAt(idx, matrix);
    cm.paint.setXYZ(idx, car.paint[0], car.paint[1], car.paint[2]);
    cm.wheels.setXYZW(idx, car.wheelSpin, car.wheelSteer, car.bodyPitch, car.bodyRoll);
    cm.plates.setXYZW(idx, ...car.plate.packed);
    // the camera's bearing from the car, in the car's own local frame (world bearing to the camera, minus the car's
    // own heading) — not the car's raw heading, so the foil glint (applyCarHolo) reacts to where the camera is
    // looking from, not to the car simply turning under a viewer whose own relative angle hasn't changed.
    const toCamera = Math.atan2(camera.position.x - car.x, camera.position.z - car.z) - car.heading;
    cm.holo.setXYZW(idx, holo[0], holo[1], holo[2], toCamera);
    cm.rust.setXY(idx, rust[0], rust[1]);
    matrix.makeScale(0, 0, 0);
    carParts.body.setMatrixAt(i, matrix);
  } else {
    scale.set(car.width*carScale(car), car.height*carScale(car), car.length*carScale(car));
    matrix.compose(position, rotation, scale);
    carParts.body.setMatrixAt(i, matrix);
  }
  if (S.showRoadsafetyDebug) {
    const { halfLength, halfWidth } = carHitbox(car), h = carHeight(car);
    scale.set(halfWidth*2, h, halfLength*2);
    matrix.compose(position.setY(Y_ROAD + h*0.5), rotation, scale);
    carHitboxDebugMesh.setMatrixAt(i, matrix);
  }
}
/**
 * The scale a car is drawn and measured at: the global people/traffic scale, times its own size trait (cars without a
 * design have no traits yet — see refreshCarTraits — so read as 1 until one's assigned).
 * @param {object} car
 * @returns {number}
 */
export function carScale(car) { return S.peopleSize*(car.traits?.size ?? 1); }
/**
 * A car's height in world units: its design's, or the box car's own until it has a design.
 * @param {object} car
 * @returns {number}
 */
export function carHeight(car) { return (car.design != null && carMeshes[car.design] ? carMeshes[car.design].height : car.height)*carScale(car); }
/**
 * A car's design mesh data, or null before the models have loaded.
 * @param {object} car
 * @returns {?object}
 */
export function carModelOf(car) { return car.design != null ? carMeshes[car.design] : null; }
/**
 * A car's length in world units, from its design or from the box car. Asked for separately from carWidth, as the gap and
 * overlap tests want one without the other.
 * @param {object} car
 * @returns {number}
 */
// what the engine sounds need of a car (see audio/engine.js): where its engine is, how big it is against an ordinary car
// (bigger, lower), whether it's running — not stalled, sinking or burning — and its design, for the kind of engine
export const engineOf = car => ({ y: Y_ROAD + carHeight(car)/2, size: carLength(car)/(BOX_CAR_LENGTH*S.peopleSize), running: !goingUnder(car) && !(car.stall > 0) && car.fuse == null, design: carModelOf(car)?.name });
// Each car on the road, for the light its headlights throw (see streetlights.js): where it is, which way it faces and how
// long it is. (A car going under the water has its lights put out.)
export function forEachHeadlight(fn) {
  cars.forEach(car => { if ((car.li >= 0 || car === drivenCar) && !goingUnder(car)) fn(car.x, car.z, car.heading, carLength(car)); });
}
export function carLength(car) { const cm = carModelOf(car); return (cm ? cm.length : car.length)*BOX_CAR_LENGTH*carScale(car); }
/**
 * A car's width in world units, from its design or from the box car.
 * @param {object} car
 * @returns {number}
 */
export function carWidth(car) { const cm = carModelOf(car); return (cm ? cm.width : car.width*BOX_CAR_WIDTH)*carScale(car); }
export const CAR_REAR_AXLE = 0.3;
/**
 * Turn a car by `by` radians about a point CAR_REAR_AXLE of its length back from car.x/car.z, keeping that point fixed, so
 * the back end follows the front round a turn.
 * @param {object} car
 * @param {number} by - radians
 * @returns {void}
 */
export function turnCar(car, by) {
  const back = CAR_REAR_AXLE*carLength(car), heading = car.heading + by;
  car.x += back*(Math.sin(heading) - Math.sin(car.heading));
  car.z += back*(Math.cos(heading) - Math.cos(car.heading));
  car.heading = heading;
}
