import { Y_PATH, Y_SIDEWALK } from '../../core/scene.js';
import { carriageSpot, getTrainShuttles, getTrainStations, holdTrain } from '../../trains/trains.js';
import { possession } from '../possession.js';
import { peopleNav, wrapAngle } from './people.js';

// ============================================================ where someone possessed is standing
// Walked about by hand (see walkPossessed in peopleTracking.js), someone is on the ground — a hangout's, the road's or
// the pavement's — unless they've got up onto something. p.footing says what:
//  • { kind: 'raised', y }: a raised walkway's deck or ramp (see raised.js), at height y. They get up there by a ramp's
//    foot, and the ledges keep them on — they only come down the way they went up.
//  • { kind: 'station', node }: a train station's deck — the platform either side of the track, the doorways and the
//    landings outside them. The vault's glass and the track's edge keep them on it; they leave in a lift, off a landing
//    that's down on the ground, or through a stopped carriage's open door. Its doors open for them as they come near,
//    as they do for anyone.
//  • { kind: 'lift', node, side }: in one of a station's lift cabs, carried up or down with it. Stepping in calls it to
//    the other end; standing by a doorway it isn't at calls it there. Its doorways are only open where it's standing,
//    and the shaft is a wall anywhere else.
//  • { kind: 'carriage', lineId, u, v, yaw }: aboard a carriage, at (u, v) in its standing room (see carriageSpot),
//    carried wherever it goes — turned with it too — and out again through its door when it's stopped at a station with
//    its doors open.

/** How far up or down a raised walkway can be from where someone is and still be stepped onto: well under a ramp's drop
 * per turn, so the turns of its spiral stay apart — and a deck, up at least MIN_RAISED_HEIGHT, is out of reach from the ground. */
const RAISED_STEP = 0.8;
/** How near a wall (the vault, a ledge, a lift's glass) the middle of someone can come. */
const BODY = 0.25;
/** How far into a lift's doorway someone can stand before they're in it (and out of it before they're out: see inLift). */
const LIFT_IN = 0.45;
/** Half the width of a carriage's doorway, along it. */
const CARRIAGE_DOOR_HALF = 0.6;
/** How far off a doorway someone standing calls a lift to it. */
const LIFT_CALL_REACH = 3;

// ---- raised walkways
/**
 * The nearest raised walkway surface to a point that's within a step of a height: how high it is there, how far past
 * its walkable edge the point is (negative: on it), and the nearest point on it.
 * @param {number} x
 * @param {number} z
 * @param {number} y - the height they're at
 * @returns {?{y: number, over: number, x: number, z: number}} the surface, or null if none is within a step
 */
function raisedSurfaceAt(x, z, y) {
  let best = null;
  peopleNav?.lines.forEach(nav => {
    if (!nav.raised) return;
    const last = nav.pts.length - 2;
    for (let i=0;i<=last;i++) {
      const a = nav.pts[i], b = nav.pts[i+1], abx = b.x - a.x, abz = b.z - a.z, l2 = abx*abx + abz*abz;
      const raw = l2 > 0 ? ((x - a.x)*abx + (z - a.z)*abz)/l2 : 0, t = Math.max(0, Math.min(1, raw));
      const qy = nav.ys ? nav.ys[i] + (nav.ys[i+1] - nav.ys[i])*t : nav.y;
      if (Math.abs(qy - y) > RAISED_STEP) continue;
      const qx = a.x + abx*t, qz = a.z + abz*t;
      let over, cx = x, cz = z;
      if ((i === 0 && nav.cutStart && raw < 0) || (i === last && nav.cutEnd && raw > 1)) {
        // past a deck's end, where it's cut square for its ramp: not round it, as a line's end elsewhere is (a junction's)
        const l = Math.sqrt(l2), ux = abx/l, uz = abz/l, past = Math.abs(raw - t)*l;
        const side = -(x - qx)*uz + (z - qz)*ux, off = Math.max(-nav.walk, Math.min(nav.walk, side));
        over = Math.max(Math.abs(side) - nav.walk, past);
        cx = qx - uz*off; cz = qz + ux*off;
      } else {
        const d = Math.hypot(x - qx, z - qz);
        over = d - nav.walk;
        if (over > 0) { cx = qx + (x - qx)/d*nav.walk; cz = qz + (z - qz)/d*nav.walk; }
      }
      if (!best || over < best.over) best = { y: qy, over, x: over > 0 ? cx : x, z: over > 0 ? cz : z };
    }
  });
  return best;
}
/**
 * The raised walkway point nearest a point, within a step of a height (for letting go of someone up there).
 * @param {number} x
 * @param {number} z
 * @param {number} y - the height they're at
 * @returns {?{li: number, vi: number}} the point, or null if there's none
 */
export function nearestRaisedVertex(x, z, y) {
  let best = null;
  peopleNav?.lines.forEach((nav, li) => nav.raised && nav.pts.forEach((q, vi) => {
    if (Math.abs((nav.ys ? nav.ys[vi] : nav.y) - y) > RAISED_STEP*2) return;
    const d = Math.hypot(q.x - x, q.z - z);
    if (!best || d < best.d) best = { li, vi, d };
  }));
  return best;
}
// Up on one: at its height there, held at the ledge — or, walking off a ramp's foot, back on the ground.
function onRaised(p, f, x, z) {
  const s = raisedSurfaceAt(x, z, f.y), atFoot = f.y <= Y_PATH + RAISED_STEP*0.5;
  if (!s || (s.over > 0 && atFoot)) { p.footing = null; return null; }
  f.y = s.y;
  return { x: s.x, y: s.y, z: s.z }; // (held at the ledge, if they'd walk past it)
}

// ---- stations, in their own coordinates: `a` across the track (+ to its right, as st.spot has it), `b` along it
const localOf = (st, x, z) => { const dx = x - st.x, dz = z - st.z; return { a: dx*st.right.x + dz*st.right.z, b: dx*st.forward.x + dz*st.forward.z }; };
const worldOf = (st, a, b) => ({ x: st.x + st.right.x*a + st.forward.x*b, z: st.z + st.right.z*a + st.forward.z*b });
const deckYOf = st => st.spot(0, 0).y;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** A carriage stopped at a station with its doors open, if there is one. */
const openCarriageAt = st => getTrainShuttles().find(s => s.stopNode === st.nodeId && st.lineIds.includes(s.lineId) && s.doors >= 2);
/**
 * The spots just inside a carriage's door on a side of the station (as carriageDoor in peopleActivities.js has them):
 * in the station's coordinates, and in the world.
 */
function carriageDoorOn(shuttle, st, side) {
  const spots = [carriageSpot(shuttle, 1, 0), carriageSpot(shuttle, -1, 0)].map(q => ({ ...localOf(st, q.x, q.z), q }));
  const door = spots.find(d => Math.sign(d.a) === side);
  return door && { a: Math.abs(door.a), b: door.b, inside: door.q };
}
/**
 * Where on a station someone can stand, as boxes in its coordinates — `s` which side of the track, `a0`..`a1` how far
 * out from it on that side, `b0`..`b1` along it: each platform, each doorway and landing, the landing carried on into
 * its lift's doorway while the cab's there, and the gap across to a stopped carriage's open door.
 */
function stationRegions(st) {
  const out = [], H = st.halfW, edge = st.radius + 0.3, shuttle = openCarriageAt(st);
  [1, -1].forEach(s => {
    out.push({ s, a0: edge, a1: H - 0.5, b0: -st.straightHalf, b1: st.straightHalf });
    if (st.doorHalf > BODY) {
      out.push({ s, a0: H - 0.6, a1: H + 0.2, b0: -(st.doorHalf - BODY), b1: st.doorHalf - BODY });
      const lift = st.lifts.find(l => l.side === s), face = lift && lift.across - lift.depth;
      const a1 = !lift ? st.reach - BODY : lift.openAt('top') ? face + LIFT_IN : face - BODY;
      out.push({ s, a0: H, a1, b0: -(st.landingHalf - BODY), b1: st.landingHalf - BODY });
    }
    const door = shuttle && carriageDoorOn(shuttle, st, s);
    if (door) out.push({ s, a0: door.a, a1: edge + 0.05, b0: door.b - CARRIAGE_DOOR_HALF, b1: door.b + CARRIAGE_DOOR_HALF, gap: { shuttle, door } });
  });
  return out;
}
const regionHas = (r, a, b) => { const o = r.s*a; return o >= r.a0 && o <= r.a1 && b >= r.b0 && b <= r.b1; };
const regionClamp = (r, a, b) => ({ a: r.s*clamp(r.s*a, r.a0, r.a1), b: clamp(b, r.b0, r.b1) });
// A lift's cab, in its own terms: `out` from the middle of its shaft (away from the station), and `b` along the track.
const cabOf = (lift, a, b) => ({ out: lift.side*a - lift.across, b });
const inShaft = (lift, c, pad) => Math.abs(c.out) <= lift.depth - pad && Math.abs(c.b) <= lift.width - pad;

function onStation(p, f, x, z) {
  const st = getTrainStations().get(f.node);
  if (!st) { p.footing = null; return null; }
  const { a, b } = localOf(st, x, z), deckY = deckYOf(st);
  // its doors open for anyone near them
  [1, -1].forEach(s => { const d = st.spot(s*st.halfW, 0); if (Math.hypot(d.x - x, d.z - z) < 2.6) st.openDoor(s); });
  // a lift: called up to anyone on the landing by its doorway, and stepped into once it's there
  for (const lift of st.lifts) {
    const c = cabOf(lift, a, b);
    if (Math.abs(c.b) > lift.width + 0.5 || c.out < -lift.depth - LIFT_CALL_REACH) continue;
    if (!lift.openAt('top')) { if (c.out < -lift.depth) lift.call('top'); continue; }
    if (c.out > -lift.depth + LIFT_IN && Math.abs(c.b) <= lift.width - BODY) { p.footing = { kind: 'lift', node: st.nodeId, side: lift.side }; lift.call('bottom'); return inLift(p, p.footing, x, z); }
  }
  const regions = stationRegions(st);
  // across the gap into a stopped carriage
  const gap = regions.find(r => r.gap && r.s*a < r.a0 && r.s*a > r.a0 - 0.6 && b >= r.b0 && b <= r.b1);
  if (gap) {
    const { shuttle } = gap.gap;
    p.footing = { kind: 'carriage', lineId: shuttle.lineId, u: 0, v: 0, yaw: carriageSpot(shuttle, 0, 0).yaw };
    return inCarriage(p, p.footing, x, z);
  }
  let here = regions.find(r => regionHas(r, a, b));
  if (!here) {
    // off the end of a landing that's down on the ground (with no lift, it is), onto the ground
    if (!st.lifts.length && st.doorHalf > BODY && Math.abs(a) > st.reach - BODY && Math.abs(b) <= st.landingHalf) { p.footing = null; return null; }
    // otherwise held at the wall (or the edge of the platform): at the nearest spot that's in
    let best = null;
    regions.forEach(r => { const q = regionClamp(r, a, b), d = Math.hypot(q.a - a, q.b - b); if (!best || d < best.d) best = { ...q, d, r }; });
    here = best.r;
    ({ x, z } = worldOf(st, best.a, best.b));
  }
  if (here.gap) {
    holdTrain(here.gap.shuttle.lineId); // (the carriage doesn't shut its doors on them)
    return { x, y: st.floorAt(x, z, here.gap.door.inside), z };
  }
  // on the platform, a carriage stopped here waits for them (up to TRAIN_HOLD_MAX), as it does for anyone on their way
  // in to catch it
  if (here.a0 < st.halfW - 1) {
    const stopped = getTrainShuttles().find(s => s.stopNode === st.nodeId && st.lineIds.includes(s.lineId));
    if (stopped) holdTrain(stopped.lineId);
  }
  return { x, y: deckY, z };
}

function inLift(p, f, x, z) {
  const st = getTrainStations().get(f.node), lift = st?.lifts.find(l => l.side === f.side);
  if (!lift) { p.footing = null; return null; }
  const local = localOf(st, x, z), c = cabOf(lift, local.a, local.b);
  // out of its doorway at whichever end it's standing at
  if (lift.openAt('top') && c.out < -lift.depth + BODY) { p.footing = { kind: 'station', node: st.nodeId }; return onStation(p, p.footing, x, z); }
  if (lift.openAt('bottom') && c.out > lift.depth - BODY) { p.footing = null; return null; }
  // otherwise kept in the cab (moving about in it, it waits for them a moment)
  const out = clamp(c.out, -lift.depth + BODY, lift.depth - BODY), along = clamp(c.b, -lift.width + BODY, lift.width - BODY);
  if (lift.level && Math.hypot(x - p.x, z - p.z) > 1e-3) lift.wait();
  const at = worldOf(st, lift.side*(lift.across + out), along);
  return { x: at.x, y: lift.y, z: at.z };
}

// ---- carriages
/** Where a point is in a carriage's standing room: (u, v) as carriageSpot takes them, and how long its axes are. */
function carriageLocal(shuttle, x, z) {
  const o = carriageSpot(shuttle, 0, 0), ua = carriageSpot(shuttle, 1, 0), va = carriageSpot(shuttle, 0, 1);
  const ux = ua.x - o.x, uz = ua.z - o.z, vx = va.x - o.x, vz = va.z - o.z;
  const uLen = Math.hypot(ux, uz) || 1, vLen = Math.hypot(vx, vz) || 1;
  return { u: ((x - o.x)*ux + (z - o.z)*uz)/(uLen*uLen), v: ((x - o.x)*vx + (z - o.z)*vz)/(vLen*vLen), uLen, vLen };
}
function inCarriage(p, f, x, z) {
  const shuttle = getTrainShuttles().find(s => s.lineId === f.lineId);
  if (!shuttle) { p.footing = null; return null; }
  const { u, v, vLen } = carriageLocal(shuttle, x, z);
  // out through its door, stopped at a station with them open, onto the platform
  const stop = shuttle.doors >= 2 && shuttle.stopNode != null && getTrainStations().get(shuttle.stopNode);
  if (stop && Math.abs(v)*vLen <= CARRIAGE_DOOR_HALF) {
    holdTrain(shuttle.lineId);
    if (Math.abs(u) > 1) { p.footing = { kind: 'station', node: stop.nodeId }; return onStation(p, p.footing, x, z); }
  }
  f.u = clamp(u, -1, 1); f.v = clamp(v, -1, 1);
  const at = carriageSpot(shuttle, f.u, f.v);
  return { x: at.x, y: at.y, z: at.z };
}

// ---- from the ground
function fromGround(p, x, z) {
  let pushed = false;
  // onto a ramp's foot
  const s = raisedSurfaceAt(x, z, Y_PATH);
  if (s && s.over <= 0) { p.footing = { kind: 'raised', y: s.y }; return { x, y: s.y, z }; }
  for (const st of getTrainStations().values()) {
    const { a, b } = localOf(st, x, z);
    if (Math.abs(a) > st.reach + 2*LIFT_CALL_REACH + 3 || Math.abs(b) > st.straightHalf + st.halfW + 3) continue;
    // a lift: called down to anyone by its doorway, stepped into from there once it's down — a wall otherwise
    for (const lift of st.lifts) {
      const c = cabOf(lift, a, b);
      if (Math.abs(c.b) > lift.width + 0.5 || c.out > lift.depth + LIFT_CALL_REACH || c.out < -lift.depth - 0.5) continue;
      if (!lift.openAt('bottom') && c.out > lift.depth) lift.call('bottom');
      if (!inShaft(lift, c, -BODY)) continue;
      const was = localOf(st, p.x, p.z), from = cabOf(lift, was.a, was.b);
      const doorway = lift.openAt('bottom') && Math.abs(c.b) <= lift.width - BODY && from.out >= lift.depth - LIFT_IN - 0.2;
      if (doorway && c.out >= lift.depth - LIFT_IN) return null; // (stood in its doorway)
      if (doorway) { p.footing = { kind: 'lift', node: st.nodeId, side: lift.side }; lift.call('top'); return inLift(p, p.footing, x, z); }
      // pushed back out of the shaft, by whichever face is nearest
      const faces = [
        { out: lift.depth + BODY, b: c.b, d: lift.depth + BODY - c.out },
        { out: -lift.depth - BODY, b: c.b, d: c.out + lift.depth + BODY },
        { out: c.out, b: lift.width + BODY, d: lift.width + BODY - c.b },
        { out: c.out, b: -lift.width - BODY, d: c.b + lift.width + BODY },
      ].sort((m, n) => m.d - n.d)[0];
      ({ x, z } = worldOf(st, lift.side*(lift.across + faces.out), faces.b));
      pushed = true;
    }
    // up onto a landing that's down on the ground (a station with no lifts sits down on it: see snapStationHeight)
    if (!st.lifts.length && Math.abs(deckYOf(st) - Y_SIDEWALK) < 1.5) {
      const r = stationRegions(st).find(r => !r.gap && r.a0 === st.halfW && regionHas(r, a, b));
      if (r) { p.footing = { kind: 'station', node: st.nodeId }; return onStation(p, p.footing, x, z); }
    }
  }
  return pushed ? { x, z, ground: true } : null;
}

/**
 * Carry someone possessed along with whatever they're standing in, before they're walked this frame: a carriage (turning
 * the way they look with it) or a lift cab.
 * @param {Person} p - the person
 * @returns {void}
 */
export function carryPossessed(p) {
  const f = p.footing;
  if (f?.kind === 'carriage') {
    const shuttle = getTrainShuttles().find(s => s.lineId === f.lineId);
    if (!shuttle) return;
    const at = carriageSpot(shuttle, f.u, f.v);
    possession.yaw += wrapAngle(at.yaw - f.yaw);
    f.yaw = at.yaw;
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else if (f?.kind === 'lift') {
    const lift = getTrainStations().get(f.node)?.lifts.find(l => l.side === f.side);
    if (lift) p.y = lift.y;
  }
}

/**
 * Where someone possessed ends up, walked to (x, z) this frame, if they're up on something or getting up onto it — or
 * null if they're on the ground there (see p.footing, above), or, on the ground but walked into a lift's shaft, where
 * it holds them (`ground` set, and no y: that's the ground's).
 * @param {Person} p - the person
 * @param {number} x
 * @param {number} z
 * @returns {?{x: number, y?: number, z: number, ground?: boolean}} where they are
 */
export function stepFooting(p, x, z) {
  const f = p.footing;
  if (f?.kind === 'raised') return onRaised(p, f, x, z);
  if (f?.kind === 'station') return onStation(p, f, x, z);
  if (f?.kind === 'lift') return inLift(p, f, x, z);
  if (f?.kind === 'carriage') return inCarriage(p, f, x, z);
  return fromGround(p, x, z);
}

/**
 * What someone's standing on, at (x, y, z) — for someone just possessed, wherever they'd got to on their own.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {?object} their footing (see above), or null on the ground
 */
export function footingAt(x, y, z) {
  for (const shuttle of getTrainShuttles()) {
    const { u, v } = carriageLocal(shuttle, x, z), at = carriageSpot(shuttle, 0, 0);
    if (Math.abs(u) <= 1.1 && Math.abs(v) <= 1.1 && Math.abs(at.y - y) < 1) return { kind: 'carriage', lineId: shuttle.lineId, u: clamp(u, -1, 1), v: clamp(v, -1, 1), yaw: at.yaw };
  }
  for (const st of getTrainStations().values()) {
    const { a, b } = localOf(st, x, z);
    const lift = st.lifts.find(l => inShaft(l, cabOf(l, a, b), 0) && Math.abs(l.y - y) < 1);
    if (lift) return { kind: 'lift', node: st.nodeId, side: lift.side };
    if (Math.abs(deckYOf(st) - y) < 1 && Math.abs(a) <= st.reach + 0.5 && Math.abs(b) <= st.straightHalf + st.halfW) return { kind: 'station', node: st.nodeId };
  }
  const s = raisedSurfaceAt(x, z, y);
  if (s && s.over <= 0.5 && s.y > Y_PATH + 0.2) return { kind: 'raised', y: s.y };
  return null;
}
