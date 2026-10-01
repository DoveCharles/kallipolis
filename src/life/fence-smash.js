import * as THREE from 'three';
import { camera } from '../core/scene.js';
import { playSound } from '../audio/sfx.js';
import { fenceMeshList, forFencesNear, fenceSideOf } from '../zones/fences.js';
import { fenceDebris } from './giblets.js';
import { carHeight, carLength, carWidth } from './traffic/placing.js';
import { slowedBy } from './traffic/collisions.js';
import { damage } from '../core/health.js';

// ============================================================ cars smashing fences
// A moving car that reaches a fence piece (see "fences as obstacles" in zones/fences.js) blows it apart into smoke and
// splinters: its vertices are collapsed to a point (the originals kept on the mesh), and it's put back once it's been
// out of view for RESET_AFTER seconds. Each slows the car as a person FENCE_WEIGHT times as heavy would, and dents it (FENCE_DAMAGE).
const SMASH_SPEED = 1, RESET_AFTER = 30, FENCE_WEIGHT = 2, FENCE_DAMAGE = 5;
const broken = new Set();
/**
 * Smash whatever fence pieces a car is touching.
 * @param {object} car - with x, z, heading and speed (or `motion`, how it's moving if knocked)
 * @param {?{x: number, z: number}} motion - its velocity, if not along its heading
 */
export function smashFences(car, motion = null) {
  if (car.traits?.ghost) return; // (a ghost car goes through)
  const speed = motion ? Math.hypot(motion.x, motion.z) : Math.abs(car.speed ?? 0);
  if (speed < SMASH_SPEED) return;
  const hl = carLength(car)/2, hw = carWidth(car)/2, sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const reach = Math.hypot(hl, hw);
  const vel = motion ? { x: motion.x, y: 0, z: motion.z } : { x: sin*car.speed, y: 0, z: cos*car.speed };
  forFencesNear(car.x, car.z, reach + 1, piece => {
    if (piece.broken) return;
    const near = fenceSideOf(piece, car.x, car.z);
    if (Math.abs(near.side) > reach) return;
    // (the piece against the car's box: sampled along it, as pieces are short)
    for (let k = 0; k <= 4; k++) {
      const x = piece.a.x + (piece.b.x - piece.a.x)*k/4 - car.x, z = piece.a.z + (piece.b.z - piece.a.z)*k/4 - car.z;
      if (Math.abs(x*sin + z*cos) < hl + 0.1 && Math.abs(x*cos - z*sin) < hw + 0.1) { breakPiece(piece, vel, carHeight(car)); slowedBy(car, 'person', FENCE_WEIGHT); damage(car, FENCE_DAMAGE); return; }
    }
  });
}
/**
 * Punch whatever fence piece is nearest in front of someone, within `reach` and `arcCos` of dead ahead: it breaks.
 * @param {{x: number, y: number, z: number, heading: number}} p
 * @param {number} reach
 * @param {number} arcCos
 * @returns {boolean} whether one did
 */
export function punchFence(p, reach, arcCos) {
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  let best = null, nearest = reach;
  forFencesNear(p.x, p.z, reach + 1, piece => {
    if (p.y < piece.y0 - 0.6 || p.y > piece.y1) return;
    const { t } = fenceSideOf(piece, p.x, p.z);
    const dx = piece.a.x + (piece.b.x - piece.a.x)*t - p.x, dz = piece.a.z + (piece.b.z - piece.a.z)*t - p.z, d = Math.hypot(dx, dz);
    if (d > nearest || (d > 1e-3 && (dx*fx + dz*fz)/d < arcCos)) return;
    best = piece; nearest = d;
  });
  if (best) breakPiece(best, { x: fx*2, y: 0, z: fz*2 }, 1);
  return !!best;
}
function breakPiece(piece, vel, height) {
  const pos = piece.mesh.geometry.attributes.position;
  piece.mesh.userData.fenceRest ??= pos.array.slice();
  const cx = (piece.a.x + piece.b.x)/2, cz = (piece.a.z + piece.b.z)/2;
  for (let v = piece.v0; v < piece.v1; v++) pos.setXYZ(v, cx, piece.y0, cz);
  pos.needsUpdate = true;
  piece.broken = true; piece.hidden = 0;
  broken.add(piece);
  const at = { x: cx, y: (piece.y0 + piece.y1)/2, z: cz };
  fenceDebris(at, Math.max(0.6, height*0.5), piece.color, { x: vel.x*0.5, y: 0, z: vel.z*0.5 });
  playSound('crash', at, 0.5);
}
function restorePiece(piece) {
  const pos = piece.mesh.geometry.attributes.position, rest = piece.mesh.userData.fenceRest;
  if (rest) { pos.array.set(rest.subarray(piece.v0*3, piece.v1*3), piece.v0*3); pos.needsUpdate = true; }
  piece.broken = false;
  broken.delete(piece);
}
const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4(), sphere = new THREE.Sphere();
let lastT = null;
/**
 * Put back broken fence pieces that have been out of view long enough.
 * @param {number} t - the time now, in seconds
 */
export function updateFences(t) {
  const dt = lastT == null ? 0 : Math.min(1, t - lastT);
  lastT = t;
  if (!broken.size) return;
  const live = fenceMeshList();
  frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  for (const piece of broken) {
    if (!live.has(piece.mesh)) { broken.delete(piece); continue; } // (rebuilt since: whole again)
    sphere.center.set((piece.a.x + piece.b.x)/2, (piece.y0 + piece.y1)/2, (piece.a.z + piece.b.z)/2);
    sphere.radius = Math.hypot(piece.b.x - piece.a.x, piece.b.z - piece.a.z)/2 + 1;
    piece.hidden = frustum.intersectsSphere(sphere) ? 0 : piece.hidden + dt;
    if (piece.hidden > RESET_AFTER) restorePiece(piece);
  }
}
