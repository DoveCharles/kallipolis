import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { camera, Y_ROAD } from '../core/scene.js';
import { damage } from '../core/health.js';
import { playSound } from '../audio/sfx.js';
import { blowOutWall, leaveBuilding, roomClash } from '../buildings/interior.js';
import { destroyBuilding } from '../buildings/rubble.js';
import { wallDebris } from './giblets.js';
import { inRoom, people } from './people/people.js';
import { evacuateBuilding } from './people/peopleActivities.js';
import { carHeight, carLength } from './traffic/placing.js';
import { cars } from './traffic/state.js';

// A car that touched the room the view's in from a windowed wall's street side (see traffic/room-veer.js) smashes in: every
// windowed wall blows out first (blowOutWall, wallDebris, BANGS, a big shake), and the car's set burning as at no health (its
// fuse: see collisions.js) and carried on in (steerIn), turning for the middle of the room and slowing to a stop there. When it goes up, whoever's in the room near it
// is killed ('crashedinto') or hurt; EJECT_AFTER later the view's thrown back out, everyone left comes running out, and the
// building's knocked down for good (buildings/rubble.js) — the price of a plot too small beside a road.
const KILL_REACH = 3.5, HURT_REACH = 6, HURT = 40, THROW = 9, EJECT_AFTER = 1; // (reaches at people size 1; seconds)
const TURN_RATE = 2.5, MIN_SPEED = 4; // (radians a second it turns for the middle; the least it comes in at, units a second)
// the bangs as the walls go: seconds after, and how loud (the same sound's only played once in 0.06s: see audio/sfx.js)
const BANGS = [[0, 3], [0.1, 2.5], [0.25, 2.5], [0.45, 2], [0.7, 1.5]];
const WALL_SHAKE = [0.45, 1.4], CAR_SHAKE = [0.2, 0.7]; // (camera shake: how far at first, and for how long)
const WALL_COLOR = new THREE.Color(0xb9b1a6);
let pending = null; // { group, key, at, centre, car (till it goes up), last (where it last was), t }
let shake = null;   // { amp, time, left }
let bangs = [];     // [seconds till, volume, where]

const shakeCamera = ([amp, time]) => { if (!shake || amp >= shake.amp*shake.left/shake.time) shake = { amp: amp*S.peopleSize, time, left: time }; };

/**
 * A car smashing in through the room's `side` wall.
 * @param {object} car
 * @param {string} side - which windowed wall (see roomClash)
 * @returns {void}
 */
export function crashIntoRoom(car, side) {
  const c = roomClash();
  if (!c || pending) return;
  const ahead = carLength(car)/2, at = { x: car.x + Math.sin(car.heading)*ahead, y: Y_ROAD, z: car.z + Math.cos(car.heading)*ahead };
  c.windows.forEach(w => {
    blowOutWall(w.side);
    const from = w.side === side ? at : { x: w.mid.x, y: Y_ROAD, z: w.mid.z };
    wallDebris({ x: from.x, y: from.y + carHeight(car)*0.5, z: from.z }, 3*S.peopleSize, WALL_COLOR);
  });
  const heard = { x: (at.x + c.centre.x)/2, y: Y_ROAD + 1, z: (at.z + c.centre.z)/2 }; // (in the room, so not muffled as outside)
  bangs = BANGS.map(([t, volume]) => [t, volume, heard]);
  shakeCamera(WALL_SHAKE);
  car.roomRoll = { clash: c, crash: side, smashing: true }; // (drawn as it comes in: see room-veer.js)
  car.kick = null;
  const speed = Math.max(MIN_SPEED*S.peopleSize, Math.abs(car.speed));
  damage(car, Infinity); // (burning, its fuse lit: see collisions.js)
  pending = { group: c.group, key: c.key, at, centre: c.centre, car, speed, reach: Math.hypot(c.centre.x - car.x, c.centre.z - car.z) || 1, last: { x: car.x, z: car.z }, t: EJECT_AFTER };
}
// The car burning its way in: turning for the middle of the room, and slowing as it comes to a stop there.
function steerIn(car, dt) {
  const { centre } = pending, dx = centre.x - car.x, dz = centre.z - car.z, d = Math.hypot(dx, dz);
  if (d < 0.05) return;
  const want = Math.atan2(dx, dz), off = Math.atan2(Math.sin(want - car.heading), Math.cos(want - car.heading));
  car.heading += Math.max(-TURN_RATE*dt, Math.min(TURN_RATE*dt, off));
  const step = Math.min(d, pending.speed*Math.sqrt(d/pending.reach)*dt + 0.02*dt); // (slowing into the middle)
  car.x += Math.sin(car.heading)*step; car.z += Math.cos(car.heading)*step;
}
// Gone up (or blown up and waiting on its respawn): whoever's in the room near where it was, killed or hurt.
function carWentUp(at) {
  const kill = KILL_REACH*S.peopleSize, hurt = HURT_REACH*S.peopleSize;
  people.filter(inRoom).forEach(p => {
    const dx = p.x - at.x, dz = p.z - at.z, d = Math.hypot(dx, dz) || 1;
    if (d > hurt) return;
    const momentum = { x: dx/d*THROW, y: THROW*0.4, z: dz/d*THROW };
    damage(p, d <= kill ? Infinity : HURT, { by: 'car', cause: 'crashedinto', momentum, from: at });
  });
  shakeCamera(CAR_SHAKE);
}

/** Each frame (after the camera's placed): the camera shaken; after a crash, the car in, then the view out, the building emptied and knocked down. */
export function updateRoomCrash(dt) {
  if (shake && (shake.left -= dt) > 0) {
    const a = shake.amp*(shake.left/shake.time)**2;
    camera.position.x += (Math.random()*2 - 1)*a; camera.position.y += (Math.random()*2 - 1)*a*0.6; camera.position.z += (Math.random()*2 - 1)*a;
  } else shake = null;
  bangs = bangs.filter(b => (b[0] -= dt) > 0 || (playSound('explosion', b[2], b[1]), false));
  if (!pending) return;
  const car = pending.car;
  if (car) {
    if (cars.includes(car) && car.fuse != null && !car.reviving) { steerIn(car, dt); pending.last = { x: car.x, z: car.z }; return; }
    carWentUp(pending.last);
    pending.car = null;
  }
  if ((pending.t -= dt) > 0) return;
  const { group, key, at } = pending;
  pending = null;
  if (roomClash()?.key === key) App.stopFollowingBuilding?.();
  if (roomClash()?.key === key) leaveBuilding(); // (in with someone followed, not the building's card)
  evacuateBuilding(key, at);
  destroyBuilding(group);
}
