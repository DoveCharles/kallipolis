import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ZONE_GROUND, computeWindowGlowFactor } from '../core/scene.js';
import { mulberry32, polygonArea } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder, disposeObject } from './roads.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { makeFlatZoneMesh } from '../zones/surface-detail.js';
import { buildFountain, makeFountainSpray } from '../zones/plazas.js';
import { buildingKey, buildingNumber } from '../buildings/footprints.js';
import { buildingName, buildingSign, buildingTypesReady } from '../buildings/building-types.js';
import { insetPolygonExact, toClipperPath, fromClipperPath, createRegionTester, offsetPaths, pathsArea } from '../zones/cutouts.js';

// ---------------------------------------------------------- shopping centre
// A mall is a kind of path (roadType 'mall'): drawn in the Paths tab like any other, its network is the concourse — one
// building round it, walked like the outdoors. Every end of it is an entrance, every node where three or more branches
// meet is a court under a glass dome, and any node marked a food court (right-click it) is a bigger court with tables and
// chairs, where people hang out as they do in a plaza (holder.foodCourts: see buildPeopleNav). The mall reaches its
// shops' depth either side of the concourse; a road through it cuts it in two, with an entrance either side of the road.
// Zones give way to it as they do to roads (see S.landCutFootprint in paths.js).
//
// Each mall's built into a holder of its own in S.malls — shaped like a zone as far as the rest of the app cares (an id,
// its buildingsGroup, walkGaps and so on: see buildingHolders in core/shared.js) — and only again when its network, its
// settings or the roads across it change, and never while a node's being dragged (see rebuildMalls).
//
// Shop units line the concourse on two storeys: each a building like any other (a clothes shop, a salon, a bar — a pub's
// layout — or a vacant unit), so people go in, the camera follows them, and each has its own card. The concourse is open
// to the glass roof down the middle; upstairs, a gallery runs in front of the upper shops on either side, round every
// court, with bridges across the void and escalators up to the bridges.
//
// People walk it on the ground by lanes down each branch by the shopfronts (holder.walkGaps, as a suburb's lanes: see
// buildPeopleNav), meeting in the middle of each court and coming out through the entrances onto whatever pavement's
// there; upstairs, by the galleries, bridges and escalators — all walked as a raised walkway is (holder.mallNav: the
// same shape as a raised network's nav in roads/raised.js). An upper unit keeps `base`, its floor's height, and its door
// is onto the gallery (see buildingDoors in peoplePathing.js).

export const MALL_LEVEL = 5;          // floor to floor
const EDGE = 0.4;                     // the mall's walls stand this far back from a road's pavement
const UNIT_GAP = 0.35;                // between the units' backs and the outer walls
const ROOM = { w: 8, d: 6 };           // a shop's room, deep by wide (see makeUnit)
const WALL_IN = 0.1;                  // a unit's walls, in from its lot (so neighbours' walls never meet in one place)
const PARAPET = 0.8;                  // outer walls above the units' roofs
const CLERESTORY = 1.3;               // the glass walls round the concourse, up from the units' roof to the glass roof
const DOOR_H = 4.2;                   // the entrances' glass, and the lintel over it
const LANE_IN = 1.8;                  // the ground lanes, in from the shopfronts
const COURT = 1.5;                    // a court's radius, in the concourse's half-widths
const FOOD_COURT = 2.6;               // and the food court's (if there's room)
const MIN_AREA = 400;                 // the least of a mall worth building (a piece a road leaves smaller is left empty)
// what a new mall path is, unless it takes after the one last selected (see input.js): its concourse is the line's width,
// and the rest is kept on each line of the network as `mall`
export const MALL_WIDTH = 14;
export const MALL_DEFAULTS = { depth: 14, shopWidth: 10, upper: true, clothes: 0.55, salons: 0.25, pubs: 0.2, vacant: 0.1, theme: 0, seed: 1 };
export const isMallLine = line => line.roadType === 'mall';
export const mallSettingsOf = line => ({ ...MALL_DEFAULTS, ...(line.mall || {}) });
const ESCALATOR_SLOPE = Math.tan(Math.PI/6), ESCALATOR_W = 1.1, BRIDGE_HALF = 1.5, BRIDGE_EVERY = 32;
const GLASS = 0xbfd9e6;
// Every mall's in a nineties colour scheme — its own by its seed, or the one picked in its settings (mallTheme, 1 on):
// the floor's two tiles (laid in a diagonal chequer), the piers between the shops with their inlaid stripe, and the
// accents — plinths, capitals, the galleries' edges, the outside's band — the roof's frame, the brass of the handrails,
// the columns, and the walls outside.
export const MALL_THEMES = [
  { name: 'Seafoam', neon: [0xff3fa4, 0x3ff2e0], tiles: [0xf7dfe6, 0xd2f1e9], pier: 0xfaf0e4, inlay: 0x55c1b3, accent: 0x2ea298, frame: 0xf2faf8, rail: 0xd9b35f, column: 0xf3a9bc, walls: 0xf4e1d2, flowers: [0xff7aa8, 0xffd23f, 0xffffff, 0xb07bea] },
  { name: 'Sunset', neon: [0xff7a2f, 0xc75cff], tiles: [0xfde7d0, 0xe6ddf7], pier: 0xfff5ea, inlay: 0xf39b78, accent: 0x8d6ad6, frame: 0xffffff, rail: 0xcaa55a, column: 0xbaa5ec, walls: 0xf7e2cb, flowers: [0xff8a5b, 0xffcf4a, 0xe25b9b, 0xffffff] },
  { name: 'Miami', neon: [0x3ff6ff, 0xff3f9e], tiles: [0xfff0f5, 0xcdf3f8], pier: 0xf2fcfb, inlay: 0x47c4d9, accent: 0xff6ea4, frame: 0x47c4d9, rail: 0xe3e5e8, column: 0x82d9e5, walls: 0xf9e7ef, flowers: [0xff4f94, 0xfff06a, 0x9b6bff, 0xffffff] },
  { name: 'Lemon', neon: [0xff3f6c, 0x3fb6ff], tiles: [0xfff7d1, 0xd8edfb], pier: 0xfffdf3, inlay: 0xf3c232, accent: 0x3a8ed8, frame: 0xfbfbfb, rail: 0xd3ae3a, column: 0xf6d35a, walls: 0xf8f0d5, flowers: [0xff6a6a, 0x4f8cff, 0xffd23f, 0xffffff] },
];
// polished tiles, in world space: a diagonal chequer of the theme's two colours, each tile a touch lighter or darker than
// the next, set in cream mortar
const MORTAR = 0xf1e6cc;
function applyTiles(mat, theme, size = 0.6) {
  const hex = c => { const v = new THREE.Color(c); return `vec3(${v.r.toFixed(4)}, ${v.g.toFixed(4)}, ${v.b.toFixed(4)})`; };
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMallPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMallPos = (modelMatrix*vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vMallPos;
float mallHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 q = vMallPos.xz/${size.toFixed(3)}, r = vec2(q.x + q.y, q.x - q.y)*0.70711, cell = floor(r);
  vec3 base = mix(${hex(theme.tiles[0])}, ${hex(theme.tiles[1])}, mod(cell.x + cell.y, 2.0))*(0.97 + 0.06*mallHash(cell));
  vec2 g = abs(fract(r) - 0.5);
  float joint = smoothstep(0.455, 0.47, max(g.x, g.y));
  diffuseColor.rgb = mix(base, ${hex(MORTAR)}, joint);
}`);
  };
  mat.customProgramCacheKey = () => 'mallTiles' + theme.name + size;
  return mat;
}
const tiled = theme => applyTiles(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.04 }), theme);
const INSIDE_WALLS = [0xf1ece2, 0xe8eef0, 0xf3e6e6, 0xe9f0e4, 0xeee8f4, 0xf4efe0];
const TABLE_TOP = 0.75, SEAT_TOP = Y_ZONE_GROUND + 0.45;
const LAMP_STRENGTH = 0.4, DOWNLIGHT_STRENGTH = 0.3; // (the lamps' light, as a share of a street lamp's: see streetlights.js)
// each shop's fascia: one colour, never the same as the shop's next door
const CLADDINGS = [0xff6ea4, 0x47c4d9, 0x8d6ad6, 0xf39b78, 0x2ea298, 0xf3c232, 0x3a8ed8, 0xe8505b, 0x7fcf6a, 0xb85ec9, 0x1d2340,
  0xff9f40, 0x5b6ee1, 0xd6336c, 0xf7f2e8, 0x14866d];
// and the lettering on it: each shop in one of these, by its number
const SIGN_FONTS = ['900 {px}px "Arial Black", Impact, sans-serif', 'italic bold {px}px "Brush Script MT", "Segoe Script", cursive',
  'bold {px}px "Comic Sans MS", "Chalkboard SE", cursive', 'bold {px}px Georgia, "Times New Roman", serif',
  'italic bold {px}px "Trebuchet MS", Verdana, sans-serif', 'bold {px}px "Courier New", monospace', '{px}px Impact, "Arial Narrow", sans-serif'];
// Something that glows, and more so after dark (see updateWindowGlowForSun in core/scene.js, which calls onGlow): neon
// tubes are bright even by day, the lamps only really come on at dusk.
function glowing(color, emissive, day, night) {
  const mat = new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.3, metalness: 0 });
  const set = f => { mat.emissiveIntensity = day + (night - day)*f; };
  mat.userData.baseEmissiveIntensity = night;
  mat.userData.onGlow = set;
  set(computeWindowGlowFactor(S.sunElevation));
  return mat;
}

const plain = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide, ...extra });
const glassMaterial = () => new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.28,
  side: THREE.DoubleSide, depthWrite: false });
// a shop window: tinted, and mostly what's reflected in it — the shop's still there behind it, just not laid bare
const shopGlass = () => new THREE.MeshStandardMaterial({ color: 0x8fb4c2, roughness: 0.05, metalness: 0.55, transparent: true, opacity: 0.6,
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

// ---------------------------------------------------------- shop units
// One unit on `fp` ({x, z}[]), its floor at y0: walls round it but for its front (any edge on the concourse, `inC`),
// which is glass under a fascia board; a floor (upstairs), a ceiling, and a counter and a few stands inside.
function makeUnit(lot, inC, y0, kind, rng, level, theme, piers, signs, cladding, key) {
  const group = new THREE.Group();
  group.name = 'Building';
  const top = y0 + MALL_LEVEL - 0.35;
  Object.assign(group.userData, { footprint: lot, height: y0 + MALL_LEVEL, base: y0, buildingKind: kind, mallLevel: level, batchable: true });
  // (lit, its light spilling out onto the concourse after dark: see streetlights.js)
  if (kind !== 'vacant') Object.assign(group.userData, { lobbyLight: 0.25, lobbyColor: new THREE.Color(0xfff1dc) });
  // its walls a little in from its lot, so a party wall is two walls with a gap between, never two drawn in one place
  const fp = insetPolygonExact(lot, WALL_IN)[0] || lot;
  const walls = createMeshBuilder(), glass = createMeshBuilder(), fascia = createMeshBuilder(), fittings = createMeshBuilder();
  const riser = createMeshBuilder(), brass = createMeshBuilder();
  const vacant = kind === 'vacant', RISER = 0.5;
  let widest = null;
  const fronts = fp.map((p, i) => {
    const q = fp[(i+1) % fp.length], side = outsideOf(p, q, (x, z) => !inC(x, z), 0.6);
    // (a front: the concourse just off it, the unit itself just the other side)
    return side && inC(side.out.x, side.out.z) && side.len > 0.8 ? side : null;
  });
  fp.forEach((p, i) => {
    const q = fp[(i+1) % fp.length], side = fronts[i];
    if (side) {
      // a shopfront: a tiled stallriser, glass above it in brass frames, and the fascia over, with its sign board
      const ux = (q.x - p.x)/side.len, uz = (q.z - p.z)/side.len, F = frameOf(side.m, ux, uz), out = Math.sign(F.uv({ x: side.m.x + side.n.x, z: side.m.z + side.n.z }).v);
      if (vacant) wallQuad(walls, p, q, y0, top - 1.1); // (boarded up)
      else {
        wallQuad(riser, p, q, y0, y0 + RISER);
        wallQuad(glass, p, q, y0 + RISER, top - 1.1);
        frameBox(brass, F, 0, out*0.03, side.len/2, 0.04, y0 + RISER - 0.04, y0 + RISER + 0.04);
        frameBox(brass, F, 0, out*0.03, side.len/2, 0.04, top - 1.14, top - 1.06);
        const bays = Math.max(1, Math.round(side.len/2.2));
        for (let k = 1; k < bays; k++) frameBox(brass, F, -side.len/2 + k*side.len/bays, out*0.03, 0.035, 0.04, y0 + RISER, top - 1.1);
      }
      wallQuad(walls, p, q, top - 1.1, y0 + MALL_LEVEL);
      frameBox(fascia, F, 0, out*0.08, side.len/2 - 0.1, 0.1, top - 1.0, top - 0.2);
      if (!widest || side.len > widest.len) widest = { ...side, F, out };
      // a pier where the front meets a party wall (see the piers in generateMall)
      [[p, fronts[(i + fp.length - 1) % fp.length], 1], [q, fronts[(i+1) % fp.length], -1]].forEach(([c, neighbour, into]) => {
        if (!neighbour) piers.push({ x: c.x, z: c.z, dx: ux*into, dz: uz*into, n: side.n, y0, top });
      });
    } else if (dist(p, q) > 1e-3) wallQuad(walls, p, q, y0, y0 + MALL_LEVEL);
  });
  // its room (see enterBuilding in interior.js): the old narrow one, 8 by 6, with its shopfront just behind the shop's own
  // widest front and facing out through it
  if (widest) {
    const back = ROOM.w/2 + 0.5;
    group.userData.room = { w: ROOM.w, d: ROOM.d, facing: { x: widest.n.x, z: widest.n.z }, at: { x: widest.m.x - widest.n.x*back, z: widest.m.z - widest.n.z*back } };
  }
  // its name, on its widest front's fascia (see signAtlas)
  if (widest && widest.len > 2) signs.push({ key, kind, m: widest.m, n: widest.n, len: widest.len, y: top - 0.6, cladding });
  const path = [toClipperPath(fp)];
  tops(walls, path, top, true);       // the ceiling (and from above, the roof: the floor over it is the next unit's)
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
  [
    meshOf(built(walls), plain(vacant ? 0xdad6cc : wallColor, { emissive: vacant ? 0x000000 : wallColor, emissiveIntensity: 0.12 }), 'Building'),
    meshOf(built(fascia), plain(cladding, { roughness: 0.45 }), 'Building'),
    meshOf(built(fittings), plain([0x6b5a4a, 0xdedad2, 0x2f3338, 0xb9a27e][Math.floor(rng()*4)], { roughness: 0.6 }), 'Building'),
    meshOf(built(riser), plain(rng() < 0.5 ? theme.inlay : theme.accent, { roughness: 0.35 }), 'Building'),
    meshOf(built(brass), plain(theme.rail, { roughness: 0.3, metalness: 0.7 }), 'Building'),
    meshOf(built(glass), shopGlass(), 'Building', false),
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

// ---------------------------------------------------------- the shops' names
// Every shop's name (its title in buildings.txt — a pub's "The Red Lion", a vacant unit's "TO LET" — else what it is)
// lettered onto its fascia: all of a mall's drawn once into one canvas, packed in rows, and each sign a quad showing its
// own bit of it — so however many shops, it's one texture and one draw. Lettering's dark on a light fascia and light on
// a dark one, in a typeface picked by the shop's number, and glows a little after dark.
const SIGN_H = 0.6, SIGN_PX = 64, ATLAS_W = 2048;
// a title's `font` (see buildingSign) as a canvas font: any of italic/oblique/bold/a weight at its start kept as its style
// (bold if it gives none), the rest the typeface, falling back to a plain sans-serif where the browser hasn't got it
function signFont(given) {
  const words = given.trim().split(/\s+/), style = [];
  while (words.length > 1 && /^(italic|oblique|bold|bolder|lighter|normal|[1-9]00)$/i.test(words[0])) style.push(words.shift());
  if (!style.some(w => /bold|lighter|normal|\d00/i.test(w))) style.push('bold');
  return `${style.join(' ')} {px}px "${words.join(' ').replace(/"/g, '')}", sans-serif`;
}
function signAtlas(signs) {
  if (!signs.length || typeof document === 'undefined') return null;
  const cells = signs.map(sg => {
    const number = buildingNumber(sg.key), w = Math.min(sg.len - 0.7, 6);
    const sign = buildingSign(sg.kind, number), text = sign.text || buildingName(sg.kind, number, 0);
    return { ...sg, number, w, text, sign, px: Math.max(SIGN_PX, Math.min(ATLAS_W, Math.round(SIGN_PX*w/SIGN_H))) };
  }).filter(c => c.w > 0.8 && c.text);
  // shelf packing: left to right, a new row whenever one's full
  let x = 0, y = 0;
  cells.forEach(c => { if (x + c.px > ATLAS_W) { x = 0; y += SIGN_PX; } c.ax = x; c.ay = y; x += c.px; });
  const H = y + SIGN_PX, canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  cells.forEach(c => {
    // (the title's own typeface and colour, where buildings.txt gives them: see buildingSign)
    const bg = new THREE.Color(c.cladding), light = bg.r*0.3 + bg.g*0.59 + bg.b*0.11 > 0.55;
    const font = c.sign.font ? signFont(c.sign.font) : SIGN_FONTS[c.number % SIGN_FONTS.length];
    const ink = c.sign.color ? new THREE.Color(c.sign.color) : null, inkLight = ink ? ink.r*0.3 + ink.g*0.59 + ink.b*0.11 > 0.55 : !light;
    let px = SIGN_PX*0.72;
    ctx.font = font.replace('{px}', px.toFixed(0));
    const width = ctx.measureText(c.text).width;
    if (width > c.px*0.92) { px *= c.px*0.92/width; ctx.font = font.replace('{px}', px.toFixed(0)); }
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, px*0.08);
    ctx.strokeStyle = inkLight ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.55)';
    ctx.fillStyle = ink ? c.sign.color : light ? '#1d2340' : '#fffaf0';
    ctx.strokeText(c.text, c.ax + c.px/2, c.ay + SIGN_PX/2 + 2);
    ctx.fillText(c.text, c.ax + c.px/2, c.ay + SIGN_PX/2 + 2);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // each sign a quad just proud of its fascia, reading left to right to someone facing the shop
  const pos = [], nor = [], uv = [], index = [];
  cells.forEach(c => {
    const right = { x: c.n.z, z: -c.n.x }, mid = { x: c.m.x + c.n.x*0.19, z: c.m.z + c.n.z*0.19 };
    const corner = (s, t) => [mid.x + right.x*s*c.w/2, c.y + t*SIGN_H/2, mid.z + right.z*s*c.w/2];
    const u0 = c.ax/ATLAS_W, u1 = (c.ax + c.px)/ATLAS_W, v1 = 1 - c.ay/H, v0 = 1 - (c.ay + SIGN_PX)/H, base = pos.length/3;
    [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]].forEach(([s, t, u, v]) => { pos.push(...corner(s, t)); nor.push(c.n.x, 0, c.n.z); uv.push(u, v); });
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mat = glowing(0xffffff, 0xffffff, 0.15, 0.7);
  Object.assign(mat, { map: texture, emissiveMap: texture, alphaTest: 0.4, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  mat.addEventListener('dispose', () => texture.dispose()); // (the canvas goes with the mall)
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'MallSigns';
  return mesh;
}
// buildings.txt read after the malls were built: their signs said what the shops are, not their names — so build them again
buildingTypesReady.then(() => { if (S.malls?.length) { builtAs.clear(); rebuildMalls(); } });

// ---------------------------------------------------------- the network as a spine
// A mall network's lines as a graph: its nodes where branches meet or end, or that are marked a food court (the path's
// own nodes, by id), and its edges the stretches of line between them, as points along the drawn path — a spline's
// curve and all. An end is an entrance, heading out the way the path does.
function spineOfNetwork(lines) {
  const degree = new Map();
  lines.forEach(l => l.nodeIds.forEach((id, i) => degree.set(id, (degree.get(id) || 0) + (i === 0 || i === l.nodeIds.length - 1 ? 1 : 2))));
  const isKey = id => degree.get(id) !== 2 || !!roadNodes[id]?.foodCourt;
  const nodes = new Map(), edges = [];
  const nodeOf = id => {
    if (!nodes.has(id)) { const n = roadNodes[id]; nodes.set(id, { id, x: n.x, z: n.z, deg: 0, food: !!n.foodCourt }); }
    return nodes.get(id);
  };
  lines.forEach(line => {
    const ids = line.nodeIds.filter(id => roadNodes[id]);
    if (ids.length < 2) return;
    const tess = tessellateOpenPath(ids.map(id => roadNodes[id]));
    // (where along the curve each node is: the nearest point, looking on from the last)
    let from = 0;
    const at = ids.map(id => {
      const n = roadNodes[id];
      let best = from;
      for (let k = from; k < tess.length; k++) if (dist(tess[k], n) < dist(tess[best], n)) best = k;
      from = best;
      return best;
    });
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (i < ids.length - 1 && !isKey(ids[i])) continue;
      const pts = tess.slice(at[start], at[i] + 1).map(p => ({ x: p.x, z: p.z }));
      pts[0] = { x: roadNodes[ids[start]].x, z: roadNodes[ids[start]].z };
      pts[pts.length - 1] = { x: roadNodes[ids[i]].x, z: roadNodes[ids[i]].z };
      if (pts.length >= 2 && lengthOf(pts) > 0.5) {
        edges.push({ a: ids[start], b: ids[i], pts });
        nodeOf(ids[start]).deg++; nodeOf(ids[i]).deg++;
      }
      start = i;
    }
  });
  nodes.forEach(n => {
    if (n.deg !== 1) return;
    const e = edges.find(e => e.a === n.id || e.b === n.id), pts = e.a === n.id ? e.pts.slice().reverse() : e.pts;
    const back = pointAlong(pts.slice().reverse(), Math.min(4, lengthOf(pts))), l = dist(n, back) || 1;
    n.entrance = { x: n.x, z: n.z, dx: (n.x - back.x)/l, dz: (n.z - back.z)/l };
  });
  return { nodes: [...nodes.values()], edges };
}
// The part of `spine` inside a piece of the mall (`inside` its test): an edge a road cuts across stops at the piece's
// edge, and a new end there is an entrance, facing out across the road.
function spineWithin(spine, inside) {
  const nodes = new Map(), edges = [];
  let cuts = 0;
  const keep = n => { if (!nodes.has(n.id)) nodes.set(n.id, { ...n, deg: 0 }); return nodes.get(n.id); };
  const cutAt = (a, b) => { // (a inside, b out: where between them it leaves, by bisection)
    let lo = 0, hi = 1;
    for (let k = 0; k < 30; k++) { const m = (lo + hi)/2; if (inside(a.x + (b.x - a.x)*m, a.z + (b.z - a.z)*m)) lo = m; else hi = m; }
    const x = a.x + (b.x - a.x)*lo, z = a.z + (b.z - a.z)*lo, l = dist(a, b) || 1;
    const n = { id: 'cut' + (cuts++), x, z, deg: 0, entrance: { x, z, dx: (b.x - a.x)/l, dz: (b.z - a.z)/l } };
    nodes.set(n.id, n);
    return n;
  };
  const byId = new Map(spine.nodes.map(n => [n.id, n]));
  // (a metre at a time: a straight stretch is just its two ends, which may both be under roads with mall between them;
  // each stretch left is simplified back to its own bends)
  const dense = pts => pts.flatMap((p, i) => {
    if (!i) return [p];
    const q = pts[i-1], n = Math.max(1, Math.ceil(dist(p, q)));
    return Array.from({ length: n }, (_, k) => ({ x: q.x + (p.x - q.x)*(k + 1)/n, z: q.z + (p.z - q.z)*(k + 1)/n }));
  });
  spine.edges.map(e => ({ ...e, pts: dense(e.pts) })).forEach(e => {
    let run = null, from = null;
    const finish = (to, last) => { if (run && lengthOf([...run, last]) > 1) { run.push({ x: last.x, z: last.z }); edges.push({ a: from.id, b: to.id, pts: simplify(run, 0.05) }); from.deg++; to.deg++; } run = null; };
    e.pts.forEach((p, i) => {
      const inNow = inside(p.x, p.z);
      if (i === 0) { if (inNow) { from = keep(byId.get(e.a)); run = [{ x: p.x, z: p.z }]; } return; }
      const q = e.pts[i-1], inBefore = inside(q.x, q.z);
      if (inBefore && !inNow) { const c = cutAt(q, p); finish(c, c); }
      else if (!inBefore && inNow) { const c = cutAt(p, q); from = c; run = [{ x: c.x, z: c.z }]; }
      if (inNow && run) { if (i === e.pts.length - 1) finish(keep(byId.get(e.b)), p); else run.push({ x: p.x, z: p.z }); }
    });
  });
  const used = [...nodes.values()].filter(n => n.deg > 0);
  used.forEach(n => { if (n.deg !== 1 && !String(n.id).startsWith('cut')) delete n.entrance; });
  return { nodes: used, byId: new Map(used.map(n => [n.id, n])), edges: edges.map((e, i) => ({ ...e, id: i })) };
}

// ---------------------------------------------------------- building the malls
// Each mall network's footprint: out to its shops' depth either side of the concourse (and round a food court, so its
// shops wrap round it), less the roads and rivers across it — worked out every time the paths are, for the zones to give
// way to (see paths.js). The malls themselves are built by rebuildMalls, from what's worked out here.
let footprints = new Map(); // networkId -> { lines, spine, paths (the footprint, as Clipper paths), key }
export function mallFootprints() {
  const networks = new Map();
  S.roadLines.forEach(line => {
    if (!isMallLine(line) || line.drawing || line.nodeIds.filter(id => roadNodes[id]).length < 2) return;
    if (!networks.has(line.networkId)) networks.set(line.networkId, []);
    networks.get(line.networkId).push(line);
  });
  const roads = S.riverFootprint?.length ? union(S.roadFootprint, S.riverFootprint) : S.roadFootprint;
  const roadsBack = roads.length ? offsetPaths(roads, EDGE, ClipperLib.JoinType.jtRound) : [];
  footprints = new Map();
  networks.forEach((lines, netId) => {
    const s = mallSettingsOf(lines[0]), CW = (lines[0].width || MALL_WIDTH)/2, half = CW + s.depth;
    const spine = spineOfNetwork(lines);
    if (!spine.edges.length) return;
    const foods = spine.nodes.filter(n => n.food && n.deg >= 2).map(n => circlePath(n, FOOD_COURT*CW + Math.min(s.depth, 10)));
    const band = union(bandOf(spine.edges.map(e => e.pts), half), foods);
    const paths = minus(band, roadsBack);
    const key = JSON.stringify([lines.map(l => [l.width, l.mall, l.nodeIds.map(id => { const n = roadNodes[id]; return [n.x, n.z, n.type, n.handleIn, n.handleOut, !!n.foodCourt]; })]),
      Math.round(pathsArea(paths)*10)]);
    footprints.set(netId, { lines, spine, paths, key, s, CW });
  });
  return [...footprints.values()].flatMap(f => f.paths);
}
// The malls, built (or built again) wherever what they're built from has changed — but not while a node's being dragged,
// which would build one over and over: they're left as they were till it's let go of, then built once.
const builtAs = new Map(); // networkId -> key it was last built from
let waiting = null;
S.malls = [];
export function rebuildMalls() {
  if (S.draggedNode != null) { if (!waiting) waiting = setTimeout(() => { waiting = null; rebuildMalls(); }, 150); return; }
  let changed = false;
  // gone, or changed: taken down
  S.malls = S.malls.filter(holder => {
    const f = footprints.get(holder.networkId);
    if (f && builtAs.get(holder.networkId) === f.key) return true;
    scene.remove(holder.buildingsGroup); disposeObject(holder.buildingsGroup);
    changed = true;
    return false;
  });
  [...builtAs.keys()].forEach(id => { if (!footprints.has(id)) builtAs.delete(id); });
  // new, or changed: built, a holder for each piece of it a road leaves
  footprints.forEach((f, netId) => {
    if (builtAs.get(netId) === f.key) return;
    builtAs.set(netId, f.key);
    changed = true;
    const pieces = piecesOf(f.paths).filter(p => Math.abs(polygonArea(p)) >= MIN_AREA)
      .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    pieces.forEach((outline, k) => {
      const inPiece = createRegionTester([toClipperPath(outline)]);
      const spine = spineWithin(f.spine, inPiece);
      if (!spine.edges.length) return;
      const holder = { id: `mall-${netId}-${k}`, name: 'Mall', zoneType: 'mall', networkId: netId, closed: true, drawing: false,
        points: outline.map(p => ({ x: p.x, z: p.z, type: 'poly' })), settings: { ...toZoneSettings(f.s, f.CW), setback: 0, borderSetback: 0 },
        buildingsGroup: new THREE.Group(), walkGaps: null, mallNav: null, foodCourts: [], doorSetback: 0 };
      holder.buildingsGroup.name = 'Mall';
      generateMall(holder, outline, { ...spine, halfWidth: f.CW + f.s.depth }, f.CW);
      scene.add(holder.buildingsGroup);
      S.malls.push(holder);
    });
  });
  if (changed) { S.peopleNavDirty = true; App.updateStats?.(); }
}
const toZoneSettings = (s, CW) => ({ mallConcourse: CW*2, mallShopWidth: s.shopWidth, mallUpper: s.upper, mallClothes: s.clothes,
  mallSalons: s.salons, mallPubs: s.pubs, mallVacant: s.vacant, mallTheme: s.theme, seed: s.seed });

// ---------------------------------------------------------- the mall
function generateMall(zone, outline, spine, CW) {
  const s = zone.settings;
  const theme = MALL_THEMES[(s.mallTheme > 0 ? s.mallTheme - 1 : (s.seed >>> 0)) % MALL_THEMES.length];
  const ground = makeFlatZoneMesh(outline, 0xffffff, Y_ZONE_GROUND, 'MallFloor', mat => { mat.roughness = 0.22; mat.metalness = 0.04; applyTiles(mat, theme); });
  if (ground) zone.buildingsGroup.add(ground);
  const outlinePath = [toClipperPath(outline)], inOutline = createRegionTester(outlinePath);
  const G = Math.max(2.5, Math.min(4, CW*0.5)), VH = CW - G; // the galleries' width, and half the void between them

  // ---- the courts: one wherever branches meet, and a bigger one — the food court — at any node marked as one
  const courts = spine.nodes.filter(n => n.deg >= 3 || (n.food && n.deg >= 2))
    .map(n => ({ x: n.x, z: n.z, r: n.food ? Math.max(COURT*CW, FOOD_COURT*CW) : COURT*CW, node: n.id, food: !!n.food }));
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
  const segs = segmentsOf(spine), W = Math.max(5, s.mallShopWidth ?? 10), R = spine.halfWidth*1.6 + 10;
  const band = minus(within(outlinePath, insetPolygonExact(outline, UNIT_GAP).map(toClipperPath)), C);
  let claimed = [], index = 0;
  const piers = [], signs = [], lastCladding = [];
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
          let cladding = CLADDINGS[Math.floor(rng()*CLADDINGS.length)];
          if (cladding === lastCladding[level]) cladding = CLADDINGS[(CLADDINGS.indexOf(cladding) + 1 + Math.floor(rng()*(CLADDINGS.length - 1))) % CLADDINGS.length];
          lastCladding[level] = cladding;
          zone.buildingsGroup.add(makeUnit(fp, inC, level*MALL_LEVEL, kind, rng, level, theme, piers, signs, cladding, buildingKey(zone, zone.buildingsGroup.children.length)));
        }
      });
    }
  }));

  // ---- the shell: outer walls (glass doors at the entrances), the roof over the units, the glass over the concourse
  const shell = new THREE.Group();
  shell.name = 'MallShell';
  shell.userData.batchable = true;
  const walls = createMeshBuilder(), trim = createMeshBuilder(), glass = createMeshBuilder(), frame = createMeshBuilder(), roof = createMeshBuilder();
  const stripe = createMeshBuilder(), pierMain = createMeshBuilder(), pierInlay = createMeshBuilder(), columns = createMeshBuilder();
  const deckFloor = createMeshBuilder(), deckUnder = createMeshBuilder(), rails = createMeshBuilder(), steel = createMeshBuilder();
  const planters = createMeshBuilder(), soil = createMeshBuilder(), leaves = createMeshBuilder(), trunks = createMeshBuilder();
  const flowers = theme.flowers.map(() => createMeshBuilder());
  const bars = [], railBars = [];
  // the lights: neon tubes, by colour; and the lamps — globes on posts, downlights under the galleries, pendants in the
  // food court — every one of which lights the floor about it after dark (lampPosts: see streetlights.js)
  const neon = new Map(), lampPosts = [], globes = createMeshBuilder(), poles = createMeshBuilder();
  const tube = (color, a, b, w = 0.06) => { if (!neon.has(color)) neon.set(color, []); if (dist(a, b) > 0.02 || Math.abs(a.y - b.y) > 0.02) neon.get(color).push(bar(a, b, w)); };
  const lampPost = p => {
    poles.addGeometry(new THREE.CylinderGeometry(0.07, 0.1, 3.7, 10), p.x, Y_ZONE_GROUND + 1.85, p.z);
    poles.addGeometry(new THREE.CylinderGeometry(0.2, 0.24, 0.3, 12), p.x, Y_ZONE_GROUND + 0.15, p.z);
    globes.addGeometry(new THREE.SphereGeometry(0.24, 14, 10), p.x, Y_ZONE_GROUND + 4.0, p.z);
    for (let k = 0; k < 3; k++) {
      const a = k/3*Math.PI*2, q = { x: p.x + Math.cos(a)*0.5, z: p.z + Math.sin(a)*0.5 };
      poles.addGeometry(bar({ x: p.x, y: Y_ZONE_GROUND + 3.55, z: p.z }, { x: q.x, y: Y_ZONE_GROUND + 3.6, z: q.z }, 0.05), 0, 0, 0);
      globes.addGeometry(new THREE.SphereGeometry(0.19, 12, 8), q.x, Y_ZONE_GROUND + 3.8, q.z);
    }
    lampPosts.push({ x: p.x, z: p.z, y: 0, strength: LAMP_STRENGTH });
  };
  const pendant = (p, from, at) => {
    poles.addGeometry(bar({ x: p.x, y: from, z: p.z }, { x: p.x, y: at + 0.3, z: p.z }, 0.02), 0, 0, 0);
    poles.addGeometry(new THREE.CylinderGeometry(0.08, 0.42, 0.3, 14), p.x, at + 0.3, p.z);
    globes.addGeometry(new THREE.SphereGeometry(0.3, 14, 10), p.x, at, p.z);
    lampPosts.push({ x: p.x, z: p.z, y: 0, strength: LAMP_STRENGTH });
  };
  const EH = Math.min(4, CW - 0.5), entrances = spine.nodes.filter(n => n.entrance).map(n => n.entrance);
  const doorway = p => entrances.some(E => { const dx = p.x - E.x, dz = p.z - E.z; return Math.abs(dx*E.dx + dz*E.dz) < 2.5 && Math.abs(-dx*E.dz + dz*E.dx) < EH; });
  outline.forEach((p, i) => {
    const q = outline[(i+1) % outline.length], len = dist(p, q), steps = Math.max(1, Math.ceil(len/0.5));
    let runStart = 0, runDoor = null;
    const flush = (t0, t1, door) => {
      if (t1 - t0 < 1e-6) return;
      const a = { x: p.x + (q.x - p.x)*t0, z: p.z + (q.z - p.z)*t0 }, b = { x: p.x + (q.x - p.x)*t1, z: p.z + (q.z - p.z)*t1 };
      if (door) { wallQuad(glass, a, b, 0, DOOR_H); wallQuad(walls, a, b, DOOR_H, HW - 1.1); }
      else wallQuad(walls, a, b, 0, HW - 1.1);
      wallQuad(stripe, a, b, HW - 1.1, HW - 0.85); // (a stripe of the inlay's colour under the band)
      wallQuad(walls, a, b, HW - 0.85, HW - 0.6);
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
    tube(theme.neon[0], F.at(3.45, -EH - 0.8, DOOR_H + 0.37), F.at(3.45, EH + 0.8, DOOR_H + 0.37), 0.08); // (neon along its front)
    tube(theme.neon[1], F.at(-0.15, -EH, DOOR_H + 0.1), F.at(-0.15, EH, DOOR_H + 0.1), 0.07);            // (and over the doors inside)
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
    for (let k = 0; k < 48; k++) { // (a neon ring round the dome's foot)
      const a0 = k/48*Math.PI*2, a1 = (k+1)/48*Math.PI*2, r = c.r - 0.2;
      tube(theme.neon[1], { x: c.x + Math.cos(a0)*r, y: GLASS_TOP - 0.1, z: c.z + Math.sin(a0)*r }, { x: c.x + Math.cos(a1)*r, y: GLASS_TOP - 0.1, z: c.z + Math.sin(a1)*r }, 0.09);
    }
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
  // and round every court, just in front of the shops facing it: in arcs between where the lanes cross it, each lane
  // given a point there for the arcs to meet it at. A court with a fountain in the middle (any but the food court, if
  // there's room) keeps its lanes to the ring; in the food court they carry on in among the tables to its middle.
  courts.forEach(c => { if (!c.food && c.r - 4 >= 2.2) c.fountain = Math.min(3.4, c.r - 4); });
  const rings = [];
  courts.forEach(c => {
    const rr = c.r - 1.1, crossings = [];
    lanes.forEach((lane, li) => {
      for (let i = 0; i + 1 < lane.length; i++) {
        const a = lane[i], b = lane[i+1], da = dist(a, c) - rr, db = dist(b, c) - rr;
        if ((da < 0) === (db < 0)) continue;
        // (where along a→b it's rr out, by bisection)
        let lo = 0, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi)/2, p = { x: a.x + (b.x - a.x)*m, z: a.z + (b.z - a.z)*m }; if ((dist(p, c) - rr < 0) === (da < 0)) lo = m; else hi = m; }
        const p = { x: a.x + (b.x - a.x)*lo, z: a.z + (b.z - a.z)*lo };
        lane.splice(i + 1, 0, p);
        if (c.fountain) lanes[li] = da < 0 ? lane.slice(i + 1) : lane.slice(0, i + 2);
        crossings.push({ p, ang: Math.atan2(p.z - c.z, p.x - c.x) });
        break;
      }
    });
    crossings.sort((a, b) => a.ang - b.ang);
    if (crossings.length >= 2) crossings.forEach((a, i) => {
      const b = crossings[(i+1) % crossings.length];
      let span = b.ang - a.ang;
      if (span <= 0) span += Math.PI*2;
      const n = Math.max(2, Math.ceil(span*rr/3)), arc = [a.p];
      for (let k = 1; k < n; k++) arc.push({ x: c.x + Math.cos(a.ang + span*k/n)*rr, z: c.z + Math.sin(a.ang + span*k/n)*rr });
      arc.push(b.p);
      if (arc.every(p => inOutline(p.x, p.z))) rings.push(arc);
    });
  });
  lanes.push(...rings);
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
        steel.addGeometry(truss.translate((top.x + foot.x)/2, (top.y + foot.y)/2 - 0.32, (top.z + foot.z)/2), 0, 0, 0);
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
    tops(deckFloor, deck, deckTop);
    tops(deckUnder, deck, deckBottom, true);
    edgesOf(deck).forEach(([p, q]) => {
      wallQuad(trim, p, q, deckBottom, deckTop);
      // a balustrade wherever the deck's edge looks out over the void or the open concourse (not onto a shopfront, nor
      // off the top of an escalator)
      const o = outsideOf(p, q, inDeck, 0.3);
      if (!o || !inUpperC(o.out.x, o.out.z) && !inC(o.out.x, o.out.z) || onLanding(o.out.x, o.out.z)) return;
      wallQuad(glass, p, q, deckTop, deckTop + 1.05);
      railBars.push(bar({ ...p, y: deckTop + 1.1 }, { ...q, y: deckTop + 1.1 }, 0.08));
      // (and a neon tube along its edge, under the balustrade)
      const off = { x: o.n.x*0.05, z: o.n.z*0.05 };
      tube(theme.neon[0], { x: p.x + off.x, y: deckBottom + 0.14, z: p.z + off.z }, { x: q.x + off.x, y: deckBottom + 0.14, z: q.z + off.z });
    });
    // columns just back from the void's edge, every 9 m or so, clear of the lanes
    edgesOf(voidPaths).forEach(([p, q]) => {
      const o = outsideOf(p, q, inVoid, 0.35);
      if (!o) return;
      for (let t = 4.5; t < o.len; t += 9) {
        const c = { x: p.x + (q.x - p.x)*t/o.len + o.n.x*0.35, z: p.z + (q.z - p.z)*t/o.len + o.n.z*0.35 };
        if (!inDeck(c.x, c.z) || nearLane(c, 1.1) || onLanding(c.x, c.z)) continue;
        // (round, in the theme's colour, on a white base and under a flared white capital)
        columns.addGeometry(new THREE.CylinderGeometry(0.26, 0.26, deckBottom - 0.7, 16), c.x, 0.35 + (deckBottom - 0.7)/2, c.z);
        pierMain.addGeometry(new THREE.CylinderGeometry(0.36, 0.38, 0.35, 16), c.x, 0.175, c.z);
        pierMain.addGeometry(new THREE.CylinderGeometry(0.46, 0.27, 0.35, 16), c.x, deckBottom - 0.175, c.z);
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
    // a downlight under each gallery every few metres, over the shopfronts
    galleries.forEach(line => {
      const len = lengthOf(line);
      for (let d = 3; d < len - 1; d += 9) {
        const p = pointAlong(line, d);
        globes.addGeometry(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 14), p.x, deckBottom - 0.03, p.z);
        lampPosts.push({ x: p.x, z: p.z, y: 0, strength: DOWNLIGHT_STRENGTH });
      }
    });
    nets.push({ H: deckTop, lateral: 0.6, walk: BH - 0.3, decks: spans, ramps, indoor: true });
  }
  zone.mallNav = nets;

  // ---- the piers between the shops: thick, standing proud of the fronts, on a plinth in the accent colour with a stripe
  // of the inlay's up the face, a capital at the fascia and a cornice at the ceiling (one to a corner, however many units
  // share it)
  const placedPiers = [];
  piers.forEach(pr => {
    if (placedPiers.some(o => o.y0 === pr.y0 && dist(o, pr) < 1.3)) return; // (neighbours share a corner, near enough)
    placedPiers.push(pr);
    const F = frameOf(pr, pr.dx, pr.dz), out = Math.sign(F.uv({ x: pr.x + pr.n.x, z: pr.z + pr.n.z }).v) || 1;
    const box = (b, hu, v0, v1, y0, y1) => frameBox(b, F, 0, out*(v0 + v1)/2, hu, (v1 - v0)/2, y0, y1);
    // (their backs between the lot's front and the shop's, WALL_IN behind it, so no face is drawn where another is)
    const back = -WALL_IN/2;
    box(trim, 0.62, back, 0.6, pr.y0, pr.y0 + 0.35);               // plinth
    box(pierMain, 0.5, back, 0.45, pr.y0 + 0.35, pr.top);          // shaft
    box(pierInlay, 0.13, 0.44, 0.49, pr.y0 + 0.75, pr.top - 1.5);  // stripe
    box(trim, 0.6, back, 0.57, pr.top - 1.32, pr.top - 1.1);       // capital
    box(pierMain, 0.64, back, 0.62, pr.top - 0.08, pr.top + 0.12); // cornice
  });

  // ---- planters and pools down the middle of the concourse, clear of the lanes and the escalators: flower beds, every
  // other one with a palm, and every third a long pool with jets; and a fountain in every court but the food court, with
  // palms in pots round it
  const deco = mulberry32((s.seed>>>0) ^ 0x90FA11);
  const flower = (u, v, F, y) => { const p = F.at(u, v); flowers[Math.floor(deco()*flowers.length)].addGeometry(new THREE.IcosahedronGeometry(0.09 + deco()*0.05, 0), p.x, y, p.z); };
  const rod = (a, b, r0, r1) => {
    const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z), len = d.length();
    const geo = new THREE.CylinderGeometry(r1, r0, len, 8);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    return geo.translate((a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2);
  };
  const palm = (c, base) => {
    const h = 3.3 + deco()*1.4, lean = deco()*0.5, la = deco()*Math.PI*2, top = { x: c.x + Math.cos(la)*lean, y: base + h, z: c.z + Math.sin(la)*lean };
    const at = t => ({ x: c.x + (top.x - c.x)*t*t, y: base + h*t, z: c.z + (top.z - c.z)*t*t }); // (bending more towards the top)
    for (let i = 0; i < 7; i++) trunks.addGeometry(rod(at(i/7), at((i+1)/7), 0.2 - i*0.012, 0.15 - i*0.01), 0, 0, 0);
    const fronds = 8 + Math.floor(deco()*4);
    for (let j = 0; j < fronds; j++) {
      const frond = new THREE.BoxGeometry(0.45, 0.03, 2.3).translate(0, 0, 1.15);
      frond.rotateX(0.25 + deco()*0.45).rotateY(j/fronds*Math.PI*2 + deco()*0.3);
      leaves.addGeometry(frond, top.x, top.y, top.z);
    }
  };
  const planter = (F, hu, hv, withPalm) => {
    frameBox(planters, F, 0, 0, hu, hv, Y_ZONE_GROUND, Y_ZONE_GROUND + 0.5);
    frameBox(trim, F, 0, 0, hu + 0.07, hv + 0.07, Y_ZONE_GROUND + 0.5, Y_ZONE_GROUND + 0.6);
    frameBox(soil, F, 0, 0, hu - 0.08, hv - 0.08, Y_ZONE_GROUND + 0.6, Y_ZONE_GROUND + 0.64);
    for (let u = -hu + 0.5; u <= hu - 0.5 + 1e-6; u += 0.9) {
      const p = F.at(u, (deco() - 0.5)*hv*0.6);
      leaves.addGeometry(new THREE.IcosahedronGeometry(0.34 + deco()*0.12, 1).scale(1, 0.7, 1), p.x, Y_ZONE_GROUND + 0.82, p.z);
    }
    for (let k = 0; k < Math.round(hu*hv*9); k++) flower((deco()*2 - 1)*(hu - 0.2), (deco()*2 - 1)*(hv - 0.15), F, Y_ZONE_GROUND + 0.72 + deco()*0.3);
    if (withPalm) palm(F.at(0, 0), Y_ZONE_GROUND + 0.64);
  };
  const water = (shore, geo) => {
    const mat = new THREE.MeshStandardMaterial({ color: App.WATER_COLOR, roughness: 1 });
    App.applyWaterShader(mat, shore, [], 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'MallWater'; mesh.receiveShadow = true;
    zone.buildingsGroup.add(mesh);
  };
  const jet = (p, top, pool, reach) => {
    const spray = makeFountainSpray(new THREE.Vector3(p.x, top, p.z), pool, reach);
    spray.userData.sharedGeometry = false; spray.userData.sharedMaterial = false; // (its own: freed with the mall)
    zone.buildingsGroup.add(spray);
  };
  const pool = (F, hu, hv) => {
    const y0 = Y_ZONE_GROUND, rim = 0.28, H = 0.55;
    [[0, hv - rim/2, hu, rim/2], [0, -hv + rim/2, hu, rim/2], [hu - rim/2, 0, rim/2, hv - rim], [-hu + rim/2, 0, rim/2, hv - rim]]
      .forEach(([u, v, a, b]) => { frameBox(planters, F, u, v, a, b, y0, y0 + H); frameBox(trim, F, u, v, a + 0.04, b + 0.04, y0 + H, y0 + H + 0.08); });
    const iu = hu - rim, iv = hv - rim, corners = [F.at(-iu, -iv), F.at(iu, -iv), F.at(iu, iv), F.at(-iu, iv)];
    frameBox(pierInlay, F, 0, 0, iu, iv, y0, y0 + 0.05);
    const b = createMeshBuilder();
    b.addQuad(...corners.map(p => ({ x: p.x, y: y0 + H - 0.12, z: p.z })), { x: 0, y: 1, z: 0 });
    water(corners.map((p, i) => { const q = corners[(i+1) % 4]; return [p.x, p.z, q.x, q.z]; }), b.build());
    const jets = Math.max(1, Math.round(hu/1.6));
    for (let k = 0; k < jets; k++) {
      const u = -iu + (k + 0.5)*2*iu/jets, p = F.at(u, 0);
      steel.addGeometry(new THREE.CylinderGeometry(0.05, 0.08, 0.3, 8), p.x, y0 + H - 0.05, p.z);
      jet(p, y0 + 1.5, y0 + H - 0.12, Math.min(0.6, iv - 0.1));
    }
  };
  const bedW = Math.min(1.8, 2*(lv - 0.9) - 1.2);
  if (bedW >= 0.8) spine.edges.forEach((e, ei) => {
    const len = lengthOf(e.pts), na = spine.byId.get(e.a), nb = spine.byId.get(e.b), from = na.entrance ? CW + 1 : 0;
    const busy = bridges.filter(b => b.edge === ei).map(b => b.d + from), reserve = BH + L + 2.5;
    let k = Math.floor(deco()*3);
    for (let t = (na.entrance ? CW + 12 : 7); t < len - (nb.entrance ? CW + 12 : 7) + 1e-6; t += 12) {
      const at = pointAlong(e.pts, t), hu = 2.6, F = frameOf(at, at.dx, at.dz), ends = [F.at(-hu - 0.3, 0), F.at(hu + 0.3, 0)];
      if (nearCourt(at, 3) || busy.some(d => Math.abs(d - t) < reserve)) continue;
      if (!ends.every(p => inC(p.x, p.z)) || [at, ...ends].some(p => nearLane(p, bedW/2 + 0.8))) continue;
      const which = k++ % 3;
      if (which === 2) pool(F, hu, bedW/2 + 0.2); else planter(F, hu, bedW/2, which === 0);
      const post = F.at(hu + 0.8, 0);
      if (inC(post.x, post.z) && !nearLane(post, 0.9)) lampPost(post); // (a lamp post at its end)
    }
  });
  courts.forEach(c => {
    if (!c.fountain) return;
    zone.buildingsGroup.add(buildFountain({ x: c.x, z: c.z }, c.fountain, Y_ZONE_GROUND));
    for (let k = 0; k < 4; k++) {
      const a = k*Math.PI/2, p = { x: c.x + Math.cos(a)*(c.fountain + 1.4), z: c.z + Math.sin(a)*(c.fountain + 1.4) };
      if (!nearLane(p, 1) && inC(p.x, p.z)) lampPost(p);
    }
    for (let k = 0; k < 4; k++) {
      const a = Math.PI/4 + k*Math.PI/2, p = { x: c.x + Math.cos(a)*(c.fountain + 1.5), z: c.z + Math.sin(a)*(c.fountain + 1.5) };
      if (nearLane(p, 1.2) || !inC(p.x, p.z)) continue;
      pierMain.addGeometry(new THREE.CylinderGeometry(0.5, 0.36, 0.6, 14), p.x, Y_ZONE_GROUND + 0.3, p.z);
      soil.addGeometry(new THREE.CylinderGeometry(0.44, 0.44, 0.04, 14), p.x, Y_ZONE_GROUND + 0.6, p.z);
      palm(p, Y_ZONE_GROUND + 0.6);
    }
  });

  // ---- the food courts: tables and chairs in the middle (their stalls are the Objects tab's, put down wherever you like)
  zone.foodCourts = [];
  const furniture = createMeshBuilder(), tabletops = createMeshBuilder();
  courts.filter(c => c.food).forEach((food, fi) => {
    const rng = mulberry32((s.seed>>>0) ^ 0x5F0DC0 ^ Math.imul(fi + 1, 0x9E3779B1));
    const obstacles = [], seats = [];
    const inner = upper ? food.r - G - 0.3 : food.r - 1.2;
    // palms in big pots about the middle
    for (let k = 0; k < 4; k++) {
      const a = Math.PI/4 + k*Math.PI/2, p = { x: food.x + Math.cos(a)*inner*0.5, z: food.z + Math.sin(a)*inner*0.5 };
      if (nearLane(p, 1.6) || inner < 6) continue;
      pierMain.addGeometry(new THREE.CylinderGeometry(0.6, 0.42, 0.7, 14), p.x, Y_ZONE_GROUND + 0.35, p.z);
      soil.addGeometry(new THREE.CylinderGeometry(0.54, 0.54, 0.04, 14), p.x, Y_ZONE_GROUND + 0.7, p.z);
      palm(p, Y_ZONE_GROUND + 0.7);
      obstacles.push({ x: p.x, z: p.z, r: 0.9 });
    }
    // lamp posts between the palms, and lamps hung from the dome over the tables
    for (let k = 0; k < 4; k++) {
      const a = k*Math.PI/2, p = { x: food.x + Math.cos(a)*inner*0.5, z: food.z + Math.sin(a)*inner*0.5 };
      if (nearLane(p, 1.4) || inner < 6) continue;
      lampPost(p);
      obstacles.push({ x: p.x, z: p.z, r: 0.6 });
    }
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5)/8*Math.PI*2, p = { x: food.x + Math.cos(a)*inner*0.62, z: food.z + Math.sin(a)*inner*0.62 };
      pendant(p, GLASS_TOP + food.r*0.6*Math.sqrt(Math.max(0, 1 - 0.62*0.62*inner*inner/(food.r*food.r))), upper ? MALL_LEVEL + 2.5 : 5.5);
    }
    // round tables in rows, four chairs each, clear of the lanes and the middle where they meet
    const step = 3.4;
    for (let x = -inner; x <= inner; x += step) for (let z = -inner; z <= inner; z += step) {
      const t = { x: food.x + x + (Math.round(z/step) % 2 ? step/2 : 0), z: food.z + z };
      if (dist(t, food) > inner - 1.2 || nearLane(t, 2) || dist(t, food) < 2.5 || !inOutline(t.x, t.z) || obstacles.some(o => dist(t, o) < o.r + 1.2)) continue;
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
    zone.foodCourts.push({ x: food.x, z: food.z, r: inner, seats, obstacles });
  });
  [
    meshOf(built(furniture), plain(0x33373d, { roughness: 0.5, metalness: 0.3 }), 'MallFurniture'),
    meshOf(built(tabletops), plain(0xf4f1ea, { roughness: 0.4 }), 'MallFurniture'),
  ].forEach(m => m && shell.add(m));

  if (bars.length) frame.addGeometry(mergeGeometryList(bars), 0, 0, 0);
  if (railBars.length) rails.addGeometry(mergeGeometryList(railBars), 0, 0, 0);
  [
    meshOf(built(walls), plain(theme.walls, { roughness: 0.9 }), 'Building'),
    meshOf(built(trim), plain(theme.accent, { roughness: 0.45 }), 'Building'),
    meshOf(built(stripe), plain(theme.inlay, { roughness: 0.45 }), 'Building'),
    meshOf(built(roof), plain(0x9aa3a6, { roughness: 0.95 }), 'Building'),
    meshOf(built(frame), plain(theme.frame, { roughness: 0.4, metalness: 0.3 }), 'Building'),
    meshOf(built(pierMain), plain(theme.pier, { roughness: 0.4 }), 'Building'),
    meshOf(built(pierInlay), plain(theme.inlay, { roughness: 0.35 }), 'Building'),
    meshOf(built(columns), plain(theme.column, { roughness: 0.35 }), 'Building'),
    meshOf(built(deckFloor), tiled(theme), 'Building'),
    meshOf(built(deckUnder), plain(0xfbf8f2, { roughness: 0.8 }), 'Building'),
    meshOf(built(rails), plain(theme.rail, { roughness: 0.25, metalness: 0.75 }), 'Building'),
    meshOf(built(steel), plain(0xd3d8de, { roughness: 0.3, metalness: 0.6 }), 'Building'),
    meshOf(built(planters), plain(theme.column, { roughness: 0.4 }), 'MallPlanter'),
    meshOf(built(soil), plain(0x4a3524, { roughness: 1 }), 'MallPlanter'),
    meshOf(built(leaves), plain(0x3f9b4a, { roughness: 0.8 }), 'MallPlanter'),
    meshOf(built(trunks), plain(0x8a6a45, { roughness: 0.9 }), 'MallPlanter'),
    ...flowers.map((b, i) => meshOf(built(b), plain(theme.flowers[i], { roughness: 0.6, emissive: theme.flowers[i], emissiveIntensity: 0.12 }), 'MallPlanter')),
    meshOf(built(glass), glassMaterial(), 'MallGlass', false),
  ].forEach(m => m && shell.add(m));
  zone.buildingsGroup.add(shell);
  // (the lights on their own, left out of the merged meshes, since they glow more or less by the time of day)
  const lights = new THREE.Group();
  lights.name = 'MallLights';
  neon.forEach((list, color) => { const m = meshOf(mergeGeometryList(list), glowing(color, color, 0.7, 1.5), 'MallNeon', false); if (m) lights.add(m); });
  const lamps = meshOf(built(globes), glowing(0xfff6e0, 0xffe2b0, 0.2, 0.9), 'MallLamps', false);
  if (lamps) { lamps.userData.lampPosts = lampPosts; lights.add(lamps); }
  const posts = meshOf(built(poles), plain(theme.frame, { roughness: 0.35, metalness: 0.5 }), 'MallLamps');
  if (posts) lights.add(posts);
  const names = signAtlas(signs);
  if (names) lights.add(names);
  zone.buildingsGroup.add(lights);
}

Object.assign(App, { mallFootprints, rebuildMalls });
