import { App, S } from '../../core/shared.js';
import { voiceOfPerson, beginFleeing, buildingLabel, clipNamed, followed, groups, hasClip, headingTo, indoorsCount, isGone, isOpenGround, modelScale, people, peopleNav, peopleNavBuiltAt, peopleRng, personModel, pickFrom, pickWeighted, playOnce, randomSpotIn, riderFollowed, setIndoorsCount, setRiderFollowed, walkableUpTo, weightOf, wrapAngle } from './people.js';
import { CHAT_GAP, CIRCLE_MAX, CIRCLE_RADIUS, GRASS_SITS, LIE_DOWNS } from './peopleModel.js';
import { placeAtVertex, reseatPerson, updateCrossing, wanderInto, walkwayPoint } from './peoplePathing.js';
import * as THREE from 'three';
import { controls } from '../../core/camera-controls.js';
import { profileOf, profilesVersion } from '../profiles.js';
import { getTrainShuttles, getTrainStations, trainStationsVersion } from '../../trains/trains.js';
import { isBloodlusting, punchSpill } from './peopleBlood.js';
import { puffSmoke } from '../giblets.js';
import { playSound } from '../../audio/sfx.js';
import { exclaim } from '../../audio/voices.js';
import { PUNCH_MIN_PUSH, followPerson, personHeight, stopFollowingPerson } from './peopleTracking.js';
import { roomHolds, roomRoute, roomSeats, roomSpot, roomVisit, someoneHome, watchingTV } from '../../buildings/interior.js';

// ---- what people get up to besides walking about.
//
// p.act names it: 'chat' (two people meeting, head on along a walkway or one crossing to another in a plaza or park: they
// wave, talk a while, wave goodbye), 'bench' (a plaza bench), 'circle' (park grass, others joining to talk), 'lie' (park
// grass, only with nobody else about).
//
// People talking are a group and take turns, looking at whoever is talking. Someone standing about for a while fidgets
// now and then (Idle2/Idle3).
/**
 * Take a group out of the ones going on.
 * @param {object} g - the group
 * @returns {void}
 */
function removeGroup(g) {
  const k = groups.indexOf(g);
  if (k >= 0) groups.splice(k, 1);
}

/**
 * End a conversation between two, and set them both carrying on.
 * @param {object} g - the group
 * @returns {void}
 */
function endChat(g) {
  removeGroup(g);
  const chatGroup = g.members.splice(0);
  chatGroup.forEach((m, index) => { 
    m.group = null; finishActivity(m); 
    if (chatGroup.length <= 1) return;
    let victim;
    if (index === 0) victim = chatGroup[1]
    else victim = chatGroup[0]
    throwPunch(undefined, m, true, victim)
  });
}

/**
 * Take a person out of the group they're in, ending a conversation between two if that's what it was.
 * @param {Person} p - the person
 * @returns {void}
 */
function leaveGroup(p) {
  const g = p.group;
  if (!g) return;
  p.group = null;
  g.members.splice(g.members.indexOf(p), 1);
  if (g.speaker === p) g.speaker = null;
  g.members.forEach(m => { if (m.lookAt === p) m.lookAt = null; });
  // a conversation between two ends when either goes; a circle carries on while anyone's left in it
  if (g.kind === 'chat') endChat(g); else if (!g.members.length) removeGroup(g);
}

/**
 * Stop whatever a person's doing, back to standing.
 * @param {Person} p - the person
 * @returns {void}
 */
export function endActivity(p) {
  leaveGroup(p);
  endAttack(p);
  releasePunched(p);
  if (p.seat) { p.seat.by = null; p.seat = null; }
  p.act = null; p.stage = ''; p.spot = null; p.faceTo = null; p.lookAt = null; p.pose = 'Idle'; p.seatLift = 0;
}

/**
 * Stop whatever a person's doing and set them carrying on: off somewhere nearby, or on along their walkway — and not
 * stopping to talk again for a while.
 * @param {Person} p - the person
 * @returns {void}
 */
function finishActivity(p) {
  endActivity(p);
  if (p.mode === 'wander') { const s = randomSpotIn(peopleNav.areas[p.area], p); p.tx = s.x; p.tz = s.z; p.wait = 0.3 + peopleRng()*1.5; }
  p.chatCooldown = 30 + peopleRng()*60;
}

/**
 * Start two people talking.
 * @param {Person} a - the one waited on, if the other is walking over
 * @param {Person} b - the other
 * @param {boolean} approach - whether the second walks over to the first first, who waits for them
 * @returns {object} the group they're talking in
 */
function startChat(a, b, approach) {
  const g = { kind: 'chat', members: [a, b], stage: 'gather', timer: 25, speaker: null, turnIn: 0 };
  groups.push(g);
  [a, b].forEach(m => { endActivity(m); m.act = 'chat'; m.group = g; m.wait = 0; });
  a.lookAt = b; b.lookAt = a;
  if (!approach) wave(g, 'greet');
  return g;
}

/**
 * Have both of a conversation wave, hello or goodbye, standing still for it.
 * @param {object} g - the group
 * @param {string} stage - the stage to put them into ('greet' or 'bye')
 * @returns {void}
 */
function wave(g, stage) {
  g.stage = stage;
  g.timer = hasClip('Wave') ? clipNamed('Wave').duration : 1;
  g.members.forEach(m => playOnce(m, 'Wave'));
}

/**
 * Send someone hanging out in a plaza or park over to someone else standing about there, to talk.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether anyone was found to go over to
 */
export function goChat(p, area) {
  if (!personModel) return false;
  let friend = null, best = 25;
  for (let k=0;k<10;k++) {
    const q = people[Math.floor(peopleRng()*people.length)], d = Math.hypot(q.x - p.x, q.z - p.z);
    if (q !== p && q.mode === 'wander' && q.area === p.area && !q.act && !q.fright && !q.oneShot && !q.moving && !q.attack && !q.punched && q.traits.chatty > 0 && d < best
      && walkableUpTo(area, p, q.x, q.z).clear) { friend = q; best = d; }
  }
  if (!friend) return false;
  startChat(friend, p, true);
  const gap = CHAT_GAP*S.peopleSize, d = Math.max(best, 1e-3);
  p.tx = friend.x + (p.x - friend.x)/d*gap; p.tz = friend.z + (p.z - friend.z)/d*gap;
  if (!area.inside(p.tx, p.tz)) { p.tx = p.x; p.tz = p.z; }
  return true;
}

/**
 * Have two people meeting head on along a walkway (on the same side of it) now and then stop to talk — though never too
 * many at once.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function meetOnWalkways(dt) {
  const cells = new Map(), CELL = 2;
  let talking = 0;
  people.forEach(p => {
    p.chatCooldown -= dt;
    if (p.mode !== 'line') return;
    if (p.act) { talking++; return; }
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  });
  if (!hasClip('Wave') || talking > people.length*0.15) return;
  const reach = 1.6*S.peopleSize;
  people.forEach(p => {
    if (p.mode !== 'line' || p.act || p.fright || p.crossStage || p.attack || p.punched || p.chatCooldown > 0 || (p.chatCheckIn -= dt) > 0) return;
    p.chatCheckIn = 0.4 + peopleRng()*0.8;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-1;ox<=1;ox++) for (let oz=-1;oz<=1;oz++) for (const q of cells.get((cx+ox) + ',' + (cz+oz)) || []) {
      if (q === p || q.act || q.fright || q.crossStage || q.attack || q.punched || q.chatCooldown > 0 || q.li !== p.li || q.dir === p.dir) continue;
      // still coming towards each other, and close
      if ((q.u - p.u)*p.dir < 0 || Math.hypot(q.x - p.x, q.z - p.z) > reach) continue;
      if (peopleRng() < 0.35*p.traits.chatty*q.traits.chatty) startChat(p, q, false); else p.chatCooldown = q.chatCooldown = 10;
      return;
    }
  });
}

/**
 * Move who's speaking in a conversation on: the more talkative someone is, the more of the turns they take, and the
 * longer they go on.
 * @param {object} g - the group
 * @param {Person[]} talkers - those in it who can talk
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
function takeTurns(g, talkers, dt) {
  g.turnIn -= dt;
  if (!talkers.includes(g.speaker) || g.turnIn <= 0) {
    // the more talkative someone is, the more of the turns they take, and the longer they go on
    const others = talkers.filter(m => m !== g.speaker);
    g.speaker = others[pickWeighted(others, m => m.traits.talkative)];
    g.turnIn = (1.5 + peopleRng()*4)*Math.sqrt(g.speaker.traits.talkative);
    g.speaker.lookAt = pickFrom(talkers.filter(m => m !== g.speaker));
  }
  talkers.forEach(m => { if (m !== g.speaker) m.lookAt = g.speaker; });
}

/**
 * Run the conversations: two standing come together, wave hello, take turns talking a while, wave goodbye and go; a
 * circle on the grass talks among whoever's sat down in it.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateGroups(dt) {
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g.kind === 'circle') {
      const seated = g.members.filter(m => m.stage === 'sit');
      if (seated.length >= 2) takeTurns(g, seated, dt); else g.speaker = null;
      continue;
    }
    const [a, b] = g.members;
    g.timer -= dt;
    if (g.stage === 'gather') {
      a.faceTo = headingTo(a, b);
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 0.3) wave(g, 'greet');
      else if (g.timer <= 0) { endChat(g); continue; }
    } else if (g.stage === 'greet') {
      if (g.timer <= 0) { g.stage = 'talk'; g.timer = (8 + peopleRng()*22)*(a.traits.patience + b.traits.patience)/2; }
    } else if (g.stage === 'talk') {
      takeTurns(g, g.members, dt);
      if (g.timer <= 0) { g.speaker = null; wave(g, 'bye'); }
    } else if (g.timer <= 0) {
      endChat(g);
      continue;
    }
    if (g.stage !== 'gather') { a.faceTo = headingTo(a, b); b.faceTo = headingTo(b, a); }
  }
}

/**
 * Run the crowd for one frame: keep the numbers right, rebuild the walkways when the map has changed, and move everyone
 * — walking, crossing, talking, sitting, punching, riding the trains, going indoors, being possessed — then write it all
 * out to the instanced meshes and the shader's attributes, and put the camera where it's following.
 *
 * The dt is clamped, so a tab left in the background doesn't teleport everyone across the map on the frame it comes back.
 * @param {number} t - the time now, in seconds
 * @returns {void}
 */

/** Where on the ground to check for room, around a spot (see clearGround). */
const GROUND_PROBES = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Work out whether there's room on the grass: in the park all round a spot, off any walkway cutting through it (people
 * sit and lie down on the ground beside a path, never on it), and clear of the tree trunks.
 * @param {Hangout} area - the hangout
 * @param {number} x - the middle of the spot
 * @param {number} z
 * @param {number} r - how much room they need all round it
 * @returns {boolean} whether it's clear
 */
function clearGround(area, x, z, r) {
  for (const [dx, dz] of GROUND_PROBES) {
    const px = x + dx*r, pz = z + dz*r;
    if (!area.inside(px, pz) || peopleNav.onPath(px, pz)) return false;
  }
  return area.trees.every(tree => Math.hypot(tree.x - x, tree.z - z) > tree.r + r);
}

/**
 * Send someone in a plaza to a free bench seat nearby, or someone in a park or on a beach to the ground, to join a
 * circle there with room in it or to start one.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether somewhere was found
 */
export function goSit(p, area) {
  if (!personModel) return false;
  if (area.kind === 'plaza') {
    // (only people about the size the benches are made for)
    if (!hasClip('Sit1') || !area.seats.length || Math.abs(S.peopleSize*p.traits.size - 1) > 0.3) return false;
    let seat = null, best = 40;
    for (let k=0;k<10;k++) {
      const free = area.seats[Math.floor(peopleRng()*area.seats.length)], d = Math.hypot(free.x - p.x, free.z - p.z);
      if (!free.by && d < best) { seat = free; best = d; }
    }
    if (!seat) return false;
    seat.by = p;
    Object.assign(p, { seat, act: 'bench', stage: 'go', timer: 30, wait: 0 });
    return true;
  }
  const sits = GRASS_SITS.filter(hasClip);
  if (!isOpenGround(area) || !sits.length) return false;
  const radius = CIRCLE_RADIUS*S.peopleSize;
  const circle = groups.find(g => g.kind === 'circle' && g.area === area && g.members.length < CIRCLE_MAX && Math.hypot(g.cx - p.x, g.cz - p.z) < 30);
  let spot = null;
  if (circle && peopleRng() < 0.85) {
    // the place round the circle furthest from anyone already there
    for (let k=0;k<12;k++) {
      const angle = (k + peopleRng()*0.5)/12*Math.PI*2, x = circle.cx + Math.sin(angle)*radius, z = circle.cz + Math.cos(angle)*radius;
      const gap = Math.min(...circle.members.map(m => Math.abs(wrapAngle(angle - m.circleAngle))));
      if (gap > 0.9 && (!spot || gap > spot.gap) && clearGround(area, x, z, 0.35*S.peopleSize)
        && walkableUpTo(area, p, x, z).clear) spot = { x, z, angle, gap };
    }
    if (!spot) return false;
    circle.members.push(p);
    p.group = circle;
  } else {
    // an open patch of grass, away from other circles and anyone lying down
    for (let k=0;k<10 && !spot;k++) {
      const patch = randomSpotIn(area, p), angle = peopleRng()*Math.PI*2;
      const cx = patch.x - Math.sin(angle)*radius, cz = patch.z - Math.cos(angle)*radius;
      if (clearGround(area, cx, cz, radius + 0.5*S.peopleSize) && !groups.some(g => g.kind === 'circle' && Math.hypot(g.cx - cx, g.cz - cz) < 5)
        && !people.some(q => q.act === 'lie' && Math.hypot(q.x - cx, q.z - cz) < 4)) spot = { x: patch.x, z: patch.z, angle, cx, cz };
    }
    if (!spot) return false;
    p.group = { kind: 'circle', area, members: [p], speaker: null, turnIn: 0, cx: spot.cx, cz: spot.cz };
    groups.push(p.group);
  }
  Object.assign(p, { act: 'circle', stage: 'go', spot: { x: spot.x, z: spot.z }, circleAngle: spot.angle, sitClip: pickFrom(sits), timer: 40, wait: 0 });
  return true;
}

/**
 * Send someone in a park or on a beach with nobody else about to a patch of ground to lie down on.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {boolean} whether somewhere was found
 */
export function goLieDown(p, area) {
  const poses = LIE_DOWNS.filter(hasClip);
  if (!personModel || !isOpenGround(area) || !poses.length) return false;
  const size = S.peopleSize, near = 8*size;
  if (people.some(q => q !== p && q.mode === 'wander' && q.area === p.area && Math.abs(q.x - p.x) < near && Math.abs(q.z - p.z) < near)) return false;
  for (let k=0;k<10;k++) {
    const patch = randomSpotIn(area, p), heading = peopleRng()*Math.PI*2, fx = Math.sin(heading), fz = Math.cos(heading);
    // room from their head (behind where their pelvis goes) to their feet
    if (![-0.5, 0, 0.5, 0.9].every(d => clearGround(area, patch.x + fx*d*size, patch.z + fz*d*size, 0.45*size))) continue;
    Object.assign(p, { act: 'lie', stage: 'go', spot: { x: patch.x, z: patch.z, heading }, lieClip: pickFrom(poses), timer: 30, wait: 0 });
    return true;
  }
  return false;
}

/**
 * Work out where someone sitting or lying down, or talking in a plaza or park, should walk to, if anywhere.
 *
 * Sitting or lying down goes: walking there ('go'), turning the right way ('turn'), waving hello to a circle ('greet'),
 * sitting or lying ('sit') for a while, getting up ('rise'), and waving goodbye to a circle ('bye').
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where to head (null to stay put)
 */
export function updateActivity(p, area, dt) {
  if (p.act === 'chat') return p.group.stage === 'gather' && p === p.group.members[1] ? { x: p.tx, y: area.y, z: p.tz } : null;
  // where they sit or lie, and facing which way: in front of a bench seat, facing out into the plaza (sitting shifts them
  // back onto it); a place in a circle, facing its middle; or a patch of grass
  let spot = p.spot, facing, poseName;
  if (p.act === 'bench') {
    const seat = p.seat, reach = -clipNamed('Sit1').pelvisZ*modelScale(p);
    spot = { x: seat.x + seat.nx*reach, z: seat.z + seat.nz*reach };
    facing = Math.atan2(seat.nx, seat.nz);
    poseName = 'Sit1';
  } else if (p.act === 'circle') {
    facing = headingTo(spot, { x: p.group.cx, z: p.group.cz });
    poseName = p.sitClip;
  } else {
    facing = spot.heading;
    poseName = p.lieClip;
  }
  switch (p.stage) {
    case 'go':
      p.timer -= dt;
      if (p.timer <= 0) { finishActivity(p); return null; } // can't get there
      if (Math.hypot(spot.x - p.x, spot.z - p.z) > 0.25) return { x: spot.x, y: area.y, z: spot.z };
      p.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = facing;
      if (Math.abs(wrapAngle(facing - p.heading)) > 0.15) break;
      if (p.act === 'circle' && hasClip('Wave') && p.group.members.some(m => m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'greet'; break; }
      // falls through
    case 'greet':
      if (p.oneShot) break;
      p.stage = 'sit';
      p.pose = poseName;
      p.timer = ((p.act === 'circle' ? 25 : 15) + peopleRng()*45)*p.traits.patience;
      if (p.act === 'bench') p.seatLift = p.seat.y - area.y - clipNamed('Sit1').seatY*modelScale(p);
      // falls through
    case 'sit':
      p.timer -= dt;
      if (p.timer <= 0) { p.stage = 'rise'; p.pose = 'Idle'; p.lookAt = null; }
      break;
    case 'rise':
      if (weightOf(p, clipNamed('Idle')) < 1) break;
      if (p.act === 'circle' && hasClip('Wave') && p.group.members.some(m => m !== p && m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'bye'; break; }
      finishActivity(p);
      return null;
    case 'bye':
      if (!p.oneShot) { finishActivity(p); return null; }
      break;
  }
  // on a bench, sitting down shifts them back onto the seat, and getting up forward off it — as far as sitting puts their
  // pelvis behind their feet, so that their feet stay put
  if (p.act === 'bench') {
    const w = weightOf(p, clipNamed('Sit1'));
    p.x = spot.x + (p.seat.x - spot.x)*w; p.z = spot.z + (p.seat.z - spot.z)*w;
  }
  return null;
}

//  ============== Punching  ============== 
// Someone (more often the more aggression they have) picks on someone near them — on the same walkway, or in
// the same plaza or park — goes up to them, to talk distance, punches them, and walks off.
//
// The victim notices them at the last moment, turns to face them, and is knocked flat on their back; they lie there a
// while, then get up where they fell.
const PUNCH_RATE = 1/8;        // the chance a second of picking on someone, per unit of aggression
const PUNCH_REACH = 8;          // how far off (at people size 1) the one they pick on can be
const PUNCH_NOTICE = 2.5;       // how near they come before they're noticed
export const PUNCH_CHASE_SPEED = 1.5;  // how much faster than they walk they go after them
const PUNCH_CHASE_MAX = 10;     // seconds before they give up on catching them
const BYSTANDER_RADIUS = 7, BYSTANDER_SHARE = 0.5; // how near (at people size 1) someone has to be to a punch to join in, and their chance as a share of the victim's
const DOWN_TIME_SCALE = 0.7;    // how long someone lies there once knocked flat, as a share of the usual 3 to 7 seconds
const DODGE_SMOKE_PUFFS = 6; // the puffs of smoke left where someone dodged from
const DODGE_LEAP_DISTANCE = 4; // how far someone with the dodge trait leaps back from a punch
const BLOODLUST_DODGE_BONUS = 0.3; // added to the dodge chance of anyone bloodlusting (covered in blood, with the bloodlust trait)
const RETALIATE_CHANCE = 0.1;   // the chance, per unit of aggression, that someone punched goes after whoever did it when they get up (or else runs)
export const PUNCH_HIT_TIME = 0.5;    // how far into the Punch animation the fist lands, in seconds
let reach = PUNCH_REACH*S.peopleSize;
/**
 * Whether someone going about their business might punch or be punched.
 * @param {Person} q - the person
 * @returns {boolean} whether they're fair game
 */
export const isFairGame = q => (q.mode === 'line' || q.mode === 'wander') && !q.act && !q.fright && !q.stun && !q.please && !q.jc && !q.crossStage
  && !q.attack && !q.punched && !q.oneShot;
/**
 * Let everyone who might pick a fight this frame think about it.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function pickFights(dt) {
  if (!hasClip('Punch') || !hasClip('Fall')) return;
  reach = PUNCH_REACH*S.peopleSize;
  people.forEach(p => {
    throwPunch(dt, p)
  });
}

/**
 * Give someone the chance to pick on someone near them, and set them going after whoever they pick.
 * @param {number} dt - seconds since the last frame
 * @param {Person} p - the person
 * @param {boolean} [isForced] - whether the punch is called for rather than rolled for (the game's doing)
 * @param {Person} [forcedVictim] - who to go for, when it is
 * @returns {void}
 */
export function throwPunch(dt, p, isForced, forcedVictim) {
  const { aggression } = p.traits;
  dt = isForced? p.punchCooldown : dt; //force punch roll if forced
  if ( !isForced && (aggression-1 <= 0 || (p.punchCooldown -= dt*aggression/3) > 0 || !isFairGame(p))) return;
  if (isForced) dt = 1;
  if (peopleRng() > dt*PUNCH_RATE*aggression/4){
    p.punchCooldown = 20 + peopleRng()*20;
    return;
  } 
  
  let victim;
  if (forcedVictim) {
    victim = forcedVictim;
  } else {
    // anyone near enough: along the same walkway (not across the block it runs round), or in the same hangout
    const nav = p.mode === 'line' ? peopleNav.lines[p.li] : null;
    const along = q => { const d = Math.abs(q.u - p.u); return nav.loop ? Math.min(d, nav.total - d) : d; };
    const near = people.filter(q => q !== p && q.mode === p.mode && Math.abs(q.x - p.x) < reach && Math.abs(q.z - p.z) < reach
      && Math.hypot(q.x - p.x, q.z - p.z) < reach && (nav ? q.li === p.li && along(q) < reach : q.area === p.area) && isFairGame(q));
    if (!near.length) { p.punchCooldown = 2 + peopleRng()*3; return; }
    victim = pickFrom(near);
  }
  goAfter(p, victim);
  p.punchCooldown = 20 + peopleRng()*20;
}

/**
 * Set someone going after someone to punch them: up to them, to talk distance, then a punch (see updateAttack).
 * @param {Person} p - the one who'll punch
 * @param {Person} victim - who they're going after
 * @param {boolean} [revenge] - whether it's for a punch thrown at them or someone else, which nobody else then takes up
 * @returns {void}
 */
export function goAfter(p, victim, revenge = false) {
  p.attack = { target: victim, stage: 'chase', timer: PUNCH_CHASE_MAX*(revenge ? p.traits.patience : 1), revenge }; // (how long they'll chase someone for revenge goes by their patience)
  p.lookAt = victim;
  if (!victim.punched) victim.punched = { by: p, stage: 'marked', timer: 0 }; // (several can be after one person: the first to reach them lands it)
}

/** How far, as a multiple of the gap they stand at, a controlled person can get from whoever's punching them before the punch lands and still not be hit. */
const PUNCH_MISS_FACTOR = 1.5;

/** How long someone stands staring down whoever they've just knocked flat, in seconds. */
const PUNCH_STARE_TIME = 1.5;

/**
 * Move someone punching on, each frame.
 * @param {Person} p - the person punching
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still)
 */
export function updateAttack(p, dt) {
  const a = p.attack, t = a.target;
  a.timer -= dt;
  if (a.stage === 'chase') {
    if ((t.punched?.by !== p && t.punched?.stage !== 'marked') || a.timer <= 0 || !(t.mode === 'line' || t.mode === 'wander' || t.mode === 'leaving' || t.mode === 'possessed') || t.jc) { endAttack(p); return null; }
    const d = Math.hypot(t.x - p.x, t.z - p.z), gap = CHAT_GAP*S.peopleSize;
    if (t.mode !== 'possessed' && t.punched.stage === 'marked' && d < PUNCH_NOTICE*S.peopleSize) { // (whoever's being controlled isn't braced, and keeps their freedom until the fist lands)
      t.punched = null;
      endActivity(t);
      t.oneShot = null; t.wait = 0;
      t.punched = { by: p, stage: 'brace', timer: 0 };
      t.faceTo = headingTo(t, p); t.lookAt = p;
    }
    if (d > gap + 0.1) return { x: t.x + (p.x - t.x)/d*gap, y: t.y, z: t.z + (p.z - t.z)/d*gap };
    a.stage = 'punch';
    a.chaseLeft = a.timer; // (what's left of the chase, if the punch misses)
    a.timer = PUNCH_HIT_TIME;
    playOnce(p, 'Punch');
    swingSound(p);
  }
  if (a.stage === 'punch') {
    if (t.punched?.by !== p) { endAttack(p); return null; } // (someone else got there first: it's over)
    p.faceTo = headingTo(p, t);
    if (a.timer > 0) return null;
    if (t.mode === 'possessed' && Math.hypot(t.x - p.x, t.z - p.z) > CHAT_GAP*S.peopleSize*PUNCH_MISS_FACTOR) { // (walked out of reach: it misses, and they're chased on)
      a.stage = 'chase';
      a.timer = a.chaseLeft;
      return null;
    }
    if (t.punched?.by === p && !dodgePunch(t, p)) {
      knockDown(t, p);
      if (t.mode !== 'possessed') App.pushPerson?.(t, t.x - p.x, t.z - p.z, PUNCH_MIN_PUSH*p.traits.speed*p.traits.size);
    }
    a.stage = 'stare';
    a.timer = PUNCH_STARE_TIME;
  }
  if (a.stage === 'stare') {
    p.faceTo = headingTo(p, t); // keep looking down at them while it plays out
    if (a.timer > 0) return null;
    a.stage = 'follow';
  }
  // the stare's over, they walk off
  if (!p.oneShot) {
    endAttack(p);
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), from = nav.pts[k], to = nav.pts[k + 1];
      if (((to.x - from.x)*(t.x - p.x) + (to.z - from.z)*(t.z - p.z))*p.dir > 0) p.dir = -p.dir;
    } else if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      let best = null;
      for (let k=0;k<8;k++) {
        const spot = randomSpotIn(area, p), d = Math.hypot(spot.x - t.x, spot.z - t.z);
        if (!best || d > best.d) best = { ...spot, d };
      }
      p.tx = best.x; p.tz = best.z; p.wait = 0;
    }
  }
  return null;
}

/**
 * Stop someone going after whoever they were going to punch — who, if they hadn't been hit yet, carries on as they were.
 * @param {Person} p - the person punching
 * @returns {void}
 */
function endAttack(p) {
  const a = p.attack;
  if (!a) return;
  p.attack = null;
  p.lookAt = null; p.faceTo = null;
  const t = a.target;
  if (t.punched?.by === p && (t.punched.stage === 'marked' || t.punched.stage === 'brace')) { t.punched = null; t.faceTo = null; t.lookAt = null; }
}

/**
 * Let someone being punched off it (to do something else): whoever was coming for them gives up, and if they were
 * falling they stand straight back up.
 * @param {Person} p - the person being punched
 * @returns {void}
 */
function releasePunched(p) {
  const k = p.punched;
  if (!k) return;
  p.punched = null;
  if (k.by.attack?.target === p) endAttack(k.by);
  if (k.stage === 'fall') p.oneShot = null;
}

/**
 * The whoosh of a fist swung, as it comes through, a moment before it lands (PUNCH_HIT_TIME into the Punch animation).
 * @param {Person} p - whoever's swinging
 * @returns {void}
 */
export function swingSound(p) {
  playSound('whoosh', { x: p.x, y: p.y + personHeight(p)*0.75, z: p.z }, 1, Math.max(0, PUNCH_HIT_TIME - 0.15));
}

/**
 * Land the punch: knock them flat on their back, facing whoever hit them.
 * They cry out as they go (whatever knocked them down), and a fist landing is heard.
 * @param {Person} t - the one being hit
 * @param {Person} p - the one hitting them
 * @returns {void}
 */
export function knockDown(t, p) {
  if (p.traits) punchSpill(t, p);
  const head = { x: t.x, y: t.y + personHeight(t)*0.9, z: t.z };
  if (people.includes(p)) playSound('punch', { ...head, y: t.y + personHeight(t)*0.75 });
  exclaim(head, voiceOfPerson(t));
  t.punched.stage = 'fall';
  t.heading = headingTo(t, p);
  t.faceTo = null; t.lookAt = null;
  playOnce(t, 'Fall');
  t.pose = 'Fallen';
  bystandersReactToPunch(t, p);
}

/**
 * Let someone with the dodge trait, at that chance, leap back out of a punch, then go after whoever threw it.
 * @param {Person} t - the one about to be hit
 * @param {{x: number, z: number}} from - whoever is punching them
 * @returns {boolean} whether they got clear (the punch misses)
 */
export function dodgePunch(t, from) {
  const chance = t.traits.dodge + (isBloodlusting(t) ? BLOODLUST_DODGE_BONUS : 0);
  if (chance <= 0 || isGone(t) || peopleRng() >= chance) return false;
  const attacker = from.traits ? from : null;
  if (t.punched?.by === from && (t.punched.stage === 'marked' || t.punched.stage === 'brace')) t.punched = null;
  endActivity(t);
  t.stun = t.fright = t.please = null; t.oneShot = null; t.wait = 0;
  t.crossStage = null; t.jc = null;
  puffSmoke({ x: t.x, y: t.y, z: t.z }, 1.7*t.height*S.peopleSize, DODGE_SMOKE_PUFFS); // (where they leapt from)
  App.pushPerson?.(t, t.x - from.x, t.z - from.z, DODGE_LEAP_DISTANCE*Math.max(1, t.traits.size));
  if (t.mode !== 'possessed') { t.heading = t.faceTo = headingTo(t, from); t.lookAt = attacker; } // (leaping back, still facing them)
  if (attacker && (t.mode === 'line' || t.mode === 'wander' || t.mode === 'leaving')) goAfter(t, attacker, true);
  return true;
}

/**
 * Everyone near someone who's just been punched by a person (out to start something) reacts at once: half the victim's own chance (see reactToPunch),
 * less for anyone more evil, to go after whoever did it, and otherwise they run from them.
 * @param {Person} victim - who was hit
 * @param {object} puncher - whoever hit them (anything but a person is ignored)
 * @returns {void}
 */
function bystandersReactToPunch(victim, puncher) {
  if (!puncher?.traits || puncher.attack?.revenge || (puncher.punched && puncher.punched.stage !== 'marked')) return; // (a revenge punch is answered by no one but whoever it hit: see reactToPunch)
  const radius = BYSTANDER_RADIUS*S.peopleSize;
  people.forEach(q => {
    if (q === victim || q === puncher || isGone(q) || q.punched || q.attack || !['line', 'wander', 'leaving'].includes(q.mode)) return;
    if (Math.hypot(q.x - victim.x, q.z - victim.z) > radius) return;
    const chance = RETALIATE_CHANCE*q.traits.aggression*BYSTANDER_SHARE/Math.max(0.25, 1 + (q.traits.evil ?? 0));
    endActivity(q);
    q.stun = q.fright = q.please = null; q.oneShot = null; q.wait = 0;
    if (q.mode !== 'leaving' && peopleRng() < chance) goAfter(q, puncher, true);
    else beginFleeing(q, { x: puncher.x, z: puncher.z });
  });
}

/** The modes whose people can't be knocked over: anyone dead, not yet placed, out of sight or on a train. */
const UNREACHABLE_MODES = ['dead', 'none', 'indoors', 'train'];
/**
 * Whether someone can be knocked over by a blow they didn't see coming: anyone in view, the one being controlled included,
 * whatever they're in the middle of or feeling (walking, leaving a plaza, sitting, chatting, lying down, crossing a road, frightened, stunned,
 * delighted, about to be punched by someone else), unless they're already down or getting up.
 * @param {Person} q - the person
 * @returns {boolean} whether a blow would land
 */
export const canBeKnockedOver = q => !UNREACHABLE_MODES.includes(q.mode) && (!q.punched || q.punched.stage === 'marked' || q.punched.stage === 'brace');

/**
 * Knock someone over as if they'd been punched, by whatever is at `from` ({ x, z }): flat on their back, facing it, out
 * of whatever they were doing (see canBeKnockedOver).
 * @param {Person} t - the one being hit
 * @param {{x: number, z: number}} from - where the blow came from
 * @returns {boolean} whether they went down
 */
export function knockOver(t, from) {
  if (isGone(t) || !canBeKnockedOver(t) || !hasClip('Fall')) return false;
  releasePunched(t); // (whoever was coming to punch them gives up)
  if (t.act || t.attack) finishActivity(t);
  t.fright = t.stun = t.please = null;
  t.crossStage = null; t.jc = null; // (a car yielding to them stops)
  t.punched = { by: from, stage: 'brace', timer: 0 };
  knockDown(t, from);
  return true;
}

/**
 * Move someone who's been knocked flat on their back to where the fall leaves them: to where their pelvis landed, as
 * for anyone lying down, the pose drawn set back from there by as much (so nothing moves).
 * @param {Person} p - the person
 * @returns {void}
 */
export function landFall(p) {
  const fallen = clipNamed('Fallen'), s = modelScale(p), sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  const offX = fallen.pelvisX*s, offZ = fallen.pelvisZ*s;
  p.x += offX*cos + offZ*sin; p.z += offZ*cos - offX*sin;
  p.clipA = p.clipB = fallen; p.fade = 1;
  p.punched.stage = 'down';
  p.punched.timer = (3 + peopleRng()*4)*DOWN_TIME_SCALE;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
}

/**
 * Move someone who's been punched on, each frame: lying there a while, then getting up.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updatePunched(p, dt) {
  const k = p.punched;
  if (k.stage === 'down' && (k.timer -= dt) <= 0) { k.stage = 'rise'; p.pose = 'Idle'; }
  else if (k.stage === 'rise' && weightOf(p, clipNamed('Idle')) >= 1) { p.punched = null; p.wait = 0.5 + peopleRng(); reactToPunch(p, k.by); }
}

/**
 * Someone who's just got up after being punched by a person: in proportion to their aggression, they go after whoever
 * did it, and otherwise run from them. (Knocked over by anything else — a bee — they carry on.)
 * @param {Person} p - the person who was punched
 * @param {object} by - whoever knocked them over
 * @returns {void}
 */
function reactToPunch(p, by) {
  if (!by?.traits || isGone(by)) return;
  const canFight = (p.mode === 'line' || p.mode === 'wander') && (!by.punched || by.punched.stage === 'marked') && ['line', 'wander', 'leaving', 'possessed'].includes(by.mode);
  if (canFight && (p.traits.vampire || peopleRng() < RETALIATE_CHANCE*p.traits.aggression)) {
    goAfter(p, by, true);
  } else {
    beginFleeing(p, { x: by.x, z: by.z });
  }
}

export const RIDE_CHANCE = 0.05;
/** How far beyond a station's sides a walkway can pass and still lead up to it. */
const STATION_REACH = 4;
/** How long someone waits on a platform, and rides, before giving up on it. */
const TRAIN_WAIT_MAX = 120, TRAIN_RIDE_MAX = 240;
/** What each station's foot leads to, and which station is nearest each walkway point and hangout (see stationLinks). */
let stationLinksCache = null, stationLinksKey = '';
/**
 * Work out what each station's foot leads to, again when the walkways or the trains change: for each station node,
 * { area (the hangout it stands in, or -1), vertex ({ li, vi }, the nearest walkway point, or null) } — and the other
 * way, the station near each walkway point ('li:vi') and those in each hangout (by index).
 * @returns {{ground: Map<*, *>, byVertex: Map<string, *>, byArea: Map<number, *>}} the links
 */
export function stationLinks() {
  const key = peopleNavBuiltAt + ':' + trainStationsVersion();
  if (stationLinksCache && key === stationLinksKey) return stationLinksCache;
  stationLinksKey = key;
  const { areas, lines, grid, CELL } = peopleNav, links = { ground: new Map(), byVertex: new Map(), byArea: new Map() };
  const nearest = new Map(); // 'li:vi' -> its distance to the station it's been given
  getTrainStations().forEach(st => {
    const area = areas.findIndex(a => st.x >= a.minX && st.x <= a.maxX && st.z >= a.minZ && st.z <= a.maxZ && a.inside(st.x, st.z));
    const reach = st.halfW + STATION_REACH, span = Math.ceil(reach/CELL);
    const cx = Math.floor(st.x/CELL), cz = Math.floor(st.z/CELL);
    let vertex = null;
    for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      if (lines[li].blocked && lines[li].blocked[vi]) return; // (not out on a road)
      const q = lines[li].pts[vi], d = Math.hypot(q.x - st.x, q.z - st.z), k = li + ':' + vi;
      if (d > reach) return;
      if (!vertex || d < vertex.d) vertex = { li, vi, d };
      if (!nearest.has(k) || d < nearest.get(k)) { nearest.set(k, d); links.byVertex.set(k, st.nodeId); }
    });
    if (area < 0 && !vertex) return;
    links.ground.set(st.nodeId, { area, vertex });
    if (area >= 0) { if (!links.byArea.has(area)) links.byArea.set(area, []); links.byArea.get(area).push(st.nodeId); }
  });
  return (stationLinksCache = links);
}

/**
 * Send someone off to the foot of a station to ride its trains.
 * @param {Person} p - the person
 * @param {*} node - the station's node id
 * @param {{x: number, y: number, z: number}} from - where they are now
 * @returns {void}
 */
export function goRideTrain(p, node, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'train';
  p.train = { node, stage: 'approach', target: { x: from.x, y: from.y, z: from.z }, side: 1, along: 0, lineId: null, timer: 0 };
}

/**
 * Move someone riding the trains on, each frame: to the foot of the station, up onto its landing, in to wait on the
 * platform, then aboard the first carriage to stop there, and back out again at the other end.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still, or aboard)
 */
export function updateTrainRider(p, i, dt) {
  const ride = p.train, st = getTrainStations().get(ride.node), reached = () => Math.hypot(ride.target.x - p.x, ride.target.z - p.z) < 0.35;
  ride.timer += dt;
  if (ride.stage === 'ride') {
    const shuttle = getTrainShuttles().find(s => s.lineId === ride.lineId);
    if (!shuttle) { gotOff(p, i); dropToGround(p); return null; } // (their line's gone)
    p.x = shuttle.object.position.x; p.y = shuttle.object.position.y; p.z = shuttle.object.position.z;
    const at = shuttle.arrived && getTrainStations().get(shuttle.stopNode);
    if (at && stationLinks().ground.has(at.nodeId) && (at.networkStations <= 2 || peopleRng() < 1/at.networkStations || ride.timer > TRAIN_RIDE_MAX)) {
      // off here: back onto the platform, beside the track, to walk out the way they'd have come in
      ride.node = at.nodeId; ride.stage = 'exit'; ride.side = peopleRng() < 0.5 ? -1 : 1; ride.timer = 0;
      const out = at.spot(ride.side*(at.radius + 0.8), (peopleRng()*2 - 1)*Math.min(2, at.alongMax));
      p.x = out.x; p.y = out.y; p.z = out.z;
      p.heading = headingTo(p, at.spot(ride.side*at.landing, 0));
      ride.target = at.spot(ride.side*at.landing, 0);
      gotOff(p, i);
    }
    return null;
  }
  if (!st) { dropToGround(p); return null; } // (the station's gone from under them)
  if (ride.stage === 'approach') {
    if (!reached()) return ride.target;
    // up onto the landing outside whichever of its doors is nearer
    const plus = st.spot(st.landing, 0), minus = st.spot(-st.landing, 0);
    ride.side = Math.hypot(plus.x - p.x, plus.z - p.z) <= Math.hypot(minus.x - p.x, minus.z - p.z) ? 1 : -1;
    const landing = ride.side > 0 ? plus : minus;
    p.x = landing.x; p.y = landing.y; p.z = landing.z;
    ride.stage = 'enter';
    ride.along = (peopleRng()*2 - 1)*st.alongMax;
    ride.target = st.spot(ride.side*(st.radius + 0.8 + peopleRng()*1.2), ride.along);
    return ride.target;
  }
  if (ride.stage === 'enter') {
    if (!reached()) return ride.target;
    ride.stage = 'wait'; ride.timer = 0;
    p.faceTo = headingTo(p, st.spot(0, ride.along)); // (towards the track)
    return null;
  }
  if (ride.stage === 'wait') {
    const shuttle = getTrainShuttles().find(s => s.stopNode === ride.node && st.lineIds.includes(s.lineId));
    if (shuttle) {
      // aboard
      p.faceTo = null; p.oneShot = null;
      ride.stage = 'ride'; ride.lineId = shuttle.lineId; ride.timer = 0;
      if (followed === i) { stopFollowingPerson(); App.followTrainLine?.(shuttle.lineId); setRiderFollowed(i); }
    } else if (ride.timer > TRAIN_WAIT_MAX) {
      // fed up of waiting: back out
      p.faceTo = null;
      ride.stage = 'exit'; ride.target = st.spot(ride.side*st.landing, 0);
    }
    return null;
  }
  // 'exit': out to the landing, then down to the station's foot
  if (!reached()) return ride.target;
  landAtStation(p, ride.node);
  return null;
}

/**
 * Put the camera back onto someone who's just got off a train, if it came along for the ride and is still on it.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @returns {void}
 */
function gotOff(p, i) {
  if (riderFollowed !== i) return;
  setRiderFollowed(-1);
  if (App.followedTrainLine?.() !== p.train.lineId) return;
  App.stopFollowingTrain();
  followPerson(i);
}

/**
 * Bring someone down from a station's landing to its foot: onto the walkway there (heading either way), or into the
 * hangout it's in.
 * @param {Person} p - the person
 * @param {*} node - the station's node id
 * @returns {void}
 */
function landAtStation(p, node) {
  const foot = stationLinks().ground.get(node), st = getTrainStations().get(node);
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  if (foot && foot.vertex) {
    placeAtVertex(p, foot.vertex.li, foot.vertex.vi, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else if (foot) {
    const area = peopleNav.areas[foot.area];
    wanderInto(p, foot.area, st);
    p.x = p.tx; p.z = p.tz; p.y = area.y;
  } else {
    p.mode = 'line';
    dropToGround(p);
  }
}

/**
 * Put someone straight onto the nearest walkway or hangout below, the station or line they were on having gone.
 * @param {Person} p - the person
 * @returns {void}
 */
function dropToGround(p) {
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  p.mode = 'line';
  reseatPerson(p);
  if (p.mode === 'line') { const at = walkwayPoint(p); p.x = at.x; p.y = at.y; p.z = at.z; }
  else if (p.mode === 'wander') { p.x = p.tx; p.z = p.tz; p.y = peopleNav.areas[p.area].y; }
}

/** What the followed carriage's card was last told, so it's only told again when it changes. */
let passengersKey = null;
/**
 * Tell the followed carriage's card who's aboard, by name, with whoever the camera came aboard with picked out. Clicking
 * one of the others makes them the one it came aboard with instead, so it gets off with them (see gotOff).
 * @returns {void}
 */
export function showPassengers() {
  const line = App.followedTrainLine?.();
  const riders = [];
  if (line && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'train' && p.train.stage === 'ride' && p.train.lineId === line) riders.push(i); });
  const key = line + '|' + riders.join(',') + '|' + riderFollowed + '|' + profilesVersion() + '|' + !!personModel;
  if (key === passengersKey || !App.setTrainCardPassengers) return;
  passengersKey = key;
  App.setTrainCardPassengers(
    riders.map(i => profileOf(people[i].id, personModel ? personModel.isMan[i] === 1 : null).name),
    riders.indexOf(riderFollowed),
    at => { setRiderFollowed(riders[at]); },
  );
}

// ============== Going Indoors ============== 
// Someone walking past a building's door (buildingDoors) sometimes goes in — up to the door, inside
// for up to INDOORS_MAX_HOURS of the day's clock (measured at the World panel's day length, whether or not it is running) —
// then back out the same door and on along the walkway they left.
//
// p.indoors: { building, stage ('approach' → 'inside' → 'exit'), back (the walkway point they came from), hoursLeft }
/** The chance of going in, at each walkway point with a door onto it. */
export const ENTER_CHANCE = 0.1;
/** How long a visit lasts, in hours of the day's clock. */
const INDOORS_MIN_HOURS = 0.25, INDOORS_MAX_HOURS = 7;
/** The most of the crowd that may be indoors (or on their way in) at once: INDOORS_MAX_SHARE of the people alive. */
const INDOORS_MAX_SHARE = 0.3;
/** Seconds after coming out before they'd go in anywhere again. */
export const INDOORS_COOLDOWN = 30;
/**
 * Whether this person may go indoors right now.
 * @param {Person} p - the person
 * @returns {boolean} whether they may
 */

export const mayGoIndoors = p => p.indoorsCooldown <= 0 && !p.act && !p.attack && !p.punched && !p.fright && indoorsCount < people.length*INDOORS_MAX_SHARE;
/**
 * Send someone in at a building's door, for anything up to INDOORS_MAX_HOURS of the day's clock.
 * @param {Person} p - the person
 * @param {object} building - the building they're going into (see buildingDoors)
 * @param {{x: number, y: number, z: number}} from - the walkway point they came off
 * @returns {void}
 */
export function goIndoors(p, building, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'indoors';
  // mostly a quick visit, now and then most of the day
  const hours = INDOORS_MIN_HOURS + (INDOORS_MAX_HOURS - INDOORS_MIN_HOURS)*peopleRng()**2;
  p.indoors = { building, stage: 'approach', back: { x: from.x, y: from.y, z: from.z }, hoursLeft: hours };
  p.inRoom = null;
  setIndoorsCount(indoorsCount + 1);
}

/**
 * Move someone going into, being in, or coming out of a building on, each frame.
 * @param {Person} p - the person
 * @param {number} i - their index in people (for the camera's sake)
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to (null to stand still, or to be inside)
 */
export function updateIndoors(p, i, dt) {
  const visit = p.indoors, { door } = visit.building;
  if (visit.stage === 'approach') {
    if (Math.hypot(door.x - p.x, door.z - p.z) >= 0.35) return { x: door.x, y: visit.building.y, z: door.z };
    visit.stage = 'inside';
    p.faceTo = null; p.lookAt = null; p.oneShot = null;
    if (followed === i) lookAtBuilding(visit.building);
    return null;
  }
  if (visit.stage === 'inside') {
    visit.hoursLeft -= dt*24/(Math.max(0.1, S.dayLengthMinutes)*60);
    if (visit.hoursLeft > 0) return aboutTheRoom(p, visit, dt);
    // back out, at the door, facing the walkway
    visit.stage = 'exit';
    standUp(p);
    p.inRoom = null; p.faceTo = null;
    p.x = door.x; p.z = door.z; p.y = visit.building.y;
    p.heading = headingTo(p, visit.back) + (p.traits.backwards ? Math.PI : 0);
    if (followed === i) lookAtPerson(p);
    // and out with whoever the building's card was told to wait on: the camera leaves the building for them
    if (awaited === i) { awaited = -1; App.stopFollowingBuilding?.(); followPerson(i); }
    return visit.back;
  }
  // 'exit': back to the walkway, then on along it, whichever way
  if (Math.hypot(visit.back.x - p.x, visit.back.z - p.z) >= 0.35) return visit.back;
  p.indoors = null;
  p.indoorsCooldown = INDOORS_COOLDOWN*(0.5 + peopleRng());
  p.mode = 'line';
  p.dir = peopleRng() < 0.5 ? -1 : 1;
  reseatPerson(p);
  return null;
}

/**
 * Someone inside a building while the camera's in there too (see buildings/interior.js): somewhere in its one room — put
 * there the first frame the room's there to be in (now and then already sat down), and after that standing about, now
 * and then going over to somewhere else in it, round the furniture, or to sit on the sofa or a chair a while. The room's
 * no bigger than a room, so they amble rather than stride.
 * @param {Person} p - the person
 * @param {object} visit - their p.indoors
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to, or null to stand where they are
 */
function aboutTheRoom(p, visit, dt) {
  if (!roomHolds(visit.building.key)) { standUp(p); p.inRoom = null; return null; }
  someoneHome();
  if (p.inRoom?.visit !== roomVisit()) {
    standUp(p);
    const at = roomSpot(peopleRng);
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.heading = peopleRng()*Math.PI*2;
    p.inRoom = { visit: roomVisit(), route: null, wait: peopleRng()*4, seat: null, stage: '' };
    // (some already sat down: straight onto the seat, as if they'd been there a while)
    const seat = peopleRng() < ROOM_SIT_ALREADY ? freeSeat(p) : null;
    if (seat) {
      takeSeat(p, seat);
      const stand = standingSpot(p, seat);
      p.x = stand.x; p.z = stand.z;
      p.heading = Math.atan2(seat.nx, seat.nz);
      p.inRoom.stage = 'turn';
    }
  }
  const here = p.inRoom;
  if (here.seat) return sitting(p, here, dt);
  if (here.route) {
    const next = here.route[0];
    if (Math.hypot(next.x - p.x, next.z - p.z) >= 0.3) return next;
    here.route.shift();
    if (here.route.length) return here.route[0];
    here.route = null;
    here.wait = (3 + peopleRng()*10)*p.traits.patience;
    p.faceTo = peopleRng()*Math.PI*2; // (somewhere to look, once they're there)
  } else if ((here.wait -= dt) <= 0 && !p.oneShot) {
    here.wait = 1 + peopleRng()*2; // (tried again in a moment, if there's no getting there)
    const seat = peopleRng() < ROOM_SIT_CHANCE ? freeSeat(p) : null;
    if (seat) {
      const route = roomRoute(p, standingSpot(p, seat));
      if (route) { takeSeat(p, seat); here.route = route; here.stage = 'go'; here.timer = 25; p.faceTo = null; return route[0]; }
    }
    here.route = roomRoute(p, roomSpot(peopleRng));
    if (here.route) p.faceTo = null;
  }
  return null;
}
/** The chance, each time someone in a room moves on, that it's to sit down, and that they're sat down already when it's first shown. */
const ROOM_SIT_CHANCE = 0.45, ROOM_SIT_ALREADY = 0.4;
/**
 * A seat in the room nobody's on or heading for, if there is one — and if they're about the size the furniture's made for.
 * @param {Person} p - the person
 * @returns {?object} the seat (see roomSeats)
 */
function freeSeat(p) {
  if (!personModel || !hasClip('Sit1') || Math.abs(S.peopleSize*p.traits.size - 1) > 0.3) return null;
  const free = roomSeats().filter(seat => !seat.by);
  return free.length ? free[Math.floor(peopleRng()*free.length)] : null;
}
function takeSeat(p, seat) {
  seat.by = p;
  p.inRoom.seat = seat;
}
/**
 * Where to stand to sit down on a seat: in front of it, as far as sitting puts their pelvis behind their feet (as on a
 * bench: see updateActivity).
 * @param {Person} p - the person
 * @param {object} seat - the seat (see roomSeats)
 * @returns {{x: number, y: number, z: number}} the spot, in the world
 */
function standingSpot(p, seat) {
  const reach = -clipNamed('Sit1').pelvisZ*modelScale(p);
  return { x: seat.x + seat.nx*reach, y: p.y, z: seat.z + seat.nz*reach };
}
/**
 * Up off wherever they're sitting in the room, if they are, and the seat let go of.
 * @param {Person} p - the person
 * @returns {void}
 */
function standUp(p) {
  const seat = p.inRoom?.seat;
  if (seat && seat.by === p) seat.by = null;
  if (p.inRoom) { p.inRoom.seat = null; p.inRoom.watched = null; }
  p.pose = 'Idle'; p.seatLift = 0; p.faceTo = null;
}
/**
 * Someone in a room with a seat to sit on: walking over ('go'), turning round ('turn'), sitting a while ('sit'), then
 * getting up ('rise') — sitting down shifting them back onto it and getting up forward off it, as on a bench.
 * @param {Person} p - the person
 * @param {object} here - their p.inRoom
 * @param {number} dt - seconds since the last frame
 * @returns {?{x: number, y: number, z: number}} where they should walk to, or null
 */
function sitting(p, here, dt) {
  const seat = here.seat, stand = standingSpot(p, seat), facing = Math.atan2(seat.nx, seat.nz);
  switch (here.stage) {
    case 'go':
      if ((here.timer -= dt) <= 0) { standUp(p); here.route = null; here.wait = 2; return null; } // can't get there
      if (here.route?.length) {
        const next = here.route[0];
        if (Math.hypot(next.x - p.x, next.z - p.z) >= (here.route.length > 1 ? 0.3 : 0.15)) return next;
        here.route.shift();
        if (here.route.length) return here.route[0];
      }
      here.route = null;
      here.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = facing;
      if (Math.abs(wrapAngle(facing - p.heading)) > 0.15 || p.oneShot) break;
      here.stage = 'sit';
      p.pose = 'Sit1';
      here.timer = (20 + peopleRng()*60)*p.traits.patience;
      p.seatLift = seat.y - p.y - clipNamed('Sit1').seatY*modelScale(p);
      // falls through
    case 'sit': {
      // (on the sofa, with a video on: up once it's over, however long that is — or, if the player won't say, as anywhere else)
      const on = seat.sofa ? watchingTV() : null;
      if (on > 0 && here.watched == null) here.watched = on;
      here.timer -= dt;
      if (here.watched != null && on !== -1 ? on !== here.watched : here.timer <= 0) { here.stage = 'rise'; p.pose = 'Idle'; }
      break;
    }
    case 'rise':
      if (weightOf(p, clipNamed('Idle')) < 1) break;
      standUp(p);
      here.wait = (2 + peopleRng()*6)*p.traits.patience;
      return null;
  }
  const w = weightOf(p, clipNamed('Sit1'));
  p.x = stand.x + (seat.x - stand.x)*w; p.z = stand.z + (seat.z - stand.z)*w;
  return null;
}

/** What the followed building's card was last told, so it's only told again when it changes. */
let inhabitantsKey = null;
/** Whoever indoors the camera's waiting on, or -1. */
export let awaited = -1;
/** Set whenever the camera starts or stops waiting on someone indoors (see showInhabitants). */
export function setAwaited(v) { awaited = v; }
/**
 * Tell the followed building's card who's inside, by name (see building-card.js). Clicking one of them waits on that one
 * — the camera leaves the building with them when they come back out the door (see awaited), the way it gets off a train
 * with whoever it came aboard with.
 * @returns {void}
 */
export function showInhabitants() {
  const key = App.followedBuildingKey?.();
  const inside = [];
  if (key && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'indoors' && p.indoors.stage === 'inside' && p.indoors.building.key === key) inside.push(i); });
  if (!inside.includes(awaited)) awaited = -1; // (the building let go of, or whoever it was gone some other way)
  const shownKey = key + '|' + inside.join(',') + '|' + awaited + '|' + profilesVersion() + '|' + !!personModel;
  if (shownKey === inhabitantsKey || !App.setBuildingCardInhabitants) return;
  inhabitantsKey = shownKey;
  if (key) App.setBuildingCardInhabitants(
    inside.map(i => profileOf(people[i].id, personModel ? personModel.isMan[i] === 1 : null).name),
    inside.indexOf(awaited),
    at => { awaited = inside[at]; },
  );
}

/**
 * Move the camera, following someone who's gone indoors, back far enough to take in the building they're in.
 * @param {object} b - the building (see buildingDoors)
 * @returns {void}
 */
function lookAtBuilding(b) {
  controls.goalRadius = Math.max(controls.goalRadius, Math.min(400, (b.size + b.height)*1.6));
}

/**
 * Swoop the camera back in on someone who's come out of a building.
 * @param {Person} p - the person
 * @returns {void}
 */
function lookAtPerson(p) {
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, personHeight(p)*9));
}

/**
 * Whether this person is walking over a road (see updateCrossing) — treated like someone standing in the middle of it
 * ('mid') by checkYield in traffic.js: out on the live lanes, not on a sidewalk.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the road
 */





