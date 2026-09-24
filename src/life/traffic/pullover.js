import { S } from '../../core/shared.js';
import { cars } from './state.js';

// Cars give way to anything that smells (the smells trait — an ambulance, say): any car ahead of one on the move, near
// enough and in its path (either way along the road), slows to a stop pulling over to its kerb, turned PULL_ANGLE towards
// it, mostly onto the pavement — clearing the middle of the road — until it's gone past, then pulls back out. `car.pull`
// eases 0 (in lane) to 1 (pulled over); offroute.js draws it off the route, and the smelly car ignores cars pulled over
// (gapAhead in spacing.js, and the lane queue in traffic.js).
const PULL_REACH = 30, PULL_CORRIDOR = 6, PULL_RATE = 1.2, PULL_HOLD = 1; // (units ahead it's noticed from, and either side of its path, at people size 1; share a second; seconds kept pulled over after it's passed)
const PULL_ANGLE = Math.PI/6, PULL_OVER = 1.8; // (how far it's turned in; how far over it goes, in lane offsets — 1 puts its middle on the kerb)

/** The cars everyone gives way to this frame: smelly and moving. */
export const smellyCars = () => cars.filter(car => car.traits?.smells && car.li >= 0 && Math.abs(car.speed) > 1);

/**
 * Ease a car towards pulled over while a smelly car's coming, and back out once it's gone.
 * @param {object} car - an AI car, not smelly itself
 * @param {object[]} smelly - from smellyCars
 * @param {number} dt
 * @returns {void}
 */
export function updatePull(car, smelly, dt) {
  const reach = PULL_REACH*S.peopleSize, corridor = PULL_CORRIDOR*S.peopleSize;
  const coming = smelly.some(s => {
    if (s === car) return false;
    const dx = car.x - s.x, dz = car.z - s.z, dir = Math.sign(s.speed), fx = Math.sin(s.heading)*dir, fz = Math.cos(s.heading)*dir;
    const ahead = dx*fx + dz*fz, across = Math.abs(dx*fz - dz*fx);
    return ahead > 0 && ahead < reach && across < corridor;
  });
  car.pullHold = coming ? PULL_HOLD : Math.max(0, (car.pullHold ?? 0) - dt);
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
