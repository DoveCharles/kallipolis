import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { scene } from '../core/scene.js';

// ---------------------------------------------------------- fences & railings
// Fences (around parks, industrial lots) and railings (along bridges) are all built the same way: rails running along a
// line, and posts spaced evenly along it — carried over from one segment to the next, so a curve made of many short
// segments still gets evenly spaced posts rather than one at every bend.
const PARK_FENCE_STYLE = { height:1.1, rails:[1.05, 0.6], railWidth:0.08, railHeight:0.08, postSize:0.14, postSpacing:2.5, color:0x3a3d38 };
// one segment a→b ({x,z}) of a railing standing at baseY; `state` carries the distance since the last post between calls,
// and collects its pieces (see "fences as obstacles") in state.pieces, if given
export function addRailingSegment(builder, a, b, baseY, style, state) {
  const len = Math.hypot(b.x-a.x, b.z-a.z);
  if (len < 1e-3) return;
  const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len, n = Math.ceil(len/style.postSpacing);
  let s = style.postSpacing - (state.carry!=null ? state.carry : style.postSpacing);
  for (let k=0;k<n;k++) {
    const s0 = len*k/n, s1 = len*(k+1)/n, v0 = builder.vertexCount();
    style.rails.forEach(h => builder.addBox(a.x+dx*(s0+s1)/2, a.z+dz*(s0+s1)/2, dx, dz, (s1-s0)/2 + style.railWidth/2, style.railWidth/2, baseY+h-style.railHeight, baseY+h));
    for (; s <= s1; s += style.postSpacing) builder.addBox(a.x+dx*s, a.z+dz*s, dx, dz, style.postSize/2, style.postSize/2, baseY, baseY+style.height);
    state.pieces?.push({ a: { x: a.x+dx*s0, z: a.z+dz*s0 }, b: { x: a.x+dx*s1, z: a.z+dz*s1 }, y0: baseY, y1: baseY+style.height, v0, v1: builder.vertexCount(), color: style.color });
  }
  state.carry = len - (s - style.postSpacing);
}
// a railing along a polyline ({x,z}[]), ending in a post
export function addRailingLine(builder, line, baseY, style, pieces = null) {
  const state = { pieces };
  for (let i=0;i<line.length-1;i++) addRailingSegment(builder, line[i], line[i+1], baseY, style, state);
  const end = line[line.length-1], prev = line[line.length-2];
  const len = Math.hypot(end.x-prev.x, end.z-prev.z) || 1;
  if (state.carry > style.postSpacing*0.25) {
    builder.addBox(end.x, end.z, (end.x-prev.x)/len, (end.z-prev.z)/len, style.postSize/2, style.postSize/2, baseY, baseY+style.height);
    const last = pieces?.[pieces.length-1];
    if (last) last.v1 = builder.vertexCount(); // (the end post goes with the last piece)
  }
}
// open Clipper paths with the parts inside `gaps` (Clipper polygons) cut out
export function cutLines(lines, gaps) {
  if (!gaps.length) return lines;
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(lines, ClipperLib.PolyType.ptSubject, false);
  clipper.AddPaths(gaps, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.Clipper.OpenPathsFromPolyTree(tree).filter(line => line.length >= 2);
}
// a mesh of railings along polylines ({x,z}[]), each ending in a post
export function buildRailingMesh(lines, baseY, style, name) {
  const builder = createMeshBuilder(), pieces = [];
  lines.forEach(line => addRailingLine(builder, line, baseY, style, pieces));
  const geo = builder.build();
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: style.color, roughness: style.roughness!=null ? style.roughness : 0.8, metalness: style.metalness || 0 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = name;
  registerFence(mesh, pieces);
  return mesh;
}

// ---------------------------------------------------------- fences as obstacles
// Every railing's pieces ({ a, b, y0, y1, v0, v1, color }: its line, height and vertices), bucketed by FENCE_CELL.
// People walked by hand are held back by them unless jumping (holdAtFences); anyone knocked flat goes up and over them
// (fenceCrossed); cars smash them (life/fence-smash.js: a piece's `broken`). A mesh gone from the scene drops out.
const FENCE_CELL = 4;
const fenceMeshes = new Set();
let fenceGrid = null;
export function registerFence(mesh, pieces) {
  if (!pieces.length) return;
  pieces.forEach(piece => { piece.mesh = mesh; piece.broken = false; piece.hidden = 0; });
  mesh.userData.fencePieces = pieces;
  fenceMeshes.add(mesh);
  fenceGrid = null;
}
const inScene = o => { while (o.parent) o = o.parent; return o === scene; };
/** Every registered fence mesh still in the scene (dropping any that aren't). */
export function fenceMeshList() {
  for (const mesh of fenceMeshes) if (!inScene(mesh)) { fenceMeshes.delete(mesh); fenceGrid = null; }
  return fenceMeshes;
}
function gridOf() {
  if (fenceGrid) return fenceGrid;
  const meshes = fenceMeshList(); // (first: dropping a mesh gone from the scene clears fenceGrid)
  fenceGrid = new Map();
  meshes.forEach(mesh => mesh.userData.fencePieces.forEach(piece => {
    const x0 = Math.floor(Math.min(piece.a.x, piece.b.x)/FENCE_CELL), x1 = Math.floor(Math.max(piece.a.x, piece.b.x)/FENCE_CELL);
    const z0 = Math.floor(Math.min(piece.a.z, piece.b.z)/FENCE_CELL), z1 = Math.floor(Math.max(piece.a.z, piece.b.z)/FENCE_CELL);
    for (let cx=x0;cx<=x1;cx++) for (let cz=z0;cz<=z1;cz++) {
      const key = cx + ',' + cz;
      if (!fenceGrid.has(key)) fenceGrid.set(key, []);
      fenceGrid.get(key).push(piece);
    }
  }));
  return fenceGrid;
}
/** Each standing fence piece in the cells within `r` of (x, z) (one spanning cells may come twice). */
export function forFencesNear(x, z, r, fn) {
  const grid = gridOf(), span = Math.ceil(r/FENCE_CELL), cx = Math.floor(x/FENCE_CELL), cz = Math.floor(z/FENCE_CELL);
  for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) {
    const list = grid.get((cx+ox) + ',' + (cz+oz));
    if (list) for (const piece of list) if (!piece.broken) fn(piece);
  }
}
// (x, z) against a piece: how far along it (0-1, clamped), how far to its side (signed: + to its left), and that side's normal
export function fenceSideOf(piece, x, z) {
  const ux = piece.b.x - piece.a.x, uz = piece.b.z - piece.a.z, l = Math.hypot(ux, uz) || 1;
  const t = Math.max(0, Math.min(1, ((x - piece.a.x)*ux + (z - piece.a.z)*uz)/(l*l)));
  return { t, side: (ux*(z - piece.a.z) - uz*(x - piece.a.x))/l, nx: -uz/l, nz: ux/l };
}
const atHeight = (piece, y) => y > piece.y0 - 0.6 && y < piece.y1;
/** Where someone at height y walking from (x0, z0) to (x, z) is held: `r` off each fence piece, on the side they came from. */
export function holdAtFences(x0, z0, x, z, y, r) {
  forFencesNear(x, z, r + 1, piece => {
    if (!atHeight(piece, y)) return;
    const from = fenceSideOf(piece, x0, z0);
    if (Math.abs(from.side) < r*0.5) return; // (somehow in it already: let them out)
    const to = fenceSideOf(piece, x, z);
    if (to.t <= 0 || to.t >= 1) { // (round its ends)
      const c = to.t <= 0 ? piece.a : piece.b, d = Math.hypot(x - c.x, z - c.z);
      if (d < r && d > 1e-6) { x = c.x + (x - c.x)/d*r; z = c.z + (z - c.z)/d*r; }
      return;
    }
    const sign = Math.sign(from.side);
    if (to.side*sign < r) { const by = sign*r - to.side; x += to.nx*by; z += to.nz*by; }
  });
  return { x, z };
}
/** The first standing fence piece at height y that the move (x0, z0) → (x, z) goes across, or null. */
export function fenceCrossed(x0, z0, x, z, y) {
  let hit = null;
  forFencesNear(x, z, 1, piece => {
    if (hit || !atHeight(piece, y)) return;
    const from = fenceSideOf(piece, x0, z0), to = fenceSideOf(piece, x, z);
    if (Math.sign(from.side) !== Math.sign(to.side) && to.t > 0 && to.t < 1) hit = piece;
  });
  return hit;
}
// The lines a fence around `poly` (a zone's outline) should follow: the edge of its area — the outline minus the zones
// above it — pulled in by `inset`, with a gap wherever a road, river or path crosses it, and left off wherever it runs along
// water or a beach zone (that edge is a beach or an embankment instead).
function zoneFenceLines(zone, poly, inset) {
  const { ctDifference, ctUnion, ctIntersection } = ClipperLib.ClipType;
  const edge = App.offsetPaths(clipPolygons(ctDifference, [App.toClipperPath(poly)], App.zoneOutlinesAbove(zone)), -inset, ClipperLib.JoinType.jtMiter);
  if (!edge.length) return [];
  const loops = edge.map(path => path.concat([path[0]]));
  const reach = App.offsetPaths([App.toClipperPath(poly)], App.ZONE_CUTOUT_REACH + inset, ClipperLib.JoinType.jtRound);
  const crossings = clipPolygons(ctIntersection, clipPolygons(ctUnion, S.landCutFootprint, S.pathFootprint), reach);
  const water = clipPolygons(ctIntersection, clipPolygons(ctUnion, App.getWaterRegion(), App.getBeachZoneArea()), reach);
  const gaps = clipPolygons(ctUnion, crossings.length ? App.offsetPaths(crossings, 0.6, ClipperLib.JoinType.jtRound) : [],
    water.length ? App.offsetPaths(water, inset + 0.6, ClipperLib.JoinType.jtRound) : []);
  return cutLines(loops, gaps).map(App.fromClipperPath);
}

Object.assign(App, { PARK_FENCE_STYLE, buildRailingMesh, zoneFenceLines });
