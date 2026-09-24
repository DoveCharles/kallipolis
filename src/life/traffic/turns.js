import { S } from '../../core/shared.js';
import { placeKey } from '../../roads/markings.js';
import { GIVE_UP_AFTER } from './spacing.js';
import { trafficRng } from './state.js';

//  ============================================================ DEAD ENDS  ============================================================
// Roads with ends only take only so many cars. A stretch takes at most stretchRoom cars, counted per frame in stretchCounts
// (buildCarGrid), and one whose way on is a full stretch either picks another or waits at the stop line (planTurn,
// waitToTurn). A dead end is never full.
const CAR_SLOT = 7; // how much lane a car stopped in a queue takes up (at size 1)
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
/**
 * Which way a car goes at a junction point: at random among its linked lines' options whenever there are any and either
 * it is the end of its line or a 0.35 roll comes up, otherwise straight on. There is no straight on at the dead end of a
 * non-loop line.
 * @param {number} li
 * @param {number} vi
 * @param {number} dir
 * @returns {object} the turn: { li, vi, from, link, dir, stretch }
 */
export function pickTurn(li, vi, dir) {
  const { options, straight } = turnOptions(li, vi, dir);
  const turn = options.length && (!straight || trafficRng() < 0.35);
  return { li, vi, from: dir, ...(turn ? options[Math.floor(trafficRng()*options.length)] : straight) };
}
/**
 * Work out the car's turn at the point ahead if it hasn't already (planTurn), then say whether it has to hold at the stop
 * line for it: true while the stretch it is joining is full and isn't the one it is already on, with its plan re-picked
 * every GIVE_UP_AFTER seconds of waiting in case some other way now has room.
 * @param {object} car
 * @param {object} ahead - the junction ahead, from junctionAhead
 * @param {number} dt - seconds this frame
 * @returns {boolean} whether it must hold
 */
export function waitToTurn(car, ahead, dt) {
  if (!planFor(car, ahead.vi)) { car.plan = planTurn(car, ahead.vi); car.held = 0; }
  if (!stretchFull(car.plan.stretch) || stretchOf(car.li, car.seg) === car.plan.stretch) { car.held = 0; return false; }
  car.held += dt;
  if (car.held > GIVE_UP_AFTER) { car.plan = planTurn(car, ahead.vi); car.held = 0; } // (maybe there's room some other way now)
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
  const { options, straight } = turnOptions(car.li, vi, car.dir);
  const picked = pickTurn(car.li, vi, car.dir);
  if (!stretchFull(picked.stretch)) return picked;
  const free = [...options, ...(straight ? [straight] : [])].filter(o => !stretchFull(o.stretch));
  return free.length ? { li: car.li, vi, from: car.dir, ...free[Math.floor(trafficRng()*free.length)] } : picked;
}
