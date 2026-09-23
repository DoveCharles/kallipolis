import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { PERSON_TRAIT_COLORS } from './peopleModel.js';
import { PEOPLE_MAX, beginFleeing, isGone, people, peopleRng, personModel } from './people.js';
import { canBeKnockedOver, endActivity, goAfter } from './peopleActivities.js';
import { spillBlood } from '../giblets.js';

// Blood: when someone's killed (see killPerson), whoever's near enough is splashed — everyone within BLOOD_BLAST_RADIUS of a
// blast, or, if something struck them (a car or a plane), everyone in the cone it sent them flying along. Each takes a
// random handful of points, more the closer they are, up to BLOOD_MAX. Every point stains their skin, clothes, hat and hair a little closer to dark red and splotches their skin,
// and sends them running for BLOOD_FLEE_TIME. The more they hold, the more frightened their face (see updatePeople). Each
// BLOOD_FADE_TIME they lose a point, the colours easing back a step with it, until they're back as they were. Each point
// also speeds them up by BLOOD_SPEED_BONUS (on their speed trait) while they hold it (see bloodSpeed).
export const BLOOD_MAX = 50;
const BLOOD_COLOR = new THREE.Color(0x8a1010), BLOOD_STAIN = 0.02; // (of the way from their own colour to BLOOD_COLOR, for each point)
const SKIN_STAIN_SHARE = 0.75; // skin takes this much of BLOOD_STAIN
const BLOOD_OPACITY = 0.02; // how opaque the splotches over them are, for each point (see the Blood row of the traits texture)
const BLOOD_FLEE_TIME = 1.2, BLOOD_FADE_TIME = 1.2, BLOOD_SPEED_BONUS = 0.01;
const BLOOD_MIN_SPEED_BONUS = 0.4, BLOOD_MIN_FEAR = 0.5; // what even a single point does: at least this much speed, and this scared a face
/** What their blood adds to their speed trait (at least BLOOD_MIN_SPEED_BONUS, with any). */
export const bloodSpeed = p => p.blood ? Math.max(BLOOD_MIN_SPEED_BONUS, BLOOD_SPEED_BONUS*p.blood) : 0;
/** How scared their blood makes them look, 0 to 1 (at least BLOOD_MIN_FEAR, with any). */
export const bloodFear = p => p.blood ? Math.max(BLOOD_MIN_FEAR, p.blood/BLOOD_MAX) : 0;
const STAINED_PARTS = ['Skin', 'Top', 'Pants', 'Shoes', 'Hat', 'Hair', 'Skirt', 'Cuff'];
// (distances at people size 1)
const BLOOD_STRUCK_SPHERE_SHARE = 0.5, BLOOD_STRUCK_SPHERE_STRENGTH = 0.5; // the sphere round someone struck by something (a car, a plane), as a share of a blast's size and of its strength
const BLOOD_BLAST_RADIUS = 27;                      // how far a blast splashes
const BLOOD_CONE_COS = Math.cos(Math.PI*26/180);    // how near dead ahead of what struck them someone has to be: within 26 degrees
// (the cone as it was, to roll back to: range 52.5 + 6.3 a unit of speed, strength 0.48, falling off with the square of the
// distance and the cube of the aim — see BLOOD_CONE_DISTANCE_POWER and BLOOD_CONE_AIM_POWER)
const BLOOD_CONE_RANGE = 35, BLOOD_CONE_RANGE_PER_SPEED = 4.2; // how far the cone reaches, and how much further for each unit of speed
const BLOOD_CONE_STRENGTH = 0.7, BLOOD_BLAST_STRENGTH = 2.8; // what a cone and a blast give at their middle, as a share of BLOOD_BURST_POINTS
const BLOOD_CONE_DISTANCE_POWER = 2.5, BLOOD_CONE_AIM_POWER = 2.5; // how steeply the cone falls off towards its far end, and towards its sides
const BLOOD_BURST_POINTS = 7.2, BLOOD_BURST_VARIANCE = 0.5;    // what someone at the middle takes, and how far either way each is off it, as a share
const BLOOD_BLAST_SPEED = 160; // how fast a blast's chunks get to people, for when it lands on them
const PUNCH_SPILL_CHANCE = 0.1, PUNCH_SPILL_SCALE = 0.2, PUNCH_SPILL_CHUNKS_MIN = 2, PUNCH_SPILL_CHUNKS_MAX = 3, PUNCH_SPILL_THROW = 3; // a landed punch spills blood this often, over this share of a blast's reach, in this many chunks thrown this fast
const MOVING_SPEED = 1; // slower than this, what struck them is taken to have stopped and it's a blast
const stained = new THREE.Color();

/** Whether someone's free to run: walking about, and not being punched or fighting — and not out for blood themselves. */
const canRun = p => (p.mode === 'line' || p.mode === 'wander') && !p.punched && !p.attack && !p.traits.bloodlust;

// Someone with the bloodlust trait, covered in blood, doesn't run from it: they go twice as fast (see bloodlustSpeed) and, every
// HUNT_EVERY seconds they're not already at it, pick the nearest person they can knock over within HUNT_RADIUS (at people size 1)
// and go after them, again and again.
const HUNT_EVERY = 0.25, HUNT_RADIUS = 40;
/** How many times faster their bloodlust makes them. */
export const bloodlustSpeed = p => p.blood && p.traits.bloodlust ? 2 : 1;
/** Whether they're out for blood: they've the trait, and blood on them. */
export const isBloodlusting = p => !!p.blood && !!p.traits.bloodlust;
/** The colour the whites of bloodlusting eyes turn, all the way. */
const BLOODLUST_EYE_COLOR = new THREE.Color(0xe96a86); // (#ff0038 halfway to light grey, #d3d3d3)

/**
 * Write someone's colours to the person model: their own, moved BLOOD_STAIN towards BLOOD_COLOR for each point of blood.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @returns {void}
 */
function stain(p, i) {
  if (!personModel || !p.bloodBase) return;
  const data = personModel.traitData;
  STAINED_PARTS.forEach(part => {
    const o = ((2 + PERSON_TRAIT_COLORS.indexOf(part))*PEOPLE_MAX + i)*4, base = p.bloodBase[part];
    stained.setRGB(base[0], base[1], base[2]).lerp(BLOOD_COLOR, BLOOD_STAIN*(part === 'Skin' ? SKIN_STAIN_SHARE : 1)*p.blood);
    data[o] = stained.r; data[o + 1] = stained.g; data[o + 2] = stained.b;
  });
  if (p.traits.bloodlust && p.eyeBase) {
    const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Eyes'))*PEOPLE_MAX + i)*4, eyes = p.blood > 0 ? [BLOODLUST_EYE_COLOR.r, BLOODLUST_EYE_COLOR.g, BLOODLUST_EYE_COLOR.b] : p.eyeBase;
    data[o] = eyes[0]; data[o + 1] = eyes[1]; data[o + 2] = eyes[2];
  }
  data[((2 + PERSON_TRAIT_COLORS.indexOf('Blood'))*PEOPLE_MAX + i)*4 + 3] = Math.min(1, BLOOD_OPACITY*p.blood); // (the splotches)
  personModel.traitTexture.needsUpdate = true;
}

/**
 * Give someone `points` of blood (up to BLOOD_MAX): stain them, and send them running from `from` for as long as their
 * points add up to. Anyone busy being punched, fought or knocked down keeps still but is still stained.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @param {{x: number, z: number}} from - where it came from
 * @param {number} points - how many to give
 * @returns {void}
 */
function splatter(p, i, from, points) {
  if (!personModel || !S.bloodSoak || isGone(p) || p.blood >= BLOOD_MAX) return;
  p.bloodFrom = from;
  if (!p.blood) {
    const data = personModel.traitData;
    p.bloodBase = Object.fromEntries(STAINED_PARTS.map(part => {
      const o = ((2 + PERSON_TRAIT_COLORS.indexOf(part))*PEOPLE_MAX + i)*4;
      return [part, [data[o], data[o + 1], data[o + 2]]];
    }));
    p.bloodTimer = BLOOD_FADE_TIME;
  }
  p.blood = Math.min(BLOOD_MAX, (p.blood ?? 0) + points);
  stain(p, i);
  if (canRun(p)) {
    if (p.fright?.stage !== 'flee') { endActivity(p); p.stun = p.please = null; p.oneShot = null; beginFleeing(p, from); }
    p.fright.timer = BLOOD_FLEE_TIME*p.blood;
  }
}

/**
 * Each frame for someone with blood on them: every BLOOD_FADE_TIME it loses a point.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @param {number} i - their index in people
 * @returns {void}
 */
export function updateBlood(p, dt, i) {
  keepRunning(p);
  if (p.traits.bloodlust) hunt(p, dt);
  if ((p.bloodTimer -= dt) > 0) return;
  p.blood--;
  p.bloodTimer = BLOOD_FADE_TIME;
  stain(p, i);
  if (p.blood <= 0) { p.blood = 0; p.bloodBase = null; return; }
}

/**
 * Send someone out for blood to the nearest person they can punch, if they're free to.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
function hunt(p, dt) {
  if ((p.huntIn = (p.huntIn ?? 0) - dt) > 0) return;
  p.huntIn = HUNT_EVERY;
  if ((p.mode !== 'line' && p.mode !== 'wander') || p.punched || p.attack) return;
  const radius = HUNT_RADIUS*S.peopleSize;
  let prey = null, nearest = radius;
  people.forEach(q => {
    if (q === p || isGone(q) || q.punched || q.attack || !canBeKnockedOver(q)) return;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < nearest) { prey = q; nearest = d; }
  });
  if (!prey) return;
  endActivity(p); p.stun = p.fright = p.please = null; p.oneShot = null;
  goAfter(p, prey);
}

/**
 * Send someone back to running if whatever interrupted it is over while they're still holding blood, for as long as it has left.
 * @param {Person} p - the person
 * @returns {void}
 */
function keepRunning(p) {
  if (!canRun(p) || p.fright || p.stun || p.please) return;
  beginFleeing(p, p.bloodFrom ?? { x: p.x, z: p.z });
  p.fright.timer = BLOOD_FADE_TIME*(p.blood - 1) + p.bloodTimer; // (as long as their blood will last)
}

const arriving = []; // blood on its way to people: { p, i, from, points, delay }

/**
 * Splash everyone a kill reaches. `victim` is who was just killed; `momentum` ({ x, y, z } a second) is the velocity of
 * whatever struck them, if anything did: if it's moving, the cone ahead of it out to BLOOD_CONE_RANGE (further, the faster
 * it was going) is splashed, along with a sphere of BLOOD_STRUCK_SPHERE_SHARE of BLOOD_BLAST_RADIUS round them; and otherwise
 * (a blast) the whole sphere of BLOOD_BLAST_RADIUS. Each person inside takes
 * BLOOD_BURST_POINTS, far less towards the edges of the cone or the reach, and varied at random by BLOOD_BURST_VARIANCE — landing on
 * them after the time the chunks take to get there (see updateArrivingBlood).
 * @param {Person} victim - who was killed, at their spot when they were
 * @param {?{x: number, y: number, z: number}} momentum - the velocity of whatever hit them
 * @param {{scale?: number, includeVictim?: boolean}} [options] - `scale` shrinks or grows the reach; `includeVictim` splashes them too (they're still alive)
 * @returns {void}
 */
export function bloodBurst(victim, momentum, { scale = 1, includeVictim = false } = {}) {
  if (!personModel || !S.bloodSoak) return; // (off in the Gameplay settings)
  const size = S.peopleSize, speed = momentum ? Math.hypot(momentum.x, momentum.y, momentum.z) : 0, cone = speed > MOVING_SPEED;
  // (something that struck them splashes the cone ahead of it and, closer round them, a smaller sphere)
  const coneRange = (BLOOD_CONE_RANGE + BLOOD_CONE_RANGE_PER_SPEED*speed)*size*scale, sphereRange = BLOOD_BLAST_RADIUS*(cone ? BLOOD_STRUCK_SPHERE_SHARE : 1)*size*scale;
  const reach = cone ? Math.max(coneRange, sphereRange) : sphereRange;
  const at = { x: victim.x, y: victim.y + 0.85*victim.height*size, z: victim.z }, from = { x: victim.x, z: victim.z };
  people.forEach((p, i) => {
    if ((p === victim && !includeVictim) || isGone(p) || p.blood >= BLOOD_MAX) return;
    const dx = p.x - at.x, dy = p.y + 0.85*p.height*size - at.y, dz = p.z - at.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out nearly everyone)
    const d = Math.hypot(dx, dy, dz);
    // the share of BLOOD_BURST_POINTS they take: the sphere's falls off with the square of the distance, the cone's by
    // BLOOD_CONE_DISTANCE_POWER, and with how far off-centre they are too (BLOOD_CONE_AIM_POWER), so it's concentrated in the middle
    let share = 0;
    if (d < sphereRange) share += BLOOD_BLAST_STRENGTH*(cone ? BLOOD_STRUCK_SPHERE_STRENGTH : 1)*(1 - d/sphereRange)**2;
    if (cone && d < coneRange) {
      const cos = d > 1e-3 ? (dx*momentum.x + dy*momentum.y + dz*momentum.z)/(d*speed) : 1;
      if (cos >= BLOOD_CONE_COS) share += BLOOD_CONE_STRENGTH*(1 - d/coneRange)**BLOOD_CONE_DISTANCE_POWER*((cos - BLOOD_CONE_COS)/(1 - BLOOD_CONE_COS))**BLOOD_CONE_AIM_POWER; // (aim: 1 dead ahead, 0 at the cone's edge)
    }
    const points = Math.round(BLOOD_BURST_POINTS*share*(1 + (Math.random()*2 - 1)*BLOOD_BURST_VARIANCE));
    // it lands when the chunks would get to them: at the speed of what struck them, or a blast's
    if (points > 0) arriving.push({ p, i, from, points, delay: d/(cone ? speed : Math.max(BLOOD_BLAST_SPEED/2, BLOOD_BLAST_SPEED*speed)) });
  });
}

/**
 * When someone lands a punch, now and then a little blood spurts from them: a small burst that stains whoever is close
 * (PUNCH_SPILL_SCALE of a blast's reach, the victim too) and a few chunks of it.
 * @param {Person} victim - who was hit
 * @param {Person} puncher - who hit them
 * @returns {void}
 */
export function punchSpill(victim, puncher) {
  if (peopleRng() >= PUNCH_SPILL_CHANCE) return;
  const size = S.peopleSize, dx = victim.x - puncher.x, dz = victim.z - puncher.z, d = Math.hypot(dx, dz) || 1;
  const chunks = PUNCH_SPILL_CHUNKS_MIN + Math.floor(peopleRng()*(PUNCH_SPILL_CHUNKS_MAX - PUNCH_SPILL_CHUNKS_MIN + 1));
  spillBlood({ x: victim.x, y: victim.y, z: victim.z }, 1.7*victim.height*size, chunks, { x: dx/d*PUNCH_SPILL_THROW, y: 0, z: dz/d*PUNCH_SPILL_THROW });
  bloodBurst(victim, null, { scale: PUNCH_SPILL_SCALE, includeVictim: true });
}

/**
 * Land the blood from bloodBurst on each person as it reaches them.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateArrivingBlood(dt) {
  for (let k = arriving.length - 1; k >= 0; k--) {
    const a = arriving[k];
    if ((a.delay -= dt) > 0) continue;
    splatter(a.p, a.i, a.from, a.points);
    arriving[k] = arriving[arriving.length - 1];
    arriving.pop();
  }
}
