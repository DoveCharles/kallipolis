import { S } from '../../core/shared.js';
import { signalState } from '../../roads/markings.js';
import { carLength } from './placing.js';

// ---- junction queues: every signalled junction (S.roadJunctions) lets cars over its stop lines in the order they
// reached them (j.waiting, by car.gate.at), among those whose light lets them go — so no arm floods the junction and the
// flow stays even. A car is let in (admitted) only while nothing inside the junction (j.inside) crosses its path: cars
// from its own arm follow it; cars from the opposite arm share it only while both go straight on. A car held for its
// exit being full (waitToTurn) doesn't hold up the queue. It's inside until it's past the junction's edge by half its
// length, or INSIDE_MAX seconds, in case it never gets there.
const ARRIVED = 2, INSIDE_MAX = 12, AMBER_GO = 3; // (units at size 1 short of the line a car counts as queued; seconds; units short of the line it still goes on amber)
const STRAIGHT = Math.cos(Math.PI/5), OPPOSITE = -0.7; // (how nearly in line its way out must be with its way in; arms counted as facing)
const STALE = 1; // (seconds a queued car can go uncalled — it's off its route, say — before it's dropped)

/**
 * Whether a car's planned way through a junction goes straight on: its way out within 36° of its way in.
 * @param {object} car
 * @param {object} arm - the arm it comes in on
 * @returns {boolean}
 */
function straightOn(car, arm) {
  const p = car.plan;
  if (!p) return false;
  if (!p.link) return true;
  const nav = S.trafficNav.lines[p.link.li], v = p.link.vi, w = Math.max(0, Math.min(nav.pts.length - 1, v + p.dir));
  const ex = nav.pts[w].x - nav.pts[v].x, ez = nav.pts[w].z - nav.pts[v].z;
  return -(arm.x*ex + arm.z*ez)/(Math.hypot(ex, ez) || 1) > STRAIGHT;
}
/** Whether admitting `car` would cross `other`, already inside. */
function crosses(car, other) {
  const a = car.gate, b = other.gate;
  if (a.arm === b.arm) return false;
  return !(a.arm.x*b.arm.x + a.arm.z*b.arm.z < OPPOSITE && straightOn(car, a.arm) && straightOn(other, b.arm));
}
/** Whether a queued car's light lets it go: green, or amber too close to the line to stop. */
function mayGo(car, j, t) {
  const state = signalState(j, car.gate.arm.phase, t);
  return state === 2 || (state === 1 && car.gate.lineGap <= AMBER_GO*S.peopleSize);
}
function admit(car, j, t) {
  const g = car.gate;
  g.admitted = true; g.admittedAt = t;
  const at = j.waiting.indexOf(car);
  if (at >= 0) j.waiting.splice(at, 1);
  j.inside.push(car);
}

/**
 * Tidy every junction's queue and who's inside, once a frame before the cars move.
 * @param {number} t
 * @returns {void}
 */
export function updateJunctionGates(t) {
  S.roadJunctions.forEach(j => {
    if (!j.waiting) return;
    j.waiting = j.waiting.filter(car => car.gate?.j === j && !car.gate.admitted && car.li >= 0 && !car.kick && t - car.gate.seen < STALE);
    j.inside = j.inside.filter(car => {
      const g = car.gate;
      if (!g || g.j !== j || car.li < 0) return false;
      const d = Math.hypot(car.x - j.x, car.z - j.z);
      if (d < j.r) g.entered = true;
      if ((g.entered && d > j.r + carLength(car)*0.5) || t - g.admittedAt > INSIDE_MAX) { car.gate = null; return false; }
      return true;
    });
  });
}

/**
 * Whether a car coming up to junction `j` on `arm` must hold at its stop line (see the queue above).
 * @param {object} car
 * @param {object} j
 * @param {object} arm - the arm it's coming in on
 * @param {number} lineGap - how far its front bumper is short of the stop line (negative: over it)
 * @param {number} t
 * @param {boolean} held - held at the line anyway this frame (its exit is full: waitToTurn), so it doesn't hold up others
 * @returns {boolean}
 */
export function junctionGate(car, j, arm, lineGap, t, held) {
  let g = car.gate;
  if (!g || g.j !== j) g = car.gate = { j, arm, at: null, admitted: false, entered: false, admittedAt: 0, seen: t };
  g.seen = t; g.arm = arm; g.held = held; g.lineGap = lineGap;
  if (g.admitted) return false;
  j.waiting ??= []; j.inside ??= [];
  if (lineGap < -0.5) { admit(car, j, t); return false; } // (already over the line)
  if (lineGap > ARRIVED*S.peopleSize) return true; // (not there yet: it drives up to the line)
  if (g.at == null) { g.at = t; j.waiting.push(car); }
  if (held) return true;
  if (!mayGo(car, j, t)) return true;
  if (j.waiting.some(o => o !== car && o.gate.at < g.at && !o.gate.held && mayGo(o, j, t))) return true; // (someone there first)
  if (j.inside.some(o => crosses(car, o))) return true;
  admit(car, j, t);
  return false;
}
