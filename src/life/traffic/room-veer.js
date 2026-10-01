import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { camera, Y_ROAD } from '../../core/scene.js';
import { roomClash } from '../../buildings/interior.js';
import { carLength, carWidth } from './placing.js';

// While the view's in a room reaching into the street (roomClash in buildings/interior.js), AI cars heading into its box
// veer round it: a sideways offset put on and taken off with the rest in offroute.js, so the route's untouched. One whose
// body, veered as far as MAX_VEER car widths, would still go through a windowed wall holds its line and smashes in
// (life/room-crash.js) — a plot too close to the road always pays for it; through a blank wall it just goes hidden.
const LOOK = 14, MARGIN = 0.3, VEER_SPEED = 2.5; // (at people size 1; VEER_SPEED sideways a second at most)
// the veer's a damped spring (VEER_SPRING a second), its sideways speed kept under VEER_SLIP of the car's: the car turns
// into it and out of it smoothly, and a car standing still doesn't slide sideways
const VEER_SPRING = 1.6, VEER_SLIP = 0.3;
// the turn drawn eases toward the one its sideways speed gives (YAW_EASE a second, no faster than YAW_RATE radians a
// second), so nothing turns it in a frame; blocked by a car beside it, the veer's held VEER_HOLD seconds, not re-tried each frame
const YAW_EASE = 6, YAW_RATE = 1.2, VEER_HOLD = 0.5;
const MAX_VEER = 1.1;

const local = (c, x, z) => ({ x: c.e[0]*x + c.e[8]*z + c.e[12], z: c.e[2]*x + c.e[10]*z + c.e[14] });
const localDir = (c, x, z) => ({ x: c.e[0]*x + c.e[8]*z, z: c.e[2]*x + c.e[10]*z });
// (the car's own frame in the room's terms: where it is, ahead and to its right)
function frame(c, car) {
  const s = Math.sin(car.heading), k = Math.cos(car.heading);
  return { p: local(c, car.x, car.z), f: localDir(c, s, k), r: localDir(c, k, -s) };
}
// Which windowed wall the car's body, `off` right of its route, would sweep through between its tail and `reach` ahead:
// only from the wall's outer side (a car behind the room hits a blank wall first).
function throughWindow(c, car, p, f, r, off, reach) {
  const half = carWidth(car)/2, s0 = -carLength(car)/2, t0 = off - half, t1 = off + half;
  const toCar = (x, z) => { const dx = x - p.x, dz = z - p.z; return [dx*f.x + dz*f.z, dx*r.x + dz*r.z]; };
  for (const w of c.windows) {
    if ((p[w.axis] - w.at)*w.sign < 0) continue;
    const [a, b] = w.axis === 'x' ? [toCar(w.at, c.z0), toCar(w.at, c.z1)] : [toCar(c.x0, w.at), toCar(c.x1, w.at)];
    // (the wall's segment against the swept rectangle: Liang–Barsky)
    let u0 = 0, u1 = 1, hit = true;
    const ds = b[0] - a[0], dt = b[1] - a[1];
    for (const [d, gap] of [[-ds, a[0] - s0], [ds, reach - a[0]], [-dt, a[1] - t0], [dt, t1 - a[1]]]) {
      if (d === 0) { if (gap < 0) { hit = false; break; } continue; }
      const u = gap/d;
      if (d < 0) u0 = Math.max(u0, u); else u1 = Math.min(u1, u);
      if (u0 > u1) { hit = false; break; }
    }
    if (hit) return w.side;
  }
  return null;
}
// How far right (negative: left) of its route the car should be to miss the room's box, and whether it can't in MAX_VEER.
function missBy(c, car, prefer = 0) { // (prefer: the side it's already veering to, kept while that clears it)
  const { p, f, r } = frame(c, car), size = S.peopleSize, back = -carLength(car)/2, ahead = LOOK*size;
  // the box's corners in the car's frame (s ahead, t right), cut to what's between its tail and LOOK ahead
  let poly = [[c.x0, c.z0], [c.x1, c.z0], [c.x1, c.z1], [c.x0, c.z1]].map(([x, z]) => {
    const dx = x - p.x, dz = z - p.z;
    return [dx*f.x + dz*f.z, dx*r.x + dz*r.z];
  });
  if (poly.every(([s]) => s < back) || poly.every(([s]) => s > ahead)) return null;
  for (const [edge, keep] of [[back, 1], [ahead, -1]]) {
    const out = [];
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length], ina = (a[0] - edge)*keep >= 0, inb = (b[0] - edge)*keep >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const u = (edge - a[0])/(b[0] - a[0]); out.push([edge, a[1] + (b[1] - a[1])*u]); }
    });
    poly = out;
    if (!poly.length) return null;
  }
  const t0 = Math.min(...poly.map(q => q[1])), t1 = Math.max(...poly.map(q => q[1])), half = carWidth(car)/2 + MARGIN*size;
  if (t1 < -half || t0 > half) return null;
  const left = t0 - half, right = t1 + half, most = carWidth(car)*MAX_VEER;
  const kept = prefer < 0 ? left : prefer > 0 ? right : null, off = kept != null && Math.abs(kept) <= most ? kept : -left < right ? left : right;
  const veer = Math.sign(off)*Math.min(Math.abs(off), most);
  return { off: veer, through: Math.abs(off) > most && throughWindow(c, car, p, f, r, veer, ahead) };
}

/**
 * This frame's veer round the room for an AI car on its route (car.veer eased toward it), or null for none.
 * @param {object} car
 * @param {number} dt
 * @returns {?{off: number, turn: number}}
 */
export function veerOf(car, dt) {
  const c = roomClash(), was = car.veer ?? 0;
  let goal = 0;
  if (c) {
    const miss = missBy(c, car, Math.sign(was));
    if (miss?.through && car.roomRoll?.clash !== c) car.roomRoll = { clash: c, crash: miss.through };
    if (miss && !(car.roomRoll?.clash === c && car.roomRoll.crash)) goal = miss.off; // (a crashing car holds its line)
  }
  if (car.veerHold > 0) { car.veerHold -= dt; if (c) goal = was; } // (blocked by a car beside it: see holdVeer)
  let vel = car.veerVel ?? 0;
  if (!was && !goal && !vel && !car.veerYaw) return null;
  const top = Math.min(VEER_SPEED*S.peopleSize, Math.abs(car.speed)*VEER_SLIP);
  vel += (VEER_SPRING*VEER_SPRING*(goal - was) - 2*VEER_SPRING*vel)*dt;
  vel = Math.max(-top, Math.min(top, vel));
  const v = was + vel*dt;
  car.veer = v; car.veerVel = vel;
  easeYaw(car, dt);
  if (!goal && Math.abs(v) < 1e-3 && Math.abs(vel) < 1e-3 && Math.abs(car.veerYaw) < 1e-3) { car.veer = car.veerVel = car.veerYaw = 0; return null; }
  return { off: v, turn: car.veerYaw, was };
}
// (the drawn turn, eased toward the way its sideways speed points)
function easeYaw(car, dt) {
  const goal = Math.atan2(car.veerVel ?? 0, Math.max(Math.abs(car.speed), 1)), yaw = car.veerYaw ?? 0;
  const step = Math.max(-YAW_RATE*dt, Math.min(YAW_RATE*dt, (goal - yaw)*Math.min(1, YAW_EASE*dt)));
  car.veerYaw = yaw + step;
}
/** A veer blocked by a car beside it (see offroute.js): back where it was, held VEER_HOLD seconds; its turn still eases. */
export function holdVeer(car, was) {
  car.veer = was; car.veerVel = 0; car.veerHold = VEER_HOLD;
  return car.veerYaw ?? 0;
}

// Whether any of the car, as drawn, overlaps the room's box (separating axes: the box's two and the car's two — so a long
// bus the room's corner pokes into the side of counts, though none of its own corners are in)
function anyCornerIn(car) {
  const c = roomClash();
  if (!c || Y_ROAD + 0.5 < c.y0 || Y_ROAD + 0.5 > c.y1) return false;
  const { p, f, r } = frame(c, car), l = carLength(car)/2, w = carWidth(car)/2;
  const pts = [[l, w], [l, -w], [-l, w], [-l, -w]].map(([a, b]) => ({ x: p.x + f.x*a + r.x*b, z: p.z + f.z*a + r.z*b }));
  if (pts.every(q => q.x < c.x0) || pts.every(q => q.x > c.x1) || pts.every(q => q.z < c.z0) || pts.every(q => q.z > c.z1)) return false;
  const box = [[c.x0, c.z0], [c.x1, c.z0], [c.x1, c.z1], [c.x0, c.z1]];
  for (const [axis, half] of [[f, l], [r, w]]) {
    const d = box.map(([x, z]) => (x - p.x)*axis.x + (z - p.z)*axis.z);
    if (Math.min(...d) > half || Math.max(...d) < -half) return false;
  }
  return true;
}
// The windowed wall a car touching the box is smashing through, if it's on the street side of any: always a windowed one —
// whichever's nearest the car's centre.
function outsideWindow(c, car) {
  const p = local(c, car.x, car.z), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let best = null;
  for (const w of c.windows) {
    if ((p[w.axis] - w.at)*w.sign <= 0) continue;
    const b = w.axis === 'x' ? 'z' : 'x', d = Math.hypot(p[w.axis] - w.at, p[b] - clamp(p[b], c[b + '0'], c[b + '1']));
    if (!best || d < best.d) best = { side: w.side, d };
  }
  return best?.side ?? null;
}
/** Which windowed wall a car's just touched the room through, if any: time to smash in (life/room-crash.js). Decided at
 * contact, whether or not it was seen coming (car.roomRoll only stops it veering); not a car hidden in there already. */
export function crashingIn(car) {
  const c = roomClash();
  if (!c || car.traits?.ghost || car.roomHid === c || car.roomRoll?.smashing || !anyCornerIn(car)) return null;
  return outsideWindow(c, car);
}

// A car any of which has been in the room's box (there when the view came in, or in through a blank wall) stays hidden
// (car.roomHid) till it's out of the camera's view, so it's never seen coming out through a window. Called by placeCar.
const seen = new THREE.Vector3();
export function hiddenByRoom(car) {
  const c = roomClash();
  if (!c || (car.roomRoll?.clash === c && car.roomRoll.smashing)) return car.roomHid = null; // (smashing in: seen)
  if (anyCornerIn(car) && (car.roomHid === c || !outsideWindow(c, car))) return car.roomHid = c; // (in through a blank wall)
  if (car.roomHid !== c) return car.roomHid = null;
  seen.set(car.x, Y_ROAD + 0.5, car.z).project(camera);
  if (seen.z > 1 || Math.abs(seen.x) > 1.2 || Math.abs(seen.y) > 1.2) car.roomHid = null; // (behind or off screen)
  return car.roomHid;
}
