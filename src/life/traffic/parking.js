import { S } from '../../core/shared.js';
import { cars, trafficRng } from './state.js';
import { carJoinLane, lanePoint, reseatCar } from './lanes.js';
import { deckOf, routeIn, routeOut, smoothPath } from '../../zones/carpark.js';

// Cars pulling into car parks (zones/carpark.js), sitting in a bay a while, then backing out and driving off.
// car.park = { lot, bay, ei, path, cum, s, k, phase: 'in' | 'parked' | 'back' | 'out', back, until, wait, ahead, join, holdAt }
const PARK_SPEED = 3, PARK_CHANCE = 0.3, START_PARKED = 0.25;
let cache = { nav: null, lots: [], list: [] };
const lotOf = id => S.zones.find(z => z.id === id)?.carPark;
const allLots = () => S.zones.map(z => z.carPark).filter(lot => lot?.entrances.length && lot.bays.length);

// every entrance with its spot on a lane: { lot, ei, li, u, key }
function entrances() {
  const nav = S.trafficNav, lots = allLots();
  if (cache.nav === nav && cache.lots.length === lots.length && cache.lots.every((l, i) => l === lots[i])) return cache.list;
  const list = [];
  lots.forEach(lot => lot.entrances.forEach((e, ei) => {
    const d = e.drop, cx = Math.floor(d.x/nav.CELL), cz = Math.floor(d.z/nav.CELL);
    let best = null;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) (nav.grid.get((cx + ox) + ',' + (cz + oz)) || []).forEach(({ li, vi }) => {
      const line = nav.lines[li];
      [vi - 1, vi].forEach(sg => {
        if (sg < 0 || sg >= line.pts.length - 1) return;
        const a = line.pts[sg], b = line.pts[sg + 1], abx = b.x - a.x, abz = b.z - a.z, l2 = abx*abx + abz*abz || 1;
        const t = Math.max(0, Math.min(1, ((d.x - a.x)*abx + (d.z - a.z)*abz)/l2)), dist = Math.hypot(a.x + abx*t - d.x, a.z + abz*t - d.z);
        if (!best || dist < best.dist) best = { dist, li, u: line.cum[sg] + t*Math.sqrt(l2) };
      });
    });
    if (best && best.dist < 4) list.push({ lot, ei, li: best.li, u: best.u, key: lot.zoneId + ':' + ei });
  }));
  cache = { nav, lots, list };
  return list;
}
const freeBays = lot => lot.bays.filter(b => !(b.car?.park?.bay === b && cars.includes(b.car))); // (a car gone or benched leaves its bay)
const setPath = (p, pts) => {
  p.path = pts; p.cum = [0];
  for (let i = 1; i < pts.length; i++) p.cum.push(p.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  p.s = 0; p.k = 0;
};
const pointAt = (p, s) => {
  const { path, cum } = p;
  s = Math.max(0, Math.min(cum[cum.length - 1], s));
  let k = 0;
  while (k < cum.length - 2 && cum[k + 1] < s) k++;
  const t = (s - cum[k])/((cum[k + 1] - cum[k]) || 1), a = path[k], b = path[k + 1] ?? a;
  return { x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t };
};
const roadSide = e => [{ x: e.side.x, y: 0.1, z: e.side.z }, { x: e.road.x, y: 0, z: e.road.z }];

/** A car on a lane coming up to a car park entrance may turn in (once per pass). */
export function maybePark(car, t) {
  if (car.kick || car.speed < 0.5 || car.traits?.smells) return false;
  for (const en of entrances()) {
    if (en.li !== car.li) continue;
    const ahead = (en.u - car.u)*car.dir;
    if (ahead < 3 || ahead > 9 || (car.parkSkip?.key === en.key && t < car.parkSkip.until)) continue;
    car.parkSkip = { key: en.key, until: t + 20 };
    if (trafficRng() > PARK_CHANCE) return false;
    const free = freeBays(en.lot);
    for (let tries = 0; tries < 5 && free.length; tries++) {
      const bay = free[Math.floor(trafficRng()*free.length)], route = routeIn(en.lot, bay, en.ei);
      if (!route) continue;
      const e = en.lot.entrances[en.ei];
      car.park = { lot: en.lot, bay, ei: en.ei, phase: 'in', back: false, wait: 0 };
      setPath(car.park, smoothPath([{ x: car.x, y: 0, z: car.z }, ...roadSide(e).reverse(), ...route]));
      bay.car = car; car.plan = null; car.gate = null; car.ahead = null;
      return true;
    }
    return false;
  }
  return false;
}
/** A newly spawned car may start out parked, in a free bay. */
export function maybeStartParked(car) {
  if (car.li < 0 || trafficRng() > START_PARKED) return;
  const lots = allLots().filter(lot => freeBays(lot).length);
  if (!lots.length) return;
  const lot = lots[Math.floor(trafficRng()*lots.length)], free = freeBays(lot), bay = free[Math.floor(trafficRng()*free.length)];
  car.park = { lot, bay, ei: 0, phase: 'parked', until: (S.lastTrafficTime ?? 0) + trafficRng()*120, wait: 0 };
  bay.car = car;
  car.x = bay.cx; car.z = bay.cz; car.heading = Math.atan2(-bay.fx, -bay.fz); car.speed = 0; car.deckY = deckOf(bay.level);
}
/** Off the car park and back on the nearest lane (its lot was rebuilt, say). */
export function endPark(car, reseat) {
  const p = car.park;
  if (p?.bay.car === car) p.bay.car = null;
  car.park = null; car.deckY = 0; car.rampPitch = 0;
  if (reseat) reseatCar(car);
}
/** After the lanes are rebuilt: a parked car keeps its place, on a lane index that still exists. */
export function reseatParked(car) {
  const n = S.trafficNav.lines.length;
  if (!n || lotOf(car.park.lot.zoneId) !== car.park.lot) { endPark(car, true); return; }
  const li = Math.min(car.li, n - 1);
  carJoinLane(car, li, Math.min(car.u, S.trafficNav.lines[li].total), car.dir);
}
function leave(car, t) {
  const p = car.park, lot = p.lot, ens = entrances().filter(en => en.lot === lot);
  const en = ens[Math.floor(trafficRng()*ens.length)], r = en && routeOut(lot, p.bay, en.ei);
  if (!r) { p.until = t + 30; return; }
  const dir = trafficRng() < 0.5 ? -1 : 1, tmp = { li: en.li, u: 0, dir, seg: 0 };
  carJoinLane(tmp, en.li, en.u + dir*6, dir);
  const J = lanePoint(tmp), e = lot.entrances[en.ei];
  p.ei = en.ei; p.join = { li: en.li, u: tmp.u, dir };
  p.ahead = smoothPath([...r.ahead, ...roadSide(e), { x: J.x, y: 0, z: J.z }]);
  p.joinAt = J;
  p.phase = 'back'; p.back = true; p.wait = 0;
  setPath(p, smoothPath(r.back));
}
/** Moves a car that's parking, parked or leaving; false once it's back on its lane (or has given up). */
export function driveParked(car, dt, t) {
  const p = car.park;
  if (lotOf(p.lot.zoneId) !== p.lot) { endPark(car, true); return false; }
  car.kick = null;
  if (p.phase === 'parked') { car.speed = 0; if (t >= p.until) leave(car, t); return true; }
  const total = p.cum[p.cum.length - 1], left = total - p.s;
  let v = Math.min(PARK_SPEED*S.peopleSpeed, 0.8 + left*0.8);
  // give way to another car in the car park just ahead, and wait for a gap before pulling out
  const fx = Math.sin(car.heading)*(p.back ? -1 : 1), fz = Math.cos(car.heading)*(p.back ? -1 : 1);
  const blocked = cars.some(o => o !== car && o.park && o.park.phase !== 'parked' && Math.abs((o.deckY ?? 0) - (car.deckY ?? 0)) < 1
    && (o.x - car.x)*fx + (o.z - car.z)*fz > 0 && Math.hypot(o.x - car.x, o.z - car.z) < 6);
  const waitOut = p.phase === 'out' && left < 14 && left > 6 && cars.some(o => o !== car && !o.park && o.li >= 0 && Math.hypot(o.x - p.joinAt.x, o.z - p.joinAt.z) < 9);
  if ((blocked || waitOut) && p.wait < (waitOut ? 8 : 3)) { v = 0; p.wait += dt; } else if (!blocked && !waitOut) p.wait = 0;
  const speed = Math.abs(car.speed);
  const next = v > speed ? Math.min(v, speed + 3*dt) : Math.max(v, speed - 6*dt);
  car.speed = p.back ? -next : next;
  p.s = Math.min(total, p.s + next*dt);
  const at = pointAt(p, p.s), a = pointAt(p, p.s - 0.6), b = pointAt(p, p.s + 0.6), dx = b.x - a.x, dz = b.z - a.z, run = Math.hypot(dx, dz);
  car.x = at.x; car.z = at.z; car.deckY = at.y;
  if (run > 0.05) {
    car.heading = Math.atan2(dx, dz) + (p.back ? Math.PI : 0);
    car.rampPitch = -Math.atan2(b.y - a.y, run)*(p.back ? -1 : 1);
  }
  if (p.s < total) return true;
  if (p.phase === 'in') { p.phase = 'parked'; p.until = t + 20 + trafficRng()*100; car.speed = 0; car.rampPitch = 0; return true; }
  if (p.phase === 'back') { p.phase = 'out'; p.back = false; p.wait = 0; car.speed = 0; setPath(p, p.ahead); return true; }
  // out: onto the lane
  const { li, u, dir } = p.join;
  endPark(car);
  if (li < S.trafficNav.lines.length) carJoinLane(car, li, u, dir); else reseatCar(car);
  return false;
}
