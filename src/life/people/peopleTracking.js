import * as THREE from 'three';
import { App, S } from '../../core/shared.js';
import { Y_ROAD, Y_SIDEWALK, camera } from '../../core/scene.js';
import { CAMERA_MIN_RADIUS, controls } from '../../core/camera-controls.js';
import { controlInput, endPossession, possession, startPossession } from '../possession.js';
import { FLEE_SPEED, PERSON_WALK_SPEED, followed, wrapAngle, buildingLabel, hasClip, isGone, modelScale, people, peopleNav, peopleRng, personModel, playOnce, setFollowed, setRiderFollowed } from './people.js';
import { HEAD_CENTER } from './peopleModel.js';
import { INDOORS_COOLDOWN, PUNCH_HIT_TIME, canBeKnockedOver, endActivity, knockOver } from './peopleActivities.js';
import { reseatPerson } from './peoplePathing.js';

// ============== following someone with camera  ============== 
// In World mode, clicking a person keeps the view centered on them as they move —
// orbiting and zooming as usual, and closer in than the camera otherwise can — with a card saying who they are
// (person-card.js).
//
// Let go by a click elsewhere, a pan, leaving World mode, or them leaving the crowd.

/**
 * How tall a person stands, this frame.
 * @param {Person} p - the person
 * @returns {number} their height, in world units
 */
export const personHeight = p => 1.7*p.height*S.peopleSize*p.heightScale;
/**
 * Find the person under a point on the screen (the one nearest the camera, if several are): a point within about their
 * width of the line up the middle of them, as they look on screen — or within a few pixels, for someone far off.
 * @param {number} clientX - the point's x, in pixels from the left of the window
 * @param {number} clientY - its y, in pixels from the top
 * @returns {number} their index in people, or -1
 */
export function pickPerson(clientX, clientY) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), head = new THREE.Vector3();
  let best = -1, bestDepth = Infinity;
  people.forEach((p, i) => {
    if (isGone(p)) return;
    foot.set(p.x, p.y, p.z).project(camera);
    head.set(p.x, p.y + personHeight(p), p.z).project(camera);
    if (Math.abs(foot.z) > 1 || Math.abs(head.z) > 1) return; // behind the camera, or beyond what it draws
    const ax = (foot.x + 1)/2*width, ay = (1 - foot.y)/2*height, bx = (head.x + 1)/2*width, by = (1 - head.y)/2*height;
    const lengthSq = (bx - ax)**2 + (by - ay)**2;
    const k = lengthSq > 0 ? Math.max(0, Math.min(1, ((clientX - ax)*(bx - ax) + (clientY - ay)*(by - ay))/lengthSq)) : 0;
    const off = Math.hypot(clientX - (ax + (bx - ax)*k), clientY - (ay + (by - ay)*k));
    if (off <= Math.max(8, Math.sqrt(lengthSq)*0.22) && foot.z < bestDepth) { best = i; bestDepth = foot.z; }
  });
  return best;
}

/**
 * Follow whoever's under a point on the screen, or stop following if nobody is.
 * @param {number} clientX - the point's x, in pixels from the left of the window
 * @param {number} clientY - its y, in pixels from the top
 * @returns {void}
 */
export function followPersonAt(clientX, clientY) {
  const i = pickPerson(clientX, clientY);
  if (i < 0) { stopFollowingPerson(); return; }
  followPerson(i);
}

/**
 * Follow whoever's at this place in the crowd: show their card, and let the camera in close.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function followPerson(i) {
  setFollowed(i);
  setRiderFollowed(-1);
  const h = personHeight(people[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9)); // swooping in, if the camera's far off
  App.showPersonCard(i, personModel ? personModel.isMan[i] === 1 : null);
  App.setPersonCardIndoors(isGone(people[i]) && people[i].indoors ? buildingLabel(people[i].indoors.building) : null);
}

// Where someone's head is and which way their face points, in the world, for the person card's headshot: from their pose
// this frame, worked out as the shader works it out — the head bone's pose (blended between rows and between the two clips),
// their head turned and tilted, and where they are.
const headshot = { head: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3(), distance: 0 };
const headPoseA = new Float32Array(12), headPoseB = new Float32Array(12);
const headMatrix = new THREE.Matrix4(), headTurn = new THREE.Matrix3(), lookTurn = new THREE.Matrix4(), lookTilt = new THREE.Matrix4();
const headshotInstance = new THREE.Matrix4(), headOffset = new THREE.Vector3();
/**
 * Read the head bone's pose (its matrix's top three rows) at a row of the bone texture, blending between rows.
 * @param {Float32Array} out - the twelve numbers to write the pose into
 * @param {number} row - the row of the bone texture, part-way between rows being part-way between frames
 * @returns {void}
 */
function headPoseAt(out, row) {
  const { boneData, boneWidth, headBone } = personModel, r = Math.floor(row), t = row - r;
  const a = (r*boneWidth + headBone*3)*4, b = ((r + 1)*boneWidth + headBone*3)*4;
  for (let k=0;k<12;k++) out[k] = boneData[a + k] + (boneData[b + k] - boneData[a + k])*t;
}

/**
 * Work out where someone's head is and which way their face points, in the world, for the person card's headshot.
 * @param {number} i - their index in people
 * @returns {{head: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, distance: number}} where to put the headshot
 * camera, which way it looks, which way is up, and how far off it draws
 */
export function headshotOf(i) {
  const anim = personModel.anim.array, look = personModel.look.array, o = i*4, fade = anim[o+2];
  headPoseAt(headPoseA, anim[o]);
  headPoseAt(headPoseB, anim[o+1]);
  const e = headPoseA.map((value, k) => value*fade + headPoseB[k]*(1 - fade));
  headMatrix.set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
  headTurn.setFromMatrix4(headMatrix);
  lookTurn.makeRotationY(look[o]).multiply(lookTilt.makeRotationX(look[o+1]));
  personModel.mesh.getMatrixAt(i, headshotInstance);
  headOffset.copy(HEAD_CENTER).applyMatrix4(lookTurn).applyMatrix3(headTurn);
  headshot.head.copy(personModel.headPivot).applyMatrix4(headMatrix).add(headOffset).applyMatrix4(headshotInstance);
  headshot.forward.set(0, 0, 1).applyMatrix4(lookTurn).applyMatrix3(headTurn).transformDirection(headshotInstance);
  headshot.up.set(0, 1, 0).applyMatrix4(lookTurn).applyMatrix3(headTurn).transformDirection(headshotInstance);
  headshot.distance = 4.6*modelScale(people[i]);
  return headshot;
}

// Someone blowing up nearby: everyone around notices (the nearer, the sooner), drops whatever they were doing, stares in
// shock — mouth open, face aghast — then runs off away from it for a while, more than twice as fast.
/**
 * Stop following whoever the camera's on, and hand it back to the player.
 * @returns {void}
 */
export function stopFollowingPerson() {
  if (followed < 0) return;
  if (possession.index === followed) unpossessPerson();
  setFollowed(-1);
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hidePersonCard();
}

//  ============== possessing someone  ============== 
// (see possession.js): whoever the camera's following is walked about from their own eyes.
//
// They drop whatever they were doing and walk wherever they're walked — onto the roads too, where cars can hit them — and
// when let go carry on from the nearest walkway, with the camera back behind them.
const EYE_NEAR = 0.2; // the nearest the view draws, from their eyes
let cameraNear = camera.near;
/**
 * Start walking someone the camera's following about from their own eyes (see possession.js): they drop whatever they
 * were doing, and the view comes in to where their head is.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function possessPerson(i) {
  const p = people[i];
  if (i !== followed || !p || isGone(p) || possession.index === i) return;
  endActivity(p);
  if (p.train) { p.train = null; p.trainCooldown = 40 + peopleRng()*50; }
  if (p.indoors) { p.indoors = null; p.indoorsCooldown = INDOORS_COOLDOWN; }
  p.crossStage = null; p.jc = null; p.fright = p.stun = p.please = null; p.oneShot = null;
  p.mode = 'possessed';
  p.onRoad = false;
  swing = null;
  if (!startPossession(i, p.heading + (p.traits.backwards ? Math.PI : 0))) { p.mode = 'wander'; reseatPerson(p); return; }
  cameraNear = camera.near;
  camera.near = EYE_NEAR;
  camera.updateProjectionMatrix();
}
/**
 * Let someone go, back to walking themselves: back into a hangout or onto the nearest walkway, with the camera behind
 * them looking the way they were.
 * @returns {void}
 */
export function unpossessPerson() {
  if (possession.index < 0) return;
  const i = possession.index, p = people[i];
  endPossession();
  swing = null;
  camera.near = cameraNear;
  camera.updateProjectionMatrix();
  if (!p || p.mode !== 'possessed') return;
  // back into a hangout they're standing in, else onto the nearest walkway
  p.mode = 'wander';
  p.onRoad = false;
  reseatPerson(p);
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 1; }
  // the camera behind them, looking the way they were
  const behind = possession.yaw + Math.PI;
  controls.goalTheta = controls.theta + wrapAngle(behind - controls.theta);
  controls.goalPhi = Math.max(controls.goalPhi, Math.PI*0.3);
}
/**
 * Walk someone being possessed where they're asked to go, this frame, over whatever's there.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {{x: number, y: number, z: number}} where they end up, at the height of the ground there
 */
export function walkPossessed(p, dt) {
  const { forward, right, run } = controlInput(), yaw = possession.yaw;
  const len = Math.hypot(forward, right);
  let x = p.x, z = p.z;
  if (len > 0) {
    const speed = PERSON_WALK_SPEED*p.stride*Math.max(0.5, p.traits.speed)*(run ? FLEE_SPEED*p.traits.boost : 1);
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    x += (fx*forward + rx*right)/len*speed*dt;
    z += (fz*forward + rz*right)/len*speed*dt;
  }
  // how high the ground is there: a hangout's, the road's, or the pavement's
  const area = peopleNav.areas.find(a => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && a.inside(x, z));
  p.onRoad = !area && peopleNav.onPavement(x, z);
  p.area = area ? peopleNav.areas.indexOf(area) : -1;
  return { x, y: area ? area.y : p.onRoad ? Y_ROAD : Y_SIDEWALK, z };
}
/**
 * Put the camera at the view from someone's eyes (or where they'd be, as a cuboid).
 * @param {number} i - their index in people
 * @returns {void}
 */
export function placePossessedCamera(i) {
  const p = people[i];
  if (personModel) camera.position.copy(headshotOf(i).head);
  else camera.position.set(p.x, p.y + personHeight(p)*0.92, p.z);
  camera.rotation.set(possession.pitch, possession.yaw + Math.PI, 0, 'YXZ');
}

// ---- throwing a punch yourself: possessing someone, a click swings their fist at whoever is in front of them (the click
// itself is possession.js's).
//
// Unlike a fight someone picks of their own ("punching"), nobody is walked up to and nobody is stared at afterwards: the
// swing plays wherever they are standing and lands on the nearest person within SWING_REACH ahead and SWING_ARC, at the
// moment the fist arrives — knocking them flat, as any punch does — or on nobody.
/** Who a swing can reach: how far ahead of them, and how near dead ahead they have to be — the same whatever anyone's size. */
const SWING_REACH = 3.4;
const SWING_ARC = Math.cos(Math.PI*4/9);
/** The punch being thrown: { timer } — how long until the fist lands. */
let swing = null;
/**
 * Swing a possessed person's fist at whoever's in front of them — the click itself is possession.js's.
 * @returns {void}
 */
export function punchFromPossession() {
  const p = people[possession.index];
  if (!p || p.mode !== 'possessed' || p.punched || swing || !hasClip('Punch') || !hasClip('Fall')) return;
  swing = { timer: PUNCH_HIT_TIME };
  playOnce(p, 'Punch');
}

/**
 * Run the swing they've thrown, each frame: when the fist lands, whoever's nearest in front of them takes it.
 * @param {Person} p - the person who swung
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateSwing(p, dt) {
  if (!swing || (swing.timer -= dt) > 0) return;
  swing = null;
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  /** @type {?Person} */
  let hit = null;
  let nearest = SWING_REACH;
  people.forEach(q => {
    if (q === p || isGone(q) || !canBeKnockedOver(q)) return;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d > nearest || d < 1e-3 || (dx*fx + dz*fz)/d < SWING_ARC) return;
    hit = q; nearest = d;
  });
  // a bee nearer than anyone takes it instead, and its colony comes for the puncher
  const bee = App.beeInPunch?.({ x: p.x, y: p.y, z: p.z, heading: p.heading, reach: nearest, arcCos: SWING_ARC, height: personHeight(p) });
  if (bee) { App.punchBee?.(bee, p); return; }
  if (!hit) return;
  knockOver(hit, p);
}
/** Drop a swing that's been thrown, for someone knocked down before it landed. */
export function cancelSwing() { swing = null; }

//  ============== Riding the trains  ============== 
// At TRAIN_RATE, someone near station pops to landing. At each stop after, they exit with probability  1/stationCount or guaranteed if two stations.
// Someone followed by the camera takes it with them (see followCarriage in trains.js).
// p.train: { node: Station, stage: 'approach'|'enter'|'wait'|'ride'|'exit', target: Vec3, side: number, along: number, lineId: string, timer: number }

/** The chance, at each walkway point near a station, of deciding to ride the trains. */


