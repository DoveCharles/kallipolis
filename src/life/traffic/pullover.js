import { S } from '../../core/shared.js';
import { drivenCar } from './driving.js';
import { placeKey } from '../../roads/markings.js';
import { carLength } from './placing.js';

// Cars give way to the car the player is driving, when it smells (the smells trait — an ambulance, say): any car ahead of one on the move, near
// enough and in its path (either way along the road), slows to a stop pulling over to its kerb, turned PULL_ANGLE towards
// it, mostly onto the pavement — clearing the middle of the road — until it's gone past, then pulls back out. `car.pull`
// eases 0 (in lane) to 1 (pulled over); offroute.js draws it off the route, and the smelly car ignores cars pulled over
// (gapAhead in spacing.js, and the lane queue in traffic.js).
const PULL_REACH = 30, PULL_CORRIDOR = 6, PULL_RATE = 1.2, PULL_HOLD = 1; // (units ahead it's noticed from, and either side of its path, at people size 1; share a second; seconds kept pulled over after it's passed)
const PULL_ANGLE = Math.PI/6, PULL_OVER = 1.8; // (how far it's turned in; how far over it goes, in lane offsets — 1 puts its middle on the kerb)

// No pulling over in or close to a junction (S.roadJunctions, roads/markings.js), where it would block it — nor heading
// into one closer than it could pull over and stop short of (its speed × PULL_STOP_TIME past JUNCTION_CLEAR): it keeps
// going through instead, dropping any pull it had.
const JUNCTION_CLEAR = 6, PULL_STOP_TIME = 1.5; // (units beyond a junction's edge, at people size 1; seconds it takes to pull over and stop)
const nearJunction = car => S.roadJunctions.some(j => Math.hypot(car.x - j.x, car.z - j.z) < j.r + JUNCTION_CLEAR*S.peopleSize);
function junctionTooClose(car, ahead) {
  const j = ahead && !ahead.deadEnd && S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
  return !!j && ahead.dist < j.r + JUNCTION_CLEAR*S.peopleSize + carLength(car)/2 + Math.abs(car.speed)*PULL_STOP_TIME;
}

/** The cars everyone gives way to this frame: only the one the player's driving, if it smells (moving, to start a pull; any, to stay pulled — see updatePull). */
export const smellyCars = () => drivenCar?.traits?.smells ? [drivenCar] : [];
// Hysteresis, so a car doesn't pull over and back out over and over: once pulling it stays until the smelly car is past
// it by its own length, or further than RELEASE times the reach or corridor it started pulling at; a smelly car that's
// slowed or stopped still counts; and a junction only stops a pull starting, not one under way. Positions are taken off
// their drawn offsets (car.sway) — the pull itself moves a car sideways, out of the corridor it's measured by.
const RELEASE = 1.5, START_SPEED = 1;
// A car that's stood still STILL_LIMIT seconds (held up by a smelly car that can't get by, say) ignores smelly cars for
// IGNORE_FOR seconds, pulling back out and carrying on — but never while it's alongside one (besideSmelly), where
// pulling back out would drive it into it: it stays pulled over till that one has gone by.
const STILL_LIMIT = 25, IGNORE_FOR = 10, STILL_SPEED = 0.3, BESIDE_GAP = 1; // (seconds; seconds; units a second; units at size 1 past either end still counted as alongside)
/** Whether a car is alongside one of the smelly cars: overlapping it lengthways, within the release corridor either side. */
function besideSmelly(car, smelly, cx, cz) {
  const corridor = PULL_CORRIDOR*S.peopleSize*RELEASE;
  return smelly.some(s => {
    if (s === car) return false;
    const sh = s.heading - (s.sway?.turn ?? 0), dx = cx - (s.x - (s.sway?.x ?? 0)), dz = cz - (s.z - (s.sway?.z ?? 0));
    const along = dx*Math.sin(sh) + dz*Math.cos(sh), across = Math.abs(dx*Math.cos(sh) - dz*Math.sin(sh));
    return Math.abs(along) < (carLength(car) + carLength(s))/2 + BESIDE_GAP*S.peopleSize && across < corridor;
  });
} // (times the reach and corridor; units a second a smelly car must be doing to start a pull)

/**
 * Ease a car towards pulled over while a smelly car's coming, and back out once it's gone.
 * @param {object} car - an AI car, not smelly itself
 * @param {object[]} smelly - from smellyCars
 * @param {number} dt
 * @param {?object} ahead - the junction ahead (junctionAhead in lanes.js)
 * @returns {void}
 */
export function updatePull(car, smelly, dt, ahead) {
  const pulling = (car.pull ?? 0) > 0 || (car.pullHold ?? 0) > 0, grow = pulling ? RELEASE : 1;
  const cx = car.x - (car.sway?.x ?? 0), cz = car.z - (car.sway?.z ?? 0);
  const beside = pulling && besideSmelly(car, smelly, cx, cz);
  car.stillFor = Math.abs(car.speed) < STILL_SPEED ? (car.stillFor ?? 0) + dt : 0;
  if (car.stillFor > STILL_LIMIT && !beside) { car.stillFor = 0; car.ignoreSmells = IGNORE_FOR; }
  if (beside) { car.ignoreSmells = 0; car.stillFor = 0; }
  if ((car.ignoreSmells = Math.max(0, (car.ignoreSmells ?? 0) - dt)) > 0) smelly = [];
  const reach = PULL_REACH*S.peopleSize*grow, corridor = PULL_CORRIDOR*S.peopleSize*grow;
  const coming = beside || smelly.some(s => {
    if (s === car || (!pulling && Math.abs(s.speed) < START_SPEED)) return false;
    const sx = s.x - (s.sway?.x ?? 0), sz = s.z - (s.sway?.z ?? 0), sh = s.heading - (s.sway?.turn ?? 0);
    const dx = cx - sx, dz = cz - sz, dir = s.speed < -0.1 ? -1 : 1, fx = Math.sin(sh)*dir, fz = Math.cos(sh)*dir;
    const ahead = dx*fx + dz*fz, across = Math.abs(dx*fz - dz*fx);
    return ahead > (pulling ? -carLength(car) : 0) && ahead < reach && across < corridor;
  });
  const blocked = (car.pull ?? 0) < 0.3 && (junctionTooClose(car, ahead) || nearJunction(car));
  car.pullHold = blocked ? 0 : coming ? PULL_HOLD : Math.max(0, (car.pullHold ?? 0) - dt);
  const target = car.pullHold > 0 ? 1 : 0;
  car.pull = (car.pull ?? 0) + Math.max(-PULL_RATE*dt, Math.min(PULL_RATE*dt, target - (car.pull ?? 0)));
}

/**
 * How far a car is pulled over, as offroute.js takes it.
 * @param {object} car
 * @returns {?{off: number, turn: number}} right of its route (negative: left, to the kerb) and turned right; null if not pulled over
 */
export function pullOf(car) {
  if (!car.pull) return null;
  const lane = S.trafficNav.lines[car.li]?.lane ?? 1, ease = car.pull*car.pull*(3 - 2*car.pull);
  return { off: -ease*lane*PULL_OVER, turn: -ease*PULL_ANGLE };
}
