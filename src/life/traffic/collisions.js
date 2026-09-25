import { S, App } from '../../core/shared.js';
import { Y_ROAD } from '../../core/scene.js';
import { pointInPolygon } from '../../core/math.js';
import { footprintBounds } from '../../buildings/footprints.js';
import { isPedInDanger, voiceOfPerson } from '../people/people.js';
import { exclaim } from '../../audio/voices.js';
import { puffSmoke, sparks, burnFx, igniteFx } from '../giblets.js';
import { playSound } from '../../audio/sfx.js';
import { BOOST_UNLOCK, DRIVE_ACCEL, DRIVE_TOP_SPEED, boostMax, boostMultiplier, boostSmoke, drivenCar } from './driving.js';
import { killCar } from './follow.js';
import { carJoinLane, lanePoint, routePoint } from './lanes.js';
import { CAR_REAR_AXLE, carHeight, carLength, carWidth } from './placing.js';
import { CAR_STOP_GAP, carsOverlap, forCarsNear, spotTaken } from './spacing.js';
import { cars } from './state.js';
import { damage } from '../../core/health.js';
import { redirectWeave } from './drunk.js';

// What a car hits: people (runOverPeople), aircraft (strikeWithAircraft), buildings (hitBuildings) and other cars
// (bumpIntoCars) — with the fuse that sets a car burning (lightFuse) and the kick that knocks one off its lane (kickCar).

const CAR_HITBOX_SCALE = 0.6;
const CAR_KILL_SCALE = 0.7, CAR_CLIP_SCALE = 1.5, CAR_STUN_SCALE = 2; // of CAR_HITBOX_SCALE: anyone within the first is killed, anyone else within the second is knocked over, and anyone else within the third is shocked
const CAR_SHOCK_TIME = 1; // how long, in seconds, someone stays shocked
const CAR_PUSH_PER_SPEED = 0.1, CAR_KNOCK_PUSH_FACTOR = 0.15; // how far a car throws someone back, per unit of its speed — the shocked, and (by the factor) the knocked over
const CAR_FALL_SPEEDUP = 5; // how many times faster than normal someone knocked over by a car goes down
/**
 * The hitbox a car runs people over with: half its length and width, each with a 0.25 margin, scaled by CAR_HITBOX_SCALE —
 * so a car hits someone under its middle rather than at its very corners.
 * @param {object} car
 * @returns {{ halfLength: number, halfWidth: number }}
 */
export function carHitbox(car, scale = CAR_HITBOX_SCALE*CAR_KILL_SCALE) {
  const length = carLength(car), width = carWidth(car);
  return { halfLength: (length*0.5 + 0.25)*scale, halfWidth: (width*0.5 + 0.25)*scale };
}
const LYING_HEAD = 0.8, LYING_LEGS = 0.5; // (how far from someone lying down's middle their head and legs are, at people size and height 1)
/** Whether someone is on the ground: falling, knocked flat, or getting up (see knockDown in people/peopleActivities.js). */
export const isLying = p => !!p.punched && p.punched.stage !== 'marked' && p.punched.stage !== 'brace';
/**
 * Whether a car is over any of someone lying down — their middle, their head or their legs — within `box` (the same kill
 * box someone standing is hit by), so a car running over any of them kills them.
 * @param {object} p - the person, lying facing whoever knocked them down, their head behind them
 * @param {object} car
 * @param {{halfLength: number, halfWidth: number}} box
 * @returns {boolean}
 */
function lyingUnder(p, car, box) {
  const size = p.height*S.peopleSize, fx = Math.sin(p.heading), fz = Math.cos(p.heading), cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  return [-LYING_HEAD, 0, LYING_LEGS].some(along => {
    const dx = p.x + fx*along*size - car.x, dz = p.z + fz*along*size - car.z;
    return Math.abs(dx*cos - dz*sin) < box.halfWidth && Math.abs(dx*sin + dz*cos) < box.halfLength;
  });
}
const SIDE_THROW = 3; // (how many times further someone knocked over square from the side is thrown than someone hit head on; the nudge zone's shove isn't scaled)
/**
 * Throw someone away from a car, `factor` times CAR_PUSH_PER_SPEED of its speed.
 * @param {object} p - the person
 * @param {object} car
 * @param {number} factor
 * @param {number} [speed]
 * @param {number} [sideThrow] - how many times further a square side-on hit throws them (SIDE_THROW for a knock-over; 1, unscaled, for a nudge)
 * @returns {void}
 */
function throwBack(p, car, factor, speed = car.speed, sideThrow = 1) {
  const away = { x: p.x - car.x, z: p.z - car.z }, len = Math.hypot(away.x, away.z);
  if (len < 1e-3) { away.x = Math.sin(car.heading); away.z = Math.cos(car.heading); }
  const sideways = len < 1e-3 ? 0 : Math.abs(away.x*Math.cos(car.heading) - away.z*Math.sin(car.heading))/len; // (0 head on, 1 square from the side)
  App.pushPerson?.(p, away.x, away.z, Math.abs(speed)*CAR_PUSH_PER_SPEED*factor*(1 + (sideThrow - 1)*sideways));
}
/**
 * Kill every pedestrian whose position falls inside carHitbox, turned to the car's heading (killPerson in people.js,
 * crediting the driver — including anyone falling or lying knocked down, hit anywhere under the kill box: see lyingUnder), and knock over anyone else inside the larger clipping box (knockOverPerson). A normal car reaches only someone out on the road, over it or halfway, and never anyone it has
 * waved over; the car being driven, or one knocked and moving (`motion`, its velocity { x, z }), reaches anyone within carHeight of Y_ROAD.
 * @param {object} car
 * @param {?{x: number, z: number, thrown?: boolean, by?: string}} motion - a knocked car's velocity, or null to go by its speed and heading; `thrown` if the knock is still carrying it, `by` 'player' to credit the player with the kills
 * @returns {void}
 */
// Hitting someone: CAR_HIT_DAMAGE per unit of weight × speed under the kill box, KNOCK_BOX_DAMAGE_SHARE of that in the
// knock-over box; once per box as they come into it (see car.struck), not every frame they're under it.
const CAR_HIT_DAMAGE = 8, KNOCK_BOX_DAMAGE_SHARE = 1/5;
const carHitDamage = (car, speed) => CAR_HIT_DAMAGE*(car.traits?.weight ?? 1)*speed;
// Whether a normal car can reach someone at all: out on the road, over it or halfway (and not waved over), or knocked down.
export const inCarsWay = p => (isPedInDanger(p) || p.crossStage === 'mid' || !!p.punched) && !p.jc?.waved;
// (`inWay`: App.people filtered by inCarsWay, if the caller has it already — updateTraffic does, once a frame for every car)
export function runOverPeople(car, motion = null, inWay = null) {
  const { halfLength, halfWidth } = carHitbox(car, motion?.thrown ? 1 : undefined), clip = carHitbox(car, CAR_HITBOX_SCALE*CAR_CLIP_SCALE), stun = carHitbox(car, CAR_HITBOX_SCALE*CAR_STUN_SCALE);
  const reach = Math.hypot(stun.halfLength, stun.halfWidth) + 1.5*LYING_HEAD*S.peopleSize, cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  const driven = car === drivenCar, reachesAll = driven || !!motion, shocked = new Set(), struck = new Map();
  const velocity = motion ?? { x: Math.sin(car.heading)*car.speed, z: Math.cos(car.heading)*car.speed }, speed = Math.hypot(velocity.x, velocity.z);
  (reachesAll ? App.people : inWay ?? App.people.filter(inCarsWay)).forEach(p => {
    if (reachesAll ? Math.abs(p.y - Y_ROAD) > carHeight(car) : !inCarsWay(p)) return; // (checked again: someone knocked down by an earlier car this frame may have got up)
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out most people before the exact check)
    const right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    const under = isLying(p) ? lyingUnder(p, car, { halfLength, halfWidth }) : Math.abs(right) < halfWidth && Math.abs(forward) < halfLength;
    const hit = under ? 'kill' : p.mode !== 'possessed' && Math.abs(right) < clip.halfWidth && Math.abs(forward) < clip.halfLength ? 'knock' : null;
    if (hit) {
      // struck by it and knocked over (the hearted can't die of it: see ui/favorites.js), then hurt by its weight and speed
      const before = car.struck?.get(p);
      struck.set(p, before === 'kill' ? 'kill' : hit);
      if (before === hit || before === 'kill') return;
      const knocked = p.mode !== 'possessed' && !isLying(p) && App.knockOverPerson(p, car);
      if (knocked || hit === 'kill') {
        impactSound('thump', p, speed);
        slowedBy(car, 'person', p.traits?.weight);
      }
      if (knocked && p.mode !== 'dead') { App.knockedByCar?.(p); throwBack(p, car, CAR_KNOCK_PUSH_FACTOR, speed, SIDE_THROW); p.shotRate = CAR_FALL_SPEEDUP; }
      if (hit === 'kill' && speed >= 0.5) exclaim({ x: p.x, y: p.y + App.personHeight(p)*0.9, z: p.z }, voiceOfPerson(p));
      const alive = p.mode !== 'dead';
      damage(p, carHitDamage(car, speed)*(hit === 'kill' ? 1 : KNOCK_BOX_DAMAGE_SHARE), {
        by: driven || motion?.by === 'player' ? 'player' : 'car', momentum: { x: velocity.x, y: 0, z: velocity.z }, throwScale: CAR_GIB_THROW, from: car });
      if (alive && p.mode === 'dead' && car.traits?.bloodlust) bloodlustBoost(car);
    }
    else if (p.mode === 'possessed') return;
    else if (Math.abs(right) < stun.halfWidth && Math.abs(forward) < stun.halfLength) {
      shocked.add(p);
      if (!car.shocked?.has(p) && !p.stun && !p.fright && !p.please && !p.punched && !p.attack) {
        p.stun = { stage: 'notice', timer: 0.15, from: { x: car.x, z: car.z }, hold: CAR_SHOCK_TIME };
        throwBack(p, car, 1, speed);
      }
    }
  });
  car.shocked = shocked; // (each is shocked once, as the car comes within reach)
  car.struck = struck;   // (and hurt once per box, as they come into it)
  // and any bee it hits (see life/bees.js)
  App.strikeBees?.({ x: car.x, z: car.z, heading: car.heading, halfLength, halfWidth, height: carHeight(car) });
}
const BLOODLUST_BOOST = 0.1; // (the share of its boost meter a bloodlust car gets back for each person it kills)
/** A kill feeds a bloodlust car's boost: BLOODLUST_BOOST of its boostMax back, unlocking it if that's enough (see driving.js). */
function bloodlustBoost(car) {
  const max = boostMax(car);
  car.boostLeft = Math.min(max, (car.boostLeft ?? max) + BLOODLUST_BOOST*max);
  if (car.boostLeft >= BOOST_UNLOCK*max) car.boostLocked = false;
}
/**
 * Strike whoever an aircraft is touching — whatever lies within its footprint (a box turned to `heading`) and whose height
 * overlaps the aircraft's — by weight, as a driven car does (AIRCRAFT_WEIGHT against theirs): a person is killed, a car is
 * destroyed if `speed` reaches WRECK_SPEED_PER_SLOWDOWN times the slow-down hitting it costs, or else shoved away (jolted, from
 * JOLT_SPEED_PER_SLOWDOWN times) and stopped. Called each frame by whatever is flying one low enough to matter (see flyByHand in
 * zones/airport.js); anything killed is credited to the player. A car is struck once as the aircraft meets it.
 * @param {{x: number, y: number, z: number, heading: number, halfLength: number, halfWidth: number, below: number, above: number, speed?: number, velocity?: {x: number, y: number, z: number}}} aircraft
 *   Its middle, its heading, half its length and wingspan, how far its body reaches below and above `y`, its speed, and its velocity (which anyone it kills keeps as chunks).
 * @returns {number} the share of its speed the aircraft loses to what it has newly struck (0 to 1)
 */
const CAR_GIB_THROW = 1.5; // how much further than the car's own speed alone the people it hits are thrown in pieces
export function strikeWithAircraft({ x, y, z, heading, halfLength, halfWidth, below, above, speed = 0, velocity = null }) {
  const cos = Math.cos(heading), sin = Math.sin(heading), reach = Math.hypot(halfLength, halfWidth);
  const inFootprint = (px, pz) => {
    const dx = px - x, dz = pz - z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return false; // (cheaply rules out most of them before the exact check)
    return Math.abs(dx*cos - dz*sin) < halfWidth && Math.abs(dx*sin + dz*cos) < halfLength;
  };
  const sharesHeight = (base, height) => base < y + above && base + height > y - below;
  const aircraft = { traits: { weight: AIRCRAFT_WEIGHT } };
  let keep = 1;
  App.people.forEach((p, i) => {
    if (!sharesHeight(p.y, p.height*S.peopleSize) || !inFootprint(p.x, p.z)) return;
    App.killPerson(i, 'player', velocity);
    keep *= 1 - Math.min(PERSON_MAX_SLOWDOWN, PERSON_SLOWDOWN*(p.traits?.weight ?? 1)/AIRCRAFT_WEIGHT);
  });
  for (let i = cars.length - 1; i >= 0; i--) {
    const car = cars[i];
    if (car.li < 0) continue;
    if (!sharesHeight(Y_ROAD, carHeight(car)) || !inFootprint(car.x, car.z)) { car.struckByAircraft = false; continue; }
    if (car.struckByAircraft) continue;
    car.struckByAircraft = true;
    const share = slowdownShare(aircraft, car.traits?.weight);
    keep *= 1 - Math.min(CAR_MAX_SLOWDOWN, share);
    if (speed >= WRECK_SPEED_PER_SLOWDOWN*share) { killCar(i); continue; }
    const jolted = speed >= JOLT_SPEED_PER_SLOWDOWN*share;
    kickCar(car, car.x - x, car.z - z, jolted ? speed*BUMP_JOLT_SHOVE : Math.min(1, speed*BUMP_SHOVE + BUMP_PUSH_POWER*AIRCRAFT_WEIGHT));
    car.speed = 0;
  }
  return 1 - keep;
}
// ---- the driven car against buildings: each building's footprint (see see-through.js) is a wall it can't drive through
const WALL_HEAD_ON = 0.8, WALL_DRAG = 3, WALL_LET_GO = 0.25, WALL_SCRAPE_SPEED = 2, WALL_SCRAPE_EVERY = 0.08, WALL_SCRAPE_SPARKS = 3; // (the share of its travel going into the wall that counts as head-on; how fast scraping along one slows it, per second at full into; how long clear of walls, in seconds, before touching one counts as hitting it afresh; the least speed that scrapes sparks, how often, and how many)
/**
 * The building footprint a car's turned rectangle overlaps, or null: a circle round each footprint to reject it first,
 * then any corner of the car inside the footprint, or any corner of the footprint inside the car.
 * @param {object} car - anything with x, z and heading that carLength and carWidth can measure
 * @returns {?Array<{x: number, z: number}>}
 */
export function buildingHit(car) {
  const halfLength = carLength(car)/2, halfWidth = carWidth(car)/2, reach = Math.hypot(halfLength, halfWidth);
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) =>
    ({ x: car.x + sin*halfLength*a + cos*halfWidth*b, z: car.z + cos*halfLength*a - sin*halfWidth*b }));
  const inCar = q => {
    const dx = q.x - car.x, dz = q.z - car.z;
    return Math.abs(dx*sin + dz*cos) < halfLength && Math.abs(dx*cos - dz*sin) < halfWidth;
  };
  for (const zone of S.zones) {
    const zoneReach = zoneBounds(zone);
    if (!zoneReach || Math.hypot(car.x - zoneReach.c.x, car.z - zoneReach.c.z) > zoneReach.r + reach) continue;
    for (const group of zone.buildingsGroup.children) {
    const fp = group.userData.footprint;
    if (!fp || fp.length < 3) continue;
    const { c, r } = footprintBounds(group);
    if (Math.hypot(car.x - c.x, car.z - c.z) > r + reach) continue;
    if (corners.some(q => pointInPolygon(q, fp)) || fp.some(inCar)) return fp;
    }
  }
  return null;
}
// A circle round all of a zone's buildings (see footprintBounds), so buildingHit can pass over whole zones out of reach:
// kept on its buildingsGroup, which is replaced whenever the zone is rebuilt, and worked out again if buildings are added.
function zoneBounds(zone) {
  const group = zone.buildingsGroup;
  if (!group?.children.length) return null;
  let bounds = group.userData.hitBounds;
  if (!bounds || bounds.count !== group.children.length) {
    const circles = group.children.filter(b => b.userData.footprint?.length >= 3).map(footprintBounds);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    circles.forEach(({ c, r }) => { minX = Math.min(minX, c.x - r); maxX = Math.max(maxX, c.x + r); minZ = Math.min(minZ, c.z - r); maxZ = Math.max(maxZ, c.z + r); });
    const c = { x: (minX + maxX)/2, z: (minZ + maxZ)/2 };
    bounds = group.userData.hitBounds = { count: group.children.length, c, r: circles.length ? Math.hypot(maxX - minX, maxZ - minZ)/2 : -Infinity };
  }
  return bounds;
}
/**
 * The wall of a footprint nearest a point, as the point on it nearest and the way out of the building, square to it.
 * @param {Array<{x: number, z: number}>} fp
 * @param {{x: number, z: number}} p
 * @returns {{ q: {x: number, z: number}, n: {x: number, z: number} }}
 */
function nearestWall(fp, p) {
  let best = null;
  fp.forEach((a, k) => {
    const b = fp[(k+1) % fp.length], ex = b.x - a.x, ez = b.z - a.z, len2 = ex*ex + ez*ez || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x)*ex + (p.z - a.z)*ez)/len2)), q = { x: a.x + ex*t, z: a.z + ez*t };
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (!best || d < best.d) {
      const len = Math.sqrt(len2), n = { x: ez/len, z: -ex/len }, out = (p.x - q.x)*n.x + (p.z - q.z)*n.z < 0 ? -1 : 1;
      best = { d, q, n: { x: n.x*out, z: n.z*out } };
    }
  });
  return best;
}
/**
 * Keep the driven car out of buildings. Run into one and it slides along the wall, keeping only the part of its move
 * that doesn't go into it (and, failing that, its turn or nothing at all); the first touch takes off the share of its
 * speed that was going into the wall, with sparks — and head-on (WALL_HEAD_ON) and fast enough, throws it back with its
 * engine dead, as hitting a much heavier car does. Held against the wall it slows the more it's pointed into it, and
 * scrapes sparks along it. A car that's somehow in one already can go anywhere but deeper in.
 * @param {object} car - the driven car
 * @param {object} was - its position and heading before this frame
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function hitBuildings(car, was, dt) {
  const fp = buildingHit(car);
  if (!fp) { car.clearOfWalls = (car.clearOfWalls ?? Infinity) + dt; return; }
  const { q, n } = nearestWall(fp, was), moved = { x: car.x - was.x, z: car.z - was.z }, push = moved.x*n.x + moved.z*n.z;
  const stuck = buildingHit({ ...car, ...was }); // (already in it — shoved there by a car, say: free to go anywhere but deeper)
  if (stuck && push >= 0) return;
  const turned = { x: car.x, z: car.z, heading: car.heading };
  car.x = was.x + moved.x - n.x*Math.min(0, push); car.z = was.z + moved.z - n.z*Math.min(0, push);
  if (!stuck && buildingHit(car)) { Object.assign(car, turned, { x: was.x, z: was.z }); if (buildingHit(car)) Object.assign(car, was); }
  const travel = Math.sign(car.speed || 1), into = Math.max(0, -(Math.sin(car.heading)*n.x + Math.cos(car.heading)*n.z)*travel);
  const contact = { x: q.x, y: Y_ROAD + carHeight(car)*0.4, z: q.z };
  const fresh = !(car.clearOfWalls < WALL_LET_GO); // (sliding along a wall leaves it just clear of it now and then)
  car.clearOfWalls = 0;
  if (fresh) {
    impactSound('crash', contact, Math.abs(car.speed)*into);
    if (into > WALL_HEAD_ON && Math.abs(car.speed) >= BOUNCE_MIN_SPEED) {
      const hitSpeed = car.speed; car.speed = -travel*Math.abs(car.speed)*BUMP_BOUNCE; stallEngine(car, WALL_WEIGHT, hitSpeed);
      puffSmoke({ x: q.x, y: Y_ROAD, z: q.z }, carHeight(car), BUMP_SMOKE_PUFFS);
    } else car.speed *= 1 - into;
    sparks(contact, BUMP_SPARKS);
    car.scrapeSparks = WALL_SCRAPE_EVERY;
    return;
  }
  car.speed *= 1 - Math.min(1, WALL_DRAG*into*dt);
  if (Math.abs(car.speed) > WALL_SCRAPE_SPEED && (car.scrapeSparks -= dt) <= 0) { car.scrapeSparks = WALL_SCRAPE_EVERY; sparks(contact, WALL_SCRAPE_SPARKS); }
}
const BUMP_SHOVE = 0.15, BUMP_BOUNCE = 0.3, BOUNCE_BELOW_SPEED = 0.2, BUMP_SMOKE_PUFFS = 4, BUMP_SPARKS = 10;
export const STALL_TIME = 1, STALL_SMOKE_EVERY = 0.2; // (seconds the engine stays dead after a car is thrown back; how often it smokes meanwhile)
/** How long a stalled/burnt-out car's engine stays dead: STALL_TIME eased by its own recovery trait — the higher, the sooner it's running again. */
const stallTime = car => STALL_TIME/(car.traits?.recovery ?? 1);
// A crash that cuts the engine also hurts the car: STALL_DAMAGE × the weight of what it hit (a wall: WALL_WEIGHT) × its
// speed, over its recovery trait. Only when the engine was running, so one crash hurts once.
const STALL_DAMAGE = 1, STALL_MIN_DAMAGE = 10, WALL_WEIGHT = 5;
// A car knocked by another takes KNOCK_DAMAGE × the hitter's weight × its speed ÷ its own weight.
const KNOCK_DAMAGE = 6;
const knockDamage = (hitter, other, speed) => KNOCK_DAMAGE*(hitter.traits?.weight ?? 1)*Math.abs(speed)/(other.traits?.weight ?? 1);
function stallEngine(car, weight, speed) {
  if (!(car.stall > 0)) damage(car, Math.max(STALL_MIN_DAMAGE, STALL_DAMAGE*weight*Math.abs(speed)/(car.traits?.recovery ?? 1)));
  car.stall = stallTime(car);
}
const WRECK_SPEED_PER_SLOWDOWN = 30, JOLT_SPEED_PER_SLOWDOWN = 15, BUMP_JOLT_SHOVE = 0.2; // (a car wrecks one it hits if it's going this many times faster than the slow-down hitting it costs, as a share of speed; at half that it jolts it back, by this share of its speed)
const BUMP_PUSH_POWER = 0.03, BOUNCE_MIN_SPEED = 2; // (per unit of weight, how far a car shoves the one it's against each frame, even from a standstill; the least speed a car is thrown back from)
// The share of its speed a car of weight 1 loses hitting something of weight 1 (see the `weight` trait): 50% for a car; for a person
// far less, and never more than PERSON_MAX_SLOWDOWN (under a car's least, CAR_MIN_SLOWDOWN), however heavy they are.
const CAR_SLOWDOWN = 0.5, CAR_MIN_SLOWDOWN = 0.1, CAR_MAX_SLOWDOWN = 0.95, PERSON_SLOWDOWN = 0.05, PERSON_MAX_SLOWDOWN = 0.125;
/**
 * Slow a car for having hit something: it keeps its speed less a share set by the kind of thing (a car or a person) and
 * the weight of what it hit over its own weight — so the heavier the thing, or the lighter the car, the more it loses. A car that would be left going slower than BOUNCE_BELOW_SPEED after hitting
 * a car is thrown back instead, at BUMP_BOUNCE of the speed it hit at (times the same ratio, up to all of it) (the camera doesn't follow that: see chaseCamera), and its
 * engine dies for STALL_TIME eased by its recovery trait (stallTime), smoking (see driveByHand).
 * @param {object} car - the car that hit it
 * @param {'car'|'person'} kind - what it hit
 * @param {number} [weight] - the weight trait of what it hit
 * @returns {void}
 */
function slowedBy(car, kind, weight = 1) {
  const ratio = weight/(car.traits?.weight ?? 1);
  const loss = kind === 'person' ? Math.min(PERSON_MAX_SLOWDOWN, PERSON_SLOWDOWN*ratio) : Math.min(CAR_MAX_SLOWDOWN, slowdownShare(car, weight));
  if (kind === 'car' && Math.abs(car.speed) >= BOUNCE_MIN_SPEED && Math.abs(car.speed)*(1 - loss) < BOUNCE_BELOW_SPEED) { const hitSpeed = car.speed; car.speed = -Math.sign(car.speed || 1)*Math.abs(car.speed)*Math.min(1, BUMP_BOUNCE*ratio); stallEngine(car, weight, hitSpeed); } // (the knock back too grows with the ratio, up to its whole speed)
  else car.speed *= 1 - loss;
}
/** The share of its speed a car would lose hitting a car of weight `weight`, before it's kept to a range: more the heavier that car is against its own weight. */
const slowdownShare = (car, weight = 1) => Math.max(CAR_MIN_SLOWDOWN, CAR_SLOWDOWN*weight/(car.traits?.weight ?? 1));
export const wreckedCars = [];
const IMPACT_FULL_SPEED = 12; // (how fast a car has to hit something to be heard at its loudest; slower, quieter)
/** The sound of a car hitting something at `speed`: louder the harder, and not at all for a nudge. */
function impactSound(name, at, speed) {
  if (speed < 0.5) return;
  playSound(name, { x: at.x, y: Y_ROAD + 0.8*S.peopleSize, z: at.z }, Math.min(1, 0.25 + speed/IMPACT_FULL_SPEED));
}
export const BLAST_THROW = 8; // (how fast the blast throws what it kills, units a second)
const STALL_SPEED_SHARE = 0.5; // (of the speed that jolts a car: a car hit at least this fast, but not fast enough to jolt, cuts the engine of the car that hit it)
const STALL_WEIGHT_RATIO = 1.6; // (how many times its own weight the car it hits must be, to cut an engine — scaled up by its own recovery trait, so a car with more of it needs an even heavier hit to stall)
export const DETONATION_REACH = 8; // (how far from a car burning out cars and people are blown up, before scaling by size)
const FUSE_TIME = 3, FUSE_SPARK_EVERY = 0.05, FUSE_SPARKS = 5; // (seconds a wrecked car burns before it blows; seconds between its sparks; sparks each time)
/** Set a car burning: after FUSE_TIME it explodes, meanwhile it stays put, sparking and burning (burnFx). */
export function lightFuse(car) {
  if (car.fuse != null) return;
  igniteFx({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car));
  car.fuse = FUSE_TIME; car.fuseSparks = 0; car.speed = 0;
  car.stall = 0; car.bumping = false;
}
/**
 * Burn a car's fuse down by `dt`, sparking as it goes, and queue it to explode (wreckedCars — updateTraffic blows them up after
 * its loop) when it's out. Any knock still carrying it goes on moving it and dies away, but it never returns to its road.
 * @param {object} car
 * @param {number} dt
 * @returns {void}
 */
export function burnFuse(car, dt) {
  if (car.kick) {
    car.x += car.kick.vx*dt; car.z += car.kick.vz*dt;
    const slowing = Math.exp(-KICK_DECAY*dt);
    car.kick.vx *= slowing; car.kick.vz *= slowing;
    if (Math.hypot(car.kick.vx, car.kick.vz) < 0.05) car.kick = null;
  }
  car.speed = 0;
  runOverPeople(car, { x: 0, z: 0, thrown: true, by: 'player' }); // (anyone who touches it dies, and counts as killed by the player)
  burnFx({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), dt);
  if ((car.fuseSparks -= dt) <= 0) {
    car.fuseSparks = FUSE_SPARK_EVERY;
    sparks({ x: car.x, y: Y_ROAD + carHeight(car)*0.5, z: car.z }, FUSE_SPARKS);
  }
  if ((car.fuse -= dt) <= 0 && !wreckedCars.includes(car)) wreckedCars.push(car);
}
const AIRCRAFT_WEIGHT = 6; // (weight of an aircraft, in the same units as a car's weight trait)
// A car knocked by another is moved by an offset from where its route puts it (car.kick: x, z; the velocity vx, vz still moving
// it; and heading, which it keeps as the knock left it). Once it has stopped, it takes the nearest road (seatKickedCar), turns to
// face the nearest point on it (goal), drives back to it, accelerating as a driven car does from a standstill and boosting after KICK_BOOST_AFTER, then turns to the road's heading. A driven car
// let go off the road does the same (stopDriving). Any car in its way it has to push, as a heavier
// car pushes a lighter one from standing (BUMP_PUSH_POWER); if it can't, it stays where it is, holding still.
const KICK_DECAY = 5, KICK_SETTLED_SPEED = 0.5; // (per second: how fast a knock's speed dies away; the speed it counts as stopped at)
const KICK_TURN_RATE = 4, KICK_FACING_TOLERANCE = 0.3; // (per second; radians it may be off facing its goal while it drives)
const KICK_BOOST_AFTER = 1; // (seconds driving back before its boost comes in)
export const KICK_RESEAT_AFTER = 15; // (seconds trying to get back before it gives up on that road and heads for the nearest other one within KICK_RESEAT_REACH — each road it's tried is skipped; none near, it keeps to the one it has)
const KICK_RESEAT_REACH = 6; // (units at size 1, from where it is to the other road's middle)
// Driving back it goes no faster than KICK_RETURN_TOP (it's off its lane, often on the pavement), and stops for anyone in
// front of it for up to KICK_PEOPLE_WAIT seconds at a time.
// With the way back more than a right angle behind it, it reverses there instead (k.reverse), at up to KICK_REVERSE_TOP.
const KICK_REVERSE_TOP = 3;
const KICK_PEOPLE_PASS = 3;
const KICK_RETURN_TOP = 5, KICK_PEOPLE_WAIT = 6, KICK_PEOPLE_AHEAD = 1.5; // (units a second; seconds; units at size 1 past its bumper it looks)
export const KICK_GHOST_AFTER = 2; // (seconds held up driving back before it goes through whatever's in its way — the lane car behind waits on it, so otherwise the two could wait on each other for good)
const turnBetween = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
/**
 * Knock a car `distance` along (dirX, dirZ), gradually (see KICK_DECAY).
 * @param {object} car - the car knocked
 * @param {number} dirX - direction, not necessarily unit length
 * @param {number} dirZ
 * @param {number} distance - how far the knock carries it
 * @returns {void}
 */
export function kickCar(car, dirX, dirZ, distance) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || distance <= 0) return;
  const kick = car.kick ??= { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 }, speed = distance*KICK_DECAY/len;
  if (car.sway) { kick.x += car.sway.x; kick.z += car.sway.z; car.sway = null; } // (knocked from where it's drawn off its route — weave or pull-over — not from its route)
  kick.vx += dirX*speed; kick.vz += dirZ*speed;
  kick.goal = null; kick.reverse = null; kick.seated = false; kick.speed = 0; kick.driving = 0; kick.heldFor = 0; kick.returnFor = 0; kick.tried = null; // (knocked again: it picks the nearest road and faces the way back once it stops)
}
/**
 * The nearest lane to a spot, and the way along it a car facing `heading` would go.
 * @param {number} x
 * @param {number} z
 * @param {number} heading
 * @returns {{li: number, u: number, dir: number}|null} null if there are no lanes
 */
function nearestLaneSpot(x, z, heading, avoid = null) {
  const { lines, grid, CELL } = S.trafficNav;
  let best = null;
  const consider = (li, vi) => {
    if (avoid?.has(li)) return;
    const q = lines[li].pts[vi], d = Math.hypot(q.x - x, q.z - z);
    if (!best || d < best.d) best = { li, vi, d };
  };
  const cx = Math.floor(x/CELL), cz = Math.floor(z/CELL);
  for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) (grid.get((cx + ox) + ',' + (cz + oz)) || []).forEach(({ li, vi }) => consider(li, vi));
  if (!best) lines.forEach((nav, li) => nav.pts.forEach((_, vi) => consider(li, vi)));
  if (!best) return null;
  const nav = lines[best.li], last = nav.pts.length - 1, a = nav.pts[Math.max(0, best.vi - 1)], b = nav.pts[Math.min(last, best.vi + 1)];
  let u = nav.cum[best.vi], nearest = best.d, along = { x: b.x - a.x, z: b.z - a.z };
  for (const from of [best.vi - 1, best.vi]) { // (the nearest point may lie along either segment at that vertex)
    if (from < 0 || from >= last) continue;
    const p = nav.pts[from], q = nav.pts[from + 1], sx = q.x - p.x, sz = q.z - p.z;
    const t = Math.max(0, Math.min(1, ((x - p.x)*sx + (z - p.z)*sz)/((sx*sx + sz*sz) || 1))), d = Math.hypot(x - p.x - sx*t, z - p.z - sz*t);
    if (d < nearest) { nearest = d; u = nav.cum[from] + (nav.cum[from + 1] - nav.cum[from])*t; along = { x: sx, z: sz }; }
  }
  return { li: best.li, u, d: nearest, dir: along.x*Math.sin(heading) + along.z*Math.cos(heading) >= 0 ? 1 : -1 };
}
/**
 * Put a car with a knock (car.kick) on the nearest lane to where it really is, keeping it where it is by moving its offset from
 * the route to match.
 * @param {object} car
 * @param {number} realX - where the car is
 * @param {number} realZ
 * @returns {boolean} false if there is no lane to put it on
 */
const SEAT_TRIES = 3; // (car-lengths either way along the lane it looks for a free spot to rejoin at)
// It rejoins ahead of where it is along its way (SEAT_AHEAD × how far off the road it is, at least a car length), so it
// merges back at a shallow angle the way it's facing rather than turning round to where it was knocked from.
const SEAT_AHEAD = 2;
export function seatKickedCar(car, realX, realZ, avoid = null) {
  const k = car.kick, spot = nearestLaneSpot(realX, realZ, k.heading, avoid);
  if (!spot) return false;
  if (spot.li !== car.li) car.plan = null;
  // (from there, the nearest spot on the lane with no car on it — spotTaken — trying a car-length on, then back, and so
  // on; that spot anyway if none is free)
  const step = carLength(car) + CAR_STOP_GAP*S.peopleSize, total = S.trafficNav.lines[spot.li].total;
  const from = Math.max(0, Math.min(total, spot.u + spot.dir*Math.max(carLength(car), SEAT_AHEAD*spot.d)));
  let u = from;
  for (let n = 0; n <= SEAT_TRIES*2; n++) {
    const tryU = from + (n % 2 ? 1 : -1)*Math.ceil(n/2)*step*spot.dir;
    if (tryU < 0 || tryU > total) continue;
    carJoinLane(car, spot.li, tryU, spot.dir);
    const at = lanePoint(car);
    if (!spotTaken(car, at.x, at.z)) { u = tryU; break; }
  }
  carJoinLane(car, spot.li, u, spot.dir);
  const back = CAR_REAR_AXLE*carLength(car), front = routePoint(car, back);
  k.x = realX - (front.x - back*Math.sin(k.heading));
  k.z = realZ - (front.z - back*Math.cos(k.heading));
  k.seated = true;
  return true;
}
/**
 * Whether a knocked car can take a step (sx, sz) back towards its route: any car it would overlap there is pushed away if the
 * car is heavier than it, and if any isn't, it can't.
 * @param {object} car - the knocked car, its route position in x and z
 * @param {number} sx
 * @param {number} sz
 * @returns {boolean}
 */
// A car reversing back (see KICK_REVERSE_TOP) into a car on its lane makes that one back up along its lane for
// PUSHED_REVERSE_TIME (car.reverseFor — see updateTraffic, which passes it on down a queue) instead of knocking it off it.
export const PUSHED_REVERSE_TIME = 0.6;
function canStepBack(car, sx, sz) {
  const from = { ...car, x: car.x + car.kick.x, z: car.z + car.kick.z }, at = { ...from, x: from.x + sx, z: from.z + sz };
  const weight = car.traits?.weight ?? 1;
  let clear = true;
  forCarsNear(at.x, at.z, carLength(car)*1.5 + 4*S.peopleSize, other => {
    if (other === car || !carsOverlap(at, other) || carsOverlap(from, other)) return; // (one it's already in doesn't stop it driving out)
    if (car.kick.reverse && !other.kick && other !== drivenCar && other.li >= 0) { other.reverseFor = PUSHED_REVERSE_TIME; clear = false; return; }
    const otherWeight = other.traits?.weight ?? 1, dx = other.x - at.x, dz = other.z - at.z;
    if (weight <= otherWeight) { clear = false; return; }
    const push = BUMP_PUSH_POWER*weight/otherWeight;
    if (other === drivenCar) { const d = Math.hypot(dx, dz) || 1; other.x += dx/d*push; other.z += dz/d*push; } else kickCar(other, dx, dz, push);
  });
  return clear;
}
/** Whether anyone (outdoors) is in front of a knocked car driving back along (dirX, dirZ): within its width and
 * KICK_PEOPLE_AHEAD past its front bumper. */
function personInWay(car, k, dirX, dirZ) {
  const x = car.x + k.x, z = car.z + k.z, len = carLength(car), side = carWidth(car)*0.5 + 0.3*S.peopleSize;
  return App.people.some(p => {
    if (p.indoors) return false;
    const dx = p.x - x, dz = p.z - z, along = dx*dirX + dz*dirZ;
    return along > 0 && along < len*0.5 + KICK_PEOPLE_AHEAD*S.peopleSize && Math.abs(dx*dirZ - dz*dirX) < side;
  });
}
/** Move a knocked car's offset on by `dt`, and drop the knock once it has settled back on its route, facing along it. Returns how it moved, as a velocity { x, z }. */
export function stepKick(car, dt) {
  const k = car.kick, slowing = Math.exp(-KICK_DECAY*dt), turnRate = Math.min(1, dt*KICK_TURN_RATE);
  const nx = k.x + k.vx*dt, nz = k.z + k.vz*dt, hit = Math.hypot(k.vx, k.vz) >= KICK_SETTLED_SPEED && slideHits(car, k, nx, nz);
  if (hit) passKick(car, k, hit);
  else if (!(Math.hypot(k.vx, k.vz) >= KICK_SETTLED_SPEED && bounceOffBuildings(car, k, nx, nz))) { k.x = nx; k.z = nz; }
  k.vx *= slowing; k.vz *= slowing;
  k.blocked = false;
  const motion = { x: k.vx, z: k.vz, thrown: Math.hypot(k.vx, k.vz) >= KICK_SETTLED_SPEED }; // (thrown: still carried by the knock)
  if (Math.hypot(k.vx, k.vz) < KICK_SETTLED_SPEED) {
    if (!k.seated && !seatKickedCar(car, car.x + k.x, car.z + k.z)) { car.kick = null; return motion; }
    if ((k.returnFor = (k.returnFor ?? 0) + dt) > KICK_RESEAT_AFTER) { // (see KICK_RESEAT_AFTER)
      const rx = car.x + k.x, rz = car.z + k.z, tried = (k.tried ?? new Set()).add(car.li), other = nearestLaneSpot(rx, rz, k.heading, tried);
      k.returnFor = 0;
      if (other && other.d < KICK_RESEAT_REACH*S.peopleSize) { k.tried = tried; seatKickedCar(car, rx, rz, tried); k.heldFor = 0; }
      else { k.tried = null; seatKickedCar(car, rx, rz); k.heldFor = KICK_GHOST_AFTER; } // (no other road near: a fresh spot on its own, and through whatever's in the way)
      k.goal = null; k.reverse = null; k.speed = 0; k.driving = 0; k.peopleWait = 0;
    }
    const away = Math.hypot(k.x, k.z);
    if (away > 0.02) {
      k.goal ??= Math.atan2(-k.x, -k.z); // (fixed, so it doesn't swing about as it goes)
      k.reverse ??= Math.abs(turnBetween(k.goal - k.heading)) > Math.PI/2;
      const off = turnBetween(k.goal + (k.reverse ? Math.PI : 0) - k.heading); // (reversing, its back faces the way)
      k.heading += off*turnRate;
      if (Math.abs(off) < KICK_FACING_TOLERANCE) {
        const boosting = (k.driving += dt) >= KICK_BOOST_AFTER && !k.reverse, boost = boosting ? boostMultiplier(car) : 1;
        k.speed = Math.min((k.reverse ? KICK_REVERSE_TOP : KICK_RETURN_TOP)*S.peopleSpeed, DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost, k.speed + DRIVE_ACCEL*boost*dt);
        const step = Math.min(away, k.speed*dt), sx = -k.x/away*step, sz = -k.z/away*step;
        const ghost = (k.heldFor ?? 0) >= KICK_GHOST_AFTER; // (see KICK_GHOST_AFTER: kept till it's back, so it can't stall again halfway)
        // (waited KICK_PEOPLE_WAIT: it goes on for KICK_PEOPLE_PASS before it'll wait for anyone again — else it'd creep a frame at a time)
        if ((k.peoplePass = Math.max(0, (k.peoplePass ?? 0) - dt)) <= 0 && (k.peopleWait ?? 0) >= KICK_PEOPLE_WAIT) { k.peopleWait = 0; k.peoplePass = KICK_PEOPLE_PASS; }
        const waiting = !(k.peoplePass > 0) && personInWay(car, k, -k.x/away, -k.z/away) && (k.peopleWait = (k.peopleWait ?? 0) + dt) < KICK_PEOPLE_WAIT;
        if (waiting) { k.speed = 0; k.driving = 0; }
        else if (ghost || canStepBack(car, sx, sz)) { k.x += sx; k.z += sz; motion.x += sx/dt; motion.z += sz/dt; if (boosting) boostSmoke(car, dt); } else { k.blocked = true; k.speed = 0; k.driving = 0; k.heldFor = (k.heldFor ?? 0) + dt; }
      } else { k.speed = 0; k.driving = 0; }
    } else {
      const off = turnBetween(lanePoint(car).heading - k.heading);
      k.heading += off*turnRate;
      if (Math.abs(off) < 0.02 && Math.hypot(k.vx, k.vz) < 0.05) car.kick = null;
    }
  }
  return motion;
}
// A knocked car sliding into another stops there rather than through it, passing on its knock: the car hit takes
// KICK_TRANSFER of the knock's remaining carry, times 2 × this car's share of their weights; this car keeps what a
// heavier one would (its weight less the other's, over both), so a light car stops dead and a heavy one ploughs on slowed.
const KICK_TRANSFER = 0.8;
/** The first car a knocked car's slide to offset (nx, nz) would run into, that it isn't already overlapping, or null. */
function slideHits(car, k, nx, nz) {
  const from = { ...car, x: car.x + k.x, z: car.z + k.z, heading: k.heading }, to = { ...from, x: car.x + nx, z: car.z + nz };
  let hit = null;
  forCarsNear(to.x, to.z, carLength(car)*1.5 + 4*S.peopleSize, other => {
    if (!hit && other !== car && !wreckedCars.includes(other) && carsOverlap(to, other) && !carsOverlap(from, other)) hit = other;
  });
  return hit;
}
// A knocked car sliding into a building bounces off it: the blocked part of its slide reversed, KICK_BOUNCE of it kept
// (tried on each axis alone to tell which way the wall faces), sliding on along the wall with the rest. One already in a
// building (shoved there) slides out freely.
const KICK_BOUNCE = 0.5;
/** Bounce a knocked car's slide to offset (nx, nz) off any building it would run into; true if it did. */
function bounceOffBuildings(car, k, nx, nz) {
  const at = (x, z) => buildingHit({ ...car, x: car.x + x, z: car.z + z, heading: k.heading });
  if (!at(nx, nz) || at(k.x, k.z)) return false;
  const xBlocked = at(nx, k.z), zBlocked = at(k.x, nz), speed = Math.hypot(k.vx, k.vz);
  if (xBlocked || !zBlocked) k.vx *= -KICK_BOUNCE;
  if (zBlocked || !xBlocked) k.vz *= -KICK_BOUNCE;
  if (xBlocked !== zBlocked) { if (!xBlocked) k.x = nx; else k.z = nz; } // (along the wall)
  const contact = { x: car.x + nx, y: Y_ROAD, z: car.z + nz };
  impactSound('crash', contact, speed);
  puffSmoke(contact, carHeight(car), BUMP_SMOKE_PUFFS);
  return true;
}
/** Hand a knocked car's slide on to the car it's hit (see KICK_TRANSFER). */
function passKick(car, k, other) {
  const mine = car.traits?.weight ?? 1, theirs = other.traits?.weight ?? 1, share = mine/(mine + theirs), carry = Math.hypot(k.vx, k.vz)/KICK_DECAY;
  if (other === drivenCar) slowedBy(other, 'car', mine);
  else { kickCar(other, k.vx, k.vz, carry*2*share*KICK_TRANSFER); other.speed = 0; }
  const keep = Math.max(0, (mine - theirs)/(mine + theirs));
  k.vx *= keep; k.vz *= keep;
}
// Hitting a car hurts the hitter too: RECOIL_SHARE of what it deals, over its own weight — unless it dealt under RECOIL_MIN.
const RECOIL_SHARE = 0.5, RECOIL_MIN = 10;
/** Deal `amount` to car `victim`, struck by car `by`, which takes its recoil (see RECOIL_SHARE). */
function hitCar(victim, amount, by) {
  damage(victim, amount);
  if (amount >= RECOIL_MIN) damage(by, amount*RECOIL_SHARE/(by.traits?.weight ?? 1));
}
const SWAY_BOUNCE = 1; // (how far a weaving drunk car is thrown back off what it hits)
/**
 * A drunk AI car weaved off its route (car.sway: see traffic/drunk.js) into another car or a building: a crash — the
 * other car shoved away and stopped, and this one knocked back off it (its weave turned into a kick, so it drives back to
 * its lane as any knocked car does). Cars it already overlapped on its route (queued close) don't count.
 * @param {object} car
 * @returns {boolean} whether it hit anything
 */
export function swayCrash(car) {
  const w = car.sway, onRoute = { ...car, x: car.x - w.x, z: car.z - w.z, heading: car.heading - w.turn };
  let other = null;
  forCarsNear(car.x, car.z, carLength(car)*1.5 + 4*S.peopleSize, q => { if (!other && q !== car && !wreckedCars.includes(q) && carsOverlap(car, q) && !carsOverlap(onRoute, q)) other = q; });
  if (!other && !buildingHit(car)) return false;
  const speed = Math.abs(car.speed), contact = other ? { x: (car.x + other.x)/2, y: Y_ROAD, z: (car.z + other.z)/2 } : { x: car.x, y: Y_ROAD, z: car.z };
  impactSound('crash', contact, speed);
  puffSmoke(contact, carHeight(car), BUMP_SMOKE_PUFFS);
  sparks({ ...contact, y: contact.y + carHeight(car)*0.4 }, BUMP_SPARKS);
  if (other && other === drivenCar) slowedBy(other, 'car', car.traits?.weight); // (both null when it hit a building with no car driven) // (the player's car keeps its own handling, just jolted)
  else if (other) { kickCar(other, other.x - car.x, other.z - car.z, Math.min(1, speed*BUMP_SHOVE + BUMP_PUSH_POWER*(car.traits?.weight ?? 1))); other.speed = 0; hitCar(other, knockDamage(car, other, speed), car); }
  if (w.drunk) redirectWeave(car, Math.sign(w.off)); // (a new weave away from what it hit, so it doesn't keep hitting it)
  kickCar(car, other ? car.x - other.x : -w.x, other ? car.z - other.z : -w.z, SWAY_BOUNCE*S.peopleSize); // (takes its weave into the kick)
  car.speed = 0;
  return true;
}
/**
 * Settle what the driven car has run into. A car it overlaps is hurt as they meet (knockDamage), and shoved away from it (BUMP_SHOVE of its speed plus BUMP_PUSH_POWER for each unit of
 * its weight, scaled by the distance, so a heavy car pushes one from standing — or, from JOLT_SPEED_PER_SLOWDOWN times, jolted back BUMP_JOLT_SHOVE of
 * its speed at once) and stopped dead, and the driven car goes back to where it was this frame, slowed
 * by that car's weight (slowedBy), with a little smoke where they met.
 * @param {object} car - the driven car
 * @param {object} was - its position, heading and speed before this frame
 * @returns {void}
 */
export function bumpIntoCars(car, was) {
  const reach = carLength(car)*1.5 + 4*S.peopleSize, before = { ...car, ...was }, hitSpeed = Math.abs(car.speed);
  let contact = null, cutsEngine = null; // (cutsEngine: the weight of the car that cut it)
  const hurt = []; // (dealt after the loop: a car dying mid-loop changes the cars array)
  forCarsNear(car.x, car.z, reach, other => {
    if (other === car || wreckedCars.includes(other) || !carsOverlap(car, other)) return;
    const d = Math.hypot(other.x - car.x, other.z - car.z), dWas = Math.hypot(other.x - was.x, other.z - was.z);
    if (carsOverlap(before, other) && d >= dWas) return; // (moving off it)
    const joltSpeed = JOLT_SPEED_PER_SLOWDOWN*slowdownShare(car, other.traits?.weight), jolted = Math.abs(car.speed) >= joltSpeed;
    kickCar(other, other.x - car.x, other.z - car.z, jolted ? Math.abs(car.speed)*BUMP_JOLT_SHOVE : Math.min(1, Math.abs(car.speed)*BUMP_SHOVE + BUMP_PUSH_POWER*(car.traits?.weight ?? 1)));
    other.speed = 0;
    if (!car.bumping) hurt.push(other); // (hurt once, as they meet)
    if (!jolted && Math.abs(car.speed) >= STALL_SPEED_SHARE*joltSpeed && (other.traits?.weight ?? 1) > STALL_WEIGHT_RATIO*(car.traits?.recovery ?? 1)*(car.traits?.weight ?? 1)) cutsEngine = other.traits?.weight ?? 1; // (hit hard enough to hurt the engine, but not to jolt the car, and it's much heavier — the less likely, the more recovery it has)
    slowedBy(car, 'car', other.traits?.weight);
    contact = { x: (car.x + other.x)/2, y: Y_ROAD, z: (car.z + other.z)/2 };
  });
  if (!contact) { car.bumping = false; return; }
  Object.assign(car, was);
  if (!car.bumping) { impactSound('crash', contact, hitSpeed); puffSmoke(contact, carHeight(car), BUMP_SMOKE_PUFFS); sparks({ ...contact, y: contact.y + carHeight(car)*0.4 }, BUMP_SPARKS); } // (once, as they meet)
  if (cutsEngine != null && !car.bumping) stallEngine(car, cutsEngine, hitSpeed);
  car.bumping = true;
  hurt.forEach(other => hitCar(other, knockDamage(car, other, hitSpeed), car));
}
