// Fits a skirt (Skirt.glb, built by tools/skirt-models.py) to the person model's body, so it moves with every clip and
// takes every body shape the body does. Pure geometry, no three.js, so it can be run and checked on its own.
//
// The skirts are made at rest with no weights or shape keys of their own. Each of their vertices takes both from the
// closest point on the body: that point's triangle's bones and shape-key offsets, blended by where on the triangle it
// is. So a vertex over the hips moves with the pelvis and flares with the Hips key, one over the thigh moves between the
// thigh and knee as the thigh itself does, and one hanging out in front of the leg swings with it.
//
// The body is only looked for on the side the model was made on (x ≥ 0, see buildPersonModel), a vertex on the other
// side mirrored across to find it and its bones and offsets mirrored back. Near the middle (within MIDDLE_BLEND of it)
// a vertex takes a blend of both sides, evenly on the middle itself, so the front and back hang between the legs rather
// than going with one of them.
const MIDDLE_BLEND = 0.15;

/**
 * The closest point on triangle abc to p, as how much of each corner it is (Ericson, Real-Time Collision Detection 5.1.5).
 * @param {number[]} p - the point, [x, y, z]
 * @param {number[]} a - a corner
 * @param {number[]} b - a corner
 * @param {number[]} c - a corner
 * @returns {number[]} [how much of a, of b, of c], adding up to 1
 */
function closestOnTriangle(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1*d4 - d3*d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1/(d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5*d2 - d1*d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2/(d2 - d6); return [1 - w, 0, w]; }
  const va = d3*d6 - d5*d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3)/((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const denom = 1/(va + vb + vc), v = vb*denom, w = vc*denom;
  return [1 - v - w, v, w];
}

/**
 * Weight a skirt's vertices to the body's bones and give them the body's shape-key offsets.
 * @param {Float32Array|number[]} skirt - the skirt's vertices at rest, in the body's model space, three numbers each
 * @param {object} body - the body at rest, as buildPersonModel has it
 * @param {number[]} body.positions - its vertices, three numbers each
 * @param {number[]} body.indices - its triangles, three vertices each
 * @param {number[]} body.joints - four bones per vertex
 * @param {number[]} body.weights - how much each of those bones moves it
 * @param {number[][]} body.offsets - per shape key to carry over, each vertex's offset, three numbers each
 * @param {function(number): boolean} body.usable - whether a vertex is somewhere a skirt could fit to (not the head, arms)
 * @param {number[]} body.mirrorBone - each bone's twin on the other side of the body (itself, down the middle)
 * @returns {{joints: Float32Array, weights: Float32Array, offsets: Float32Array[]}} four bones and weights per skirt
 *   vertex, and its offset per shape key
 */
export function fitSkirt(skirt, { positions, indices, joints, weights, offsets, usable, mirrorBone }) {
  const corner = i => [positions[i*3], positions[i*3+1], positions[i*3+2]];
  const triangles = [];
  for (let t=0;t<indices.length;t+=3) {
    const tri = [indices[t], indices[t+1], indices[t+2]];
    if (tri.every(i => positions[i*3] > -1e-4 && usable(i))) triangles.push(tri);
  }
  // the closest point on the made side of the body to p: its bones (as bone → weight) and its offsets
  const nearest = p => {
    let best = null, bestDistance = Infinity, bestAt = null;
    triangles.forEach(tri => {
      const [a, b, c] = tri.map(corner), at = closestOnTriangle(p, a, b, c);
      const dx = at[0]*a[0] + at[1]*b[0] + at[2]*c[0] - p[0], dy = at[0]*a[1] + at[1]*b[1] + at[2]*c[1] - p[1], dz = at[0]*a[2] + at[1]*b[2] + at[2]*c[2] - p[2];
      const distance = dx*dx + dy*dy + dz*dz;
      if (distance < bestDistance) { bestDistance = distance; best = tri; bestAt = at; }
    });
    const bones = new Map(), offset = offsets.map(() => [0, 0, 0]);
    best.forEach((i, k) => {
      const share = bestAt[k];
      for (let j=0;j<4;j++) if (weights[i*4 + j] > 0) bones.set(joints[i*4 + j], (bones.get(joints[i*4 + j]) || 0) + share*weights[i*4 + j]);
      offsets.forEach((keyOffsets, key) => { for (let c=0;c<3;c++) offset[key][c] += share*keyOffsets[i*3 + c]; });
    });
    return { bones, offset };
  };
  const count = skirt.length/3;
  const out = { joints: new Float32Array(count*4), weights: new Float32Array(count*4), offsets: offsets.map(() => new Float32Array(count*3)) };
  for (let v=0;v<count;v++) {
    const x = skirt[v*3], { bones, offset } = nearest([Math.abs(x), skirt[v*3+1], skirt[v*3+2]]);
    // how much it's the made side's (and how much the other's, its bones swapped over and offsets turned round)
    const t = Math.max(0, Math.min(1, (x + MIDDLE_BLEND)/(2*MIDDLE_BLEND))), made = t*t*(3 - 2*t);
    const blended = new Map();
    bones.forEach((w, bone) => {
      blended.set(bone, (blended.get(bone) || 0) + w*made);
      blended.set(mirrorBone[bone], (blended.get(mirrorBone[bone]) || 0) + w*(1 - made));
    });
    const strongest = [...blended].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = strongest.reduce((sum, [, w]) => sum + w, 0);
    strongest.forEach(([bone, w], k) => { out.joints[v*4 + k] = bone; out.weights[v*4 + k] = w/total; });
    offset.forEach((o, key) => {
      out.offsets[key].set([o[0]*(2*made - 1), o[1], o[2]], v*3);
    });
  }
  return out;
}
