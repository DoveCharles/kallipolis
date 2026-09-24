import { S } from '../../core/shared.js';
import { drivenCar } from './driving.js';
import { TURN_CURVE, lanePoint } from './lanes.js';
import { carLength, carWidth } from './placing.js';
import { cars, trafficRng } from './state.js';
import { stretchCounts, stretchOf } from './turns.js';

// ---- keeping clear of other cars: gapAhead finds the nearest car whose footprint lies in the strip senseRange long and
// carWidth wide directly ahead — in its lane or not, including the one being driven — and the car eases off for it. A car
// in the oncoming lane going the other way is left out (inOncomingLane), as is the car behind it in its own lane; the
// `ahead` car is held at a distance separately. Where two cars are each in the other's way, goesFirst decides.
export const CAR_STOP_GAP = 1.5;  // how far short of the car in front one stops (at size 1)
export const CAR_BRAKE = 30;      // the hardest a car brakes, per second
const LANE_OVERLAP = 1;    // how much of the two cars' widths has to overlap for one to count as in the other's way
const CAR_GRID_CELL = 12;
const carGrid = new Map();
const cellKey = (cx, cz) => cx + ',' + cz;
/**
 * Rebuild the car grid: every car on a lane bucketed into its CAR_GRID_CELL-sized cell, and the stretch counts reset.
 * @returns {void}
 */
export function buildCarGrid() {
  carGrid.clear();
  stretchCounts.length = S.trafficNav.stretches.length;
  stretchCounts.fill(0);
  cars.forEach(car => {
    if (car.li < 0) return;
    stretchCounts[stretchOf(car.li, car.seg)]++;
    const key = cellKey(Math.floor(car.x/CAR_GRID_CELL), Math.floor(car.z/CAR_GRID_CELL));
    if (!carGrid.has(key)) carGrid.set(key, []);
    carGrid.get(key).push(car);
  });
}
/**
 * Call `fn` on every car in the grid cells within `radius` of a point.
 * @param {number} x
 * @param {number} z
 * @param {number} radius
 * @param {(car: object) => void} fn
 * @returns {void}
 */
export function forCarsNear(x, z, radius, fn) {
  const reach = Math.ceil(radius/CAR_GRID_CELL), cx = Math.floor(x/CAR_GRID_CELL), cz = Math.floor(z/CAR_GRID_CELL);
  for (let ox=-reach;ox<=reach;ox++) for (let oz=-reach;oz<=reach;oz++) (carGrid.get(cellKey(cx+ox, cz+oz)) || []).forEach(fn);
}
/** How far ahead a car looks: half its length, 6 units of clearance, and its stopping distance at its current speed. */
const senseRange = car => carLength(car)*0.5 + 6*S.peopleSize + Math.max(0, car.speed)*1.2;
/**
 * How far `car` can go before its front bumper reaches `other`, taking other's footprint as it lies along and across the
 * car's heading.
 * @param {object} car
 * @param {object} other
 * @param {number} range - how far ahead to consider
 * @returns {number} the gap, or Infinity if other is not in its way
 */
function gapTo(car, other, range) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading), dx = other.x - car.x, dz = other.z - car.z;
  const forward = dx*sin + dz*cos;
  if (forward <= 0 || forward > range) return Infinity;
  const turn = other.heading - car.heading, left = dx*cos - dz*sin; // (how far off to its left other is)
  if (other !== drivenCar && car !== drivenCar && inOncomingLane(car, other, turn)) return Infinity;
  const aLen = carLength(car), aWid = carWidth(car), bLen = carLength(other), bWid = carWidth(other);
  const c = Math.abs(Math.cos(turn)), s = Math.abs(Math.sin(turn));
  // (other's footprint, as seen along and across car's heading)
  const across = c*bWid*0.5 + s*bLen*0.5, along = c*bLen*0.5 + s*bWid*0.5;
  if (Math.abs(left) > (aWid*0.5 + across)*LANE_OVERLAP) return Infinity;
  return forward - aLen*0.5 - along;
}
/**
 * Whether `other` is ahead of a car but over in the oncoming lane, where the car ignores it. On the car's own line that
 * means the two are going opposite ways with both keeping to their lanes (keepingToLane). On another line it is judged by
 * where lanePoint puts each lane, since a car partway round a corner points across both lanes of the road it is entering.
 * @param {object} car
 * @param {object} other
 * @param {number} turn - other.heading - car.heading, in radians
 * @returns {boolean}
 */
function inOncomingLane(car, other, turn) {
  if (other.li === car.li) return other.dir !== car.dir && keepingToLane(car) && keepingToLane(other);
  if (Math.cos(turn) >= -0.3) return false;
  const a = lanePoint(car), b = lanePoint(other), sin = Math.sin(a.heading), cos = Math.cos(a.heading);
  const lane = S.trafficNav.lines[car.li].lane;
  return Math.cos(b.heading - a.heading) < -0.7 && (b.x - a.x)*cos - (b.z - a.z)*sin > lane;
}
/**
 * Whether a car is simply following its lane. False if it is within TURN_CURVE lanes of its own plus its length of a
 * junction it has planned a turn at, or that near either end of a line that dead-ends, where it will swing round into the
 * other lane.
 * @param {object} car
 * @returns {boolean}
 */
function keepingToLane(car) {
  const nav = S.trafficNav.lines[car.li], near = TURN_CURVE*nav.lane + carLength(car), plan = car.plan;
  if (plan && plan.link && plan.li === car.li && plan.from === car.dir && Math.abs(nav.cum[plan.vi] - car.u) < near) return false;
  const deadEnd = vi => !nav.loop && !nav.vertices[vi].links.length;
  return !(deadEnd(0) && car.u < near) && !(deadEnd(nav.pts.length-1) && nav.total - car.u < near);
}
/**
 * The nearest car in the car's way, and how far off it is.
 * @param {object} car
 * @returns {{ gap: number, by: ?object }} gap is Infinity and by null when nothing is in the way
 */
export function gapAhead(car) {
  const range = senseRange(car);
  let best = Infinity, by = null;
  forCarsNear(car.x, car.z, range, other => {
    if (other === car || other.ahead === car) return; // (the car behind it in its own lane never is)
    if (car.traits?.smells && other.pull > 0.3) return; // (pulled over to let it by: see pullover.js)
    if (car.pushing > 0 && other !== drivenCar && other !== car.ahead && Math.abs(other.speed) < 0.3) return; // (pushing past, see waitOrGiveUp)
    const gap = gapTo(car, other, range);
    if (gap >= best) return;
    if (other !== drivenCar && gapTo(other, car, senseRange(other)) < Infinity && goesFirst(car, other)) return;
    best = gap; by = other;
  });
  return { gap: best, by };
}
export const GIVE_UP_AFTER = 2.5, PUSH_FOR = 3; // (seconds)
/**
 * A car that has stood still GIVE_UP_AFTER + (its id % 5)*0.4 seconds — a slightly different wait each, so they don't all
 * go at once — waiting on another car that is also standing still, and that is neither the car ahead of it in its lane nor
 * the one being driven, gives up and pushes on for PUSH_FOR seconds, ignoring any stationary car but those two (gapAhead).
 * Waiting for anything else resets its patience.
 * @param {object} car
 * @param {?object} by - the car it is waiting on
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function waitOrGiveUp(car, by, dt) {
  car.pushing = Math.max(0, car.pushing - dt);
  if (!by || by === car.ahead || by === drivenCar || car.speed > 0.3 || Math.abs(by.speed) > 0.3) {
    car.waited = 0;
    return;
  }
  car.waited += dt;
  if (car.waited < GIVE_UP_AFTER + (car.id % 5)*0.4) return;
  car.waited = 0;
  car.pushing = PUSH_FOR;
}
/**
 * Of two cars each in the other's way, whether `car` is the one to go: the one nearer where their paths cross, or — with
 * the paths near enough parallel, or equally near — the one with the lower id.
 * @param {object} car
 * @param {object} other
 * @returns {boolean}
 */
function goesFirst(car, other) {
  const sa = Math.sin(car.heading), ca = Math.cos(car.heading), sb = Math.sin(other.heading), cb = Math.cos(other.heading);
  const det = sb*ca - sa*cb, px = other.x - car.x, pz = other.z - car.z;
  if (Math.abs(det) < 0.3) return car.id < other.id;
  // (tCar and tOther: how far each is along its own heading from where the two paths cross)
  const tCar = (sb*pz - cb*px)/det, tOther = (sa*pz - ca*px)/det;
  return Math.abs(tCar) !== Math.abs(tOther) ? Math.abs(tCar) < Math.abs(tOther) : car.id < other.id;
}
/**
 * Whether a car coming up to a dead end has nowhere to turn round: another car, on the same line and going the other way,
 * sitting within half their lengths plus CAR_STOP_GAP of that end of the line.
 * @param {object} car
 * @returns {boolean}
 */
export function uTurnBlocked(car) {
  const nav = S.trafficNav.lines[car.li], end = car.dir > 0 ? nav.total : 0, length = carLength(car);
  return cars.some(other => other !== car && other !== drivenCar && other.li === car.li && other.dir === -car.dir
    && Math.abs(other.u - end) < (length + carLength(other))*0.5 + CAR_STOP_GAP*S.peopleSize);
}
/**
 * Whether a car put at (x, z) would sit within half its and the other's lengths plus CAR_STOP_GAP of another car on a line.
 * @param {object} car
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function spotTaken(car, x, z) {
  const length = carLength(car);
  return cars.some(other => other !== car && other.li >= 0
    && Math.hypot(other.x - x, other.z - z) < (length + carLength(other))*0.5 + CAR_STOP_GAP*S.peopleSize);
}
/**
 * Whether two cars' footprints overlap: their turned rectangles are tested along the two axes of each car — its forward
 * one and its sideways one — with each rectangle projected onto the axis as half its length and half its width.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function carsOverlap(a, b) {
  const aLen = carLength(a), aWid = carWidth(a), bLen = carLength(b), bWid = carWidth(b), dx = b.x - a.x, dz = b.z - a.z;
  const axes = [a.heading, b.heading].flatMap(h => [[Math.sin(h), Math.cos(h)], [Math.cos(h), -Math.sin(h)]]);
  const extent = (len, wid, h, [ax, az]) => {
    const along = Math.abs(Math.sin(h)*ax + Math.cos(h)*az), across = Math.abs(Math.cos(h)*ax - Math.sin(h)*az);
    return along*len*0.5 + across*wid*0.5;
  };
  return axes.every(axis => Math.abs(dx*axis[0] + dz*axis[1])
    < extent(aLen, aWid, a.heading, axis) + extent(bLen, bWid, b.heading, axis));
}

// ---- someone lying in the road: a car that notices them (noticeChance, rolled once per person it comes up on) stops short
// of them, and waits as long as they're there — crawling off it, say (see life/people/peopleRoad.js). One that doesn't
// drives on over them.
const LYING_SIGHT = 16, LYING_SIDE = 1, LYING_STOP_GAP = 2.5; // (how far ahead a car sees; how far past its own side, for a body lying across the lane; how far short of their middle it stops — all at people size 1)
const NOTICE_AT_ONE = 0.95, NOTICE_CURVE = 1.3; // (the chance at perception 1, and how steeply it falls away below: about 39% at 0.5)
/**
 * The chance a car notices someone lying in the road ahead, by its perception trait.
 * @param {object} car
 * @returns {number}
 */
export const noticeChance = car => Math.min(0.99, NOTICE_AT_ONE*Math.pow(car.traits?.perception ?? 1, NOTICE_CURVE));
/**
 * How far a car can go before it must stop for someone it has noticed lying ahead of it, in its path, or null if there's
 * no one. Whether it notices each one is rolled the first time they're in its sight, and kept while they're lying there.
 * @param {object} car
 * @param {object[]} lying - everyone on the ground just now (see isLying in collisions.js)
 * @returns {?number}
 */
export function lyingAhead(car, lying) {
  const seen = car.lyingSeen;
  if (seen) for (const p of seen.keys()) if (!lying.includes(p)) seen.delete(p); // (up, or gone)
  if (!lying.length) return null;
  const sight = LYING_SIGHT*S.peopleSize, side = carWidth(car)*0.5 + LYING_SIDE*S.peopleSize, sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  let nearest = null;
  for (const p of lying) {
    const dx = p.x - car.x, dz = p.z - car.z, forward = dx*sin + dz*cos;
    if (forward < 0 || forward > sight || Math.abs(dx*cos - dz*sin) > side) continue;
    const noticed = car.lyingSeen ??= new Map();
    if (!noticed.has(p)) noticed.set(p, trafficRng() < noticeChance(car));
    if (noticed.get(p) && (nearest == null || forward < nearest)) nearest = forward;
  }
  return nearest == null ? null : nearest - carLength(car)*0.5 - LYING_STOP_GAP*S.peopleSize;
}
