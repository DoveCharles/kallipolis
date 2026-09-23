// Baggy jeans, made from the body's own legs as the model loads: its leg triangles (see buildPersonModel), each vertex
// pushed out along the leg's normal there and the hem, round the ankle, widened. Every vertex is one of the body's, moved,
// so it keeps that vertex's bones and shape keys and goes wherever the leg does. Round the hem goes a cuff, a band standing
// just proud of the jeans, its top edge part way up the leg from the hem and blended between the two ends' bones and shape
// keys. Pure geometry, no three.js.
const BAGGY = 0.1;        // how far out from the leg they hang
const WAISTBAND = 0.02;   // how far out from it at the top, where they meet the body
const HEM_FLARE = 1.9;    // how much wider round the hem is than round the ankle it hangs from
const CUFF = 0.3;         // how far up the leg the cuff comes
const CUFF_PROUD = 0.02;  // how far it stands out from the jeans

/**
 * Make baggy jeans out of the body's legs.
 * @param {object} body - the body at rest, as buildPersonModel has it
 * @param {number[]} body.positions - its vertices, three numbers each
 * @param {number[]} body.indices - its triangles, three vertices each
 * @param {number[]} body.joints - four bones per vertex
 * @param {number[]} body.weights - how much each of those bones moves it
 * @param {number[][]} body.offsets - per shape key to carry over, each vertex's offset, three numbers each
 * @param {function(number): boolean} body.leg - whether a vertex is on a leg (the trousers' parts of the body)
 * @param {function(number): boolean} body.usable - whether a vertex's triangles count towards the legs' normals (not the head, arms)
 * @returns {{positions: number[], indices: number[], cuff: number[], joints: number[], weights: number[], offsets: number[][]}}
 *   the jeans' vertices and triangles, 1 for each vertex of the cuff (0 for the rest), and their bones and shape-key offsets
 */
export function fitJeans({ positions, indices, joints, weights, offsets, leg, usable }) {
  // the body is split at every hard edge, so vertices in the same place are the same point of the surface
  const pointOf = new Map(), point = i => {
    const key = [0, 1, 2].map(c => Math.round(positions[i*3 + c]*1e4)).join(',');
    if (!pointOf.has(key)) pointOf.set(key, pointOf.size);
    return pointOf.get(key);
  };
  const points = Array.from({ length: positions.length/3 }, (_, i) => point(i));
  const normals = new Float64Array(pointOf.size*3);
  const legTriangles = [];
  for (let t=0;t<indices.length;t+=3) {
    const tri = [indices[t], indices[t+1], indices[t+2]];
    if (!tri.every(usable)) continue;
    if (tri.every(leg)) legTriangles.push(tri);
    const [a, b, c] = tri.map(i => [positions[i*3], positions[i*3+1], positions[i*3+2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1]*w[2] - u[2]*w[1], u[2]*w[0] - u[0]*w[2], u[0]*w[1] - u[1]*w[0]]; // (as long as the triangle's twice as big)
    tri.forEach(i => { for (let k=0;k<3;k++) normals[points[i]*3 + k] += n[k]; });
  }
  // the edges only one leg triangle has (the waist, and the hems), and every point's neighbours
  const edges = new Map(), neighbours = new Map();
  legTriangles.forEach(tri => tri.forEach((i, k) => {
    const a = points[i], b = points[tri[(k + 1) % 3]], key = Math.min(a, b) + ',' + Math.max(a, b);
    edges.set(key, (edges.get(key) || 0) + 1);
    [[a, b], [b, a]].forEach(([p, q]) => { if (!neighbours.has(p)) neighbours.set(p, new Set()); neighbours.get(p).add(q); });
  }));
  const edge = new Set(), openEdges = [];
  edges.forEach((count, key) => { if (count === 1) { const ends = key.split(',').map(Number); ends.forEach(p => edge.add(p)); openEdges.push(ends); } });
  const at = new Map(), bodyVertex = new Map();
  legTriangles.flat().forEach(i => { if (!at.has(points[i])) { at.set(points[i], [positions[i*3], positions[i*3+1], positions[i*3+2]]); bodyVertex.set(points[i], i); } });
  const lowest = Math.min(...[...at.values()].map(p => p[1])), highest = Math.max(...[...at.values()].map(p => p[1]));
  const hem = p => edge.has(p) && at.get(p)[1] < (lowest + highest)/2, waist = p => edge.has(p) && !hem(p);
  // the middle of each leg's hem, to widen it from
  const hemMiddle = side => {
    const round = [...at].filter(([p, q]) => hem(p) && Math.sign(q[0]) === side).map(([, q]) => q);
    return [0, 2].map(c => round.reduce((sum, q) => sum + q[c], 0)/Math.max(1, round.length));
  };
  const middles = { 1: hemMiddle(1), '-1': hemMiddle(-1) };
  const middleOf = q => middles[Math.sign(q[0]) || 1];
  const moved = new Map();
  at.forEach((q, p) => {
    const n = [normals[p*3], normals[p*3+1], normals[p*3+2]], length = Math.hypot(...n) || 1, out = waist(p) ? WAISTBAND : BAGGY;
    const r = q.map((x, c) => x + n[c]/length*out);
    if (hem(p)) { const [mx, mz] = middleOf(q); r[0] = mx + (r[0] - mx)*HEM_FLARE; r[2] = mz + (r[2] - mz)*HEM_FLARE; }
    moved.set(p, r);
  });

  const out = { positions: [], indices: [], cuff: [], joints: [], weights: [], offsets: offsets.map(() => []) };
  // a vertex blending body vertices (each [vertex, share]): their bones, their shape-key offsets
  const add = (position, blend, cuff) => {
    out.positions.push(...position);
    out.cuff.push(cuff ? 1 : 0);
    const bones = new Map();
    blend.forEach(([i, share]) => { for (let j=0;j<4;j++) if (weights[i*4 + j] > 0) bones.set(joints[i*4 + j], (bones.get(joints[i*4 + j]) || 0) + share*weights[i*4 + j]); });
    const strongest = [...bones].sort((a, b) => b[1] - a[1]).slice(0, 4), total = strongest.reduce((sum, [, w]) => sum + w, 0);
    for (let j=0;j<4;j++) { out.joints.push(strongest[j]?.[0] ?? 0); out.weights.push(strongest[j] ? strongest[j][1]/total : 0); }
    offsets.forEach((keyOffsets, key) => { for (let c=0;c<3;c++) out.offsets[key].push(blend.reduce((sum, [i, share]) => sum + share*keyOffsets[i*3 + c], 0)); });
    return out.positions.length/3 - 1;
  };
  const mine = new Map();
  legTriangles.flat().forEach(i => {
    if (!mine.has(i)) mine.set(i, add(moved.get(points[i]), [[i, 1]], false));
    out.indices.push(mine.get(i));
  });

  // the cuff: from each hem point CUFF up the edge towards its neighbour straightest above it, and out from the jeans
  const cuffOf = new Map();
  at.forEach((q, p) => {
    if (!hem(p)) return;
    const above = [...neighbours.get(p)].filter(n => !hem(n)).reduce((best, n) => {
      const r = at.get(n), slant = Math.hypot(r[0] - q[0], r[2] - q[2])/Math.max(1e-6, r[1] - q[1]);
      return !best || slant < best.slant ? { n, slant } : best;
    }, null);
    if (!above) return;
    const low = moved.get(p), high = moved.get(above.n), t = Math.min(1, CUFF/Math.hypot(...high.map((x, c) => x - low[c])));
    const [mx, mz] = middleOf(q);
    const proud = r => { const dx = r[0] - mx, dz = r[2] - mz, d = Math.hypot(dx, dz) || 1; return [r[0] + dx/d*CUFF_PROUD, r[1], r[2] + dz/d*CUFF_PROUD]; };
    const top = low.map((x, c) => x + (high[c] - x)*t);
    cuffOf.set(p, [add(proud(low), [[bodyVertex.get(p), 1]], true), add(proud(top), [[bodyVertex.get(p), 1 - t], [bodyVertex.get(above.n), t]], true)]);
  });
  openEdges.forEach(([a, b]) => {
    if (!cuffOf.has(a) || !cuffOf.has(b)) return;
    const [a0, a1] = cuffOf.get(a), [b0, b1] = cuffOf.get(b);
    out.indices.push(a0, b0, b1, a0, b1, a1);
  });
  return out;
}
