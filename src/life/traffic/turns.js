import { S } from '../../core/shared.js';
import { placeKey } from '../../roads/markings.js';
import { forCarsNear } from './spacing.js';
import { carLength } from './placing.js';
import { trafficRng } from './state.js';

//  ============================================================ DEAD ENDS  ============================================================
// Roads with ends only take only so many cars. A stretch takes at most stretchRoom cars, counted per frame in stretchCounts
// (buildCarGrid), and one whose way on is a full stretch either picks another or waits at the stop line (planTurn,
// waitToTurn). A dead end is never full.
const CAR_SLOT = 7;
const REPLAN_AFTER = 12; // (seconds held at the line for a full road before it looks for another way) // how much lane a car stopped in a queue takes up (at size 1)
export const stretchCounts = [];
export const stretchOf = (li, seg) => S.trafficNav.lines[li].stretchOf[Math.max(0, Math.min(S.trafficNav.lines[li].pts.length-2, seg))];
/**
 * How many cars a stretch takes: both its lanes' worth of usable length, less the junctions at its ends, and one space
 * left over to turn round in. A dead end takes any number.
 * @param {number} si - stretch index
 * @returns {number}
 */
function stretchRoom(si) {
  const st = S.trafficNav.stretches[si];
  if (st === undefined || st.deadEnd) return Infinity;
  const nav = S.trafficNav.lines[st.li];
  const junctionAt = v => S.roadJunctionByPlace.get(placeKey(nav.pts[v].x, nav.pts[v].z))?.r || 0;
  const usable = st.length - junctionAt(st.from) - junctionAt(st.to);
  return Math.max(1, Math.floor(usable*2/(CAR_SLOT*S.peopleSize)) - 1);
}
const stretchFull = si => stretchCounts[si] >= stretchRoom(si);
/**
 * The ways a car on line `li` heading `dir` can go at vertex `vi`.
 * @param {number} li
 * @param {number} vi
 * @param {number} dir - 1 or -1
 * @returns {{ options: object[], straight: ?object }} each option { link, dir, stretch }; `straight` is null at the dead end
 *   of a non-loop line
 */
function turnOptions(li, vi, dir) {
  const nav = S.trafficNav.lines[li], options = [];
  nav.vertices[vi].links.forEach(link => {
    const other = S.trafficNav.lines[link.li], last = other.pts.length-1;
    (link.vi === 0 ? [1] : link.vi === last ? [-1] : [1, -1]).forEach(d =>
      options.push({ link, dir: d, stretch: stretchOf(link.li, d > 0 ? link.vi : link.vi-1) }));
  });
  const last = nav.pts.length-1, isEnd = vi === 0 || vi === last;
  if (isEnd && !nav.loop) return { options, straight: null };
  // (round a loop, straight on from its end is on from its start, and back past its start is the other way)
  const seg = dir > 0 ? (vi === last ? 0 : vi) : (vi === 0 ? last-1 : vi-1);
  return { options, straight: { link: null, dir, stretch: stretchOf(li, seg) } };
}
// Ways on a car won't take: back down the street it came along (within DOUBLE_BACK of straight back the way it came), and —
// for cars with the avoiddeadends trait (buses) — into a dead end, or onto a road whose every way on from its far junction
// is a dead end (DEAD_END_LOOK junctions deep), so it isn't led into a cul-de-sac cluster. If that leaves nothing, only
// doubling back is ruled out; if that leaves nothing either, anything goes — so it can never be left with no way on (and
// at a dead end it turns round, as ever).
const DOUBLE_BACK = Math.cos(Math.PI/6), DEAD_END_LOOK = 1;
const lineDir = (li, v, w) => { const pts = S.trafficNav.lines[li].pts, last = pts.length - 1, a = pts[v], b = pts[Math.max(0, Math.min(last, w))]; return { x: b.x - a.x, z: b.z - a.z }; };
/** Whether way `o` on from vertex `vi` (reached on line `li` going `dir`) heads back the way the car came. */
function doublesBack(li, vi, dir, o) {
  const came = lineDir(li, vi - dir, vi), out = o.link ? lineDir(o.link.li, o.link.vi, o.link.vi + o.dir) : lineDir(li, vi, vi + o.dir);
  return (came.x*out.x + came.z*out.z)/((Math.hypot(came.x, came.z)*Math.hypot(out.x, out.z)) || Infinity) < -DOUBLE_BACK;
}
/** Whether way `o` from vertex `vi` of line `li` leads only to dead ends, looking `depth` junctions past its far end. */
function deadEndWay(o, li, depth) {
  const st = S.trafficNav.stretches[o.stretch];
  if (!st) return false;
  if (st.deadEnd) return true;
  const l = o.link ? o.link.li : li, far = o.dir > 0 ? st.to : st.from;
  if (depth <= 0 || S.trafficNav.lines[l].loop) return false;
  const { options, straight } = turnOptions(l, far, o.dir);
  const on = [...options, ...(straight ? [straight] : [])].filter(n => !doublesBack(l, far, o.dir, n));
  return on.length > 0 && on.every(n => deadEndWay(n, l, depth - 1));
}
/**
 * The ways a car can go at a junction point, less the ones it won't take (see DOUBLE_BACK).
 * @param {number} li
 * @param {number} vi
 * @param {number} dir
 * @param {?object} car - for its traits
 * @returns {{ options: object[], straight: ?object }}
 */
export function waysOn(li, vi, dir, car) {
  const all = turnOptions(li, vi, dir), avoid = car?.traits?.avoiddeadends;
  const pick = keep => ({ options: all.options.filter(keep), straight: all.straight && keep(all.straight) ? all.straight : null });
  const any = ways => ways.options.length || ways.straight;
  const forward = pick(o => !doublesBack(li, vi, dir, o));
  const best = avoid ? pick(o => !doublesBack(li, vi, dir, o) && !deadEndWay(o, li, DEAD_END_LOOK)) : forward;
  return any(best) ? best : any(forward) ? forward : all;
}
/**
 * Which way a car goes at a junction point: at random among its linked lines' options whenever there are any and either
 * it is the end of its line or a 0.35 roll comes up, otherwise straight on (see waysOn for the ways it won't take).
 * @param {number} li
 * @param {number} vi
 * @param {number} dir
 * @param {?object} car
 * @returns {object} the turn: { li, vi, from, link, dir, stretch }
 */
export function pickTurn(li, vi, dir, car = null) {
  const { options, straight } = waysOn(li, vi, dir, car);
  const turn = options.length && (!straight || trafficRng() < 0.35);
  return { li, vi, from: dir, ...(turn ? options[Math.floor(trafficRng()*options.length)] : straight) };
}
/**
 * Work out the car's turn at the point ahead if it hasn't already (planTurn), then say whether it has to hold at the stop
 * line for it: true while the stretch it is joining is full and isn't the one it is already on, with its plan re-picked
 * every REPLAN_AFTER seconds of waiting in case some other way now has room.
 * @param {object} car
 * @param {object} ahead - the junction ahead, from junctionAhead
 * @param {number} dt - seconds this frame
 * @returns {boolean} whether it must hold
 */
export function waitToTurn(car, ahead, dt) {
  if (!planFor(car, ahead.vi)) { car.plan = planTurn(car, ahead.vi); car.held = 0; }
  if (entryHeld(car, ahead, dt)) return true;
  if (!stretchFull(car.plan.stretch) || stretchOf(car.li, car.seg) === car.plan.stretch) { car.held = 0; return false; }
  car.held += dt;
  if (car.held > REPLAN_AFTER) { car.plan = planTurn(car, ahead.vi); car.held = 0; } // (maybe there's room some other way now)
  return true;
}
// Don't block the junction: a car holds at the stop line while a car is sitting (slower than ENTRY_MOVING) just past the
// junction on the lane it's going onto, within its own length plus ENTRY_CLEAR — else it'd cross and stop inside, where
// others clip into it. After ENTRY_GIVE_UP seconds held it picks another way on with room, or with none goes anyway for ENTRY_GIVE_UP, in case they wait on each other.
const ENTRY_CLEAR = 4, ENTRY_MOVING = 3, ENTRY_GIVE_UP = 12; // (units at size 1 — its stopping gap behind that car and a little over; units a second; seconds)
function entryHeld(car, ahead, dt) {
  if ((car.entryPass = Math.max(0, (car.entryPass ?? 0) - dt)) > 0) return false;
  const j = S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
  if (!j || !car.plan) { car.entryHeld = 0; return false; }
  const li = car.plan.link ? car.plan.link.li : car.li, vi = car.plan.link ? car.plan.link.vi : ahead.vi, dir = car.plan.dir;
  const nav = S.trafficNav.lines[li], from = nav.cum[vi], reach = j.r + carLength(car) + ENTRY_CLEAR*S.peopleSize;
  let blocked = false;
  forCarsNear(ahead.x, ahead.z, reach + carLength(car), other => {
    if (blocked || other === car || other.li !== li || other.dir !== dir || Math.abs(other.speed) > ENTRY_MOVING) return;
    const past = (other.u - from)*dir - carLength(other)*0.5;
    if (past > -carLength(other) && past < reach) blocked = true;
  });
  if (!blocked) { car.entryHeld = 0; return false; }
  if ((car.entryHeld = (car.entryHeld ?? 0) + dt) > ENTRY_GIVE_UP) {
    car.entryHeld = 0;
    // another way on whose road isn't full, if there is one (checked again next frame); only with none does it go anyway
    const { options, straight } = waysOn(car.li, ahead.vi, car.dir, car);
    const others = [...options, ...(straight ? [straight] : [])].filter(o => ((o.link ? o.link.li : car.li) !== li || o.dir !== dir) && !stretchFull(o.stretch));
    if (others.length) { car.plan = { li: car.li, vi: ahead.vi, from: car.dir, ...others[Math.floor(trafficRng()*others.length)] }; return true; }
    car.entryPass = ENTRY_GIVE_UP;
    return false;
  }
  return true;
}
/** Whether the car's plan is a turn at vertex `vi` of the line it is on, taken in the direction it is going. */
export const planFor = (car, vi) => car.plan && car.plan.li === car.li && car.plan.vi === vi && car.plan.from === car.dir;
/**
 * The car's turn at a junction point: pickTurn's choice, unless the stretch it joins is full, in which case one is picked
 * at random from the options and the straight on whose stretches aren't — or, with none free, pickTurn's choice stands.
 * @param {object} car
 * @param {number} vi - the junction point's index
 * @returns {object} the plan
 */
function planTurn(car, vi) {
  const { options, straight } = waysOn(car.li, vi, car.dir, car);
  const picked = pickTurn(car.li, vi, car.dir, car);
  if (!stretchFull(picked.stretch)) return picked;
  const free = [...options, ...(straight ? [straight] : [])].filter(o => !stretchFull(o.stretch));
  return free.length ? { li: car.li, vi, from: car.dir, ...free[Math.floor(trafficRng()*free.length)] } : picked;
}
