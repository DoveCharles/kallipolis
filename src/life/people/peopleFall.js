import { S, App, buildingHolders } from '../../core/shared.js';
import { pointInPolygon } from '../../core/math.js';
import { footprintBounds, wallsOf } from '../../buildings/footprints.js';
import { groundBelow } from '../../core/ground-probe.js';
import { damage } from '../../core/health.js';
import { fenceCrossed } from '../../zones/fences.js';
import { fallSpill } from './peopleBlood.js';
import { offRaisedEdge } from './peopleFooting.js';
import { peopleNav } from './people.js';

// ============================================================ falling
// Knocked flat and sliding, someone goes up and over any fence in their way (a hop, landing where they took off), and
// off the edge of a raised walkway or a mall's gallery, past its balustrade, they fall to whatever's below; so does
// someone possessed who jumps over one. p.fall = { y, vy, top, ground } (ground: fixed for a hop, else looked for below).
// Landing more than FALL_SAFE below the top of the fall hurts, FALL_DAMAGE a metre past that, always drawing blood.
const GRAVITY = 14, FENCE_HOP = 4.5, FENCE_LOOK = 0.15, FALL_SAFE = 1.5, FALL_DAMAGE = 12, KNOCK_DROP = 3;

/** Start someone falling from where they are, going up at `vy` (per people size 1). */
export function startFall(p, vy = 0, ground = null) {
  p.fall = { y: p.y, vy: vy*S.peopleSize, top: p.y, ground };
}
/**
 * Someone knocked flat has just slid from (x0, z0): off a raised edge they fall; up to a fence, they hop it.
 * @param {Person} p
 * @param {number} x0
 * @param {number} z0
 */
export function slideOff(p, x0, z0) {
  if (p.fall) return;
  const up = p.footing?.kind === 'raised' || (p.mode === 'line' && peopleNav?.lines[p.li]?.raised);
  if (up && offRaisedEdge(p.x, p.z, p.y)) {
    if (p.mode === 'possessed') p.footing = null;
    else p.fellOff = true; // (back on a walkway down there once they're up: see updatePeople)
    startFall(p);
    return;
  }
  // (a moment ahead, so they're going up as they reach it)
  if (p.push && fenceCrossed(x0, z0, p.x + p.push.x*FENCE_LOOK, p.z + p.push.z*FENCE_LOOK, p.y + 0.1)) startFall(p, FENCE_HOP, p.y);
}
const LYING_REACH = 1.4; // (how far behind their feet someone knocked flat lies, head and all, at people size and height 1)
/**
 * Whether someone about to fall flat on their back would go through something behind them: a fence, a building's wall,
 * or a raised walkway's balustrade. If so they're turned round to fall the other way (see knockDown in peopleActivities.js).
 * @param {Person} p
 * @returns {boolean}
 */
export function blockedBehind(p) {
  const reach = LYING_REACH*p.height*S.peopleSize, hx = p.x - Math.sin(p.heading)*reach, hz = p.z - Math.cos(p.heading)*reach;
  if (fenceCrossed(p.x, p.z, hx, hz, p.y + 0.1)) return true;
  const up = p.footing?.kind === 'raised' || (p.mode === 'line' && peopleNav?.lines[p.li]?.raised);
  if (up && offRaisedEdge(hx, hz, p.y)) return true;
  const head = { x: hx, z: hz };
  for (const zone of buildingHolders()) for (const group of zone.buildingsGroup.children) {
    const walls = wallsOf(group);
    if (!walls.length) continue;
    const { c, r } = footprintBounds(group);
    if (Math.hypot(hx - c.x, hz - c.z) <= r && walls.some(w => pointInPolygon(head, w.poly))) return true;
  }
  return false;
}
/**
 * Move someone falling on by dt, and land them.
 * @param {Person} p
 * @param {number} dt
 */
export function stepFall(p, dt) {
  const f = p.fall;
  f.vy -= GRAVITY*S.peopleSize*dt;
  f.y += f.vy*dt;
  f.top = Math.max(f.top, f.y);
  const ground = f.ground ?? groundBelow(p.x, f.y + 0.05, p.z, 0);
  p.y = Math.max(f.y, ground);
  if (f.y > ground) return;
  p.fall = null;
  const drop = (f.top - ground)/S.peopleSize;
  if (drop <= FALL_SAFE) return;
  fallSpill(p);
  if (drop > KNOCK_DROP && (!p.punched || p.punched.stage === 'marked')) App.knockOverPerson?.(p, { x: p.x - Math.sin(p.heading), z: p.z - Math.cos(p.heading) });
  damage(p, (drop - FALL_SAFE)*FALL_DAMAGE, { cause: 'fell' });
}
