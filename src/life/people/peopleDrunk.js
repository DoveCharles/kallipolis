import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { knockOver } from './peopleActivities.js';
import { inWater } from './peopleWater.js';

// The drunk trait, on people: now and then they fall over by themselves (knocked flat, as by a punch from just ahead of
// them), and they weave as they walk — drawn SWAY_WIDTH either side of their path in a sine wave SWAY_LENGTH long, turned
// to follow it. Only drawn: where they really are, and their route, are untouched.
const FALL_CHANCE = 1/40; // (falls a second of walking)
const SWAY_WIDTH = 0.3, SWAY_LENGTH = 5, SWAY_EASE = 2; // (at people size 1; how fast the weave fades in and out as they start and stop, per second)
const walking = p => (p.mode === 'line' || p.mode === 'wander') && p.moving && !p.punched && !inWater(p);

/**
 * A drunk person's frame, after they've moved: how far they've walked (for the weave), the weave eased in or out, and
 * maybe a fall.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @param {number} wasX - where they were at the start of the frame
 * @param {number} wasZ
 * @returns {void}
 */
export function updateDrunk(p, dt, wasX, wasZ) {
  if (!p.traits.drunk) { p.swayAmp = 0; return; }
  const on = walking(p);
  p.swayAmp = (p.swayAmp ?? 0) + ((on ? 1 : 0) - (p.swayAmp ?? 0))*Math.min(1, SWAY_EASE*dt);
  p.swayDist = (p.swayDist ?? 0) + Math.hypot(p.x - wasX, p.z - wasZ);
  if (on && Math.random() < FALL_CHANCE*dt && knockOver(p, { x: p.x + Math.sin(p.heading), z: p.z + Math.cos(p.heading) })) p.punched.stupor = true; // (for their card: see personDoing)
}

const yaw = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
/**
 * Move where a drunk person's drawn onto their weave, and turn them along it.
 * @param {Person} p - the person
 * @param {THREE.Vector3} position - where they're drawn, moved sideways
 * @param {THREE.Quaternion} rotation - their heading, turned further
 * @returns {void}
 */
export function sway(p, position, rotation) {
  if (!p.swayAmp) return;
  const width = p.swayAmp*SWAY_WIDTH*S.peopleSize, k = 2*Math.PI/(SWAY_LENGTH*S.peopleSize), u = p.swayDist*k, off = width*Math.sin(u);
  position.x += Math.cos(p.heading)*off; position.z -= Math.sin(p.heading)*off;
  rotation.multiply(yaw.setFromAxisAngle(up, Math.atan(width*k*Math.cos(u))));
}
