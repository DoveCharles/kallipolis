import * as THREE from 'three';

// The respawn trait: once per person or car, a death leaves the body whole (a car still goes up in its fireball), shaking
// violently for REVIVE_SHAKE_TIME, until a bolt of lightning brings it back as it was. See killPerson in people/people.js
// (lying down, as if knocked over: p.punched.revive) and killCar in traffic/follow.js (standing still: car.reviving).
// Going under water instead puts them straight onto the nearest land under a bolt: respawnOnBank in people/peopleWater.js,
// respawnFromWater in traffic/follow.js.
export const REVIVE_SHAKE_TIME = 2.5;
export const PERSON_SHAKE = 0.06, CAR_SHAKE = 0.12; // (how far each is thrown about, before scaling by size)

/** Whether a person or car still has its one respawn: the trait, and not used yet (`revived`). */
export const canRespawn = thing => !!thing.traits?.respawn && !thing.revived;

const jolt = new THREE.Quaternion(), euler = new THREE.Euler();
/**
 * Jitter where something's drawn this frame, for a body shaking before it's revived.
 * @param {THREE.Vector3} position - moved by up to `size` each way (and up)
 * @param {THREE.Quaternion} rotation - twisted a little about every axis
 * @param {number} size
 * @returns {void}
 */
export function shake(position, rotation, size) {
  const r = () => Math.random()*2 - 1;
  position.x += r()*size; position.y += Math.random()*size*0.5; position.z += r()*size;
  rotation.multiply(jolt.setFromEuler(euler.set(r()*0.12, r()*0.3, r()*0.12)));
}
