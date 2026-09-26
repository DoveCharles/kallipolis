import { S, App } from '../../core/shared.js';
import { camera, Y_ROAD } from '../../core/scene.js';
import { tessellateOpenPath } from '../../core/splines.js';
import { roadNodes } from '../../core/state.js';
import { roadLineWidths } from '../../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../../roads/paths.js';
import { isTrainLine } from '../../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted, isPedInDanger } from '../people/people.js';
import { pickCarPaint } from './models.js';
import { spotTaken } from './spacing.js';
import { PED_YIELD_CHANCE, PED_YIELD_RADIUS, TRAFFIC_LANE_PER_CAR, cars, trafficRng } from './state.js';
import { pickTurn, planFor } from './turns.js';
import { resetHealth } from '../../core/health.js';

// The lanes cars drive: built from the road lines (buildTrafficNav), sampled and smoothed, routes along them and round
// junctions (routePoint), spawning and reseating cars, driving on (driveAlong) and yielding at junctions and to people.

let carIds = 0;
/**
 * Rebuild the lanes from the road lines.
 *
 * Per sidewalk road line: { pts, cum, total, lane (its offset from the centerline), loop (whether the line ends where it
 * started, so cars carry on round), vertices (each { links }: the { li, vi } of any other line's point at the same place),
 * stretchOf (which stretch each segment is in) }. Points are tessellated at PEOPLE_NAV_SPACING, and a line under 4 units
 * long is left out. Also built: the points in a grid of CELL-sized cells, for re-seating cars (reseatCar); the stretches
 * between junctions and line ends, each { li, from, to, length, deadEnd }; and how many cars the roads take.
 * @returns {object} the nav: { lines, grid, CELL, stretches, capacity, … }
 */
export function buildTrafficNav() {
  const lines = [];
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const pts = [nodes[0]];
    for (let i=1;i<nodes.length;i++) {
      const a = nodes[i-1], b = nodes[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
      for (let k=1;k<=steps;k++) pts.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    }
    const cum = [0];
    for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
    if (cum[cum.length-1] < 4) return;
    const loop = line.nodeIds.length > 3 && line.nodeIds[0] === line.nodeIds[line.nodeIds.length-1];
    lines.push({ pts, cum, total: cum[cum.length-1], lane: Math.max(0.8, roadLineWidths(line).hw*0.5), loop, vertices: pts.map(() => ({ links: [] })) });
  });
  const byPlace = new Map(), grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const place = Math.round(p.x*2) + ',' + Math.round(p.z*2), cell = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!byPlace.has(place)) byPlace.set(place, []);
    byPlace.get(place).push({ li, vi });
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push({ li, vi });
  }));
  byPlace.forEach(list => { if (list.length > 1) list.forEach(a => { lines[a.li].vertices[a.vi].links = list.filter(b => b.li !== a.li); }); });
  // each line's stretches between junctions and ends, and which one each of its segments is in
  const stretches = [];
  lines.forEach((nav, li) => {
    nav.stretchOf = [];
    let from = 0;
    for (let v=1; v<nav.pts.length; v++) {
      if (!nav.vertices[v].links.length && v < nav.pts.length-1) continue;
      const deadEnd = !nav.loop && ((from === 0 && !nav.vertices[0].links.length) || (v === nav.pts.length-1 && !nav.vertices[v].links.length));
      for (let seg=from; seg<v; seg++) nav.stretchOf[seg] = stretches.length;
      stretches.push({ li, from, to: v, length: nav.cum[v] - nav.cum[from], deadEnd });
      from = v;
    }
  });
  const capacity = Math.floor(lines.reduce((sum, nav) => sum + nav.total*2, 0)/TRAFFIC_LANE_PER_CAR);
  return { lines, grid, CELL, capacity, stretches };
}
/**
 * A new car at rest, off any lane, with its own id.
 * @returns {object}
 */
export function newCar() {
  return { id: ++carIds, x: 0, z: 0, heading: 0, li: -1, u: 0, dir: 1, seg: 0, speed: 0, ahead: null,
    length: 0.9 + trafficRng()*0.3, width: 0.95 + trafficRng()*0.12, height: 0.9 + trafficRng()*0.35,
    design: null, paint: pickCarPaint(),
    // how far its wheels have rolled and how far its steering wheels are turned, both in radians, and the heading it had
    // last frame, from which turnWheels gets how fast it's turning
    wheelSpin: 0, wheelSteer: 0, lastHeading: null,
    // the body on its springs: pitch (nose up) and roll (top toward the outside of a turn), in radians, how fast each is
    // moving, and the speed it had last frame and its eased acceleration, which lean it (see swayBody)
    bodyPitch: 0, bodyPitchRate: 0, bodyRoll: 0, bodyRollRate: 0, lastSpeed: 0, accel: 0,
    // how far the steering's held over, -1 (left) to 1 (right), while it's being driven (see driveByHand)
    steerHeld: 0,
    // the person it's stopped for, if any (see checkYield) — and the last person it rolled PED_YIELD_CHANCE against, so
    // it doesn't re-roll for them every frame while it's still coming up to them
    yieldFor: null, yieldChecked: -1, yielded: 0,
    // seconds it's stood waiting for another car to move, seconds of pushing on left once it gives up (see waitOrGiveUp),
    // and seconds it's waited to turn round at a dead end (see updateTraffic)
    waited: 0, pushing: 0, uTurnWaited: 0,
    // its turn at the junction ahead, if it has picked one ({ li, vi, from, link, dir, stretch }, see planTurn), and how
    // long it's waited at the stop line for room on the road it's turning onto
    plan: null, held: 0 };
}
/**
 * Put a car in lane `li` at distance `u` along it, heading `dir`, and find the segment that puts it in.
 * @param {object} car
 * @param {number} li - lane index
 * @param {number} u - distance along the lane
 * @param {number} dir - 1 or -1
 * @returns {void}
 */
export function carJoinLane(car, li, u, dir) {
  const nav = S.trafficNav.lines[li];
  car.li = li; car.dir = dir; car.u = Math.max(0, Math.min(nav.total, u)); car.turned = null;
  car.plan = null; // (a plan names lines by index, so one made on an older nav would point at the wrong line)
  car.seg = 0;
  while (car.seg < nav.pts.length-2 && nav.cum[car.seg+1] <= car.u) car.seg++;
}
/**
 * Where a car should be: its lane's smoothed point at its distance along the lane, offset `lane` to one side for its
 * direction, with the direction the lane runs there.
 * @param {object} car
 * @returns {{ x: number, z: number, heading: number }}
 */
export function lanePoint(car) {
  const nav = S.trafficNav.lines[car.li], sm = laneSmoothed(nav), side = car.dir*nav.lane;
  const at = Math.max(0, Math.min(sm.length-1.001, car.u/sm.spacing)), k = Math.floor(at), t = at - k;
  const ax = sm[k].x + sm[k].mx*side, az = sm[k].z + sm[k].mz*side, bx = sm[k+1].x + sm[k+1].mx*side, bz = sm[k+1].z + sm[k+1].mz*side;
  let hx = bx-ax, hz = bz-az;
  if (Math.hypot(hx, hz) < 1e-6) {
    const i = Math.max(0, Math.min(nav.pts.length-2, car.seg));
    hx = nav.pts[i+1].x - nav.pts[i].x; hz = nav.pts[i+1].z - nav.pts[i].z;
  }
  return { x: ax + (bx-ax)*t, z: az + (bz-az)*t, heading: Math.atan2(hx*car.dir, hz*car.dir) };
}
const LANE_SMOOTH = 2.5, LANE_SAMPLE = 0.5;
/**
 * The road's middle at LANE_SAMPLE apart along it (its `spacing`), each averaged over LANE_SMOOTH lane offsets either side
 * of the point, with { mx, mz } the unit left of the line there. Bends are rounded off, so a car turns in before a corner
 * and the inside lane keeps no kink at a sharp one. Each point also carries `along` and `alongBack`, its distance along
 * that lane from the start (laneLength). Cached as `smoothed` on the line.
 * @param {object} nav - a traffic nav line
 * @returns {object} the smoothed sampling, with a `spacing` property
 */
function laneSmoothed(nav) {
  if (nav.smoothed) return nav.smoothed;
  const { pts, cum, total } = nav, n = pts.length, reach = LANE_SMOOTH*nav.lane, STEPS = 32;
  // the road's middle at distance u — round a loop, or carried on straight past either end
  const raw = u => {
    if (nav.loop) u = ((u % total) + total) % total;
    let lo = 0, hi = n-2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= u) lo = mid; else hi = mid - 1; }
    const a = pts[lo], b = pts[lo+1], t = (u - cum[lo])/((cum[lo+1] - cum[lo]) || 1), at = nav.loop ? Math.max(0, Math.min(1, t)) : t;
    return { x: a.x + (b.x-a.x)*at, z: a.z + (b.z-a.z)*at };
  };
  const count = Math.ceil(total/LANE_SAMPLE) + 1, spacing = total/(count-1);
  const middle = Array.from({ length: count }, (_, j) => {
    let x = 0, z = 0;
    for (let k=0; k<=STEPS; k++) { const p = raw(j*spacing + (k/STEPS*2 - 1)*reach); x += p.x; z += p.z; }
    return { x: x/(STEPS+1), z: z/(STEPS+1) };
  });
  nav.smoothed = middle.map((p, j) => {
    const before = middle[j > 0 ? j-1 : nav.loop ? count-2 : 0], after = middle[j < count-1 ? j+1 : nav.loop ? 1 : count-1];
    const dx = after.x - before.x, dz = after.z - before.z, len = Math.hypot(dx, dz) || 1;
    return { x: p.x, z: p.z, mx: -dz/len, mz: dx/len };
  });
  nav.smoothed.spacing = spacing;
  // (and how far along each lane each point is — see laneLength)
  for (const side of [1, -1]) {
    let length = 0;
    nav.smoothed.forEach((p, j) => {
      const q = nav.smoothed[j-1];
      if (q) length += Math.hypot(p.x + p.mx*side*nav.lane - q.x - q.mx*side*nav.lane, p.z + p.mz*side*nav.lane - q.z - q.mz*side*nav.lane);
      p[side > 0 ? 'along' : 'alongBack'] = length;
    });
  }
  return nav.smoothed;
}
/**
 * How far a car going `dir` has driven along the road when it is at distance `u` along the line: further than u round the
 * outside of a bend, less round the inside (laneSmoothed's along/alongBack).
 * @param {object} nav - a traffic nav line
 * @param {number} dir - 1 or -1
 * @param {number} u - distance along the line
 * @returns {number} distance driven along the road
 */
export function laneLength(nav, dir, u) {
  const sm = laneSmoothed(nav), key = dir > 0 ? 'along' : 'alongBack';
  const at = Math.max(0, Math.min(sm.length-1.001, u/sm.spacing)), k = Math.floor(at);
  return sm[k][key] + (sm[k+1][key] - sm[k][key])*(at - k);
}
/** The lane's point at distance `u` along it, going `dir`. */
function lanePointAt(li, u, dir) {
  const spot = {};
  carJoinLane(spot, li, u, dir);
  return lanePoint(spot);
}
// ---- a car's route: the path its front axle follows — along its lane, through a cubic curve where it turns onto another
// line (planned or taken on the spot) and round a U at a dead end — where its lane point alone would jump the junction.
export const TURN_CURVE = 2.5; // how far either side of a junction a turn's curve reaches, in lane offsets
export const ROUTE_SAMPLE = 0.25; // how far along the road to look ahead for how much further its route goes (see updateTraffic)
/**
 * The point `ahead` further along a car's route than its lane point, following whatever turn it has planned at the
 * junction ahead and any U-turn it is partway through.
 * @param {object} car
 * @param {number} ahead - how far further along the route to look
 * @returns {{ x: number, z: number, heading: number }}
 */
export function routePoint(car, ahead) {
  const probe = { li: car.li, u: car.u, seg: car.seg, dir: car.dir, plan: car.plan, turned: car.turned, probe: true };
  if (ahead > 0) driveAlong(probe, ahead);
  const nav = S.trafficNav.lines[probe.li];
  // turning round at a dead end: a U of radius nav.lane, reaching `depth` back from the end, swept by `angle` as the car
  // comes up to the end and goes back out
  const depth = Math.min(1.5*nav.lane, nav.total*0.5);
  if (!nav.loop && depth >= nav.lane) {
    for (const end of [1, -1]) {
      const vi = end > 0 ? nav.pts.length-1 : 0, left = end > 0 ? nav.total - probe.u : probe.u;
      if (nav.vertices[vi].links.length || left >= depth) continue;
      const angle = Math.PI*0.5*(probe.dir === end ? 1 - left/depth : 1 + left/depth);
      const mid = lanePointAt(probe.li, nav.cum[vi] - end*depth, end); // (in the lane going in, so off the middle)
      const fx = Math.sin(mid.heading), fz = Math.cos(mid.heading), lx = -fz, lz = fx;
      const cx = mid.x - lx*nav.lane, cz = mid.z - lz*nav.lane, across = nav.lane*Math.cos(angle), along = depth*Math.sin(angle);
      const tx = -nav.lane*Math.sin(angle)*lx + depth*Math.cos(angle)*fx, tz = -nav.lane*Math.sin(angle)*lz + depth*Math.cos(angle)*fz;
      return { x: cx + lx*across + fx*along, z: cz + lz*across + fz*along, heading: Math.atan2(tx, tz) };
    }
  }
  // turning off at a junction: a cubic curve reaching `curve` back along the line it's leaving and `curve` on along the
  // line it joins, picked up before the junction (turn planned) or after it (turn taken)
  const curve = TURN_CURVE*nav.lane;
  let turn = null, at = 0;
  const plan = probe.plan;
  if (plan && plan.link && plan.li === probe.li && plan.from === probe.dir) {
    const d = (nav.cum[plan.vi] - probe.u)*probe.dir;
    if (d >= 0 && d < curve) { turn = { from: { li: plan.li, vi: plan.vi, dir: plan.from }, to: { li: plan.link.li, vi: plan.link.vi, dir: plan.dir } }; at = -d; }
  }
  const turned = probe.turned;
  if (!turn && turned && turned.nav === S.trafficNav && turned.to.li === probe.li && turned.to.dir === probe.dir) {
    const d = (probe.u - nav.cum[turned.to.vi])*probe.dir;
    if (d >= 0 && d < curve) { turn = turned; at = d; }
  }
  if (!turn) return lanePoint(probe);
  const from = S.trafficNav.lines[turn.from.li], to = S.trafficNav.lines[turn.to.li];
  const p0 = lanePointAt(turn.from.li, from.cum[turn.from.vi] - turn.from.dir*curve, turn.from.dir);
  const p3 = lanePointAt(turn.to.li, to.cum[turn.to.vi] + turn.to.dir*curve, turn.to.dir);
  const reach = 0.4*Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const p1 = { x: p0.x + Math.sin(p0.heading)*reach, z: p0.z + Math.cos(p0.heading)*reach };
  const p2 = { x: p3.x - Math.sin(p3.heading)*reach, z: p3.z - Math.cos(p3.heading)*reach };
  const t = (at + curve)/(2*curve), s = 1 - t;
  const bez = k => s*s*s*p0[k] + 3*s*s*t*p1[k] + 3*s*t*t*p2[k] + t*t*t*p3[k];
  const slope = k => 3*s*s*(p1[k] - p0[k]) + 6*s*t*(p2[k] - p1[k]) + 3*t*t*(p3[k] - p2[k]);
  return { x: bez('x'), z: bez('z'), heading: Math.atan2(slope('x'), slope('z')) };
}
/**
 * Put a car somewhere at random along some line, chosen in proportion to its length, if no other car is already sitting
 * there. Gives up after 8 tries and leaves the car at li -1, which keeps it hidden until the next frame's try.
 * @param {object} car
 * @returns {void}
 */
export function spawnCar(car) {
  resetHealth(car, 'car');
  const { lines } = S.trafficNav;
  car.li = -1;
  if (!lines.length) return;
  let nearSpot = null; // (a free spot inside S.carSpawnDistance of the camera, only used if no farther one turns up)
  for (let tries = 0; tries < 8; tries++) {
    const li = pickWeighted(lines, nav => nav.total), u = trafficRng()*lines[li].total, dir = trafficRng() < 0.5 ? -1 : 1;
    carJoinLane(car, li, u, dir);
    const at = lanePoint(car);
    if (spotTaken(car, at.x, at.z)) continue;
    if (Math.hypot(at.x - camera.position.x, Y_ROAD - camera.position.y, at.z - camera.position.z) < S.carSpawnDistance) {
      nearSpot ??= { li, u, dir };
      continue;
    }
    car.x = at.x; car.z = at.z; car.heading = at.heading; car.speed = 0;
    return;
  }
  if (nearSpot) {
    carJoinLane(car, nearSpot.li, nearSpot.u, nearSpot.dir);
    const at = lanePoint(car);
    car.x = at.x; car.z = at.z; car.heading = at.heading; car.speed = 0;
    return;
  }
  car.li = -1;
}
/**
 * Put a car on the nearest line point within two grid cells of it, keeping its direction, after the roads have been
 * rebuilt — or spawn it afresh if it has no line or nothing is near enough.
 * @param {object} car
 * @returns {void}
 */
export function reseatCar(car) {
  const { lines, grid, CELL } = S.trafficNav;
  if (car.li >= 0) {
    let best = null;
    const cx = Math.floor(car.x/CELL), cz = Math.floor(car.z/CELL);
    for (let ox=-2;ox<=2;ox++) for (let oz=-2;oz<=2;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      const q = lines[li].pts[vi], d = Math.hypot(q.x-car.x, q.z-car.z);
      if (!best || d < best.d) best = { li, vi, d };
    });
    if (best) { carJoinLane(car, best.li, lines[best.li].cum[best.vi], car.dir); return; }
  }
  spawnCar(car);
}
/**
 * Move a car `dist` along its line, point to point. At each point it reaches: it takes its planned turn if it has one
 * (planTurn), otherwise picks one where the point is linked to another line; it carries on from the start at the seam of a
 * loop; and it turns back into the other lane at a dead end. The result is clamped into the line.
 * @param {object} car
 * @param {number} dist
 * @returns {void}
 */
export function driveAlong(car, dist) {
  if (dist < 0) { backAlong(car, -dist); return; }
  let nav = S.trafficNav.lines[car.li], u = car.u + car.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const ahead = car.dir > 0 ? car.seg + 1 : car.seg, at = nav.cum[ahead];
    if (car.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead], isEnd = ahead === 0 || ahead === nav.pts.length-1;
    const planned = planFor(car, ahead);
    const plan = planned ? car.plan : vertex.links.length && !car.probe ? pickTurn(car.li, ahead, car.dir, car) : null;
    if (planned || vertex.links.length || isEnd) car.plan = null; // (a plain point on the way to the junction leaves its plan alone)
    if (plan && plan.link) {
      const link = plan.link, other = S.trafficNav.lines[link.li], remaining = Math.abs(u - at), dir = plan.dir;
      const from = { li: car.li, vi: ahead, dir: car.dir };
      carJoinLane(car, link.li, other.cum[link.vi], dir);
      car.turned = { nav: S.trafficNav, from, to: { li: link.li, vi: link.vi, dir } }; // (see routePoint)
      car.seg = dir > 0 ? Math.min(link.vi, other.pts.length-2) : Math.max(link.vi-1, 0);
      nav = other;
      u = car.u + dir*remaining;
      continue;
    }
    if (isEnd && nav.loop) { u -= car.dir*nav.total; car.seg = car.dir > 0 ? 0 : nav.pts.length-2; continue; } // (round again)
    if (isEnd) { car.dir = -car.dir; u = 2*at - u; car.turned = null; continue; }
    car.seg += car.dir;
  }
  car.u = Math.max(0, Math.min(nav.total, u));
}
/**
 * Back a car `dist` along its lane, the opposite way to its direction — no further than the end of the line it's on
 * (it never reverses round a junction).
 * @param {object} car
 * @param {number} dist
 * @returns {void}
 */
function backAlong(car, dist) {
  const nav = S.trafficNav.lines[car.li];
  car.u = Math.max(0, Math.min(nav.total, car.u - car.dir*dist));
  while (car.seg > 0 && nav.cum[car.seg] > car.u) car.seg--;
  while (car.seg < nav.pts.length-2 && nav.cum[car.seg+1] <= car.u) car.seg++;
}
/**
 * The next linked point or dead end ahead of a car, looking at most `lookahead` points on. `dist` is measured along the
 * line and keeps counting round a loop.
 * @param {object} car
 * @param {number} lookahead - how many points on to look
 * @returns {object|null} { dist, x, z, vi, deadEnd }, or null if there is none that far on
 */
export function junctionAhead(car, lookahead) {
  const nav = S.trafficNav.lines[car.li], last = nav.pts.length-1, seam = car.dir > 0 ? last : 0;
  let v = car.dir > 0 ? car.seg + 1 : car.seg, round = null; // (past a loop's start: how far away that was)
  for (let k=0; k<lookahead && v >= 0 && v <= last; k++, v += car.dir) {
    const links = nav.vertices[v].links.length;
    const dist = round == null ? Math.abs(nav.cum[v] - car.u) : round + Math.abs(nav.cum[v] - nav.cum[last - seam]);
    if (links || (!nav.loop && (v === 0 || v === last))) return { dist, x: nav.pts[v].x, z: nav.pts[v].z, vi: v, deadEnd: !links };
    if (nav.loop && v === seam && round == null) { round = dist; v = last - seam; } // (on round from the other end)
  }
  return null;
}
/**
 * Whether any car on a line — moving or not, since a stopped one can pull away at any moment — is within `radius` of
 * (x, z): the roadsafety radius a pedestrian checks before crossing (crossingClear in people.js).
 * @param {number} x
 * @param {number} z
 * @param {number} radius
 * @returns {boolean}
 */
export function carsNearby(x, z, radius) {
  return cars.some(car => car.li >= 0 && Math.hypot(car.x - x, car.z - z) < radius);
}
/**
 * Whether any car on a line is somewhere `test(x, z, car)` says — carsNearby for a shape other than a circle, with the car
 * itself passed to the test.
 * @param {(x: number, z: number, car: object) => boolean} test
 * @returns {boolean}
 */
export function carsWhere(test) {
  return cars.some(car => car.li >= 0 && test(car.x, car.z, car));
}
const YIELD_GIVE_UP = 8; // (seconds)
/**
 * Everyone a car might stop for — mid-road or crossing (see checkYield) — as indices in App.people. updateTraffic
 * gathers them once a frame rather than every car walking the whole crowd.
 * @returns {number[]}
 */
export function roadCrossers() {
  const out = [];
  App.people.forEach((p, i) => { if (p.crossStage === 'mid' || isPedInDanger(p)) out.push(i); });
  return out;
}
/**
 * Whether the car stops for a pedestrian: someone mid-road ahead of it within PED_YIELD_RADIUS is stopped for with chance
 * PED_YIELD_CHANCE, or always on a junction's zebra crossing. A car committed to someone keeps stopping for them with no
 * further rolls, until they are across, gone, or YIELD_GIVE_UP seconds pass — when they are waved on (p.jc.waved) and it
 * drives on. runOverPeople spares anyone mid-road the car has waved over.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @param {number[]} [inRoad] - indices in App.people of everyone in the road (roadCrossers), if the caller has them already
 * @returns {boolean} whether it is yielding
 */
export function checkYield(car, dt, inRoad = roadCrossers()) {
  if (car.yieldFor != null) {
    const p = App.people[car.yieldFor];
    car.yielded += dt;
    if (p?.jc && car.yielded > YIELD_GIVE_UP) p.jc.waved = true;
    if (!p || (p.crossStage !== 'mid' && !isPedInDanger(p)) || car.yielded > YIELD_GIVE_UP) { car.yieldFor = null; car.yielded = 0; }
    return car.yieldFor != null;
  }
  const cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  for (const i of inRoad) {
    const p = App.people[i];
    if (i === car.yieldChecked) continue;
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.hypot(dx, dz) > PED_YIELD_RADIUS) continue;
    const forward = dx*sin + dz*cos;
    if (forward < 0.5 || forward > PED_YIELD_RADIUS) continue; // (only ahead of it, not behind)
    car.yieldChecked = i;
    // (someone on a junction's zebra crossing always gets let across)
    if (p.crossStage === 'jcross' || trafficRng() < PED_YIELD_CHANCE/Math.max(0.01, car.traits?.aggression ?? 1)) car.yieldFor = i; // (the more aggressive, the less often)
    return car.yieldFor === i;
  }
  return false;
}
