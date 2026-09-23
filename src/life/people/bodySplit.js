// Splits the person model's one body mesh into the parts it comes apart into when they die (see peopleGibs.js).
// Pure geometry, no three.js, so it can be run and checked on its own.
//
// 1. By material first: shirt (Top, Tummy bands) is the Chest, trousers (Pants) the Hips, the face's materials the
//    Head; sleeve bands go with their arm, leg bands and shoes with their leg. Skin goes by the bone it mostly moves
//    with (head, arm, leg, else chest). Left and right come from the bone, or which side of the body it's on.
// 2. Islands: vertices at the same place count as joined (the mesh is split at every material and at the mirror
//    seam). An island under minIslandShare of its part joins the part it touches most; one touching nothing is
//    hidden inside the body and dropped — unless it's in the Head, whose eyes and mouth are separate meshes.
// 3. Caps: every hole the split opened (edges joined in the whole body but open in the part) is closed with a fan of
//    copies of its rim vertices, which the caller gives a flesh color. Holes the model already had are left alone.

export const BODY_PARTS = ['Head', 'Chest', 'Hips', 'ArmL', 'ArmR', 'LegL', 'LegR'];
const FACE_SLOTS = /^(White|Black|Eyelashes|Lips)$/;
const LEG_BONE = /^(Thigh|Knee|Leg|Foot|Toe)/;

/**
 * Which part a triangle belongs to, from its material and the region of the body its bones put it in.
 * @param {string} slot - its material
 * @param {string} region - 'Head', 'ArmL', 'ArmR', 'LegL', 'LegR' or 'Torso'
 * @param {string} side - 'L' or 'R'
 * @returns {string} one of BODY_PARTS
 */
function partFor(slot, region, side) {
  if (region === 'Head' || FACE_SLOTS.test(slot)) return 'Head';
  if (slot === 'Top' || slot.startsWith('Tummy')) return 'Chest';
  if (slot === 'Pants') return 'Hips';
  if (slot === 'Shoes' || /^Leg\d/.test(slot)) return 'Leg' + side;
  if (slot.startsWith('Sleeve')) return 'Arm' + side;
  return region === 'Torso' ? 'Chest' : region;
}

/**
 * Give every vertex an id shared by all the vertices at the same place.
 * @param {ArrayLike<number>} position - xyz per vertex
 * @param {number} tolerance - how close counts as the same place
 * @returns {Int32Array} an id per vertex
 */
function weldVertices(position, tolerance) {
  const count = position.length/3, ids = new Int32Array(count), seen = new Map();
  for (let v=0;v<count;v++) {
    const key = [0, 1, 2].map(c => Math.round(position[v*3 + c]/tolerance)).join(',');
    if (!seen.has(key)) seen.set(key, seen.size);
    ids[v] = seen.get(key);
  }
  return ids;
}

/**
 * @param {object} body
 * @param {ArrayLike<number>} body.position - xyz per vertex, in model space
 * @param {ArrayLike<number>} body.index - three vertices per triangle
 * @param {ArrayLike<number>} body.joints - four bone indices per vertex
 * @param {ArrayLike<number>} body.weights - four bone weights per vertex
 * @param {string[]} body.slotOf - each vertex's material name
 * @param {string[]} body.boneNames - each bone's name
 * @param {boolean[]} body.inHead - whether each bone is the head or under it
 * @param {boolean[]} body.inArm - whether each bone is part of an arm
 * @param {number} [body.leftSign] - the sign of x on the body's left
 * @param {number} [body.minIslandShare] - an island under this share of its part's triangles is moved or dropped
 * @param {number} [body.tolerance] - how close two vertices are to count as joined
 * @returns {{parts: {name: string, index: number[]}[], capSources: number[]}} each part's triangles, which can use
 *   cap vertices numbered on from the body's own; capSources[k] is the body vertex cap vertex k copies
 */
export function splitBody({ position, index, joints, weights, slotOf, boneNames, inHead, inArm, leftSign = 1, minIslandShare = 0.05, tolerance = 1e-4 }) {
  const vertexCount = position.length/3, triangleCount = index.length/3;
  const regionOf = joint => {
    const name = boneNames[joint] || '', side = name.slice(-1);
    if (inHead[joint]) return 'Head';
    if (inArm[joint]) return 'Arm' + side;
    if (LEG_BONE.test(name)) return 'Leg' + side;
    return 'Torso';
  };
  const region = new Array(vertexCount);
  for (let v=0;v<vertexCount;v++) {
    let best = 0;
    for (let k=1;k<4;k++) if (weights[v*4 + k] > weights[v*4 + best]) best = k;
    region[v] = regionOf(joints[v*4 + best]);
  }
  // ---- 1. by material, then bone
  const partOf = new Int8Array(triangleCount);
  for (let t=0;t<triangleCount;t++) {
    const a = index[t*3], b = index[t*3+1], c = index[t*3+2];
    const r = region[b] === region[c] ? region[b] : region[a];
    const x = position[a*3] + position[b*3] + position[c*3];
    const side = /^(Arm|Leg)[LR]$/.test(r) ? r.slice(-1) : x*leftSign >= 0 ? 'L' : 'R';
    partOf[t] = BODY_PARTS.indexOf(partFor(slotOf[a], r, side));
  }
  // ---- 2. islands
  const welded = weldVertices(position, tolerance);
  const corner = (t, k) => welded[index[t*3 + k]];
  const trianglesAt = new Map(); // welded vertex -> triangles using it
  for (let t=0;t<triangleCount;t++) for (let k=0;k<3;k++) {
    const w = corner(t, k);
    if (!trianglesAt.has(w)) trianglesAt.set(w, []);
    trianglesAt.get(w).push(t);
  }
  const islands = [], islandOf = new Int32Array(triangleCount).fill(-1);
  for (let t=0;t<triangleCount;t++) {
    if (islandOf[t] >= 0) continue;
    const island = [t], part = partOf[t];
    islandOf[t] = islands.length;
    for (let n=0;n<island.length;n++) for (let k=0;k<3;k++) for (const u of trianglesAt.get(corner(island[n], k))) {
      if (islandOf[u] < 0 && partOf[u] === part) { islandOf[u] = islands.length; island.push(u); }
    }
    islands.push(island);
  }
  const partSize = BODY_PARTS.map((_, p) => partOf.reduce((n, q) => n + (q === p ? 1 : 0), 0));
  const head = BODY_PARTS.indexOf('Head');
  islands.forEach(island => {
    const part = partOf[island[0]];
    if (island.length >= minIslandShare*partSize[part]) return;
    const votes = new Map();
    island.forEach(t => { for (let k=0;k<3;k++) for (const u of trianglesAt.get(corner(t, k))) {
      if (partOf[u] !== part && partOf[u] >= 0) votes.set(partOf[u], (votes.get(partOf[u]) || 0) + 1);
    } });
    const [to] = [...votes].reduce((best, entry) => entry[1] > best[1] ? entry : best, [-1, 0]);
    const next = to >= 0 ? to : part === head ? part : -1;
    island.forEach(t => { partOf[t] = next; });
  });
  // ---- 3. caps
  const edgeKey = (u, v) => u < v ? u*vertexCount + v : v*vertexCount + u;
  const bodyEdges = new Map();
  for (let t=0;t<triangleCount;t++) {
    if (partOf[t] < 0) continue;
    for (let k=0;k<3;k++) { const key = edgeKey(corner(t, k), corner(t, (k + 1) % 3)); bodyEdges.set(key, (bodyEdges.get(key) || 0) + 1); }
  }
  const capSources = [], parts = BODY_PARTS.map(name => ({ name, index: [] }));
  for (let t=0;t<triangleCount;t++) if (partOf[t] >= 0) parts[partOf[t]].index.push(index[t*3], index[t*3+1], index[t*3+2]);
  parts.forEach((part, p) => {
    const partEdges = new Map();
    for (let t=0;t<triangleCount;t++) {
      if (partOf[t] !== p) continue;
      for (let k=0;k<3;k++) { const key = edgeKey(corner(t, k), corner(t, (k + 1) % 3)); partEdges.set(key, (partEdges.get(key) || 0) + 1); }
    }
    // the cut: edges open in the part but joined in the body, followed round a rim at a time (undirected, since the
    // mirrored half and the layered clothes don't all wind the same way; a rim can pass through a vertex twice)
    const around = new Map(), source = new Map(), used = new Set();
    for (let t=0;t<triangleCount;t++) {
      if (partOf[t] !== p) continue;
      for (let k=0;k<3;k++) {
        const u = corner(t, k), v = corner(t, (k + 1) % 3), key = edgeKey(u, v);
        if (partEdges.get(key) !== 1 || !(bodyEdges.get(key) >= 2)) continue;
        [[u, v], [v, u]].forEach(([from, to]) => { if (!around.has(from)) around.set(from, []); around.get(from).push(to); });
        source.set(u, index[t*3 + k]); source.set(v, index[t*3 + (k + 1) % 3]);
      }
    }
    for (const start of around.keys()) {
      for (;;) {
        const loop = [start];
        let u = start, closed = false;
        for (;;) {
          const v = around.get(u).find(w => !used.has(edgeKey(u, w)));
          if (v == null) break;
          used.add(edgeKey(u, v));
          if (v === start) { closed = true; break; }
          loop.push(v);
          u = v;
        }
        if (loop.length === 1 && !closed) break; // (nothing left from here)
        if (!closed || loop.length < 3) continue; // (an open run, where the cut meets a hole the model already had)
        const first = vertexCount + capSources.length;
        capSources.push(...loop.map(w => source.get(w)));
        for (let k=1;k+1<loop.length;k++) part.index.push(first, first + k, first + k + 1);
      }
    }
  });
  return { parts: parts.filter(part => part.index.length), capSources };
}
