// Multiplayer's crowd (see net/net.js): packCrowd on the host reads each person as last drawn; mirrorCrowd on a guest
// draws them so, in place of updatePeople's thinking. One record (REC floats) a person:
// [slot, id, x, y, z, qx, qy, qz, qw, scale, anim×4, look×4, eyes×4, pupil×2]. Looks come from the id (assignAppearance).
import * as THREE from 'three';
import { S, App } from '../../core/shared.js';
import { controls } from '../../core/camera-controls.js';
import { people, personModel, newPerson, refreshTraits, followed, countBelow } from './people.js';
import { updateHeld } from './peopleHolding.js';

export const REC = 24;
const ROW_JUMP = 8; // (an animation row moving further than this between snapshots is a new clip or a loop: not blended)
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
const lerp = (x, y, f) => x + (y - x)*f;

/**
 * Everyone drawn within `reach` of (cx, cz), as records.
 * @returns {Float32Array}
 */
export function packCrowd(cx, cz, reach) {
  if (!personModel) return new Float32Array(0);
  const m = personModel.mesh.instanceMatrix.array, an = personModel.anim.array, lo = personModel.look.array, ey = personModel.eyes.array, pu = personModel.pupil.array;
  const out = [];
  people.forEach((p, i) => {
    const o = i*16;
    if (!Math.hypot(m[o], m[o+1], m[o+2]) || Math.hypot(p.x - cx, p.z - cz) > reach) return;
    matrix.fromArray(m, o).decompose(position, rotation, scale);
    const k = i*4;
    out.push(i, p.id, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scale.x,
      an[k], an[k+1], an[k+2], an[k+3], lo[k], lo[k+1], lo[k+2], lo[k+3], ey[k], ey[k+1], ey[k+2], ey[k+3], pu[i*2], pu[i*2+1]);
  });
  return new Float32Array(out);
}

const bySlot = list => { const at = new Map(); for (let r = 0; r < list.length; r += REC) at.set(list[r], r); return at; };

/** The guest's crowd, drawn from the host's snapshots (App.netPair), blended. */
export function mirrorCrowd() {
  if (!personModel) return;
  const pair = App.netPair?.(), n = pair?.b.count ?? 0;
  while (people.length < n) people.push(newPerson(-1)); // (a stand-in till the host sends who's there)
  people.length = n;
  personModel.mesh.instanceMatrix.array.fill(0, 0, n*16);
  people.forEach(p => { p.mode = 'none'; });
  if (pair) {
    const { a, b, f } = pair, inA = bySlot(a.people), B = b.people, A = a.people;
    const an = personModel.anim.array, lo = personModel.look.array, ey = personModel.eyes.array, pu = personModel.pupil.array;
    for (let r = 0; r < B.length; r += REC) {
      const i = B[r], id = B[r+1];
      let p = people[i];
      if (p.id !== id) { p = people[i] = newPerson(id); personModel.assignAppearance(i, id); }
      refreshTraits(p, i);
      // (bald and beard traits: as updatePeople grooms them)
      const bald = Math.sign(Math.round(p.traits.bald)), beard = Math.sign(Math.round(p.traits.beard)), groomKey = p.id*9 + (bald + 1)*3 + beard + 1;
      if (p.groomKey !== groomKey) { p.groomKey = groomKey; personModel.groom(i, p.id, bald, beard); }
      const ra = inA.get(i), blend = ra != null && A[ra+1] === id, s = blend ? ra : r, from = blend ? A : B; // (new this snapshot: not blended)
      pa.fromArray(from, s + 2); pb.fromArray(B, r + 2);
      qa.fromArray(from, s + 5); qb.fromArray(B, r + 5);
      position.lerpVectors(pa, pb, f); rotation.slerpQuaternions(qa, qb, f);
      const size = lerp(from[s+9], B[r+9], f);
      matrix.compose(position, rotation, scale.setScalar(size)).toArray(personModel.mesh.instanceMatrix.array, i*16);
      p.x = position.x; p.y = position.y; p.z = position.z; p.heading = 2*Math.atan2(rotation.y, rotation.w); p.mode = 'wander';
      const k = i*4, rows = [0, 1].every(c => B[r+10+c] >= from[s+10+c] && B[r+10+c] - from[s+10+c] < ROW_JUMP);
      const g = rows ? f : f < 0.5 ? 0 : 1;
      for (let c = 0; c < 4; c++) {
        an[k+c] = lerp(from[s+10+c], B[r+10+c], g);
        lo[k+c] = lerp(from[s+14+c], B[r+14+c], f);
        ey[k+c] = lerp(from[s+18+c], B[r+18+c], f);
      }
      pu[i*2] = lerp(from[s+22], B[r+22], f); pu[i*2+1] = lerp(from[s+23], B[r+23], f);
      // (what they wear, as updatePeople copies it)
      for (const layer of personModel.wornLayers) {
        const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
        if (!style || !style.mesh) continue;
        const slot = layer.slot[i];
        matrix.toArray(style.mesh.instanceMatrix.array, slot*16);
        for (let c = 0; c < 4; c++) { style.anim.array[slot*4 + c] = an[k+c]; style.look.array[slot*4 + c] = lo[k+c]; style.eyes.array[slot*4 + c] = ey[k+c]; }
        style.pupil.array[slot*2] = pu[i*2]; style.pupil.array[slot*2 + 1] = pu[i*2+1];
      }
    }
  }
  personModel.mesh.count = personModel.censor.count = n;
  personModel.hair.forEach(style => { style.mesh.count = countBelow(style.members, n); });
  [personModel, ...personModel.hair].forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; part.anim.needsUpdate = true; part.look.needsUpdate = true; part.eyes.needsUpdate = true; part.pupil.needsUpdate = true; });
  personModel.updateCopies(n, followed >= 0 ? [followed] : []);
  updateHeld();
  const p = people[followed];
  if (p && p.mode !== 'none') controls.goalTarget.set(p.x, p.y + 1.4*p.height*S.peopleSize, p.z);
}
