import { S, App } from '../../core/shared.js';
import { Y_ROAD } from '../../core/scene.js';
import { pointInPolygon } from '../../core/math.js';
import { footprintBounds } from '../../buildings/footprints.js';
import { isPedInDanger, voiceOfPerson } from '../people/people.js';
import { exclaim } from '../../audio/voices.js';
import { isFavoritePerson } from '../../ui/favorites.js';
import { puffSmoke, sparks, burnFx, igniteFx } from '../giblets.js';
import { playSound } from '../../audio/sfx.js';
import { DRIVE_ACCEL, DRIVE_TOP_SPEED, boostMultiplier, boostSmoke, drivenCar } from './driving.js';
import { killCar } from './follow.js';
import { carJoinLane, lanePoint, routePoint } from './lanes.js';
import { CAR_REAR_AXLE, carHeight, carLength, carWidth } from './placing.js';
import { carsOverlap, forCarsNear } from './spacing.js';
import { cars } from './state.js';

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
export function runOverPeople(car, motion = null) {
  const { halfLength, halfWidth } = carHitbox(car, motion?.thrown ? 1 : undefined), clip = carHitbox(car, CAR_HITBOX_SCALE*CAR_CLIP_SCALE), stun = carHitbox(car, CAR_HITBOX_SCALE*CAR_STUN_SCALE);
  const reach = Math.hypot(stun.halfLength, stun.halfWidth) + 1.5*LYING_HEAD*S.peopleSize, cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  const driven = car === drivenCar, reachesAll = driven || !!motion, shocked = new Set();
  const velocity = motion ?? { x: Math.sin(car.heading)*car.speed, z: Math.cos(car.heading)*car.speed }, speed = Math.hypot(velocity.x, velocity.z);
  App.people.forEach((p, i) => {
    if (reachesAll ? Math.abs(p.y - Y_ROAD) > carHeight(car) : (!isPedInDanger(p) && p.crossStage !== 'mid' && !p.punched) || p.jc?.waved) return; // only while out on the road, over it or halfway (and not waved over), or knocked down
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out most people before the exact check)
    const right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    // (anyone hearted is knocked down instead, below: they can't be killed. See ui/favorites.js)
    const under = isLying(p) ? lyingUnder(p, car, { halfLength, halfWidth }) : Math.abs(right) < halfWidth && Math.abs(forward) < halfLength;
    if (under && !isFavoritePerson(i)) { impactSound('thump', p, speed); if (speed >= 0.5) exclaim({ x: p.x, y: p.y + App.personHeight(p)*0.9, z: p.z }, voiceOfPerson(p)); App.killPerson(i, driven || motion?.by === 'player' ? 'player' : 'car', { x: velocity.x, y: 0, z: velocity.z }, CAR_GIB_THROW, car); slowedBy(car, 'person', p.traits?.weight); }
    else if (p.mode === 'possessed') return;
    else if (Math.abs(right) < clip.halfWidth && Math.abs(forward) < clip.halfLength) { if (App.knockOverPerson(p, car)) { App.knockedByCar?.(p); impactSound('thump', p, speed); throwBack(p, car, CAR_KNOCK_PUSH_FACTOR, speed, SIDE_THROW); p.shotRate = CAR_FALL_SPEEDUP; slowedBy(car, 'person', p.traits?.weight); } }
    else if (Math.abs(right) < stun.halfWidth && Math.abs(forward) < stun.halfLength) {
      shocked.add(p);
      if (!car.shocked?.has(p) && !p.stun && !p.fright && !p.please && !p.punched && !p.attack) {
        p.stun = { stage: 'notice', timer: 0.15, from: { x: car.x, z: car.z }, hold: CAR_SHOCK_TIME };
        throwBack(p, car, 1, speed);
      }
    }
  });
  car.shocked = shocked; // (each is shocked once, as the car comes within reach)
  // and any bee it hits (see life/bees.js)
  App.strikeBees?.({ x: car.x, z: car.z, heading: car.heading, halfLength, halfWidth, height: carHeight(car) });
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
function buildingHit(car) {
  const halfLength = carLength(car)/2, halfWidth = carWidth(car)/2, reach = Math.hypot(halfLength, halfWidth);
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) =>
    ({ x: car.x + sin*halfLength*a + cos*halfWidth*b, z: car.z + cos*halfLength*a - sin*halfWidth*b }));
  const inCar = q => {
    const dx = q.x - car.x, dz = q.z - car.z;
    return Math.abs(dx*sin + dz*cos) < halfLength && Math.abs(dx*cos - dz*sin) < halfWidth;
  };
  for (const zone of S.zones) for (const group of zone.buildingsGroup?.children || []) {
    const fp = group.userData.footprint;
    if (!fp || fp.length < 3) continue;
    const { c, r } = footprintBounds(group);
    if (Math.hypot(car.x - c.x, car.z - c.z) > r + reach) continue;
    if (corners.some(q => pointInPolygon(q, fp)) || fp.some(inCar)) return fp;
  }
  return null;
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
      car.speed = -travel*Math.abs(car.speed)*BUMP_BOUNCE; car.stall = stallTime(car);
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
  if (kind === 'car' && Math.abs(car.speed) >= BOUNCE_MIN_SPEED && Math.abs(car.speed)*(1 - loss) < BOUNCE_BELOW_SPEED) { car.speed = -Math.sign(car.speed || 1)*Math.abs(car.speed)*Math.min(1, BUMP_BOUNCE*ratio); car.stall = stallTime(car); } // (the knock back too grows with the ratio, up to its whole speed)
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
function lightFuse(car) {
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
const turnBetween = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
/**
 * Knock a car `distance` along (dirX, dirZ), gradually (see KICK_DECAY).
 * @param {object} car - the car knocked
 * @param {number} dirX - direction, not necessarily unit length
 * @param {number} dirZ
 * @param {number} distance - how far the knock carries it
 * @returns {void}
 */
function kickCar(car, dirX, dirZ, distance) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || distance <= 0) return;
  const kick = car.kick ??= { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 }, speed = distance*KICK_DECAY/len;
  kick.vx += dirX*speed; kick.vz += dirZ*speed;
  kick.goal = null; kick.seated = false; kick.speed = 0; kick.driving = 0; // (knocked again: it picks the nearest road and faces the way back once it stops)
}
/**
 * The nearest lane to a spot, and the way along it a car facing `heading` would go.
 * @param {number} x
 * @param {number} z
 * @param {number} heading
 * @returns {{li: number, u: number, dir: number}|null} null if there are no lanes
 */
function nearestLaneSpot(x, z, heading) {
  const { lines, grid, CELL } = S.trafficNav;
  let best = null;
  const consider = (li, vi) => {
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
  return { li: best.li, u, dir: along.x*Math.sin(heading) + along.z*Math.cos(heading) >= 0 ? 1 : -1 };
}
/**
 * Put a car with a knock (car.kick) on the nearest lane to where it really is, keeping it where it is by moving its offset from
 * the route to match.
 * @param {object} car
 * @param {number} realX - where the car is
 * @param {number} realZ
 * @returns {boolean} false if there is no lane to put it on
 */
export function seatKickedCar(car, realX, realZ) {
  const k = car.kick, spot = nearestLaneSpot(realX, realZ, k.heading);
  if (!spot) return false;
  if (spot.li !== car.li) car.plan = null;
  carJoinLane(car, spot.li, spot.u, spot.dir);
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
function canStepBack(car, sx, sz) {
  const at = { ...car, x: car.x + car.kick.x + sx, z: car.z + car.kick.z + sz };
  const weight = car.traits?.weight ?? 1;
  let clear = true;
  forCarsNear(at.x, at.z, carLength(car)*1.5 + 4*S.peopleSize, other => {
    if (other === car || !carsOverlap(at, other)) return;
    const otherWeight = other.traits?.weight ?? 1, dx = other.x - at.x, dz = other.z - at.z;
    if (weight <= otherWeight) { clear = false; return; }
    const push = BUMP_PUSH_POWER*weight/otherWeight;
    if (other === drivenCar) { const d = Math.hypot(dx, dz) || 1; other.x += dx/d*push; other.z += dz/d*push; } else kickCar(other, dx, dz, push);
  });
  return clear;
}
/** Move a knocked car's offset on by `dt`, and drop the knock once it has settled back on its route, facing along it. Returns how it moved, as a velocity { x, z }. */
export function stepKick(car, dt) {
  const k = car.kick, slowing = Math.exp(-KICK_DECAY*dt), turnRate = Math.min(1, dt*KICK_TURN_RATE);
  k.x += k.vx*dt; k.z += k.vz*dt;
  k.vx *= slowing; k.vz *= slowing;
  k.blocked = false;
  const motion = { x: k.vx, z: k.vz, thrown: Math.hypot(k.vx, k.vz) >= KICK_SETTLED_SPEED }; // (thrown: still carried by the knock)
  if (Math.hypot(k.vx, k.vz) < KICK_SETTLED_SPEED) {
    if (!k.seated && !seatKickedCar(car, car.x + k.x, car.z + k.z)) { car.kick = null; return motion; }
    const away = Math.hypot(k.x, k.z);
    if (away > 0.02) {
      k.goal ??= Math.atan2(-k.x, -k.z); // (fixed, so it doesn't swing about as it goes)
      const off = turnBetween(k.goal - k.heading);
      k.heading += off*turnRate;
      if (Math.abs(off) < KICK_FACING_TOLERANCE) {
        const boosting = (k.driving += dt) >= KICK_BOOST_AFTER, boost = boosting ? boostMultiplier(car) : 1;
        k.speed = Math.min(DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost, k.speed + DRIVE_ACCEL*boost*dt);
        const step = Math.min(away, k.speed*dt), sx = -k.x/away*step, sz = -k.z/away*step;
        if (canStepBack(car, sx, sz)) { k.x += sx; k.z += sz; motion.x += sx/dt; motion.z += sz/dt; if (boosting) boostSmoke(car, dt); } else { k.blocked = true; k.speed = 0; k.driving = 0; }
      } else { k.speed = 0; k.driving = 0; }
    } else {
      const off = turnBetween(lanePoint(car).heading - k.heading);
      k.heading += off*turnRate;
      if (Math.abs(off) < 0.02 && Math.hypot(k.vx, k.vz) < 0.05) car.kick = null;
    }
  }
  return motion;
}
/**
 * Settle what the driven car has run into. Unless it's going WRECK_SPEED_PER_SLOWDOWN times faster than the slow-down hitting a car
 * costs it (slowdownShare), a car it overlaps is shoved away from it (BUMP_SHOVE of its speed plus BUMP_PUSH_POWER for each unit of
 * its weight, scaled by the distance, so a heavy car pushes one from standing — or, from JOLT_SPEED_PER_SLOWDOWN times, jolted back BUMP_JOLT_SHOVE of
 * its speed at once) and stopped dead, and the driven car goes back to where it was this frame, slowed
 * by that car's weight (slowedBy), with a little smoke where they met. Otherwise it instead sets each car
 * it meets burning (lightFuse), slowed by each one's weight, and carries on through them — but not through one already burning, which is bumped like any other.
 * @param {object} car - the driven car
 * @param {object} was - its position, heading and speed before this frame
 * @returns {void}
 */
export function bumpIntoCars(car, was) {
  const reach = carLength(car)*1.5 + 4*S.peopleSize, before = { ...car, ...was }, hitSpeed = Math.abs(car.speed);
  let contact = null, cutsEngine = false;
  forCarsNear(car.x, car.z, reach, other => {
    if (other === car || wreckedCars.includes(other) || !carsOverlap(car, other)) return;
    const d = Math.hypot(other.x - car.x, other.z - car.z), dWas = Math.hypot(other.x - was.x, other.z - was.z);
    if (carsOverlap(before, other) && d >= dWas) return; // (moving off it)
    if (other.fuse == null && Math.abs(car.speed) >= WRECK_SPEED_PER_SLOWDOWN*slowdownShare(car, other.traits?.weight)) { lightFuse(other); impactSound('crash', other, hitSpeed); sparks({ x: (car.x + other.x)/2, y: Y_ROAD + carHeight(car)*0.4, z: (car.z + other.z)/2 }, BUMP_SPARKS); slowedBy(car, 'car', other.traits?.weight); return; }
    const joltSpeed = JOLT_SPEED_PER_SLOWDOWN*slowdownShare(car, other.traits?.weight), jolted = Math.abs(car.speed) >= joltSpeed;
    kickCar(other, other.x - car.x, other.z - car.z, jolted ? Math.abs(car.speed)*BUMP_JOLT_SHOVE : Math.min(1, Math.abs(car.speed)*BUMP_SHOVE + BUMP_PUSH_POWER*(car.traits?.weight ?? 1)));
    other.speed = 0;
    if (!jolted && Math.abs(car.speed) >= STALL_SPEED_SHARE*joltSpeed && (other.traits?.weight ?? 1) > STALL_WEIGHT_RATIO*(car.traits?.recovery ?? 1)*(car.traits?.weight ?? 1)) cutsEngine = true; // (hit hard enough to hurt the engine, but not to jolt the car, and it's much heavier — the less likely, the more recovery it has)
    slowedBy(car, 'car', other.traits?.weight);
    contact = { x: (car.x + other.x)/2, y: Y_ROAD, z: (car.z + other.z)/2 };
  });
  if (!contact) { car.bumping = false; return; }
  Object.assign(car, was);
  if (!car.bumping) { impactSound('crash', contact, hitSpeed); puffSmoke(contact, carHeight(car), BUMP_SMOKE_PUFFS); sparks({ ...contact, y: contact.y + carHeight(car)*0.4 }, BUMP_SPARKS); } // (once, as they meet)
  if (cutsEngine && !car.bumping) car.stall = stallTime(car);
  car.bumping = true;
}
