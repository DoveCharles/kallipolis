// Multiplayer's traffic (see net/net.js): packTraffic on the host reads each car as last drawn (placeCar); mirrorTraffic
// on a guest draws them so, in place of updateTraffic's driving. One record (REC floats) a car:
// [slot, design, x, y, z, qx, qy, qz, qw, scale, paint×3, wheels×4, plate×4, holo×3, rust×3].
import * as THREE from 'three';
import { App } from '../../core/shared.js';
import { camera } from '../../core/scene.js';
import { cars } from './state.js';
import { carMeshes, carParts } from './models.js';

export const REC = 27;
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), pa = new THREE.Vector3(), pb = new THREE.Vector3(), euler = new THREE.Euler();

/**
 * Every car drawn within `reach` of (cx, cz), as records.
 * @returns {Float32Array}
 */
export function packTraffic(cx, cz, reach) {
  const out = [], counts = carMeshes.map(() => 0);
  cars.forEach((car, i) => {
    const d = car.design;
    if (car.li < 0 || d == null || !carMeshes[d]) return;
    const k = counts[d]++, cm = carMeshes[d], m = cm.mesh.instanceMatrix.array; // (in the order placeCar filled them)
    if (!Math.hypot(m[k*16], m[k*16+1], m[k*16+2]) || Math.hypot(car.x - cx, car.z - cz) > reach) return;
    matrix.fromArray(m, k*16).decompose(position, rotation, scale);
    out.push(i, d, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scale.x,
      cm.paint.getX(k), cm.paint.getY(k), cm.paint.getZ(k), cm.wheels.getX(k), cm.wheels.getY(k), cm.wheels.getZ(k), cm.wheels.getW(k),
      cm.plates.getX(k), cm.plates.getY(k), cm.plates.getZ(k), cm.plates.getW(k), cm.holo.getX(k), cm.holo.getY(k), cm.holo.getZ(k),
      cm.rust.getX(k), cm.rust.getY(k), cm.rust.getZ(k));
  });
  return new Float32Array(out);
}

/** The guest's traffic, drawn from the host's snapshots (App.netPair), blended. */
export function mirrorTraffic() {
  carParts.all.forEach(mesh => { mesh.count = 0; });
  const pair = App.netPair?.(), counts = carMeshes.map(() => 0);
  if (pair) {
    const { a, b, f } = pair, A = a.cars, B = b.cars, inA = new Map();
    for (let r = 0; r < A.length; r += REC) inA.set(A[r], r);
    for (let r = 0; r < B.length; r += REC) {
      const d = B[r+1], cm = carMeshes[d];
      if (!cm) continue;
      const ra = inA.get(B[r]), blend = ra != null && A[ra+1] === d, s = blend ? ra : r, from = blend ? A : B; // (new this snapshot: not blended)
      pa.fromArray(from, s + 2); pb.fromArray(B, r + 2);
      qa.fromArray(from, s + 5); qb.fromArray(B, r + 5);
      position.lerpVectors(pa, pb, f); rotation.slerpQuaternions(qa, qb, f);
      const k = counts[d]++;
      matrix.compose(position, rotation, scale.setScalar(from[s+9] + (B[r+9] - from[s+9])*f));
      cm.mesh.setMatrixAt(k, matrix);
      cm.paint.setXYZ(k, B[r+10], B[r+11], B[r+12]);
      cm.wheels.setXYZW(k, B[r+13], B[r+14], B[r+15], B[r+16]);
      cm.plates.setXYZW(k, B[r+17], B[r+18], B[r+19], B[r+20]);
      const heading = euler.setFromQuaternion(rotation, 'YXZ').y; // (the foil's glint follows the camera's bearing: see placeCar)
      cm.holo.setXYZW(k, B[r+21], B[r+22], B[r+23], Math.atan2(camera.position.x - position.x, camera.position.z - position.z) - heading);
      cm.rust.setXYZ(k, B[r+24], B[r+25], B[r+26]);
    }
  }
  carMeshes.forEach((cm, d) => {
    cm.mesh.count = counts[d];
    [cm.mesh.instanceMatrix, cm.paint, cm.wheels, cm.plates, cm.holo, cm.rust].forEach(attr => { attr.needsUpdate = true; });
  });
}
