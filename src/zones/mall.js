import * as THREE from 'three';
import { App } from '../core/shared.js';
import { Y_ZONE_GROUND } from '../core/scene.js';
import { mulberry32, polygonArea, centroid } from '../core/math.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { makeFlatZoneMesh } from './surface-detail.js';
import { longAxisOf } from './farmland.js';
import { cutLotByCutouts, insetPolygonExact, toClipperPath, fromClipperPath, createRegionTester } from './cutouts.js';

// ---------------------------------------------------------- shopping centre
// A mall is one building filling its zone, but walked like the outdoors. Its concourse follows the zone's shape: down the
// middle of it (its spine, see spineOf), turning where the zone turns and branching where it branches, with a court under
// a glass dome wherever branches meet and an entrance wherever a branch reaches the zone's edge. A zone with no shape to
// follow (a square, a blob) gets one straight concourse down its long axis. The biggest court — at the junction deepest
// in the zone, or halfway along a mall with none — is the food court: kiosks round its edge, tables and chairs in the
// middle under the dome, and people hanging out there as they do in a plaza (zone.foodCourt: see buildPeopleNav).
//
// Shop units line the concourse on two storeys: each a building like any other (a clothes shop, a salon, a bar — a pub's
// layout — or a vacant unit), so people go in, the camera follows them, and each has its own card. The concourse is open
// to the glass roof down the middle; upstairs, a gallery runs in front of the upper shops on either side, round every
// court, with bridges across the void and escalators up to the bridges.
//
// People walk it on the ground by lanes down each branch by the shopfronts (zone.walkGaps, as a suburb's lanes: see
// buildPeopleNav), meeting in the middle of each court and coming out through the entrances onto whatever pavement's
// there; upstairs, by the galleries, bridges and escalators — all walked as a raised walkway is (zone.mallNav: the same
// shape as a raised network's nav in roads/raised.js). An upper unit keeps `base`, its floor's height, and its door is
// onto the gallery (see buildingDoors in peoplePathing.js).

export const MALL_LEVEL = 5;          // floor to floor
const EDGE = 0.4;                     // the mall's walls stand this far in from the zone's own edge (off the pavement)
const UNIT_GAP = 0.35;                // between the units' backs and the outer walls
const PARAPET = 0.8;                  // outer walls above the units' roofs
const CLERESTORY = 1.3;               // the glass walls round the concourse, up from the units' roof to the glass roof
const DOOR_H = 4.2;                   // the entrances' glass, and the lintel over it
const LANE_IN = 1.8;                  // the ground lanes, in from the shopfronts
const COURT = 1.5;                    // a court's radius, in the concourse's half-widths
const FOOD_COURT = 2.6;               // and the food court's (if there's room)
const MIN_SPINE = 20;                 // the least concourse worth building
const PRUNE_MIN = 12;                 // a side branch reaching less than this past the junction it comes off is dropped
const ESCALATOR_SLOPE = Math.tan(Math.PI/6), ESCALATOR_W = 1.1, BRIDGE_HALF = 1.5, BRIDGE_EVERY = 32;
const GLASS = 0xbfd9e6, FRAME = 0x3a3f46;
const FASCIAS = {
  clothes: [0x1a1a1c, 0xf2f0ea, 0xa82a2a, 0x2a3a5a, 0x3a3a3c, 0xd46a2a],
  salon: [0xe890b0, 0x8ec8d8, 0xb0a0d8, 0x60b0a0],
  pub: [0x121212, 0x1f3d2b, 0x5a1a22],
  vacant: [0xe6e3dc],
};
const INSIDE_WALLS = [0xf1ece2, 0xe8eef0, 0xf3e6e6, 0xe9f0e4, 0xeee8f4, 0xf4efe0];
const KIOSKS = [0xd9482b, 0xf2b705, 0x2a9d58, 0x1f6fb2, 0xe86a9a, 0x7a4bb0, 0xf07f1d]; // (each food kiosk's colours)
const TABLE_TOP = 0.75, SEAT_TOP = Y_ZONE_GROUND + 0.45;

const plain = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide, ...extra });
const glassMaterial = () => new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.22,
  side: THREE.DoubleSide, depthWrite: false });
function meshOf(geo, mat, name, shadows = true) {
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = shadows; mesh.receiveShadow = true;
  return mesh;
}
// A builder's geometry, or null when nothing went into it.
const built = b => b.vertexCount() ? b.build() : null;

// ---------------------------------------------------------- geometry helpers
// A frame: u along (dx, dz) from `c`, v across it (to its left), both in world units.
function frameOf(c, dx, dz) {
  return {
    uv: p => ({ u: (p.x - c.x)*dx + (p.z - c.z)*dz, v: -(p.x - c.x)*dz + (p.z - c.z)*dx }),
    at: (u, v, y = 0) => ({ x: c.x + dx*u - dz*v, y, z: c.z + dz*u + dx*v }),
    dx, dz,
  };
}
// Where the line v = const is inside `uvPoly` (the outline in u, v): the longest stretch of it, or null.
function spanAt(uvPoly, v) {
  const us = [];
  uvPoly.forEach((p, i) => {
    const q = uvPoly[(i+1) % uvPoly.length];
    if ((p.v > v) !== (q.v > v)) us.push(p.u + (q.u - p.u)*(v - p.v)/(q.v - p.v));
  });
  us.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < us.length; i += 2) if (!best || us[i+1] - us[i] > best[1] - best[0]) best = [us[i], us[i+1]];
  return best;
}
const clip = p => ({ X: Math.round(p.x*CLIPPER_SCALE), Y: Math.round(p.z*CLIPPER_SCALE) });
const union = (a, b = []) => clipPolygons(ClipperLib.ClipType.ctUnion, a, b);
const minus = (a, b) => b.length ? clipPolygons(ClipperLib.ClipType.ctDifference, a, b) : a;
const within = (a, b) => clipPolygons(ClipperLib.ClipType.ctIntersection, a, b);
const circlePath = (c, r, n = 40) => Array.from({ length: n }, (_, i) => clip({ x: c.x + Math.cos(i/n*Math.PI*2)*r, z: c.z + Math.sin(i/n*Math.PI*2)*r }));
// open polylines ({x, z}[]) grown into a band `half` either side, round at the bends and square at the ends
function bandOf(lines, half) {
  const offset = new ClipperLib.ClipperOffset(2, 0.1*CLIPPER_SCALE);
  lines.forEach(pts => { if (pts.length >= 2) offset.AddPath(pts.map(clip), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenButt); });
  const out = [];
  offset.Execute(out, half*CLIPPER_SCALE);
  return out;
}
const piecesOf = paths => paths.map(fromClipperPath).filter(p => p.length >= 3);
function pointIn(poly, p) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x)*(p.z - a.z)/(b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function distToSegment(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx*abx + abz*abz;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x)*abx + (p.z - a.z)*abz)/l2)) : 0;
  return Math.hypot(p.x - a.x - abx*t, p.z - a.z - abz*t);
}
const distToLine = (p, pts) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i], pts[i+1])); return d; };

// polylines ({x, z}[])
const lengthOf = pts => pts.reduce((sum, p, i) => i ? sum + dist(pts[i-1], p) : 0, 0);
// the point at distance d along, and the way the line's going there
function pointAlong(pts, d) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i+1], l = dist(a, b);
    if (d <= l || i + 2 === pts.length) {
      const t = l ? Math.max(0, Math.min(1, d/l)) : 0;
      return { x: a.x + (b.x - a.x)*t, z: a.z + (b.z - a.z)*t, dx: l ? (b.x - a.x)/l : 1, dz: l ? (b.z - a.z)/l : 0 };
    }
    d -= l;
  }
  return { x: pts[0].x, z: pts[0].z, dx: 1, dz: 0 };
}
// the stretch from d0 along to d1 short of the end
function trimmed(pts, d0, d1) {
  const len = lengthOf(pts), a = Math.max(0, d0), b = len - Math.max(0, d1);
  if (b - a < 0.5) return null;
  const out = [pointAlong(pts, a)];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    acc += dist(pts[i], pts[i+1]);
    if (acc > a + 1e-6 && acc < b - 1e-6) out.push(pts[i+1]);
  }
  out.push(pointAlong(pts, b));
  return out.map(p => ({ x: p.x, z: p.z }));
}
// with a vertex at each of the distances `ds` along it (so a line offset from it has a vertex exactly beside each)
function withVertices(pts, ds) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = dist(pts[i], pts[i+1]);
    ds.filter(d => d > acc + 0.05 && d < acc + l - 0.05).sort((a, b) => a - b)
      .forEach(d => { const t = (d - acc)/l; out.push({ x: pts[i].x + (pts[i+1].x - pts[i].x)*t, z: pts[i].z + (pts[i+1].z - pts[i].z)*t }); });
    out.push(pts[i+1]);
    acc += l;
  }
  return out;
}
// the line `d` to its left (right, for negative d), mitred at the bends
function offsetLine(pts, d) {
  const normal = i => { const a = pts[i], b = pts[i+1], l = dist(a, b) || 1; return { x: -(b.z - a.z)/l, z: (b.x - a.x)/l }; };
  return pts.map((p, i) => {
    if (i === 0) { const n = normal(0); return { x: p.x + n.x*d, z: p.z + n.z*d }; }
    if (i === pts.length - 1) { const n = normal(i - 1); return { x: p.x + n.x*d, z: p.z + n.z*d }; }
    const n1 = normal(i - 1), n2 = normal(i), mx = n1.x + n2.x, mz = n1.z + n2.z, ml = Math.hypot(mx, mz) || 1;
    const scale = d/Math.max(0.5, (mx*n1.x + mz*n1.z)/ml);
    return { x: p.x + mx/ml*scale, z: p.z + mz/ml*scale };
  });
}
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = distToSegment(pts[i], pts[0], pts[pts.length-1]); if (d > worst) { worst = d; at = i; } }
  if (worst <= tol) return [pts[0], pts[pts.length-1]];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

// ---------------------------------------------------------- building parts
// A box in a frame (all six sides): centred on (u, v), `hu` along and `hv` across, from y0 to y1.
function frameBox(b, F, u, v, hu, hv, y0, y1) {
  const c = (su, sv, y) => F.at(u + su*hu, v + sv*hv, y);
  const U = { x: F.dx, y: 0, z: F.dz }, V = { x: -F.dz, y: 0, z: F.dx }, neg = n => ({ x: -n.x, y: -n.y, z: -n.z });
  b.addQuad(c(1,-1,y0), c(1,1,y0), c(1,1,y1), c(1,-1,y1), U);
  b.addQuad(c(-1,1,y0), c(-1,-1,y0), c(-1,-1,y1), c(-1,1,y1), neg(U));
  b.addQuad(c(1,1,y0), c(-1,1,y0), c(-1,1,y1), c(1,1,y1), V);
  b.addQuad(c(-1,-1,y0), c(1,-1,y0), c(1,-1,y1), c(-1,-1,y1), neg(V));
  b.addQuad(c(-1,-1,y1), c(1,-1,y1), c(1,1,y1), c(-1,1,y1), { x: 0, y: 1, z: 0 });
  b.addQuad(c(-1,1,y0), c(1,1,y0), c(1,-1,y0), c(-1,-1,y0), { x: 0, y: -1, z: 0 });
}
// A bar from a to b ({x, y, z}), `w` square.
function bar(a, b, w) {
  const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z), len = d.length();
  const geo = new THREE.BoxGeometry(w, len, w);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return geo.translate((a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2);
}
// An upright quad on the ground segment p→q ({x, z}), from y0 to y1.
function wallQuad(b, p, q, y0, y1) {
  const len = dist(p, q) || 1, n = { x: -(q.z - p.z)/len, y: 0, z: (q.x - p.x)/len };
  b.addQuad({ x: p.x, y: y0, z: p.z }, { x: q.x, y: y0, z: q.z }, { x: q.x, y: y1, z: q.z }, { x: p.x, y: y1, z: p.z }, n);
}
// The flat tops of Clipper `paths` at y, into builder b (facing down, for a ceiling or a deck's underside).
function tops(b, paths, y, down) {
  if (paths.length) b.addTops(clipPolygons(ClipperLib.ClipType.ctUnion, paths, [], true), y, down);
}
// Each edge of closed Clipper `paths`, as {x, z} pairs.
const edgesOf = paths => paths.flatMap(path => path.map((P, i) => [fromClipperPath([P])[0], fromClipperPath([path[(i+1) % path.length]])[0]]));
// Which way off an edge p→q is outside a region (`inside` its tester): the edge's midpoint, its normal that way, and
// the point just off it that way — or null if both sides are in or both out.
function outsideOf(p, q, inside, reach = 0.4) {
  const len = dist(p, q);
  if (len < 1e-3) return null;
  const m = { x: (p.x + q.x)/2, z: (p.z + q.z)/2 }, n = { x: -(q.z - p.z)/len, z: (q.x - p.x)/len };
  const a = { x: m.x + n.x*reach, z: m.z + n.z*reach }, b = { x: m.x - n.x*reach, z: m.z - n.z*reach };
  const ia = inside(a.x, a.z), ib = inside(b.x, b.z);
  if (ia === ib) return null;
  return ia ? { m, n: { x: -n.x, z: -n.z }, out: b, len } : { m, n, out: a, len };
}

// ---------------------------------------------------------- the spine
// The middle of the zone, as a graph: the outline rasterised, thinned to a line one cell wide (Zhang–Suen), and read off
// as branches between junctions and ends. Each branch that reaches only a little past the junction it comes off — a
// corner's, or a nub in the outline — is dropped, again and again until none is left to drop; what's left is simplified,
// and each end is carried on out to the outline, where it's an entrance. Null if nothing worth following is left (a
// square: every branch is a corner's), for the straight concourse instead.
function spineOf(outline) {
  const xs = outline.map(p => p.x), zs = outline.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const h = Math.max(0.5, Math.min(2.5, Math.sqrt(Math.abs(polygonArea(outline)))/160));
  const nx = Math.ceil((maxX - minX)/h) + 3, nz = Math.ceil((maxZ - minZ)/h) + 3, x0 = minX - h, z0 = minZ - h, N = nx*nz;
  const cx = i => x0 + (i + 0.5)*h, cz = k => z0 + (k + 0.5)*h;
  const mask = new Uint8Array(N);
  for (let k = 0; k < nz; k++) {
    const z = cz(k), cross = [];
    outline.forEach((p, i) => { const q = outline[(i+1) % outline.length]; if ((p.z > z) !== (q.z > z)) cross.push(p.x + (q.x - p.x)*(z - p.z)/(q.z - p.z)); });
    cross.sort((a, b) => a - b);
    for (let c = 0; c + 1 < cross.length; c += 2) for (let i = Math.max(0, Math.ceil((cross[c] - x0)/h - 0.5)); i < nx && cx(i) <= cross[c+1]; i++) mask[k*nx + i] = 1;
  }
  // how far each cell is from the outline (exact squared distances: Felzenszwalb & Huttenlocher, by columns then rows)
  const f = new Float64Array(N), INF = 1e20;
  for (let j = 0; j < N; j++) f[j] = mask[j] ? INF : 0;
  const pass = (count, stride, step, len) => {
    const g = new Float64Array(len), v = new Int32Array(len), zb = new Float64Array(len + 1), d = new Float64Array(len);
    for (let s = 0; s < count; s++) {
      const base = s*stride;
      for (let q = 0; q < len; q++) g[q] = f[base + q*step];
      let k = 0; v[0] = 0; zb[0] = -INF; zb[1] = INF;
      for (let q = 1; q < len; q++) {
        let sx = ((g[q] + q*q) - (g[v[k]] + v[k]*v[k]))/(2*q - 2*v[k]);
        while (sx <= zb[k]) { k--; sx = ((g[q] + q*q) - (g[v[k]] + v[k]*v[k]))/(2*q - 2*v[k]); }
        k++; v[k] = q; zb[k] = sx; zb[k+1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) { while (zb[k+1] < q) k++; d[q] = (q - v[k])*(q - v[k]) + g[v[k]]; }
      for (let q = 0; q < len; q++) f[base + q*step] = d[q];
    }
  };
  pass(nx, 1, nx, nz);
  pass(nz, nx, 1, nx);
  const dt = new Float32Array(N);
  for (let j = 0; j < N; j++) dt[j] = Math.sqrt(f[j])*h;
  const dtAt = p => { const i = Math.floor((p.x - x0)/h), k = Math.floor((p.z - z0)/h); return i < 0 || k < 0 || i >= nx || k >= nz ? 0 : dt[k*nx + i]; };

  // thinning
  const sk = mask.slice();
  const nb = j => [sk[j - nx], sk[j - nx + 1], sk[j + 1], sk[j + nx + 1], sk[j + nx], sk[j + nx - 1], sk[j - 1], sk[j - nx - 1]]; // P2..P9
  for (let changed = true, rounds = 0; changed && rounds < 400; rounds++) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const drop = [];
      for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) {
        const j = k*nx + i;
        if (!sk[j]) continue;
        const P = nb(j), B = P.reduce((s, x) => s + x, 0);
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let t = 0; t < 8; t++) if (!P[t] && P[(t+1) % 8]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (P[0]*P[2]*P[4] || P[2]*P[4]*P[6]) : (P[0]*P[2]*P[6] || P[0]*P[4]*P[6])) continue;
        drop.push(j);
      }
      drop.forEach(j => { sk[j] = 0; });
      if (drop.length) changed = true;
    }
  }
  // the skeleton's cells as a graph: 8-connected, but no diagonal step where there's a way round it by the side
  const adj = new Map();
  for (let j = 0; j < N; j++) {
    if (!sk[j]) continue;
    const list = [];
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      if (!di && !dk) continue;
      const o = j + dk*nx + di;
      if (!sk[o]) continue;
      if (di && dk && (sk[j + di] || sk[j + dk*nx])) continue;
      list.push(o);
    }
    adj.set(j, list);
  }
  // the nodes: every end, and every junction (touching junction cells are one)
  const nodeOf = new Map(), nodes = [];
  adj.forEach((list, j) => {
    if (list.length === 2 || nodeOf.has(j)) return;
    const id = nodes.length, cells = [j], stack = [j];
    nodeOf.set(j, id);
    if (list.length >= 3) while (stack.length) {
      const c = stack.pop();
      for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
        const o = c + dk*nx + di;
        if (adj.has(o) && adj.get(o).length >= 3 && !nodeOf.has(o)) { nodeOf.set(o, id); cells.push(o); stack.push(o); }
      }
    }
    const at = cells.reduce((s, c) => ({ x: s.x + cx(c % nx)/cells.length, z: s.z + cz(Math.floor(c/nx))/cells.length }), { x: 0, z: 0 });
    nodes.push({ id, x: at.x, z: at.z, dt: Math.max(...cells.map(c => dt[c])) });
  });
  const cellAt = c => ({ x: cx(c % nx), z: cz(Math.floor(c/nx)) });
  let edges = [];
  const walked = new Set();
  nodeOf.forEach((id, s) => adj.get(s).forEach(t => {
    if (walked.has(s + ',' + t) || nodeOf.get(t) === id) return;
    walked.add(s + ',' + t);
    const cells = [s, t];
    let prev = s, cur = t;
    for (let guard = 0; !nodeOf.has(cur) && guard < N; guard++) {
      const next = adj.get(cur).find(o => o !== prev);
      if (next == null) break;
      prev = cur; cur = next; cells.push(cur);
    }
    if (!nodeOf.has(cur)) return;
    walked.add(cur + ',' + prev);
    const pts = cells.map(cellAt);
    pts[0] = nodes[id]; pts[pts.length-1] = nodes[nodeOf.get(cur)];
    edges.push({ a: id, b: nodeOf.get(cur), pts: pts.map(p => ({ x: p.x, z: p.z })) });
  }));
  edges = edges.filter(e => e.a !== e.b);

  // prune, merging each node left with two branches into one branch through it, until nothing more goes
  const degrees = () => { const d = new Map(); edges.forEach(e => { d.set(e.a, (d.get(e.a) || 0) + 1); d.set(e.b, (d.get(e.b) || 0) + 1); }); return d; };
  const merge = () => {
    for (let again = true; again;) {
      again = false;
      const deg = degrees();
      for (const [id, n] of deg) {
        if (n !== 2) continue;
        const [e1, e2] = edges.filter(e => e.a === id || e.b === id);
        if (e1 === e2 || (e1.a === e2.a && e1.b === e2.b) || (e1.a === e2.b && e1.b === e2.a)) continue; // (a loop)
        const p1 = e1.b === id ? e1.pts : e1.pts.slice().reverse(), p2 = e2.a === id ? e2.pts : e2.pts.slice().reverse();
        const joined = { a: e1.b === id ? e1.a : e1.b, b: e2.a === id ? e2.b : e2.a, pts: [...p1, ...p2.slice(1)] };
        edges = edges.filter(e => e !== e1 && e !== e2).concat(joined);
        again = true;
        break;
      }
    }
  };
  merge();
  for (let round = 0; round < 40; round++) {
    const deg = degrees();
    const drop = edges.filter(e => {
      const la = deg.get(e.a) === 1, lb = deg.get(e.b) === 1;
      if (la === lb) return false;
      const leaf = nodes[la ? e.a : e.b], junction = nodes[la ? e.b : e.a];
      return dist(leaf, junction) - junction.dt < Math.max(PRUNE_MIN, 0.5*junction.dt);
    });
    if (!drop.length) break;
    edges = edges.filter(e => !drop.includes(e));
    merge();
  }
  if (!edges.length) return null;
  // the biggest piece that's left, by length
  const pieceOf = new Map();
  edges.forEach((e, i) => { pieceOf.set(e.a, pieceOf.get(e.a) ?? i); pieceOf.set(e.b, pieceOf.get(e.b) ?? i); });
  for (let changed = true; changed;) {
    changed = false;
    edges.forEach(e => { const m = Math.min(pieceOf.get(e.a), pieceOf.get(e.b)); if (pieceOf.get(e.a) !== m || pieceOf.get(e.b) !== m) { pieceOf.set(e.a, m); pieceOf.set(e.b, m); changed = true; } });
  }
  const lengths = new Map();
  edges.forEach(e => lengths.set(pieceOf.get(e.a), (lengths.get(pieceOf.get(e.a)) || 0) + lengthOf(e.pts)));
  const biggest = [...lengths].sort((a, b) => b[1] - a[1])[0][0];
  edges = edges.filter(e => pieceOf.get(e.a) === biggest);
  // the branches' widths, from the cells down their middles, for how wide the concourse can be
  const widths = edges.flatMap(e => e.pts.filter((p, i) => i % 3 === 0).map(dtAt)).sort((a, b) => a - b);
  const tol = Math.max(1.5, 0.06*widths[Math.floor(widths.length/2)]);
  edges.forEach(e => { e.pts = simplify(e.pts, tol); });
  return finishSpine(outline, nodes, edges, widths[Math.floor(widths.length*0.2)], dtAt);
}
// the spine's ends carried on out to the outline, and its nodes counted up: { nodes, edges, halfWidth, dtAt }
function finishSpine(outline, nodes, edges, halfWidth, dtAt) {
  const deg = new Map();
  edges.forEach(e => { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); });
  const used = [...deg.keys()].map(id => ({ ...nodes[id], deg: deg.get(id) }));
  const byId = new Map(used.map(n => [n.id, n]));
  used.forEach(n => {
    if (n.deg !== 1) return;
    const e = edges.find(e => e.a === n.id || e.b === n.id), fromEnd = e.b === n.id;
    const pts = fromEnd ? e.pts : e.pts.slice().reverse(), back = pointAlong(pts.slice().reverse(), Math.min(6, lengthOf(pts)));
    const dx = n.x - back.x, dz = n.z - back.z, l = Math.hypot(dx, dz) || 1, dir = { x: dx/l, z: dz/l };
    let hit = null;
    outline.forEach((p, i) => {
      const q = outline[(i+1) % outline.length], ex = q.x - p.x, ez = q.z - p.z, den = dir.x*ez - dir.z*ex;
      if (Math.abs(den) < 1e-9) return;
      const t = ((p.x - n.x)*ez - (p.z - n.z)*ex)/den, s = ((p.x - n.x)*dir.z - (p.z - n.z)*dir.x)/den;
      if (t > 0.01 && s >= 0 && s <= 1 && (!hit || t < hit)) hit = t;
    });
    if (hit == null) return;
    const E = { x: n.x + dir.x*hit, z: n.z + dir.z*hit };
    pts.push(E);
    e.pts = fromEnd ? pts : pts.reverse();
    Object.assign(n, { x: E.x, z: E.z, entrance: { x: E.x, z: E.z, dx: dir.x, dz: dir.z } });
  });
  edges.forEach((e, i) => { e.id = i; e.pts[0] = { x: byId.get(e.a).x, z: byId.get(e.a).z }; e.pts[e.pts.length-1] = { x: byId.get(e.b).x, z: byId.get(e.b).z }; });
  return { nodes: used, byId, edges, halfWidth, dtAt };
}
// One straight concourse down the long axis, end to end.
function straightSpine(outline) {
  const axis = longAxisOf(outline);
  let F = frameOf(centroid(outline), axis.dx, axis.dz);
  const uv = outline.map(F.uv), vMin = Math.min(...uv.map(p => p.v)), vMax = Math.max(...uv.map(p => p.v));
  F = frameOf(F.at(0, (vMin + vMax)/2), axis.dx, axis.dz);
  const span = spanAt(outline.map(F.uv), 0);
  if (!span) return null;
  const A = F.at(span[0], 0), B = F.at(span[1], 0), halfWidth = (vMax - vMin)/2;
  const nodes = [{ id: 0, x: A.x, z: A.z, dt: 0, deg: 1, entrance: { x: A.x, z: A.z, dx: -axis.dx, dz: -axis.dz } },
    { id: 1, x: B.x, z: B.z, dt: 0, deg: 1, entrance: { x: B.x, z: B.z, dx: axis.dx, dz: axis.dz } }];
  const edges = [{ id: 0, a: 0, b: 1, pts: [{ x: A.x, z: A.z }, { x: B.x, z: B.z }] }];
  return { nodes, byId: new Map(nodes.map(n => [n.id, n])), edges, halfWidth, dtAt: () => halfWidth };
}

// ---------------------------------------------------------- shop units
// One unit on `fp` ({x, z}[]), its floor at y0: walls round it but for its front (any edge on the concourse, `inC`),
// which is glass under a fascia board; a floor (upstairs), a ceiling, and a counter and a few stands inside.
function makeUnit(fp, inC, y0, kind, rng, level) {
  const group = new THREE.Group();
  group.name = 'Building';
  const top = y0 + MALL_LEVEL - 0.35;
  Object.assign(group.userData, { footprint: fp, height: y0 + MALL_LEVEL, base: y0, buildingKind: kind, mallLevel: level, batchable: true });
  const walls = createMeshBuilder(), glass = createMeshBuilder(), fascia = createMeshBuilder(), fittings = createMeshBuilder();
  const vacant = kind === 'vacant';
  let widest = null;
  fp.forEach((p, i) => {
    const q = fp[(i+1) % fp.length], side = outsideOf(p, q, (x, z) => !inC(x, z), 0.6);
    // (a front: the concourse just off it, the unit itself just the other side)
    if (side && inC(side.out.x, side.out.z) && side.len > 0.8) {
      wallQuad(vacant ? walls : glass, p, q, y0, top - 1.1); // (a vacant unit's boarded up)
      wallQuad(walls, p, q, top - 1.1, y0 + MALL_LEVEL);
      const F = frameOf(side.m, (q.x - p.x)/side.len, (q.z - p.z)/side.len), v = F.uv({ x: side.m.x + side.n.x, z: side.m.z + side.n.z }).v;
      frameBox(fascia, F, 0, Math.sign(v)*0.08, side.len/2 - 0.1, 0.1, top - 1.0, top - 0.2);
      if (!widest || side.len > widest.len) widest = { ...side, F, out: Math.sign(v) };
    } else if (dist(p, q) > 1e-3) wallQuad(walls, p, q, y0, y0 + MALL_LEVEL);
  });
  const path = [toClipperPath(fp)];
  tops(walls, path, top, true);       // the ceiling
  tops(walls, path, y0 + MALL_LEVEL); // and the roof or floor over it
  if (level > 0) tops(walls, path, y0 + 0.02);
  // inside, back from the widest front: a counter by the door and stands further in — enough that a lit shopfront has
  // something in it
  if (!vacant && widest) {
    const { F, out } = widest, deep = Math.max(...fp.map(p => -out*F.uv(p).v));
    const put = (u, v, hu, hv, hgt) => { if ([[-1,-1],[1,-1],[1,1],[-1,1]].every(([a, b]) => pointIn(fp, F.at(u + a*hu, v + b*hv)))) frameBox(fittings, F, u, v, hu, hv, y0, y0 + hgt); };
    put(-widest.len*0.25, -out*2.2, Math.min(1.2, widest.len*0.15), 0.4, 1.05);
    for (let k = 0; k < Math.max(1, Math.floor((deep - 5)/3)); k++) put((rng() - 0.5)*widest.len*0.3, -out*(4.5 + k*3), Math.min(1.4, widest.len*0.2), 0.45, kind === 'pub' ? 1.05 : 1.4);
  }
  const wallColor = INSIDE_WALLS[Math.floor(rng()*INSIDE_WALLS.length)];
  const colours = FASCIAS[kind] || FASCIAS.clothes;
  [
    meshOf(built(walls), plain(vacant ? 0xdad6cc : wallColor, { emissive: vacant ? 0x000000 : wallColor, emissiveIntensity: 0.12 }), 'Building'),
    meshOf(built(fascia), plain(colours[Math.floor(rng()*colours.length)], { roughness: 0.45 }), 'Building'),
    meshOf(built(fittings), plain([0x6b5a4a, 0xdedad2, 0x2f3338, 0xb9a27e][Math.floor(rng()*4)], { roughness: 0.6 }), 'Building'),
    meshOf(built(glass), glassMaterial(), 'Building', false),
  ].forEach(m => m && group.add(m));
  return group;
}
// What a unit is: vacant, or a clothes shop, a salon or a bar, by the zone's shares of each.
function kindOf(rng, s) {
  if (rng() < (s.mallVacant ?? 0.1)) return 'vacant';
  const shares = [['clothes', s.mallClothes ?? 0.55], ['salon', s.mallSalons ?? 0.25], ['pub', s.mallPubs ?? 0.2]];
  const total = shares.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return 'vacant';
  let r = rng()*total;
  return (shares.find(([, w]) => (r -= w) < 0) || shares[0])[0];
}

// The spine cut up into its straight segments, each with the way to cut across it at either end: square across at an
// end, and at a bend or a junction along the line halving the angle to the next segment round that side — so the pieces
// either side of every segment meet those of the next without a gap or an overlap.
function segmentsOf(spine) {
  const verts = new Map(), key = p => Math.round(p.x*100) + ',' + Math.round(p.z*100), segs = [];
  const vert = p => { const k = key(p); if (!verts.has(k)) verts.set(k, { x: p.x, z: p.z, out: [] }); return verts.get(k); };
  spine.edges.forEach(e => e.pts.forEach((p, i) => {
    if (!i || dist(e.pts[i-1], p) < 0.05) return;
    const a = vert(e.pts[i-1]), b = vert(p), ang = Math.atan2(b.z - a.z, b.x - a.x), seg = { a, b, ang, len: dist(a, b), edge: e };
    a.out.push({ ang, seg }); b.out.push({ ang: ang + Math.PI, seg });
    segs.push(seg);
  }));
  const wrap = x => ((x % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
  // at vertex v, heading `ang` out of it: the cut on its left and on its right
  const cuts = (v, ang) => {
    if (v.out.length < 2) return { left: ang + Math.PI/2, right: ang - Math.PI/2 };
    const others = v.out.map(o => wrap(o.ang - ang)).filter(d => d > 1e-6);
    const ccw = Math.min(...others), cw = Math.PI*2 - Math.max(...others);
    return { left: ang + ccw/2, right: ang - cw/2 };
  };
  segs.forEach(s => {
    const atA = cuts(s.a, s.ang), atB = cuts(s.b, s.ang + Math.PI);
    s.cut = { a: { 1: atA.left, [-1]: atA.right }, b: { 1: atB.right, [-1]: atB.left } };
  });
  return segs;
}
// A quad from segment points p0, p1 out along the angles a0, a1 (R long) — or, if those cross first, the triangle to
// where they cross.
function wedge(p0, p1, a0, a1, R) {
  const d0 = { x: Math.cos(a0), z: Math.sin(a0) }, d1 = { x: Math.cos(a1), z: Math.sin(a1) };
  const den = d0.x*d1.z - d0.z*d1.x;
  if (Math.abs(den) > 1e-9) {
    const wx = p1.x - p0.x, wz = p1.z - p0.z, s = (wx*d1.z - wz*d1.x)/den, t = (wx*d0.z - wz*d0.x)/den;
    if (s > 0 && t > 0 && s < R && t < R) return [p0, p1, { x: p0.x + d0.x*s, z: p0.z + d0.z*s }];
  }
  return [p0, p1, { x: p1.x + d1.x*R, z: p1.z + d1.z*R }, { x: p0.x + d0.x*R, z: p0.z + d0.z*R }];
}

// ---------------------------------------------------------- the mall
export function generateMallContent(zone, poly, cutouts, blockers) {
  const s = zone.settings;
  const ground = makeFlatZoneMesh(poly, s.mallFloorColor ?? 0xd8d2c6, Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
  if (ground) zone.buildingsGroup.add(ground);
  zone.doorSetback = 0;
  // the mall's outline: the zone less the roads and paths through it (the biggest piece, if they cut it in several), a
  // little in from its edge
  const piece = cutLotByCutouts(poly, blockers).pieces.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))[0];
  const outline = piece && insetPolygonExact(piece, EDGE)[0];
  if (!outline || Math.abs(polygonArea(outline)) < 400) return;
  const outlinePath = [toClipperPath(outline)], inOutline = createRegionTester(outlinePath);
  let spine = spineOf(outline);
  if (!spine || spine.edges.reduce((sum, e) => sum + lengthOf(e.pts), 0) < MIN_SPINE) spine = straightSpine(outline);
  if (!spine) return;
  // the concourse: as wide as asked, but leaving at least 6 m of shops either side
  const CW = Math.min((s.mallConcourse ?? 14)/2, spine.halfWidth - 6);
  if (CW < 3 || spine.edges.reduce((sum, e) => sum + lengthOf(e.pts), 0) < MIN_SPINE) return;
  const G = Math.max(2.5, Math.min(4, CW*0.5)), VH = CW - G; // the galleries' width, and half the void between them

  // ---- the courts: one where branches meet, and the food court — at the junction deepest in the zone, or else halfway
  // down the longest branch (which is split there, so it's a node like the rest)
  const courts = spine.nodes.filter(n => n.deg >= 3).map(n => ({ x: n.x, z: n.z, r: COURT*CW, node: n.id }));
  if (s.mallFoodCourt !== false) {
    let at = courts.map(c => ({ c, d: spine.dtAt(c) })).sort((a, b) => b.d - a.d)[0];
    if (!at) {
      const e = spine.edges.slice().sort((a, b) => lengthOf(b.pts) - lengthOf(a.pts))[0], half = lengthOf(e.pts)/2, mid = pointAlong(e.pts, half);
      const id = Math.max(...spine.nodes.map(n => n.id)) + 1, node = { id, x: mid.x, z: mid.z, dt: spine.dtAt(mid), deg: 2 };
      spine.nodes.push(node); spine.byId.set(id, node);
      const first = trimmed(e.pts, 0, half), second = trimmed(e.pts, half, 0);
      if (first && second) {
        spine.edges = spine.edges.filter(x => x !== e).concat([{ a: e.a, b: id, pts: first }, { a: id, b: e.b, pts: second }]);
        spine.edges.forEach((x, i) => { x.id = i; });
        const c = { x: mid.x, z: mid.z, r: COURT*CW, node: id };
        courts.push(c);
        at = { c, d: spine.halfWidth };
      }
    }
    if (at) {
      const r = Math.min(FOOD_COURT*CW, Math.max(at.d, spine.halfWidth) - 5);
      if (r > COURT*CW) at.c.r = r;
      at.c.food = true;
    }
  }
  const courtOf = id => courts.find(c => c.node === id);
  const courtPaths = rDelta => courts.map(c => circlePath(c, c.r + rDelta));
  const nearCourt = (p, pad) => courts.some(c => dist(p, c) < c.r + pad);

  // ---- the concourse, and upstairs its galleries round a void: the galleries stop short of the entrances, where it's open
  // from the floor to the glass
  const lines = spine.edges.map(e => {
    const na = spine.byId.get(e.a), nb = spine.byId.get(e.b);
    const out = e.pts.slice();
    if (na.entrance) out.unshift({ x: na.x - na.entrance.dx*3, z: na.z - na.entrance.dz*3 });
    if (nb.entrance) out.push({ x: nb.x + nb.entrance.dx*3, z: nb.z + nb.entrance.dz*3 });
    return out;
  });
  const C = within(union(bandOf(lines, CW), courtPaths(0)), outlinePath), inC = createRegionTester(C);
  const decks = spine.edges.map(e => trimmed(e.pts, spine.byId.get(e.a).entrance ? CW + 1 : 0, spine.byId.get(e.b).entrance ? CW + 1 : 0));
  const upperC = within(union(bandOf(decks.filter(Boolean), CW), courtPaths(0)), outlinePath);
  const voidPaths = union(bandOf(decks.filter(Boolean), VH), courtPaths(-G)), inVoid = createRegionTester(voidPaths);
  const deck0 = minus(upperC, voidPaths), inDeck0 = createRegionTester(deck0);

  // ---- the bridges across the void, each with a pair of escalators up to it: along the straight stretches clear of the
  // courts, one every BRIDGE_EVERY or so
  const L = MALL_LEVEL/ESCALATOR_SLOPE, BH = BRIDGE_HALF, bridges = [];
  spine.edges.forEach((e, ei) => {
    const deck = decks[ei];
    if (!deck) return;
    let acc = 0;
    for (let i = 0; i + 1 < deck.length; i++) {
      const a = deck[i], b = deck[i+1], len = dist(a, b), dx = (b.x - a.x)/len, dz = (b.z - a.z)/len;
      // (the longest stretch of it clear of every court)
      let run = null, from = null;
      for (let t = 0; t <= len + 1e-6; t += 0.5) {
        const clear = !nearCourt({ x: a.x + dx*t, z: a.z + dz*t }, 1);
        if (clear && from == null) from = t;
        if ((!clear || t + 0.5 > len) && from != null) { const to = clear ? t : t - 0.5; if (!run || to - from > run[1] - run[0]) run = [from, to]; from = null; }
      }
      if (run && run[1] - run[0] >= L + 2*BH + 4) {
        const [r0, r1] = run, n = Math.max(1, Math.floor((r1 - r0)/BRIDGE_EVERY));
        let before = r0;
        for (let k = 0; k < n; k++) {
          const t = r0 + (k + 0.5)*(r1 - r0)/n;
          const dir = t - BH - L - 1 >= before ? -1 : t + BH + L + 1 <= r1 ? 1 : 0;
          if (!dir) continue;
          bridges.push({ edge: ei, d: acc + t, at: { x: a.x + dx*t, z: a.z + dz*t }, dx, dz, dir });
          before = t + BH;
        }
      }
      acc += len;
    }
  });
  const upper = s.mallUpper !== false && bridges.length > 0 && VH >= 0.8;
  const levels = upper ? 2 : 1, HW = levels*MALL_LEVEL + PARAPET, ROOF = HW - 0.2, GLASS_TOP = ROOF + CLERESTORY;

  // ---- the units: either side of every segment of the spine, cut across every shop width, out to the walls
  const segs = segmentsOf(spine), W = Math.max(5, s.mallShopWidth ?? 10), R = spine.halfWidth*1.6 + CW + 10;
  const band = minus(within(outlinePath, insetPolygonExact(outline, UNIT_GAP).map(toClipperPath)), C);
  let claimed = [], index = 0;
  segs.forEach(seg => [1, -1].forEach(side => {
    const n = Math.max(1, Math.round(seg.len/W)), P = t => ({ x: seg.a.x + (seg.b.x - seg.a.x)*t/n, z: seg.a.z + (seg.b.z - seg.a.z)*t/n });
    const cutAt = k => k === 0 ? seg.cut.a[side] : k === n ? seg.cut.b[side] : seg.ang + side*Math.PI/2;
    for (let k = 0; k < n; k++, index++) {
      const shape = [wedge(P(k), P(k+1), cutAt(k), cutAt(k+1), R).map(clip)];
      const pieces = piecesOf(minus(within(band, shape), claimed));
      claimed = union(claimed, shape);
      pieces.forEach((fp, pi) => {
        if (Math.abs(polygonArea(fp)) < 25) return;
        const front = fp.some((p, i) => { const o = outsideOf(p, fp[(i+1) % fp.length], (x, z) => !inC(x, z), 0.6); return o && inC(o.out.x, o.out.z) && o.len > 2; });
        const gallery = fp.some((p, i) => {
          const o = outsideOf(p, fp[(i+1) % fp.length], (x, z) => !inC(x, z), 1.2);
          return o && o.len > 2 && inDeck0(o.out.x, o.out.z);
        });
        for (let level = 0; level < levels; level++) {
          // each unit on its own stream, as in a town, so one slider never reshuffles the rest
          const rng = mulberry32(((s.seed>>>0) ^ Math.imul(index+1, 0x9E3779B1) ^ Math.imul(pi+1, 0x85EBCA6B) ^ Math.imul(level+1, 0xC2B2AE35)) >>> 0);
          const kind = !front || (level > 0 && !gallery) ? 'vacant' : kindOf(rng, s);
          zone.buildingsGroup.add(makeUnit(fp, inC, level*MALL_LEVEL, kind, rng, level));
        }
      });
    }
  }));

  // ---- the shell: outer walls (glass doors at the entrances), the roof over the units, the glass over the concourse
  const shell = new THREE.Group();
  shell.name = 'MallShell';
  shell.userData.batchable = true;
  const walls = createMeshBuilder(), trim = createMeshBuilder(), glass = createMeshBuilder(), frame = createMeshBuilder(), roof = createMeshBuilder();
  const bars = [];
  const EH = Math.min(4, CW - 0.5), entrances = spine.nodes.filter(n => n.entrance).map(n => n.entrance);
  const doorway = p => entrances.some(E => { const dx = p.x - E.x, dz = p.z - E.z; return Math.abs(dx*E.dx + dz*E.dz) < 2.5 && Math.abs(-dx*E.dz + dz*E.dx) < EH; });
  outline.forEach((p, i) => {
    const q = outline[(i+1) % outline.length], len = dist(p, q), steps = Math.max(1, Math.ceil(len/0.5));
    let runStart = 0, runDoor = null;
    const flush = (t0, t1, door) => {
      if (t1 - t0 < 1e-6) return;
      const a = { x: p.x + (q.x - p.x)*t0, z: p.z + (q.z - p.z)*t0 }, b = { x: p.x + (q.x - p.x)*t1, z: p.z + (q.z - p.z)*t1 };
      if (door) { wallQuad(glass, a, b, 0, DOOR_H); wallQuad(walls, a, b, DOOR_H, HW - 0.6); }
      else wallQuad(walls, a, b, 0, HW - 0.6);
      wallQuad(trim, a, b, HW - 0.6, HW);
    };
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5)/steps, door = doorway({ x: p.x + (q.x - p.x)*t, z: p.z + (q.z - p.z)*t });
      if (runDoor === null) runDoor = door;
      if (door !== runDoor) { flush(runStart, k/steps, runDoor); runStart = k/steps; runDoor = door; }
    }
    flush(runStart, 1, runDoor);
  });
  // a canopy out over each entrance, on posts
  entrances.forEach(E => {
    const F = frameOf(E, E.dx, E.dz);
    frameBox(frame, F, 1.6, 0, 1.8, EH + 0.8, DOOR_H + 0.2, DOOR_H + 0.55);
    [-1, 1].forEach(sv => frameBox(frame, F, 3.1, sv*(EH + 0.5), 0.12, 0.12, 0, DOOR_H + 0.2));
  });
  // the flat roof over the units; over the concourse, a glass roof on glass walls up from it, and a dome over each court
  tops(roof, minus(outlinePath, C), ROOF);
  tops(glass, minus(C, courtPaths(0)), GLASS_TOP);
  edgesOf(C).forEach(([p, q]) => {
    wallQuad(glass, p, q, ROOF, GLASS_TOP);
    bars.push(bar({ ...p, y: GLASS_TOP }, { ...q, y: GLASS_TOP }, 0.14));
  });
  segs.forEach(seg => {
    const dx = (seg.b.x - seg.a.x)/seg.len, dz = (seg.b.z - seg.a.z)/seg.len;
    for (let t = 1.5; t < seg.len; t += 3) {
      const m = { x: seg.a.x + dx*t, z: seg.a.z + dz*t }, p = { x: m.x - dz*CW, y: GLASS_TOP, z: m.z + dx*CW }, q = { x: m.x + dz*CW, y: GLASS_TOP, z: m.z - dx*CW };
      if (!nearCourt(m, 0.5) && inOutline(p.x, p.z) && inOutline(q.x, q.z)) bars.push(bar(p, q, 0.1));
    }
  });
  courts.forEach(c => {
    const rise = c.r*(c.food ? 0.6 : 0.45);
    const dome = new THREE.SphereGeometry(c.r, 32, 8, 0, Math.PI*2, 0, Math.PI/2);
    dome.scale(1, rise/c.r, 1);
    glass.addGeometry(dome, c.x, GLASS_TOP, c.z);
    for (let k = 0; k < 12; k++) {
      const a = k/12*Math.PI*2, at = f => ({ x: c.x + Math.cos(a)*c.r*Math.cos(f), y: GLASS_TOP + rise*Math.sin(f), z: c.z + Math.sin(a)*c.r*Math.cos(f) });
      for (let j = 0; j < 6; j++) bars.push(bar(at(j/6*Math.PI/2), at((j+1)/6*Math.PI/2), 0.1));
    }
  });

  // ---- the ground lanes: down each branch by the shopfronts, in from an entrance or out to the middle of a court
  const lv = CW - LANE_IN, lanes = [];
  spine.edges.forEach(e => {
    const na = spine.byId.get(e.a), nb = spine.byId.get(e.b);
    const inset = n => n.entrance ? 4 : courtOf(n.id) ? Math.min(courtOf(n.id).r*0.6, lengthOf(e.pts)/3) : 0;
    const base = trimmed(e.pts, inset(na), inset(nb));
    if (!base) return;
    const ends = (n, first) => {
      if (n.entrance) {
        const E = n.entrance, inside = { x: E.x - E.dx*1, z: E.z - E.dz*1 }, outside = { x: E.x + E.dx*2, z: E.z + E.dz*2 };
        return first ? [outside, inside] : [inside, outside];
      }
      return courtOf(n.id) ? [{ x: n.x, z: n.z }] : [];
    };
    [1, -1].forEach(side => lanes.push([...ends(na, true), ...offsetLine(base, side*lv), ...ends(nb, false)]));
  });
  // and round the food court, just in front of the shops facing it: in arcs between where the lanes cross it, each
  // lane given a point there for the arcs to meet it at
  const foodCourt = courts.find(c => c.food);
  if (foodCourt) {
    const rr = foodCourt.r - 1.1, crossings = [];
    lanes.forEach(lane => {
      for (let i = 0; i + 1 < lane.length; i++) {
        const a = lane[i], b = lane[i+1], da = dist(a, foodCourt) - rr, db = dist(b, foodCourt) - rr;
        if ((da < 0) === (db < 0)) continue;
        // (where along a→b it's rr out, by bisection)
        let lo = 0, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi)/2, p = { x: a.x + (b.x - a.x)*m, z: a.z + (b.z - a.z)*m }; if ((dist(p, foodCourt) - rr < 0) === (da < 0)) lo = m; else hi = m; }
        const p = { x: a.x + (b.x - a.x)*lo, z: a.z + (b.z - a.z)*lo };
        lane.splice(i + 1, 0, p);
        crossings.push({ p, ang: Math.atan2(p.z - foodCourt.z, p.x - foodCourt.x) });
        break;
      }
    });
    crossings.sort((a, b) => a.ang - b.ang);
    if (crossings.length >= 2) crossings.forEach((a, i) => {
      const b = crossings[(i+1) % crossings.length];
      let span = b.ang - a.ang;
      if (span <= 0) span += Math.PI*2;
      const n = Math.max(2, Math.ceil(span*rr/3)), arc = [a.p];
      for (let k = 1; k < n; k++) arc.push({ x: foodCourt.x + Math.cos(a.ang + span*k/n)*rr, z: foodCourt.z + Math.sin(a.ang + span*k/n)*rr });
      arc.push(b.p);
      if (arc.every(p => inOutline(p.x, p.z))) lanes.push(arc);
    });
  }
  zone.walkGaps = lanes;
  const nearLane = (p, pad) => lanes.some(l => distToLine(p, l) < pad);

  // ---- upstairs: the galleries' decks, bridges and escalators, glass balustrades round the void, and columns under it
  const nets = [];
  if (upper) {
    const deckTop = MALL_LEVEL, deckBottom = MALL_LEVEL - 0.35, escalators = [], ramps = [];
    const bridgeRects = bridges.map(b => { const F = frameOf(b.at, b.dx, b.dz); return [[-BH, -VH - 0.3], [BH, -VH - 0.3], [BH, VH + 0.3], [-BH, VH + 0.3]].map(([u, v]) => clip(F.at(u, v))); });
    const lanesV = VH >= 1.4 ? [-0.65, 0.65] : [0];
    bridges.forEach(b => {
      const F = frameOf(b.at, b.dx, b.dz), uTop = b.dir*BH, uFoot = uTop + b.dir*L;
      // (the landing at the top of each pair, kept clear of the balustrade)
      escalators.push([[uTop, -1.3], [uTop + b.dir*1.2, -1.3], [uTop + b.dir*1.2, 1.3], [uTop, 1.3]].map(([u, v]) => clip(F.at(u, v))));
      lanesV.forEach(v => {
        const top = F.at(uTop, v, deckTop), foot = F.at(uFoot, v, Y_ZONE_GROUND), hw = ESCALATOR_W/2;
        const along = new THREE.Vector3(top.x - foot.x, top.y - foot.y, top.z - foot.z).normalize();
        const across = new THREE.Vector3(-F.dz, 0, F.dx), up = new THREE.Vector3().crossVectors(across, along);
        const truss = new THREE.BoxGeometry(Math.hypot(L, MALL_LEVEL) + 0.6, 0.6, ESCALATOR_W);
        truss.applyMatrix4(new THREE.Matrix4().makeBasis(along, up, across));
        bars.push(truss.translate((top.x + foot.x)/2, (top.y + foot.y)/2 - 0.32, (top.z + foot.z)/2));
        [-1, 1].forEach(sv => {
          const a = F.at(uTop, v + sv*hw), c = F.at(uFoot, v + sv*hw);
          glass.addQuad({ ...a, y: deckTop }, { ...c, y: Y_ZONE_GROUND }, { ...c, y: Y_ZONE_GROUND + 0.95 }, { ...a, y: deckTop + 0.95 }, { x: -F.dz, y: 0, z: F.dx });
          bars.push(bar({ ...a, y: deckTop + 1 }, { ...c, y: Y_ZONE_GROUND + 1 }, 0.08));
        });
        // for people: from the top (on the bridge's edge) down to the foot
        const steps = Math.ceil(L/0.5), pts = [], ys = [];
        for (let i = 0; i <= steps; i++) { const t = i/steps, p = F.at(uTop + (uFoot - uTop)*t, v); pts.push({ x: p.x, z: p.z }); ys.push(deckTop + (Y_ZONE_GROUND - deckTop)*t); }
        ramps.push({ pts, ys, top: pts[0], foot: pts[pts.length-1], end: false, lateral: 0.15, walk: hw - 0.2 });
      });
    });
    const deck = union(deck0, bridgeRects), inDeck = createRegionTester(deck), onLanding = createRegionTester(escalators), inUpperC = createRegionTester(upperC);
    tops(frame, deck, deckTop);
    tops(frame, deck, deckBottom, true);
    edgesOf(deck).forEach(([p, q]) => {
      wallQuad(frame, p, q, deckBottom, deckTop);
      // a balustrade wherever the deck's edge looks out over the void or the open concourse (not onto a shopfront, nor
      // off the top of an escalator)
      const o = outsideOf(p, q, inDeck, 0.3);
      if (!o || !inUpperC(o.out.x, o.out.z) && !inC(o.out.x, o.out.z) || onLanding(o.out.x, o.out.z)) return;
      wallQuad(glass, p, q, deckTop, deckTop + 1.05);
      bars.push(bar({ ...p, y: deckTop + 1.1 }, { ...q, y: deckTop + 1.1 }, 0.07));
    });
    // columns just back from the void's edge, every 9 m or so, clear of the lanes
    edgesOf(voidPaths).forEach(([p, q]) => {
      const o = outsideOf(p, q, inVoid, 0.35);
      if (!o) return;
      for (let t = 4.5; t < o.len; t += 9) {
        const c = { x: p.x + (q.x - p.x)*t/o.len + o.n.x*0.35, z: p.z + (q.z - p.z)*t/o.len + o.n.z*0.35 };
        if (!inDeck(c.x, c.z) || nearLane(c, 1.1) || onLanding(c.x, c.z)) continue;
        frameBox(trim, frameOf(c, (q.x - p.x)/o.len, (q.z - p.z)/o.len), 0, 0, 0.25, 0.25, 0, deckBottom);
      }
    });

    // for people: each branch's two galleries (with a point beside every bridge, which spans from one to the other) —
    // ending, at a court, on the ring round it, walked in arcs from gallery to gallery
    const gv = CW - G/2, galleries = [], spans = [], ringEnds = new Map();
    spine.edges.forEach((e, ei) => {
      const d = decks[ei];
      if (!d) return;
      const na = spine.byId.get(e.a), nb = spine.byId.get(e.b), onRing = n => { const c = courtOf(n.id); if (!c) return 0; const rg = c.r - G/2; return rg > gv ? Math.sqrt(rg*rg - gv*gv) : c.r; };
      const mine = bridges.filter(b => b.edge === ei);
      const base = trimmed(withVertices(d, mine.map(b => b.d)), onRing(na) + (na.entrance ? 0.5 : 0), onRing(nb) + (nb.entrance ? 0.5 : 0));
      if (!base) return;
      const own = [];
      [1, -1].forEach(side => {
        const line = offsetLine(base, side*gv);
        galleries.push(line); own.push(...line);
        [[na, line[0]], [nb, line[line.length-1]]].forEach(([n, p]) => {
          if (!courtOf(n.id)) return;
          if (!ringEnds.has(n.id)) ringEnds.set(n.id, []);
          ringEnds.get(n.id).push({ p, edge: ei });
        });
      });
      // (each bridge from the gallery's own point beside it on one side to the other's, so they're joined there)
      const nearest = q => own.reduce((best, p) => dist(p, q) < dist(best, q) ? p : best, own[0]);
      mine.forEach(b => spans.push([-gv, gv].map(v => nearest({ x: b.at.x - b.dz*v, z: b.at.z + b.dx*v }))));
    });
    ringEnds.forEach((ends, id) => {
      const c = courtOf(id), rg = c.r - G/2;
      ends.forEach(end => { end.ang = Math.atan2(end.p.z - c.z, end.p.x - c.x); });
      ends.sort((a, b) => a.ang - b.ang);
      ends.forEach((a, i) => {
        const b = ends[(i+1) % ends.length];
        if (ends.length < 2 || a.edge === b.edge) return; // (across a branch's own void)
        let span = b.ang - a.ang;
        if (span <= 0) span += Math.PI*2;
        const n = Math.max(2, Math.ceil(span*rg/3)), arc = [a.p];
        for (let k = 1; k < n; k++) arc.push({ x: c.x + Math.cos(a.ang + span*k/n)*rg, z: c.z + Math.sin(a.ang + span*k/n)*rg });
        arc.push(b.p);
        galleries.push(arc);
      });
    });
    nets.push({ H: deckTop, lateral: Math.max(0.3, G/2 - 0.9), walk: Math.max(0.4, G/2 - 0.3), decks: galleries, ramps: [], indoor: true });
    nets.push({ H: deckTop, lateral: 0.6, walk: BH - 0.3, decks: spans, ramps, indoor: true });
  }
  zone.mallNav = nets;

  // ---- the food court: kiosks round its edge between the branches coming into it, and tables and chairs in the middle
  const food = courts.find(c => c.food);
  zone.foodCourt = null;
  if (food) {
    const kiosks = createMeshBuilder(), furniture = createMeshBuilder(), tabletops = createMeshBuilder();
    const rng = mulberry32((s.seed>>>0) ^ 0x5F0DC0);
    const obstacles = [], seats = [];
    const inner = upper ? food.r - G - 0.3 : food.r - 1.2;
    // (which way each branch comes in, for the kiosks to keep out of the way of)
    const ways = spine.edges.filter(e => e.a === food.node || e.b === food.node).map(e => {
      const pts = e.a === food.node ? e.pts : e.pts.slice().reverse(), p = pointAlong(pts, Math.min(4, lengthOf(pts)));
      return Math.atan2(p.z - food.z, p.x - food.x);
    }).sort((a, b) => a - b);
    const rk = food.r - 3.4; // (their backs to the shops, clear of the walk round the court)
    ways.forEach((a, i) => {
      let gap = (ways[(i+1) % ways.length] ?? a + Math.PI*2) - a;
      if (gap <= 0) gap += Math.PI*2;
      const free = gap - 2*Math.asin(Math.min(1, (CW + 1)/rk)); // (less the branch's width either side)
      const count = Math.floor(free*rk/5.5);
      for (let k = 0; k < count; k++) {
        const ang = a + gap/2 + (k - (count - 1)/2)*5.5/rk, at = { x: food.x + Math.cos(ang)*rk, z: food.z + Math.sin(ang)*rk };
        if (!inC(at.x, at.z) || nearLane(at, 1.8)) continue;
        const F = frameOf(at, -Math.sin(ang), Math.cos(ang)), colour = KIOSKS[Math.floor(rng()*KIOSKS.length)], b = createMeshBuilder();
        frameBox(kiosks, F, 0, 0, 2, 0.5, Y_ZONE_GROUND, Y_ZONE_GROUND + 1.1);          // the counter
        frameBox(kiosks, F, 0, 1.2, 2, 0.08, Y_ZONE_GROUND, Y_ZONE_GROUND + 2.6);       // the back
        frameBox(b, F, 0, 1.1, 2.1, 0.12, Y_ZONE_GROUND + 2.6, Y_ZONE_GROUND + 3.2);    // its sign
        frameBox(b, F, 0, 0.2, 2.1, 0.9, Y_ZONE_GROUND + 2.3, Y_ZONE_GROUND + 2.4);     // and an awning out over the counter
        const mesh = meshOf(built(b), plain(colour, { roughness: 0.5, emissive: colour, emissiveIntensity: 0.25 }), 'MallKiosk');
        if (mesh) shell.add(mesh);
        obstacles.push({ x: at.x, z: at.z, r: 2.3 });
      }
    });
    // round tables in rows, four chairs each, clear of the lanes and the middle where they meet
    const step = 3.4;
    for (let x = -inner; x <= inner; x += step) for (let z = -inner; z <= inner; z += step) {
      const t = { x: food.x + x + (Math.round(z/step) % 2 ? step/2 : 0), z: food.z + z };
      if (dist(t, food) > inner - 1.2 || nearLane(t, 2) || dist(t, food) < 2.5 || !inOutline(t.x, t.z)) continue;
      const top = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 16), stem = new THREE.CylinderGeometry(0.06, 0.06, TABLE_TOP, 6);
      tabletops.addGeometry(top, t.x, Y_ZONE_GROUND + TABLE_TOP, t.z);
      furniture.addGeometry(stem, t.x, Y_ZONE_GROUND + TABLE_TOP/2, t.z);
      const turn = rng()*Math.PI/2;
      for (let k = 0; k < 4; k++) {
        const a = turn + k*Math.PI/2, cx = t.x + Math.cos(a)*0.85, cz = t.z + Math.sin(a)*0.85, nx = -Math.cos(a), nz = -Math.sin(a);
        const F = frameOf({ x: cx, z: cz }, -nz, nx);
        frameBox(furniture, F, 0, 0, 0.22, 0.22, SEAT_TOP - 0.05, SEAT_TOP);                         // seat
        frameBox(furniture, frameOf({ x: cx - nx*0.22, z: cz - nz*0.22 }, -nz, nx), 0, 0, 0.22, 0.03, SEAT_TOP, SEAT_TOP + 0.45); // back
        frameBox(furniture, F, 0, 0, 0.03, 0.03, Y_ZONE_GROUND, SEAT_TOP - 0.05);                   // leg
        seats.push({ x: cx, z: cz, y: SEAT_TOP, nx, nz });
      }
      obstacles.push({ x: t.x, z: t.z, r: 0.75 });
    }
    [
      meshOf(built(kiosks), plain(0xf1ede6, { roughness: 0.6 }), 'MallKiosk'),
      meshOf(built(furniture), plain(0x33373d, { roughness: 0.5, metalness: 0.3 }), 'MallFurniture'),
      meshOf(built(tabletops), plain(0xf4f1ea, { roughness: 0.4 }), 'MallFurniture'),
    ].forEach(m => m && shell.add(m));
    zone.foodCourt = { x: food.x, z: food.z, r: inner, seats, obstacles };
  }

  if (bars.length) frame.addGeometry(mergeGeometryList(bars), 0, 0, 0);
  [
    meshOf(built(walls), plain(s.mallWallColor ?? 0xd9d2c5, { roughness: 0.9 }), 'Building'),
    meshOf(built(trim), plain(s.mallAccentColor ?? 0x2f6f8f, { roughness: 0.5 }), 'Building'),
    meshOf(built(roof), plain(0x8a8d90, { roughness: 0.95 }), 'Building'),
    meshOf(built(frame), plain(FRAME, { roughness: 0.5, metalness: 0.4 }), 'Building'),
    meshOf(built(glass), glassMaterial(), 'MallGlass', false),
  ].forEach(m => m && shell.add(m));
  zone.buildingsGroup.add(shell);
}

Object.assign(App, { generateMallContent });
