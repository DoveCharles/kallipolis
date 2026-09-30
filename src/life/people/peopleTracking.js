import * as THREE from 'three';
import { App, S, buildingHolders } from '../../core/shared.js';
import { Y_ROAD, Y_SIDEWALK, camera } from '../../core/scene.js';
import { CAMERA_MIN_RADIUS, controls } from '../../core/camera-controls.js';
import { canTakeControl, controlInput, endPossession, possession, startPossession, HATES_POSSESSED_SPEED, rushed } from '../possession.js';
import { FLEE_SPEED, PEOPLE_MAX, PERSON_WALK_SPEED, followed, wrapAngle, buildingLabel, hasClip, moonwalkTurn, inRoom, isGone, modelScale, insideFor, people, peopleNav, peopleRng, personModel, playOnce, setFollowed, setRiderFollowed } from './people.js';
import { HAIR_ROW, HEAD_CENTER, PERSON_TRAIT_COLORS } from './peopleModel.js';

/** Their headsize trait as drawn (the Hair row's fourth number, 0 read as 1: see personLook). */
export const headSizeOf = i => personModel.traitData[(HAIR_ROW*PEOPLE_MAX + i)*4 + 3] || 1;
import { INDOORS_COOLDOWN, PUNCH_HIT_TIME, resumeTrainRide, setAwaited, swingSound, canBeKnockedOver, dodgePunch, endActivity, goAfter, knockOver, leaveGroup, sayGoodbye, standUp, talkWith } from './peopleActivities.js';
import { awaitsWatcher, endPrayerView, watchPrayer } from './peoplePrayer.js';
import { placeAtVertex, reseatPerson, walkBackToWalkway } from './peoplePathing.js';
import { carryPossessed, footingAt, nearestRaisedVertex, stepFooting } from './peopleFooting.js';
import { bloodSpeed, bloodlustSpeed, fallSpill, isBloodlusting } from './peopleBlood.js';
import { profileOf } from '../profiles.js';
import { IS_TOUCH } from '../../core/device.js';
import { setSelf } from '../../audio/sfx.js';
import { pointInPolygon } from '../../core/math.js';
import { carHitbox } from '../traffic/collisions.js';
import { carHeight } from '../traffic/placing.js';
import { cars } from '../traffic/state.js';
import { holdAtFences } from '../../zones/fences.js';
import { punchFence } from '../fence-smash.js';
import { damage } from '../../core/health.js';
import { buildingKey, buildingNumber, distToPolygonBoundary, footprintBounds, wallsOf } from '../../buildings/footprints.js';
import { buildingEnterable, buildingKindOf, buildingLabelName, buildingName, buildingTitle, buildingTypeOf } from '../../buildings/building-types.js';
import { openRoomDoor, roomBeyondDoor, roomDoorway, roomNear, roomThroughDoor, roomVisit, roomWalkable, someoneHome } from '../../buildings/interior.js';

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
 * width of the line up the middle of them, as they look on screen — or within a few pixels, for someone far off. From
 * inside a building, only those in its room.
 * @param {number} clientX - the point's x, in pixels from the left of the window
 * @param {number} clientY - its y, in pixels from the top
 * @param {{distance: number}} [out] - given the picked person's distance from the camera, for comparing across kinds
 * @returns {number} their index in people, or -1
 */
export function pickPerson(clientX, clientY, out) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), head = new THREE.Vector3();
  const indoors = !!App.isInsideBuilding?.();
  let best = -1, bestDepth = Infinity;
  people.forEach((p, i) => {
    if (indoors ? !inRoom(p) : isGone(p)) return;
    foot.set(p.x, p.y, p.z).project(camera);
    head.set(p.x, p.y + personHeight(p), p.z).project(camera);
    if (Math.abs(foot.z) > 1 || Math.abs(head.z) > 1) return; // behind the camera, or beyond what it draws
    const ax = (foot.x + 1)/2*width, ay = (1 - foot.y)/2*height, bx = (head.x + 1)/2*width, by = (1 - head.y)/2*height;
    const lengthSq = (bx - ax)**2 + (by - ay)**2;
    const k = lengthSq > 0 ? Math.max(0, Math.min(1, ((clientX - ax)*(bx - ax) + (clientY - ay)*(by - ay))/lengthSq)) : 0;
    const off = Math.hypot(clientX - (ax + (bx - ax)*k), clientY - (ay + (by - ay)*k));
    if (off <= Math.max(8, Math.sqrt(lengthSq)*0.22) && foot.z < bestDepth) { best = i; bestDepth = foot.z; }
  });
  if (out && best >= 0) { const p = people[best]; out.distance = camera.position.distanceTo(foot.set(p.x, p.y, p.z)); }
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
  if (awaitsWatcher(people[i])) { stopFollowingPerson(); setFollowed(i); setRiderFollowed(-1); followedInside = false; watchPrayer(i); return; } // (praying: face first, card after — see peoplePrayer.js)
  followPerson(i);
}

/**
 * Follow whoever's at this place in the crowd: show their card, and let the camera in close.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function followPerson(i) {
  endPrayerView();
  followedInside = false;
  setFollowed(i);
  setRiderFollowed(-1);
  const h = personHeight(people[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9)); // swooping in, if the camera's far off
  App.showPersonCard(i, personModel ? personModel.isMan[i] === 1 : null);
  doingShown = undefined;
  showFollowedDoing();
}

/** Whether the person followed was picked in the room the camera's in (see followPersonInside). */
export let followedInside = false;
/**
 * Show the card of someone in the room the camera's inside, beside the building's (its Smite button put away), and make
 * them the one the camera leaves the building with (see awaited in peopleActivities.js). The camera stays in the room.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function followPersonInside(i) {
  followedInside = true;
  setFollowed(i);
  setRiderFollowed(-1);
  setAwaited(i);
  App.showPersonCard(i, personModel ? personModel.isMan[i] === 1 : null, true);
  doingShown = undefined;
  showFollowedDoing();
}

// ---- what the followed person's card says they're up to (as a bee's says where it's got to in its round): worked out
// from whatever state they're in, most pressing first, and told to the card only when it changes
let doingShown;
const nameOf = q => { const i = people.indexOf(q); return i < 0 ? 'someone' : profileOf(q.id, personModel ? personModel.isMan[i] === 1 : null).name; };
const HANGOUTS = { park: ['in', 'the park'], plaza: ['in', 'the plaza'], beach: ['on', 'the beach'] };
/**
 * What someone's up to, in a few words, for their card.
 * @param {Person} p - the person
 * @returns {?string} what the card's Status says (null for nothing)
 */
export function personDoing(p) {
  if (p.mode === 'dead') return 'Dead';
  if (p.water) return p.mode === 'drowning' ? 'Drowned' : p.water.stage === 'rising' ? 'Climbing out of the water' : 'Falling into the water';
  if (p.mode === 'possessed') return 'Possessed';
  if (p.pray) return 'Praying';
  const k = p.punched;
  if (k && k.stage === 'brace') return 'Bracing for a punch';
  if (k && k.stage === 'crawl') return 'Crawling off the road';
  if (k && (k.stage === 'fall' || k.stage === 'down')) return k.stupor ? 'Fell over in a stupor' : 'Knocked flat by ' + nameOf(k.by);
  if (k && k.stage === 'rise') return 'Getting back up';
  const a = p.attack;
  if (a) {
    const who = nameOf(a.target);
    if (a.stage === 'chase') return a.revenge ? 'Out for revenge on ' + who : isBloodlusting(p) ? 'Out for ' + who + "'s blood" : 'Going after ' + who;
    if (a.stage === 'punch') return 'Punching ' + who;
    return 'Standing over ' + who;
  }
  if (p.fright) return p.fright.stage === 'flee' ? 'Running away' : 'Startled';
  if (p.stun) return p.stun.stage === 'held' ? 'Dazed' : 'Startled';
  if (p.please) return p.please.stage === 'held' ? 'Delighted' : 'Watching, delighted';
  if (p.mode === 'train' && p.train) {
    const stage = p.train.stage;
    const going = !!p.train.lift && p.train.lift.to === 'top';
    return stage === 'approach' || stage === 'toLanding' ? 'Off to the station' : stage === 'enter' ? 'Onto the platform' : stage === 'wait' ? 'Waiting for a train'
      : stage === 'ride' ? 'On a train' : stage === 'board' ? 'Getting on the train' : stage === 'alight' ? 'Getting off the train' : stage === 'liftWait' ? 'Waiting for the lift'
      : stage === 'liftIn' || stage === 'liftRide' || stage === 'liftOut' ? (going ? 'Going up in the lift' : 'Going down in the lift') : 'Leaving the station';
  }
  if (p.mode === 'indoors' && p.indoors) {
    const label = buildingLabel(p.indoors.building), stage = p.indoors.stage;
    if (stage === 'inside' && p.inRoom?.seat?.kind === 'cut' && p.inRoom.stage === 'sit' && !p.indoors.served) return 'Getting a haircut at ' + label;
    if (stage === 'inside' && p.inRoom?.cubicle) return p.inRoom.changing === 'go' ? 'Off to try some clothes on' : 'Trying clothes on at ' + label;
    return (stage === 'approach' ? 'Going into ' : stage === 'inside' ? 'Inside ' : 'Coming out of ') + label;
  }
  if (p.act === 'buy') {
    const what = { coffee: 'a coffee', beer: 'a pint' }[p.buy?.item] ?? 'a hot dog';
    return p.stage === 'go' ? 'Off to buy ' + what : p.stage === 'back' ? (p.snack ? 'Back on their way' : 'Giving up on ' + what) : 'Buying ' + what;
  }
  if (p.act === 'walk') { const other = p.group?.members.find(m => m !== p) ?? p.follow; return other ? 'Walking with ' + nameOf(other) : 'Out for a walk'; }
  if (p.act === 'chat') { const other = p.group?.members.find(m => m !== p); return other ? 'Chatting with ' + nameOf(other) : 'Chatting'; }
  if (p.act) {
    if (p.stage === 'greet') return 'Waving hello';
    if (p.stage === 'bye') return 'Waving goodbye';
    if (p.stage === 'rise') return 'Getting up';
    const sitting = p.stage === 'sit';
    if (p.act === 'bench') return sitting ? 'Sitting on a bench' : 'Off to a bench';
    if (p.act === 'lie') return sitting ? 'Lying down' : 'Off to lie down';
    const company = (p.group?.members.length ?? 0) > 1;
    return sitting ? (company ? 'Sitting in a circle' : 'Sitting on the grass') : (company ? 'Joining a circle' : 'Off to sit on the grass');
  }
  const cross = p.crossStage;
  if (cross === 'jwalk') return 'Going to cross the road';
  if (cross === 'jwait' || cross === 'curb' || cross === 'mid') return 'Waiting to cross';
  if (cross) return 'Crossing the road';
  const hangout = p.area >= 0 ? HANGOUTS[peopleNav.areas[p.area]?.kind] : null;
  if (p.mode === 'leaving') return hangout ? 'Leaving ' + hangout[1] : p.area < 0 ? 'Heading back to the path' : 'Leaving';
  // (aqua swim; waterwalking alone stand on top)
  if (p.mode === 'wander' && p.swimming) return p.traits.aqua ? (p.swimming === 'in' ? 'Swimming' : 'Off for a swim') : (p.swimming === 'in' ? 'Walking on water' : 'Off to walk on water');
  if (p.mode === 'wander' && p.floatPhase > 0.5 && !p.moving) return p.traits.aqua ? 'Swimming' : 'Walking on water';
  if (p.mode === 'wander') return hangout ? 'Hanging out ' + hangout.join(' ') : 'Hanging about';
  if (p.snack && (p.mode === 'line' || p.mode === 'wander')) return { coffee: 'Drinking a coffee', beer: p.snack.held.stout ? 'Drinking a stout' : 'Drinking a pint' }[p.snack.item] ?? 'Eating a hot dog';
  if (p.mode === 'line') return 'Out for a walk';
  return null;
}
/**
 * Tell the followed person's card what they're up to, if that's changed (each frame: see updatePeople).
 * @returns {void}
 */
export function showFollowedDoing() {
  if (followed < 0) return;
  const p = people[followed], doing = personDoing(p);
  if (doing === doingShown) return;
  doingShown = doing;
  App.setPersonCardDoing(doing, isGone(p) && !!p.indoors && !inRoom(p));
}

// Where someone's head is, in the world, from their pose this frame, worked out as the shader works it out — the head bone's
// pose (blended between rows and between the two clips), their head turned and tilted, and where they are — and the person
// card's headshot, from a camera that rides on their chest: in front of where their face is at rest, so their shoulders
// hold still in the picture and their head turns and nods within it.
const headshot = { head: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3(), distance: 0 };
const headAt = new THREE.Vector3();
const poseA = new Float32Array(12), poseB = new Float32Array(12);
const headMatrix = new THREE.Matrix4(), headTurn = new THREE.Matrix3(), lookTurn = new THREE.Matrix4(), lookTilt = new THREE.Matrix4();
const chestMatrix = new THREE.Matrix4(), chestTurn = new THREE.Matrix3();
const headshotInstance = new THREE.Matrix4(), headOffset = new THREE.Vector3();
/**
 * Read a bone's pose (its matrix's top three rows) at a row of the bone texture, blending between rows.
 * @param {Float32Array} out - the twelve numbers to write the pose into
 * @param {number} bone - which bone
 * @param {number} row - the row of the bone texture, part-way between rows being part-way between frames
 * @returns {void}
 */
function poseAt(out, bone, row) {
  const { boneData, boneWidth } = personModel, r = Math.floor(row), t = row - r;
  const a = (r*boneWidth + bone*3)*4, b = ((r + 1)*boneWidth + bone*3)*4;
  for (let k=0;k<12;k++) out[k] = boneData[a + k] + (boneData[b + k] - boneData[a + k])*t;
}
/**
 * A bone's pose this frame, blended between the two clips someone's between.
 * @param {THREE.Matrix4} out - where to put it
 * @param {number} bone - which bone
 * @param {number} i - their index in people
 * @returns {THREE.Matrix4} out
 */
function boneAt(out, bone, i) {
  const anim = personModel.anim.array, o = i*4, fade = anim[o+2];
  poseAt(poseA, bone, anim[o]);
  poseAt(poseB, bone, anim[o+1]);
  const e = poseA.map((value, k) => value*fade + poseB[k]*(1 - fade));
  return out.set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
}

/**
 * Where someone's head is, in the world (the middle of it, where their eyes are looked from when possessed).
 * @param {number} i - their index in people
 * @returns {THREE.Vector3} reused: copy it to keep it
 */
const headOf = i => headPointOf(i, HEAD_CENTER, headAt);
/**
 * Where a spot on someone's head is, in the world, from their pose this frame.
 * @param {number} i - their index in people
 * @param {THREE.Vector3} spot - the spot, in the model's units from the head's pivot with the head at rest (as HEAD_CENTER)
 * @param {THREE.Vector3} out - where to put it
 * @returns {THREE.Vector3} out
 */
export function headPointOf(i, spot, out) {
  const look = personModel.look.array, o = i*4;
  boneAt(headMatrix, personModel.headBone, i);
  headTurn.setFromMatrix4(headMatrix);
  lookTurn.makeRotationY(look[o]).multiply(lookTilt.makeRotationX(look[o+1]));
  personModel.mesh.getMatrixAt(i, headshotInstance);
  headOffset.copy(spot);
  if (personModel.traitData[((2 + PERSON_TRAIT_COLORS.indexOf('Eyes'))*PEOPLE_MAX + i)*4 + 3] > 0.5) { // (upside down, 🙃: see personLook)
    headOffset.set(-spot.x, personModel.face.top.y - spot.y, spot.z);
  }
  headOffset.multiplyScalar(headSizeOf(i)).applyMatrix4(lookTurn).applyMatrix3(headTurn); // (scaled about the neck, as personLook)
  return out.copy(personModel.headPivot).applyMatrix4(headMatrix).add(headOffset).applyMatrix4(headshotInstance);
}

/**
 * Where to put the person card's headshot camera: carried by their chest bone, looking at where their face is at rest.
 * @param {number} i - their index in people
 * @returns {{head: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, distance: number}} what the camera looks
 * at, which way from there it stands, which way is up, and how far off it draws
 */
export function headshotOf(i) {
  boneAt(chestMatrix, personModel.chestBone, i);
  chestTurn.setFromMatrix4(chestMatrix);
  personModel.mesh.getMatrixAt(i, headshotInstance);
  const size = headSizeOf(i);
  headshot.head.copy(HEAD_CENTER).multiplyScalar(size).add(personModel.headPivot).applyMatrix4(chestMatrix).applyMatrix4(headshotInstance);
  headshot.forward.set(0, 0, 1).applyMatrix3(chestTurn).transformDirection(headshotInstance);
  headshot.up.set(0, 1, 0).applyMatrix3(chestTurn).transformDirection(headshotInstance);
  headshot.distance = 4.6*modelScale(people[i])*size;
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
  endPrayerView();
  if (possession.index === followed) unpossessPerson();
  setFollowed(-1);
  if (followedInside) followedInside = false; // (the room had the camera all along)
  else {
    controls.minRadius = CAMERA_MIN_RADIUS;
    controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  }
  App.hidePersonCard();
}

//  ============== possessing someone  ============== 
// (see possession.js): whoever the camera's following is walked about from their own eyes.
//
// They drop whatever they were doing and walk wherever they're walked — onto the roads too, where cars can hit them — and
// when let go carry on from the nearest walkway, with the camera back behind them.
const EYE_NEAR = 0.2; // the nearest the view draws, from their eyes
const EYE_NEAR_HEADLESS = 0.1; // the same with their head hidden, close enough to see their own chest
let cameraNear = camera.near;
/**
 * Start walking someone the camera's following about from their own eyes (see possession.js): they drop whatever they
 * were doing, and the view comes in to where their head is.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function possessPerson(i) {
  const p = people[i];
  if (i !== followed || !p || possession.index === i || !S.peopleEnabled || S.interactionMode !== 'move') return;
  // (someone in the room the camera's inside — picked there, see followPersonInside — is walked round it, as anyone
  // walked in possessed is: see enterPossessed; not someone behind a changing room's curtain)
  const room = inRoom(p) ? p.indoors : null;
  if (isGone(p) && !room) return;
  if (room && (p.inRoom.cubicle || p.inRoom.hidden)) return;
  if (!canTakeControl()) return; // (checked before anything's undone; spent in possession.js)
  if (room) { standUp(p); p.inRoom = null; }
  // (up on a raised walkway, in a station, its lift or a carriage, they stay there: see peopleFooting.js)
  p.footing = footingAt(p.x, p.y, p.z);
  endActivity(p);
  if (p.train) { p.train = null; p.trainCooldown = 40 + peopleRng()*50; }
  if (p.indoors) { p.indoors = null; p.indoorsCooldown = INDOORS_COOLDOWN; }
  p.crossStage = null; p.jc = null; p.fright = p.stun = p.please = null; p.oneShot = null;
  p.mode = 'possessed';
  p.onRoad = false;
  swing = null;
  if (!startPossession(i, p.heading + moonwalkTurn(p))) { p.mode = 'wander'; reseatPerson(p); return; }
  setSelf(p);
  if (room) { possessedRoom = { key: room.building.key, building: room.building, back: room.back, floor: p.y }; p.footing = null; p.area = -1; }
  cameraNear = camera.near;
  camera.near = S.hideOwnHead ? EYE_NEAR_HEADLESS : EYE_NEAR;
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
  setSelf(null);
  swing = null;
  camera.near = cameraNear;
  camera.updateProjectionMatrix();
  if (!p || p.mode !== 'possessed') { possessedRoom = null; return; }
  leaveGroup(p); // (done with any chat: see talkWith)
  if (possessedRoom && stayIndoors(p)) return; // (let go of in a room they've walked into: they stay on there a while)
  // back into a hangout they're standing in, else walking back to the nearest walkway they can reach (walkBackToWalkway),
  // else onto the nearest walkway — up on a raised one, the nearest point of that
  // (the grid reseatPerson looks in leaves the decks out, so it would drop them to the ground below); in a station, a lift
  // or a carriage, riding the trains as anyone does from there
  p.mode = 'wander';
  p.onRoad = false;
  const f = p.footing;
  p.footing = null;
  const up = f?.kind === 'raised' ? nearestRaisedVertex(p.x, p.z, f.y) : null;
  if (up) placeAtVertex(p, up.li, up.vi, p.dir || 1);
  else if (!(f && f.kind !== 'raised' && resumeTrainRide(p, i, f))) {
    const inHangout = peopleNav.areas.some(a => insideFor(a, p)(p.x, p.z));
    if (inHangout || !walkBackToWalkway(p)) reseatPerson(p);
  }
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 1; }
  // the camera behind them, looking the way they were
  const behind = possession.yaw + Math.PI;
  controls.goalTheta = controls.theta + wrapAngle(behind - controls.theta);
  controls.goalPhi = Math.max(controls.goalPhi, Math.PI*0.3);
}
// Walking into people: anyone within BUMP_RADIUS is shocked (as by a bad sort's death — see stunBystanders in people.js) for
// BUMP_SHOCK_TIME, once, as you come within it. Walking into someone's very middle (within BUMP_CORE_RADIUS) sends you staggering SHOVE_DISTANCE straight
// back from them, slowing to a stop by SHOVE_DECAY per second and too thrown to walk while you're still going faster than
// STAGGER_SPEED, and gives them a BUMP_PUNCH_CHANCE chance per unit of aggression of punching you for it. Each is done once, as you
// walk into them. (Distances at people size 1.)
const BUMP_RADIUS = 0.5, BUMP_CORE_RADIUS = 0.5, BUMP_SHOCK_TIME = 1;
const BUMP_PUNCH_CHANCE = 0.05, SHOVE_DISTANCE = 0.7, SHOVE_DECAY = 5, STAGGER_SPEED = 1;
// Jumping (Space): in the air the keys steer (turning the way they're going towards them by AIR_CONTROL, speed kept, and
// speeding up to walking pace by AIR_ACCEL), and strafing (A/D) while turning the mouse adds AIR_GAIN of the speed per
// radian turned — bunny hopping. Holding Space jumps again the moment they land, before the ground slows them (by
// GROUND_FRICTION back to walking pace). Never over HOP_MAX times their own speed. (Per people size 1.)
const JUMP_SPEED = 4, GRAVITY = 14, AIR_ACCEL = 4, AIR_CONTROL = 6, AIR_GAIN = 0.1, GROUND_FRICTION = 8, HOP_MAX = 10;
// Walking into a car that's standing still (a moving one runs you over: see runOverPeople), you're put back outside it
// and staggered back off it, as off someone's middle. (Scale of its hitbox; moving: faster than runOverPeople's.)
const CAR_BOUNCE_SCALE = 0.9, CAR_STILL = 0.3;
function bounceOffCars(p, x, z, shove, hop) {
  for (const car of cars) {
    if (Math.abs(car.speed ?? 0) > CAR_STILL || hop.h > carHeight(car)) continue;
    const { halfLength, halfWidth } = carHitbox(car, CAR_BOUNCE_SCALE), cos = Math.cos(car.heading), sin = Math.sin(car.heading);
    const dx = x - car.x, dz = z - car.z, right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    const inR = halfWidth - Math.abs(right), inF = halfLength - Math.abs(forward);
    if (inR <= 0 || inF <= 0) continue;
    // (out through the nearest side)
    const [ox, oz, by] = inF < inR ? [sin*Math.sign(forward || 1), cos*Math.sign(forward || 1), inF] : [cos*Math.sign(right || 1), -sin*Math.sign(right || 1), inR];
    x += ox*by; z += oz*by;
    const speed = SHOVE_DISTANCE*S.peopleSize*SHOVE_DECAY;
    shove.x = ox*speed; shove.z = oz*speed; hop.vx = hop.vz = 0;
  }
  return { x, z };
}
/**
 * Walk someone being possessed where they're asked to go, this frame, over whatever's there.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {{x: number, y: number, z: number}} where they end up, at the height of the ground there
 */
export function walkPossessed(p, dt) {
  carryPossessed(p); // (along with the carriage or lift they're in, first: then walked about in it)
  const { forward, right, run, brake: jump } = controlInput(), yaw = possession.yaw;
  const len = Math.hypot(forward, right);
  let x = p.x, z = p.z;
  const shove = p.shove ??= { x: 0, z: 0 };
  const hop = p.hop ??= { h: 0, vy: 0, vx: 0, vz: 0 };
  let walkingSpeed = 0, vx = 0, vz = 0;
  if (len > 0 && Math.hypot(shove.x, shove.z) <= STAGGER_SPEED) {
    const speed = PERSON_WALK_SPEED*p.stride*Math.max(0.5, p.traits.speed + bloodSpeed(p))*bloodlustSpeed(p)*(run ? FLEE_SPEED*p.traits.boost : 1)*(rushed(p) ? HATES_POSSESSED_SPEED : 1);
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    walkingSpeed = speed;
    vx = (fx*forward + rx*right)/len*speed; vz = (fz*forward + rz*right)/len*speed;
  }
  if (hop.h > 0) { // (in the air: see "Jumping")
    const turned = Math.abs(wrapAngle(yaw - (hop.yaw ?? yaw)));
    if (walkingSpeed > 0) {
      const wish = walkingSpeed, dx = vx/wish, dz = vz/wish;
      const add = wish - (hop.vx*dx + hop.vz*dz);
      if (add > 0) { const a = Math.min(AIR_ACCEL*wish*dt, add); hop.vx += a*dx; hop.vz += a*dz; }
      const sp = Math.min(HOP_MAX*wish, Math.hypot(hop.vx, hop.vz)*(right ? 1 + AIR_GAIN*turned : 1));
      const k = 1 - Math.exp(-AIR_CONTROL*dt); hop.vx += (dx*sp - hop.vx)*k; hop.vz += (dz*sp - hop.vz)*k;
      const n = sp/(Math.hypot(hop.vx, hop.vz) || 1); hop.vx *= n; hop.vz *= n;
    }
    vx = hop.vx; vz = hop.vz;
    hop.vy -= GRAVITY*S.peopleSize*dt; hop.h += hop.vy*dt;
    if (hop.h <= 0) { hop.h = 0; hop.vy = 0; }
  } else { // (on the ground: slowed to walking, unless jumping straight off again)
    if (!jump) { const k = 1 - Math.exp(-GROUND_FRICTION*dt); hop.vx += (vx - hop.vx)*k; hop.vz += (vz - hop.vz)*k; }
    else if (Math.hypot(hop.vx, hop.vz) < walkingSpeed) { hop.vx = vx; hop.vz = vz; }
    vx = hop.vx; vz = hop.vz;
    if (jump) { hop.vy = JUMP_SPEED*S.peopleSize; hop.h = 1e-4; }
  }
  walkingSpeed = Math.hypot(vx, vz);
  hop.yaw = yaw;
  x += vx*dt; z += vz*dt;
  const slowing = Math.exp(-SHOVE_DECAY*dt);
  x += shove.x*dt; z += shove.z*dt;
  shove.x *= slowing; shove.z *= slowing;
  // (walked off from whoever they were talking to, or they've gone: that's the end of it)
  const partner = talkingTo(p);
  if (p.group && (!partner || Math.hypot(partner.x - x, partner.z - z) > TALK_LEAVE*S.peopleSize)) leaveGroup(p);
  // (in a room they've walked into: round its furniture — see "walking into buildings")
  if (possessedRoom) { p.walkingSpeed = walkingSpeed; return stepInRoom(p, possession.index, x, z); }
  const touching = new Set(), near = new Set();
  people.forEach(q => {
    if (q === p || isGone(q) || !(q.mode === 'line' || q.mode === 'wander' || q.mode === 'leaving')) return;
    if (q.punched && q.punched.stage !== 'marked') return; // (nobody bumps into someone knocked down: no shock, stagger or punch)
    const dx = q.x - x, dz = q.z - z, d = Math.hypot(dx, dz);
    if (d > BUMP_RADIUS*S.peopleSize) return;
    near.add(q);
    const startled = !p.near?.has(q);
    const entering = d < BUMP_CORE_RADIUS*S.peopleSize && !p.touching?.has(q);
    if (d < BUMP_CORE_RADIUS*S.peopleSize) touching.add(q);
    // (whoever's shocked or busy, even, drops it to go after them)
    const punching = len > 0 && entering && !p.punched && (q.mode === 'line' || q.mode === 'wander') && !q.attack && !q.punched
      && peopleRng() < BUMP_PUNCH_CHANCE*q.traits.aggression;
    if (punching) { endActivity(q); q.stun = q.fright = q.please = null; q.oneShot = null; goAfter(q, p); }
    else if (len > 0 && startled && !q.stun && !q.fright && !q.please && !q.punched && !q.attack) q.stun = { stage: 'notice', timer: 0.15, from: { x: p.x, z: p.z }, hold: BUMP_SHOCK_TIME };
    if (len === 0 || !entering) return;
    if (swing) return; // (no staggering back while throwing a punch)
    const backX = d > 1e-3 ? -dx/d : -Math.sin(yaw), backZ = d > 1e-3 ? -dz/d : -Math.cos(yaw);
    // (the distance a shove covers is its speed over SHOVE_DECAY)
    const speed = SHOVE_DISTANCE*S.peopleSize*SHOVE_DECAY;
    shove.x = backX*speed; shove.z = backZ*speed;
  });
  ({ x, z } = bounceOffCars(p, x, z, shove, hop));
  p.touching = touching; p.near = near; p.walkingSpeed = walkingSpeed; // (for how hard a punch throws someone: see updateSwing)
  if (!p.footing && !(hop.h > 0)) ({ x, z } = holdAtFences(p.x, p.z, x, z, p.y, 0.25*S.peopleSize)); // (fences are solid, but jumped through)
  if (!p.footing) ({ x, z } = clearOfBuildings(p, x, z)); // (buildings are solid, on the ground)
  // up on a raised walkway, in a station, its lift or a carriage, or getting onto one (see peopleFooting.js)
  const up = stepFooting(p, x, z);
  if (up?.ground) ({ x, z } = up); // (held outside a lift's shaft)
  else if (up) {
    p.onRoad = false; p.area = -1;
    if (p.footing?.kind === 'lift' || p.footing?.kind === 'carriage') p.y = up.y; // (carried: no easing up to it)
    return up;
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
  if (personModel) camera.position.copy(headOf(i));
  else camera.position.set(p.x, p.y + personHeight(p)*0.92, p.z);
  camera.rotation.set(possession.pitch, possession.yaw + Math.PI, 0, 'YXZ');
}

// ---- throwing a punch yourself: possessing someone, a click swings their fist at whoever is in front of them (the click
// itself is possession.js's).
//
// Unlike a fight someone picks of their own ("punching"), nobody is walked up to and nobody is stared at afterwards: the
// swing plays wherever they are standing and lands on the nearest person within SWING_REACH ahead and SWING_ARC, at the
// moment the fist arrives — knocking them flat, as any punch does — or on nobody.
/** Who a swing can reach: how far ahead of them (at a standstill, and how much further for each unit of speed they're moving at), and how near dead ahead they have to be — the same whatever anyone's size. */
const SWING_REACH = 3.4, SWING_REACH_PER_SPEED = 0.5;
const SWING_ARC = Math.cos(Math.PI*4/9);
// Punching a fence (with nobody nearer to hit) breaks the piece in reach (FENCE_PUNCH_REACH, at people size 1), and
// cuts the hand: they bleed (fallSpill) and lose FENCE_PUNCH_DAMAGE.
const FENCE_PUNCH_REACH = 1.2, FENCE_PUNCH_DAMAGE = 8;
/** How far a punch throws someone back, per unit of the puncher's speed, and the least it does however slowly they're moving. */
const PUNCH_PUSH_PER_SPEED = 0.5;
export const PUNCH_MIN_PUSH = 1; // the least a punch knocks someone back; an NPC's is scaled by their speed trait, since they slow to a stop to punch
/** The punch being thrown: { timer } — how long until the fist lands. */
let swing = null;
/**
 * Swing a possessed person's fist at whoever's in front of them — the click itself is possession.js's.
 * @returns {void}
 */
export function punchFromPossession() {
  const p = people[possession.index];
  if (!p || p.mode !== 'possessed' || (p.punched && p.punched.stage !== 'marked' && p.punched.stage !== 'brace') || swing || // (chased or braced for, they can still hit back)
       !hasClip('Punch') || !hasClip('Fall')) return;
  swing = { timer: PUNCH_HIT_TIME };
  playOnce(p, 'Punch');
  swingSound(p);
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
  let nearest = (SWING_REACH + (p.walkingSpeed ?? 0)*SWING_REACH_PER_SPEED)*Math.max(1, p.traits.size); // (the faster they're running and the bigger they are, the further it reaches — but never less than a normal person's)
  people.forEach(q => {
    if (q === p || isGone(q) || !canBeKnockedOver(q)) return;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d > nearest || d < 1e-3 || (dx*fx + dz*fz)/d < SWING_ARC) return;
    hit = q; nearest = d;
  });
  // a bee nearer than anyone takes it instead, and its colony comes for the puncher
  const bee = App.beeInPunch?.({ x: p.x, y: p.y, z: p.z, heading: p.heading, reach: nearest, arcCos: SWING_ARC, height: personHeight(p) });
  if (bee) { App.punchBee?.(bee, p); return; }
  if (!hit) {
    if (punchFence(p, Math.min(nearest, FENCE_PUNCH_REACH*S.peopleSize*Math.max(1, p.traits.size)), SWING_ARC)) { fallSpill(p); damage(p, FENCE_PUNCH_DAMAGE, { cause: 'punchedfence' }); }
    return;
  }
  if (dodgePunch(hit, p)) return; // (a vampire leaps clear)
  if (knockOver(hit, p)) App.pushPerson?.(hit, hit.x - p.x, hit.z - p.z, Math.max(PUNCH_MIN_PUSH, (p.walkingSpeed ?? 0)*PUNCH_PUSH_PER_SPEED)*p.traits.size); // (the faster they're running and the bigger they are, the further)
}
/** Drop a swing that's been thrown, for someone knocked down before it landed. */
export function cancelSwing() { swing = null; }

//  ============== Riding the trains  ============== 
// At TRAIN_RATE, someone near station pops to landing. At each stop after, they exit with probability  1/stationCount or guaranteed if two stations.
// Someone followed by the camera takes it with them (see followCarriage in trains.js).
// p.train: { node: Station, stage: 'approach'|'enter'|'wait'|'ride'|'exit', target: Vec3, side: number, along: number, lineId: string, timer: number, spot: ?{across, along, turn} (where they stand aboard) }

/** The chance, at each walkway point near a station, of deciding to ride the trains. */



//  ============== walking into buildings, and talking to people, possessing someone  ==============
// E (see possession.js) acts on whatever's in front of them, with a label floating over it saying so: talks to whoever's
// there (talkWith in peopleActivities.js — E again, or walking off, ends it), or else goes into the building they're
// looking at, if it's one people go into, the view going in with them (the room from buildings/interior.js, walked about
// by hand round its furniture). In the room, E at its door, or walking out through it, goes back out. Let go of in there,
// they stay on as anyone visiting would (see updateIndoors). Walked about outside, buildings are solid.
const REACH_BUILDING = 3;         // how far ahead a building can be gone into from
const REACH_TALK = 2.5;           // how far ahead someone can be talked to, at people size 1
const TALK_ARC = Math.cos(Math.PI/4), TALK_LEAVE = 4; // how near dead ahead; how far off ends the chat
const WALL_PAD = 0.35;            // how near a wall they can walk
const DOOR_REACH = 1.5;           // how near the room's door E lets them out from
/** The room they've walked into: { key, building (as peopleNav.buildings has it, or a stand-in), back, floor }, or null. */
let possessedRoom = null;
/** What E would act on this frame: { person } or { building } or { door }, or null (see updatePossessedTarget). */
let target = null;

// every building (anything built with a footprint) whose footprint comes within `reach` of x, z: { zone, group, index, fp, c, r }
function buildingsNear(x, z, reach) {
  const found = [];
  buildingHolders().forEach(zone => (zone.buildingsGroup?.children || []).forEach((group, index) => {
    const walls = wallsOf(group);
    if (!walls.length || !group.visible) return;
    const { c, r } = footprintBounds(group);
    if (Math.hypot(x - c.x, z - c.z) <= r + reach) walls.forEach(w => found.push({ zone, group, index, fp: w.poly, top: w.top, prop: w.prop, c, r }));
  }));
  return found;
}
// whether a building's in the way at x, z for someone at height y (not over its roof, nor under it: a mall's upper units
// stand on its lower ones)
const between = (b, y) => y < b.top && y > (b.group.userData.base || 0) - 0.5;
const solidAt = (list, x, z, y) => list.some(b => between(b, y)
  && (pointInPolygon({ x, z }, b.fp) || distToPolygonBoundary({ x, z }, b.fp) < WALL_PAD));
// x, z, or as near it as they can get along one axis or the other without walking into a building; anyone already in
// one (put there somehow) is let walk out
function clearOfBuildings(p, x, z) {
  const list = buildingsNear(p.x, p.z, Math.hypot(x - p.x, z - p.z) + WALL_PAD + 0.1);
  if (!list.length || !solidAt(list, x, z, p.y) || solidAt(list, p.x, p.z, p.y)) return { x, z };
  if (!solidAt(list, x, p.z, p.y)) return { x, z: p.z };
  if (!solidAt(list, p.x, z, p.y)) return { x: p.x, z };
  return { x: p.x, z: p.z };
}
// the building they're looking at, within REACH_BUILDING straight ahead, with where along the look it's met
function buildingAhead(p) {
  const fx = Math.sin(possession.yaw), fz = Math.cos(possession.yaw);
  const list = buildingsNear(p.x, p.z, REACH_BUILDING);
  if (!list.length) return null;
  for (let t = 0.25; t <= REACH_BUILDING; t += 0.25) {
    const x = p.x + fx*t, z = p.z + fz*t;
    const hit = list.find(b => !b.prop && between(b, p.y) && pointInPolygon({ x, z }, b.fp)); // (a yard's tanks and containers aren't gone into)
    if (!hit) continue;
    const key = buildingKey(hit.zone, hit.index), number = buildingNumber(key), kind = buildingKindOf(hit.group, hit.zone);
    const height = hit.group.userData.height ?? 0;
    const title = buildingTitle(kind, number), name = buildingName(kind, number, height, key);
    return { ...hit, key, kind, number, at: { x, z }, enterable: buildingEnterable(kind),
      name: buildingLabelName(kind, number, height, key), type: title ? name : buildingTypeOf(kind, number).name ?? name };
  }
  return null;
}
// whoever's nearest in front of them to talk to: out and about, or in the room with them
function personAhead(p) {
  const fx = Math.sin(possession.yaw), fz = Math.cos(possession.yaw);
  let best = null, nearest = REACH_TALK*S.peopleSize;
  people.forEach(q => {
    if (q === p || q.attack || q.punched || q.fright || q.stun) return;
    if (possessedRoom ? !(inRoom(q) && !q.inRoom.cubicle && !q.inRoom.hidden && !q.inRoom.leaving)
      : !((q.mode === 'line' || q.mode === 'wander') && !isGone(q) && !q.crossStage && !q.jc)) return;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d > nearest || d < 1e-3 || (dx*fx + dz*fz)/d < TALK_ARC) return;
    best = q; nearest = d;
  });
  return best;
}
// whoever the look card's for (person-card.js showLookCard): further off and wider than talking, anyone in sight — the
// the best of those in reach (LOOK_REACH dead ahead, shrinking to REACH_TALK at LOOK_ANGLE off it): nearest the middle
// of the view (where the locked cursor is), and nearest them, LOOK_NEAR_WEIGHT times as much
const LOOK_REACH = 12, LOOK_ANGLE = Math.PI/4; // how far, at people size 1; how far off the view's middle, in radians
const LOOK_NEAR_WEIGHT = 2; // how much nearness counts against being off the middle (each as a share of its limit)
const lookAt = new THREE.Vector3(), lookDir = new THREE.Vector3();
function personLooked(p) {
  let best = null, bestScore = Infinity;
  camera.getWorldDirection(lookDir);
  people.forEach(q => {
    if (q === p || q.mode === 'dead' || isGone(q) || (possessedRoom ? !inRoom(q) || q.inRoom.hidden : inRoom(q))) return;
    lookAt.set(q.x, q.y + personHeight(q)*0.6, q.z).sub(camera.position);
    const d = lookAt.length(), angle = d > 1e-3 ? lookAt.angleTo(lookDir) : Math.PI;
    if (angle >= LOOK_ANGLE) return;
    const reach = LOOK_REACH + (REACH_TALK - LOOK_REACH)*angle/LOOK_ANGLE;
    const score = angle/LOOK_ANGLE + LOOK_NEAR_WEIGHT*d/(LOOK_REACH*S.peopleSize);
    if (d <= reach*S.peopleSize && score < bestScore) { best = q; bestScore = score; }
  });
  return best;
}
// whoever the possessed is talking to (see talkWith in peopleActivities.js), while they're still in the conversation
const talkingTo = p => p.group && p.chatWith && p.group.members.includes(p.chatWith) ? p.chatWith : null;
/**
 * Work out what E would act on for whoever's possessed, and float the label over it; call each frame.
 * @returns {void}
 */
export function updatePossessedTarget() {
  const p = people[possession.index];
  target = null;
  if (p?.mode === 'possessed' && possessedRoom) someoneHome(); // (in the room like anyone else: its lamp, music, bar bot…)
  if (p?.mode === 'possessed' && S.interactionMode === 'move') {
    const partner = talkingTo(p);
    const q = rushed(p) ? null : partner ?? personAhead(p); // (rushed: can't talk)
    if (q) target = { person: q };
    else if (possessedRoom) {
      const door = roomDoorway();
      if (Math.hypot(door.x - p.x, door.z - p.z) < DOOR_REACH) target = { door };
    } else {
      const b = buildingAhead(p);
      if (b?.enterable) target = { building: b };
    }
  }
  const looked = S.lookCard && p?.mode === 'possessed' && S.interactionMode === 'move' ? personLooked(p) : null; // (Options > Display > Show Profile On Look)
  App.showLookCard?.(looked ? people.indexOf(looked) : -1); // (their card, above the possessed person's: person-card.js)
  const key = IS_TOUCH ? 'Tap <b>Use</b>' : 'Press <kbd>E</kbd>';
  if (target?.person) {
    const q = target.person, partner = talkingTo(p);
    showUseLabel({ x: q.x, y: q.y + personHeight(q)*1.1, z: q.z }, partner ? `${key} to say goodbye` : `${escapeHtml(nameOf(q))}<br>${key} to talk`, !!partner);
  } else if (target?.building) {
    const b = target.building;
    // (on the wall, straight ahead of their eyes: close up, anywhere off the line of sight is well off the middle of the view)
    const t = Math.hypot(b.at.x - camera.position.x, b.at.z - camera.position.z);
    showUseLabel({ x: camera.position.x + Math.sin(possession.yaw)*t, y: camera.position.y - 0.05*t, z: camera.position.z + Math.cos(possession.yaw)*t }, `<b>${escapeHtml(b.name)}</b><br>${escapeHtml(b.type)}<br>${key} to enter`);
  } else if (target?.door) showUseLabel({ x: target.door.x, y: target.door.y + 1.6, z: target.door.z }, `${key} to leave`);
  else showUseLabel(null);
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// the label itself: page text over the view, as a speech bubble is (see ui/speech-bubbles.js)
const useLabel = document.createElement('div');
useLabel.className = 'use-label';
useLabel.hidden = true;
(document.getElementById('canvas-wrap') ?? document.body).appendChild(useLabel);
const labelAt = new THREE.Vector3();
let labelHtml = '';
// (`pinned`: kept on screen, at its edge, when what it's over is off it — as whoever they're talking to often is, close up)
function showUseLabel(at, html, pinned = false) {
  if (at) { camera.updateMatrixWorld(); labelAt.set(at.x, at.y, at.z).project(camera); } // (the camera's only just been put at their eyes)
  if (at && pinned) {
    if (labelAt.z > 1) labelAt.set(-labelAt.x, -0.6, 0); // (behind them: flipped, as projecting behind the eye turns it round)
    labelAt.x = Math.max(-0.8, Math.min(0.8, labelAt.x)); labelAt.y = Math.max(-0.6, Math.min(0.9, labelAt.y));
  }
  if (!at || labelAt.z > 1 || Math.abs(labelAt.x) > 1.1 || Math.abs(labelAt.y) > 1.1) { useLabel.hidden = true; return; }
  if (html !== labelHtml) useLabel.innerHTML = labelHtml = html;
  useLabel.hidden = false;
  useLabel.style.left = `${(labelAt.x + 1)/2*window.innerWidth}px`;
  useLabel.style.top = `${(1 - labelAt.y)/2*window.innerHeight}px`;
}
/**
 * E pressed while possessing someone (see possession.js): whatever updatePossessedTarget found.
 * @returns {void}
 */
export function useFromPossession() {
  const i = possession.index, p = people[i];
  if (!p || p.mode !== 'possessed' || !target) return;
  if (target.person) { if (talkingTo(p)) sayGoodbye(p); else { leaveGroup(p); talkWith(p, target.person); } }
  else if (target.door) leaveRoomPossessed(p, i);
  else if (target.building) enterPossessed(p, i, target.building);
  target = null;
}
// into the room, just inside its door, looking in — the building followed and gone into, as when someone the camera's
// following goes indoors (see updateIndoors)
function enterPossessed(p, i, b) {
  leaveGroup(p);
  const near = camera.near;
  camera.near = cameraNear; // (the view outside, for the room to put back when it's left)
  if (!App.enterBuildingWith?.(b.key)) { camera.near = near; return; }
  followPersonInside(i);
  camera.near = near;
  camera.updateProjectionMatrix();
  const door = roomDoorway(), beyond = roomBeyondDoor();
  const building = peopleNav.buildings?.find(n => n.key === b.key)
    ?? { key: b.key, number: b.number, kind: b.kind, x: b.c.x, z: b.c.z, y: p.y, height: b.group.userData.height || 10, size: b.r, door: { x: p.x, z: p.z } };
  possessedRoom = { key: b.key, building, back: { x: p.x, y: p.y, z: p.z }, floor: door.y };
  p.x = door.x; p.y = door.y; p.z = door.z;
  p.footing = null; p.onRoad = false; p.area = -1;
  if (p.shove) p.shove.x = p.shove.z = 0;
  possession.yaw = Math.atan2(door.x - beyond.x, door.z - beyond.z);
  p.heading = possession.yaw + moonwalkTurn(p);
  openRoomDoor();
}
// back out of the room, at the building's door (or where they went in from), facing away from it
function leaveRoomPossessed(p, i) {
  const { building, back } = possessedRoom;
  possessedRoom = null;
  leaveGroup(p);
  const near = camera.near;
  camera.near = cameraNear;
  followedInside = false; // (or letting go of the building lets go of them: see updatePeople)
  setAwaited(-1);
  App.stopFollowingBuilding?.();
  followPerson(i);
  camera.near = near;
  camera.updateProjectionMatrix();
  putOutside(p, building, back);
}
function putOutside(p, building, back) {
  const out = building.door ?? back;
  p.x = out.x; p.z = out.z; p.y = back.y;
  p.footing = back.y > 1 ? { kind: 'raised', y: back.y } : null; // (out onto a mall's gallery, upstairs: see peopleFooting.js)
  if (p.shove) p.shove.x = p.shove.z = 0;
  possession.yaw = Math.atan2(out.x - building.x, out.z - building.z);
  p.heading = possession.yaw + moonwalkTurn(p);
}
// a step in the room: round the furniture, and out through the door
function stepInRoom(p, i, x, z) {
  if (!App.isInsideBuilding?.()) { const { building, back } = possessedRoom; possessedRoom = null; putOutside(p, building, back); return { x: p.x, y: p.y, z: p.z }; }
  if (roomThroughDoor(x, z)) { leaveRoomPossessed(p, i); return { x: p.x, y: p.y, z: p.z }; }
  if (!roomWalkable(x, z)) {
    if (roomWalkable(x, p.z)) z = p.z;
    else if (roomWalkable(p.x, z)) x = p.x;
    else if (roomWalkable(p.x, p.z)) { x = p.x; z = p.z; }
  }
  return { x, y: possessedRoom.floor, z };
}
// let go of in the room: they stay on a while, as anyone visiting would (see updateIndoors); false if there's no room
function stayIndoors(p) {
  const { building, back } = possessedRoom;
  possessedRoom = null;
  if (!App.isInsideBuilding?.()) { putOutside(p, building, back); return false; }
  p.mode = 'indoors';
  p.onRoad = false;
  const out = building.door ?? back;
  p.indoors = { building, stage: 'inside', back: { x: out.x, y: back.y, z: out.z }, hoursLeft: 0.5 + peopleRng()*2, shop: null, served: true, party: false };
  p.inRoom = { visit: roomVisit(), route: null, wait: 1 + peopleRng()*3, seat: null, stage: '' };
  camera.near = roomNear();
  camera.updateProjectionMatrix();
  return true;
}
