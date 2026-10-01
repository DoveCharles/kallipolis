import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ZONE_GROUND, computeWindowGlowFactor, SKY_ENV_MAP } from '../core/scene.js';
import { mulberry32, polygonArea } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder, disposeObject } from './roads.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { makeFlatZoneMesh } from '../zones/surface-detail.js';
import { buildFountain, makeFountainSpray } from '../zones/plazas.js';
import { buildingKey, buildingNumber } from '../buildings/footprints.js';
import { buildingName, buildingSign, buildingTypesReady } from '../buildings/building-types.js';
import { hangingSign } from '../buildings/shop-signs.js';
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
// layout — a restaurant or a vacant unit), so people go in, the camera follows them, and each has its own card. The concourse is open
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
const WALL_T = 0.4;                   // the outer walls' thickness
const UNIT_GAP = WALL_T + 0.05;       // from the outside in to the units' backs
const ROOM = { w: 8, d: 6 };           // a shop's room, deep by wide (see makeUnit)
const WALL_IN = 0.1;                  // a unit's walls, in from its lot (so neighbours' walls never meet in one place)
const PARAPET = 0.8;                  // outer walls above the units' roofs
const CLERESTORY = 1.3;               // the walls round the concourse, up from the units' roof to the glass roof
const RIDGE_RISE = 0.5;               // the glass roof's ridge, above its eaves, in the concourse's half-widths
const DOOR_H = 4.2;                   // the entrances' glass, and the lintel over it
const LANE_IN = 1.8;                  // the ground lanes, in from the shopfronts
const COURT = 1.5;                    // a court's radius, in the concourse's half-widths
const FOOD_COURT = 2.6;               // and the food court's (if there's room)
const MIN_AREA = 400;                 // the least of a mall worth building (a piece a road leaves smaller is left empty)
// what a new mall path is, unless it takes after the one last selected (see input.js): its concourse is the line's width,
// and the rest is kept on each line of the network as `mall`
export const MALL_WIDTH = 14;
export const MALL_DEFAULTS = { depth: 14, shopWidth: 10, upper: true, clothes: 0.55, salons: 0.25, pubs: 0.2, restaurants: 0.15, convenience: 0.1, vacant: 0.1, theme: 0, seed: 1 };
export const isMallLine = line => line.roadType === 'mall';
export const mallSettingsOf = line => ({ ...MALL_DEFAULTS, ...(line.mall || {}) });
const ESCALATOR_SLOPE = Math.tan(Math.PI/6), ESCALATOR_W = 1.1, BRIDGE_HALF = 1.5, BRIDGE_EVERY = 32;
const ESCALATOR_SPEED = 0.6, BELT_STEP = 0.4; // (how fast the steps carry anyone on them, over the ground; and one step's depth)
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
// the next, set in warm grey mortar
const MORTAR = 0x8a8378;
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
// (the sky's reflection map for the sheen: see SKY_ENV_MAP in core/scene.js)
const shopGlass = () => new THREE.MeshStandardMaterial({ color: 0x8fb4c2, roughness: 0.04, metalness: 0.75, transparent: true, opacity: 0.78,
  envMap: SKY_ENV_MAP, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false });
// The escalators' steps, as one mesh: dark treads with a bright nosing, grooved along their length, the texture moving
// up each belt at the pace that carries people (ESCALATOR_SPEED, over the ground, so faster along the slope) — as fast
// as the people go (S.peopleSpeed).
function beltMesh(positions, uvs) {
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 32;
  const g = canvas.getContext('2d');
  g.fillStyle = '#44484e'; g.fillRect(0, 0, 16, 32);
  g.fillStyle = '#2a2d31'; for (let x = 1; x < 16; x += 2) g.fillRect(x, 0, 1, 32); // (grooves)
  g.fillStyle = '#c9ced4'; g.fillRect(0, 0, 16, 3);                              // (each step's nosing)
  g.fillStyle = '#e0b43a'; g.fillRect(0, 0, 1, 32); g.fillRect(15, 0, 1, 32);     // (yellow along the edges)
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter; texture.anisotropy = 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide });
  mat.addEventListener('dispose', () => texture.dispose());
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'MallEscalatorSteps'; mesh.receiveShadow = true;
  const alongSlope = Math.sqrt(1 + ESCALATOR_SLOPE**2); // (the belt's length for every metre over the ground)
  let last = performance.now();
  mesh.onBeforeRender = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last)/1000);
    last = now;
    texture.offset.y = (texture.offset.y - dt*ESCALATOR_SPEED*alongSlope*(S.peopleSpeed ?? 1)/BELT_STEP) % 1;
  };
  return mesh;
}

function meshOf(geo, mat, name, shadows = true) {
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = shadows; mesh.receiveShadow = true;
  return mesh;
}
// A shell mesh split at y: triangles wholly above it go into `tiles` (cell key -> group), by which ROOF_TILE square
// their middle's in, as meshes of their own (sharing its attributes) tagged to fade with the camera near
// (buildings/see-through.js) — tile by tile, so only the roof near the camera fades. Returns what's left below.
const ROOF_TILE = 12;
function splitRoof(mesh, y, tiles) {
  if (!mesh) return [];
  const geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index;
  const at = k => idx ? idx.getX(k) : k, low = [], high = new Map();
  for (let k = 0, n = idx ? idx.count : pos.count; k + 2 < n; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2);
    if (Math.min(pos.getY(a), pos.getY(b), pos.getY(c)) < y) { low.push(a, b, c); continue; }
    const key = Math.floor((pos.getX(a) + pos.getX(b) + pos.getX(c))/3/ROOF_TILE) + ',' + Math.floor((pos.getZ(a) + pos.getZ(b) + pos.getZ(c))/3/ROOF_TILE);
    if (!high.has(key)) high.set(key, []);
    high.get(key).push(a, b, c);
  }
  if (!high.size) return [mesh];
  const part = list => {
    const g = new THREE.BufferGeometry();
    Object.entries(geo.attributes).forEach(([name, attr]) => g.setAttribute(name, attr));
    g.setIndex(list);
    const m = new THREE.Mesh(g, mesh.material);
    m.name = mesh.name; m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
    return m;
  };
  high.forEach((list, key) => {
    if (!tiles.has(key)) {
      const tile = new THREE.Group();
      tile.name = 'MallRoof';
      tile.userData.batchable = true;
      tiles.set(key, tile);
    }
    const top = part(list);
    top.userData.fadesNear = true;
    tiles.get(key).add(top);
  });
  return low.length ? [part(low)] : [];
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
  // (its fascia the colour its title asks for, if it does: see buildingSign)
  const backcolor = kind === 'vacant' ? null : buildingSign(kind, buildingNumber(key), key).backcolor;
  if (backcolor) cladding = new THREE.Color(backcolor).getHex();
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
    return side && inC(side.out.x, side.out.z) && side.len > 0.05 ? side : null;
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
      if (side.len > 0.3) frameBox(fascia, F, 0, out*0.08, side.len/2 - 0.1, 0.1, top - 1.0, top - 0.2);
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
  // and its symbol on a sign hung out from the fascia near one end (see shop-signs.js)
  if (widest && !vacant && widest.len > 1.5) {
    const { m, n, F, len } = widest, u = -len/2 + 0.6;
    const place = new THREE.Matrix4().makeBasis(new THREE.Vector3(F.dx, 0, F.dz), new THREE.Vector3(n.x, 0, n.z), new THREE.Vector3(0, 1, 0))
      .setPosition(m.x + F.dx*u + n.x*0.18, top - 0.3, m.z + F.dz*u + n.z*0.18);
    hangingSign(kind, cladding).forEach(([geo, mat]) => group.add(meshOf(geo.applyMatrix4(place), mat, 'Building')));
  }
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
// What a unit is: vacant, or a clothes shop, a salon, a bar, a restaurant or a convenience store, by the zone's shares of each.
function kindOf(rng, s) {
  if (rng() < (s.mallVacant ?? 0.1)) return 'vacant';
  const shares = [['clothes', s.mallClothes ?? 0.55], ['salon', s.mallSalons ?? 0.25], ['pub', s.mallPubs ?? 0.2], ['restaurant', s.mallRestaurants ?? 0.15],
    ['convenience', s.mallConvenience ?? 0]];
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
// The shops' lots, cut from the concourse's own edge (Clipper paths `C`) rather than from the spine, so they meet it at
// its corners: each ring of it split into runs of shopfront at every sharp corner (and wherever it stops fronting shops,
// `inShops` — an entrance), a run too short for a shop joined onto its neighbour, and each run cut into lots about `W`
// wide, each reaching back from its front along the edge's normals (a corner's bisector, shared by the lots either side)
// `R` deep, or halfway to the concourse beyond from wherever along it that's nearest. Returns the runs, each a list of lots ({x, z}[]).
function lotsAlong(C, inShops, W, R) {
  const CORNER = 0.5, SHORT = 3;
  const rings = C.map(fromClipperPath).map(r => r.filter((p, i) => dist(p, r[(i + r.length - 1) % r.length]) > 0.05)).filter(r => r.length >= 3);
  const allEdges = rings.flatMap(r => r.map((p, i) => [p, r[(i+1) % r.length]]));
  // how far along d from o the concourse's edge is next (past where o itself is on it)
  const reach = (o, d) => {
    let best = R*2;
    allEdges.forEach(([a, b]) => {
      const ex = b.x - a.x, ez = b.z - a.z, den = d.x*ez - d.z*ex;
      if (Math.abs(den) < 1e-9) return;
      const wx = a.x - o.x, wz = a.z - o.z, t = (wx*ez - wz*ex)/den, u = (wx*d.z - wz*d.x)/den;
      if (t > 0.05 && u >= 0 && u <= 1 && t < best) best = t;
    });
    return Math.min(R, best/2);
  };
  const unit = v => { const l = Math.hypot(v.x, v.z); return l > 1e-6 ? { x: v.x/l, z: v.z/l } : null; };
  const runs = [];
  rings.forEach(ring => {
    const m = ring.length;
    // each edge's normal towards the shops, or null if there are none that side (an entrance, the outer wall)
    const normals = ring.map((p, i) => {
      const q = ring[(i+1) % m], l = dist(p, q), n = { x: -(q.z - p.z)/l, z: (q.x - p.x)/l }, mid = { x: (p.x + q.x)/2, z: (p.z + q.z)/2 };
      return inShops(mid.x + n.x*0.3, mid.z + n.z*0.3) ? n : inShops(mid.x - n.x*0.3, mid.z - n.z*0.3) ? { x: -n.x, z: -n.z } : null;
    });
    const dirOf = i => unit({ x: ring[(i+1) % m].x - ring[i].x, z: ring[(i+1) % m].z - ring[i].z });
    // a break at vertex i (between edges i-1 and i): a sharp corner, or a front starting or stopping
    const breaks = ring.map((p, i) => {
      const a = normals[(i + m - 1) % m], b = normals[i];
      if (!a || !b) return true;
      const da = dirOf((i + m - 1) % m), db = dirOf(i);
      return Math.acos(Math.max(-1, Math.min(1, da.x*db.x + da.z*db.z))) > CORNER || a.x*b.x + a.z*b.z < 0;
    });
    let start = breaks.indexOf(true);
    if (start < 0) start = 0;
    const ringRuns = [];
    let cur = null;
    for (let k = 0; k < m; k++) {
      const i = (start + k) % m;
      if (breaks[i] && cur) { ringRuns.push(cur); cur = null; }
      if (!normals[i]) continue;
      if (!cur) cur = { edges: [] };
      cur.edges.push(i);
    }
    if (cur) ringRuns.push(cur);
    // (a short run joined onto the one before it round the corner, or else the one after)
    const len = r => r.edges.reduce((sum, i) => sum + dist(ring[i], ring[(i+1) % m]), 0);
    const joined = (a, b) => (a.edges[a.edges.length - 1] + 1) % m === b.edges[0];
    for (let k = 0; k < ringRuns.length && ringRuns.length > 1; k++) {
      const r = ringRuns[k];
      if (len(r) >= SHORT) continue;
      const prev = ringRuns[(k + ringRuns.length - 1) % ringRuns.length], next = ringRuns[(k+1) % ringRuns.length];
      if (prev !== r && joined(prev, r)) { prev.edges.push(...r.edges); ringRuns.splice(k--, 1); }
      else if (next !== r && joined(r, next)) { next.edges.unshift(...r.edges); ringRuns.splice(k--, 1); }
    }
    ringRuns.forEach(r => {
      const e = r.edges, pts = [ring[e[0]], ...e.map(i => ring[(i+1) % m])];
      // the way back from each vertex: between its edges' normals — at the run's ends too, where the next run round the
      // corner shares it
      const rays = pts.map((p, j) => {
        const before = j > 0 ? normals[e[j-1]] : normals[(e[0] + m - 1) % m], after = j < e.length ? normals[e[j]] : normals[(e[e.length-1] + 1) % m];
        const own = j > 0 ? normals[e[j-1]] : normals[e[0]];
        return (before && after && unit({ x: before.x + after.x, z: before.z + after.z })) || own;
      });
      // cut into lots at even distances along it
      const total = len(r), n = Math.max(1, Math.round(total/W)), lots = [];
      let lot = [{ p: pts[0], d: rays[0] }], acc = 0, next = total/n;
      for (let j = 0; j < e.length; j++) {
        const a = pts[j], b = pts[j+1], l = dist(a, b), en = normals[e[j]];
        while (lots.length < n - 1 && next < acc + l - 0.05 && next > acc + 0.05) {
          const t = (next - acc)/l, c = { p: { x: a.x + (b.x - a.x)*t, z: a.z + (b.z - a.z)*t }, d: en };
          lot.push(c); lots.push(lot); lot = [c]; next += total/n;
        }
        if (lots.length < n - 1 && Math.abs(next - acc - l) <= 0.05) { lot.push({ p: b, d: rays[j+1] }); lots.push(lot); lot = [{ p: b, d: rays[j+1] }]; next += total/n; }
        else lot.push({ p: b, d: rays[j+1] });
        acc += l;
      }
      lots.push(lot);
      runs.push(lots.map(front => {
        // (as deep all along as it can be anywhere along: one side reaching far into a point it'd leave a spike)
        const f0 = front[0], f1 = front[front.length - 1], r0 = Math.min(...front.map(c => reach(c.p, c.d))), r1 = r0;
        // (where its two sides close in, as at a point between two branches, the lot's a triangle to where they meet)
        const den = f0.d.x*f1.d.z - f0.d.z*f1.d.x;
        if (Math.abs(den) > 1e-9) {
          const wx = f1.p.x - f0.p.x, wz = f1.p.z - f0.p.z, s = (wx*f1.d.z - wz*f1.d.x)/den, t = (wx*f0.d.z - wz*f0.d.x)/den;
          if (s > 0 && t > 0 && s < r0 && t < r1) return [...front.map(c => c.p), { x: f0.p.x + f0.d.x*s, z: f0.p.z + f0.d.z*s }];
        }
        const back = front.map(c => ({ x: c.p.x + c.d.x*r0, z: c.p.z + c.d.z*r0 }));
        return [...front.map(c => c.p), ...back.reverse()];
      }));
    });
  });
  return runs;
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
    const sign = buildingSign(sg.kind, number, sg.key), text = sign.text || buildingName(sg.kind, number, 0);
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
      // (a line drawn again over one already there, between the same two nodes, is the same stretch of mall: kept once)
      const len = lengthOf(pts), mid = pointAlong(pts, len/2);
      const twin = edges.some(e => (e.a === ids[start] && e.b === ids[i] || e.a === ids[i] && e.b === ids[start])
        && Math.abs(lengthOf(e.pts) - len) < 1 && dist(pointAlong(e.pts, lengthOf(e.pts)/2), mid) < 1);
      if (pts.length >= 2 && len > 0.5 && !twin) {
        edges.push({ a: ids[start], b: ids[i], pts });
        nodeOf(ids[start]).deg++; nodeOf(ids[i]).deg++;
      }
      start = i;
    }
  });
  // (two lines drawn end to end are one stretch: joined at a plain bend, so lanes and galleries run on round it)
  nodes.forEach(n => {
    if (n.deg !== 2 || n.food) return;
    const [e1, e2] = edges.filter(e => e.a === n.id || e.b === n.id);
    if (!e2) return;
    const p1 = e1.b === n.id ? e1.pts : e1.pts.slice().reverse(), p2 = e2.a === n.id ? e2.pts : e2.pts.slice().reverse();
    const a = e1.b === n.id ? e1.a : e1.b, b = e2.a === n.id ? e2.b : e2.a;
    Object.assign(e1, { a, b, pts: [...p1, ...p2.slice(1)] });
    edges.splice(edges.indexOf(e2), 1);
    nodes.delete(n.id);
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
  const onRoad = createRegionTester(S.roadFootprint);
  const prev = footprints;
  footprints = new Map();
  networks.forEach((lines, netId) => {
    const s = mallSettingsOf(lines[0]), CW = (lines[0].width || MALL_WIDTH)/2, half = CW + s.depth;
    const spine = spineOfNetwork(lines);
    if (!spine.edges.length) return;
    const foods = spine.nodes.filter(n => n.food && n.deg >= 2).map(n => circlePath(n, FOOD_COURT*CW + Math.min(s.depth, 10)));
    // (a disc where branches meet: their bands end square there, and any bend between them leaves a sliver open to
    // the node itself, which would then count as outside the mall)
    const joins = spine.nodes.filter(n => n.deg >= 2).map(n => circlePath(n, half));
    const band = union(bandOf(spine.edges.map(e => e.pts), half), [...foods, ...joins]);
    const paths = minus(band, roadsBack);
    const key = JSON.stringify([lines.map(l => [l.width, l.mall, l.nodeIds.map(id => { const n = roadNodes[id]; return [n.x, n.z, n.type, n.handleIn, n.handleOut, !!n.foodCourt]; })]),
      Math.round(pathsArea(paths)*10)]);
    const old = prev.get(netId);
    const bridges = old?.key === key ? old.bridges : entranceBridges(spine, paths, CW, onRoad);
    footprints.set(netId, { lines, spine, paths, key, s, CW, bridges });
    // (built over water by buildBridges like a path's footbridge, less the mall itself)
    if (bridges.length) S.pathBridgeSources.push({ networkId: netId, outline: bridges, cut: paths });
  });
  return [...footprints.values()].flatMap(f => f.paths);
}
// a concourse-wide strip out of each entrance facing a road, across the gap to its pavement (see EDGE)
function entranceBridges(spine, paths, CW, onRoad) {
  const toC = (x, z) => ({ X: Math.round(x*CLIPPER_SCALE), Y: Math.round(z*CLIPPER_SCALE) });
  const strips = spineWithin(spine, createRegionTester(paths)).nodes.filter(n => String(n.id).startsWith('cut'))
    .map(n => n.entrance).filter(e => onRoad(e.x + e.dx*(EDGE + 0.5), e.z + e.dz*(EDGE + 0.5)))
    .map(e => [[-0.3, -CW], [EDGE + 1.5, -CW], [EDGE + 1.5, CW], [-0.3, CW]].map(([a, w]) => toC(e.x + e.dx*a - e.dz*w, e.z + e.dz*a + e.dx*w)));
  return strips.length ? union(strips) : [];
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
  mallSalons: s.salons, mallPubs: s.pubs, mallRestaurants: s.restaurants ?? 0.15, mallConvenience: s.convenience ?? 0, mallVacant: s.vacant, mallTheme: s.theme, seed: s.seed });

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
  // (the void runs a metre past the decks' ends at the entrances, so the floor there is open-ended, not a sliver round
  // it that the triangulation drops the hole from)
  const voidLines = spine.edges.map((e, ei) => decks[ei] && trimmed(e.pts, spine.byId.get(e.a).entrance ? CW : 0, spine.byId.get(e.b).entrance ? CW : 0));
  const voidPaths = union(bandOf(voidLines.filter(Boolean), VH), courtPaths(-G)), inVoid = createRegionTester(voidPaths);
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

  // ---- the units: all along the concourse's edge, cut across every shop width, out to the walls (see lotsAlong)
  const segs = segmentsOf(spine), W = Math.max(5, s.mallShopWidth ?? 10), R = spine.halfWidth*1.6 + 10;
  const band = minus(within(outlinePath, insetPolygonExact(outline, UNIT_GAP).map(toClipperPath)), C);
  let claimed = [];
  const piers = [], signs = [], lastCladding = [], lots = [];
  lotsAlong(C, createRegionTester(band), W, R).forEach(run => {
    const kept = [];
    run.forEach(shape => {
      const path = [shape.map(clip)], pieces = piecesOf(minus(within(band, path), claimed));
      claimed = union(claimed, path);
      pieces.forEach(fp => {
        // (a sliver goes to the lot before it along the run, if they touch — never a hole in the row)
        if (Math.abs(polygonArea(fp)) < 25) {
          const prev = kept[kept.length - 1], merged = prev && piecesOf(union([toClipperPath(prev.fp)], [toClipperPath(fp)]));
          if (merged && merged.length === 1) prev.fp = merged[0];
          return;
        }
        kept.push({ fp });
      });
    });
    lots.push(...kept);
  });
  lots.forEach(({ fp }, index) => {
    const front = fp.some((p, i) => { const o = outsideOf(p, fp[(i+1) % fp.length], (x, z) => !inC(x, z), 0.6); return o && inC(o.out.x, o.out.z) && o.len > 2; });
    const gallery = fp.some((p, i) => {
      const o = outsideOf(p, fp[(i+1) % fp.length], (x, z) => !inC(x, z), 1.2);
      return o && o.len > 2 && inDeck0(o.out.x, o.out.z);
    });
    for (let level = 0; level < levels; level++) {
      // each unit on its own stream, as in a town, so one slider never reshuffles the rest
      const rng = mulberry32(((s.seed>>>0) ^ Math.imul(index+1, 0x9E3779B1) ^ Math.imul(level+1, 0xC2B2AE35)) >>> 0);
      const kind = !front || (level > 0 && !gallery) ? 'vacant' : kindOf(rng, s);
      let cladding = CLADDINGS[Math.floor(rng()*CLADDINGS.length)];
      if (cladding === lastCladding[level]) cladding = CLADDINGS[(CLADDINGS.indexOf(cladding) + 1 + Math.floor(rng()*(CLADDINGS.length - 1))) % CLADDINGS.length];
      lastCladding[level] = cladding;
      zone.buildingsGroup.add(makeUnit(fp, inC, level*MALL_LEVEL, kind, rng, level, theme, piers, signs, cladding, buildingKey(zone, zone.buildingsGroup.children.length)));
    }
  });

  // ---- the shell: outer walls (glass doors at the entrances), the roof over the units, the glass over the concourse
  const shell = new THREE.Group();
  shell.name = 'MallShell';
  const roofTiles = new Map(); // (the shell's parts above the shops, in squares: see splitRoof)
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
  // (the outer walls are WALL_T thick: their faces outside, their faces in, capped along the top, and the doorways
  // through them lined — a reveal each side and a soffit over the glass)
  const innerOutline = insetPolygonExact(outline, WALL_T), inWalls = createRegionTester(innerOutline.map(toClipperPath));
  const faceRuns = (poly, flush) => poly.forEach((p, i) => {
    const q = poly[(i+1) % poly.length], len = dist(p, q), steps = Math.max(1, Math.ceil(len/0.5));
    let runStart = 0, runDoor = null;
    const at = t => ({ x: p.x + (q.x - p.x)*t, z: p.z + (q.z - p.z)*t });
    for (let k = 0; k < steps; k++) {
      const door = doorway(at((k + 0.5)/steps));
      if (runDoor === null) runDoor = door;
      if (door !== runDoor) { if (k/steps > runStart) flush(at(runStart), at(k/steps), runDoor); runStart = k/steps; runDoor = door; }
    }
    flush(at(runStart), q, runDoor);
  });
  // (each face turned the way it looks — out, or in to the mall — whichever way round its outline runs: lit from behind,
  // a face catches its own shadow in a moiré)
  const outerWalls = createMeshBuilder(), outerStripe = createMeshBuilder(), outerTrim = createMeshBuilder();
  const facing = (a, b, looksOut) => {
    const len = dist(a, b) || 1, m = { x: (a.x + b.x)/2 - (b.z - a.z)/len*0.05, z: (a.z + b.z)/2 + (b.x - a.x)/len*0.05 };
    return looksOut(m) ? [a, b] : [b, a];
  };
  faceRuns(outline, (a0, b0, door) => {
    const [a, b] = facing(a0, b0, m => !inOutline(m.x, m.z));
    if (door) {
      wallQuad(glass, a, b, 0, DOOR_H); wallQuad(outerWalls, a, b, DOOR_H, HW - 1.1);
      const len = dist(a, b) || 1;
      let n = { x: -(b.z - a.z)/len, z: (b.x - a.x)/len };
      if (!inOutline(a.x/2 + b.x/2 + n.x*0.1, a.z/2 + b.z/2 + n.z*0.1)) n = { x: -n.x, z: -n.z };
      const ai = { x: a.x + n.x*WALL_T, z: a.z + n.z*WALL_T }, bi = { x: b.x + n.x*WALL_T, z: b.z + n.z*WALL_T };
      // (each reveal facing into the doorway)
      [[a, ai, b], [b, bi, a]].forEach(([e, ei, other]) => {
        const edge = { x: (e.x + ei.x)/2, z: (e.z + ei.z)/2 };
        wallQuad(outerWalls, ...facing(e, ei, m => dist(m, other) < dist(edge, other)), 0, DOOR_H);
      });
      outerWalls.addQuad({ ...a, y: DOOR_H }, { ...b, y: DOOR_H }, { ...bi, y: DOOR_H }, { ...ai, y: DOOR_H }, { x: 0, y: -1, z: 0 });
    }
    else wallQuad(outerWalls, a, b, 0, HW - 1.1);
    wallQuad(outerStripe, a, b, HW - 1.1, HW - 0.85); // (a stripe of the inlay's colour under the band)
    wallQuad(outerWalls, a, b, HW - 0.85, HW - 0.6);
    wallQuad(outerTrim, a, b, HW - 0.6, HW);
  });
  innerOutline.forEach(poly => faceRuns(poly, (a0, b0, door) => wallQuad(outerWalls, ...facing(a0, b0, m => inWalls(m.x, m.z)), door ? DOOR_H : 0, HW)));
  tops(outerTrim, minus(outlinePath, innerOutline.map(toClipperPath)), HW);
  // a canopy out over each entrance, on posts
  entrances.forEach(E => {
    const F = frameOf(E, E.dx, E.dz);
    frameBox(frame, F, 1.6, 0, 1.8, EH + 0.8, DOOR_H + 0.2, DOOR_H + 0.55);
    [-1, 1].forEach(sv => frameBox(frame, F, 3.1, sv*(EH + 0.5), 0.12, 0.12, 0, DOOR_H + 0.2));
    tube(theme.neon[0], F.at(3.45, -EH - 0.8, DOOR_H + 0.37), F.at(3.45, EH + 0.8, DOOR_H + 0.37), 0.08); // (neon along its front)
    tube(theme.neon[1], F.at(-0.15, -EH, DOOR_H + 0.1), F.at(-0.15, EH, DOOR_H + 0.1), 0.07);            // (and over the doors inside)
  });
  // the flat roof over the units; over the concourse, a glass roof on walls up from the tops of the shops — pitched, from
  // its edges up to a ridge down the middle — and a dome over each court, the two meeting wherever the dome comes down
  // below the roof (the roof stops there, and so does the dome)
  tops(roof, minus(outlinePath, C), ROOF);
  edgesOf(C).forEach(([p, q]) => {
    // (where the concourse comes to the outer wall, at an entrance, the wall's own face is there up to HW: from its top)
    const onOutline = !inWalls((p.x + q.x)/2, (p.z + q.z)/2);
    if (onOutline) {
      // (and there it's as thick as the wall under it, a closed box: a lone sheet in the sun shades itself in a moiré)
      const [a, b] = facing(p, q, m => !inOutline(m.x, m.z)), len = dist(a, b) || 1;
      const ai = { x: a.x + (b.z - a.z)/len*WALL_T, z: a.z - (b.x - a.x)/len*WALL_T }, bi = { x: b.x + (b.z - a.z)/len*WALL_T, z: b.z - (b.x - a.x)/len*WALL_T };
      [[outerWalls, HW, GLASS_TOP - 0.3], [outerTrim, GLASS_TOP - 0.3, GLASS_TOP]].forEach(([mb, y0, y1]) => {
        wallQuad(mb, a, b, y0, y1); wallQuad(mb, bi, ai, y0, y1); wallQuad(mb, ai, a, y0, y1); wallQuad(mb, b, bi, y0, y1);
      });
      outerTrim.addQuad({ ...a, y: GLASS_TOP }, { ...b, y: GLASS_TOP }, { ...bi, y: GLASS_TOP }, { ...ai, y: GLASS_TOP }, { x: 0, y: 1, z: 0 });
    } else {
      wallQuad(walls, p, q, levels*MALL_LEVEL, GLASS_TOP - 0.3);
      wallQuad(trim, p, q, GLASS_TOP - 0.3, GLASS_TOP);
    }
    bars.push(bar({ ...p, y: GLASS_TOP }, { ...q, y: GLASS_TOP }, 0.14));
  });
  const RIDGE = CW*RIDGE_RISE, riseOf = c => c.r*(c.food ? 0.6 : 0.45);
  const roofAt = p => GLASS_TOP + RIDGE*Math.max(0, 1 - Math.min(...lines.map(l => distToLine(p, l)))/CW);
  const domeAt = (c, p) => GLASS_TOP + riseOf(c)*Math.sqrt(Math.max(0, 1 - (dist(p, c)/c.r)**2));
  const glassAt = p => Math.max(roofAt(p), ...courts.map(c => domeAt(c, p)));
  // (how far out from a court's middle, at angle a, its dome stays above the roof: out to its foot, but for where a branch
  // comes in, whose roof it meets on the way down)
  const reach = (c, a) => {
    const at = d => ({ x: c.x + Math.cos(a)*d, z: c.z + Math.sin(a)*d }), over = d => domeAt(c, at(d)) > roofAt(at(d));
    let lo = 0, hi = c.r;
    for (let d = 0.25; d < c.r; d += 0.25) if (!over(d)) { hi = d; break; } else lo = d;
    for (let k = 0; k < 20; k++) { const m = (lo + hi)/2; if (over(m)) lo = m; else hi = m; }
    return hi;
  };
  const DOME_SIDES = 96, reaches = courts.map(c => Array.from({ length: DOME_SIDES }, (_, k) => reach(c, k/DOME_SIDES*Math.PI*2)));
  const domed = courts.length ? union(courts.map((c, i) => reaches[i].map((d, k) => clip({ x: c.x + Math.cos(k/DOME_SIDES*Math.PI*2)*d, z: c.z + Math.sin(k/DOME_SIDES*Math.PI*2)*d })))) : [];
  const underDome = createRegionTester(domed), roofed = minus(C, domed);
  // the roof: a plane either side of each stretch of each line, from the ridge over it down to the eaves CW off
  const roofTris = [];
  lines.forEach(line => [1, -1].forEach(side => {
    const eave = offsetLine(line, side*CW);
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i+1], len = dist(a, b);
      if (len < 1e-3) continue;
      const height = p => GLASS_TOP + RIDGE*(1 - Math.min(CW, Math.abs((b.x - a.x)*(p.z - a.z) - (b.z - a.z)*(p.x - a.x))/len)/CW);
      piecesOf(within([[a, b, eave[i+1], eave[i]].map(clip)], roofed)).forEach(poly => {
        const tris = THREE.ShapeUtils.triangulateShape(poly.map(p => new THREE.Vector2(p.x, p.z)), []);
        tris.forEach(t => roofTris.push(...t.map(j => ({ x: poly[j].x, y: height(poly[j]), z: poly[j].z }))));
      });
    }
  }));
  if (roofTris.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(roofTris.flatMap(p => [p.x, p.y, p.z]), 3));
    geo.computeVertexNormals();
    glass.addGeometry(geo, 0, 0, 0);
  }
  // glass gable ends, wherever the roof comes to the concourse's edge above the walls (at an entrance, or a road across)
  edgesOf(roofed).forEach(([p, q]) => {
    const n = Math.max(1, Math.ceil(dist(p, q)/0.5)), at = t => ({ x: p.x + (q.x - p.x)*t/n, z: p.z + (q.z - p.z)*t/n });
    for (let k = 0; k < n; k++) {
      const a = at(k), b = at(k + 1), ya = roofAt(a), yb = roofAt(b);
      if (Math.max(ya, yb) > GLASS_TOP + 0.02 && !underDome((a.x + b.x)/2, (a.z + b.z)/2))
        glass.addQuad({ ...a, y: GLASS_TOP }, { ...b, y: GLASS_TOP }, { ...b, y: yb }, { ...a, y: ya }, { x: -(b.z - a.z), y: 0, z: b.x - a.x });
    }
  });
  // its frame: a ridge beam, and rafters every 3 m from eave to ridge to eave
  lines.forEach(line => line.forEach((p, i) => {
    if (!i) return;
    const q = line[i-1], n = Math.max(1, Math.ceil(dist(p, q)/0.5)), at = t => ({ x: q.x + (p.x - q.x)*t/n, z: q.z + (p.z - q.z)*t/n });
    let from = null;
    for (let k = 0; k <= n; k++) {
      const c = at(k), open = inC(c.x, c.z) && !underDome(c.x, c.z);
      if (open && from == null) from = c;
      if ((!open || k === n) && from) { const to = open ? c : at(k - 1); if (dist(from, to) > 0.05) bars.push(bar({ ...from, y: GLASS_TOP + RIDGE }, { ...to, y: GLASS_TOP + RIDGE }, 0.12)); from = null; }
    }
  }));
  segs.forEach(seg => {
    const dx = (seg.b.x - seg.a.x)/seg.len, dz = (seg.b.z - seg.a.z)/seg.len;
    for (let t = 1.5; t < seg.len; t += 3) {
      const m = { x: seg.a.x + dx*t, y: GLASS_TOP + RIDGE, z: seg.a.z + dz*t }, p = { x: m.x - dz*CW, y: GLASS_TOP, z: m.z + dx*CW }, q = { x: m.x + dz*CW, y: GLASS_TOP, z: m.z - dx*CW };
      if ([m, p, q].every(o => inOutline(o.x, o.z) && !underDome(o.x, o.z))) bars.push(bar(p, m, 0.1), bar(m, q, 0.1));
    }
  });
  courts.forEach((c, ci) => {
    for (let k = 0; k < 48; k++) { // (a neon ring round the dome's foot)
      const a0 = k/48*Math.PI*2, a1 = (k+1)/48*Math.PI*2, r = c.r - 0.2;
      tube(theme.neon[1], { x: c.x + Math.cos(a0)*r, y: GLASS_TOP - 0.1, z: c.z + Math.sin(a0)*r }, { x: c.x + Math.cos(a1)*r, y: GLASS_TOP - 0.1, z: c.z + Math.sin(a1)*r }, 0.09);
    }
    // (the dome, rings from where it stops at each angle — its foot, or the roof — up to its crown)
    const rise = riseOf(c), RINGS = 8, foot = d => Math.acos(Math.min(1, d/c.r));
    const at = (a, d, j, J) => { const f = foot(d) + (Math.PI/2 - foot(d))*j/J; return { x: c.x + Math.cos(a)*c.r*Math.cos(f), y: GLASS_TOP + rise*Math.sin(f), z: c.z + Math.sin(a)*c.r*Math.cos(f) }; };
    const pos = [], idx = [];
    for (let k = 0; k <= DOME_SIDES; k++) for (let j = 0; j <= RINGS; j++) {
      const p = at(k/DOME_SIDES*Math.PI*2, reaches[ci][k % DOME_SIDES], j, RINGS);
      pos.push(p.x, p.y, p.z);
    }
    for (let k = 0; k < DOME_SIDES; k++) for (let j = 0; j < RINGS; j++) {
      const a = k*(RINGS + 1) + j, b = a + RINGS + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const dome = new THREE.BufferGeometry();
    dome.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    dome.setIndex(idx);
    dome.computeVertexNormals();
    glass.addGeometry(dome, 0, 0, 0);
    for (let k = 0; k < 12; k++) {
      const a = k/12*Math.PI*2, d = reach(c, a);
      for (let j = 0; j < 6; j++) bars.push(bar(at(a, d, j, 6), at(a, d, j + 1, 6), 0.1));
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
  // the escalators' steps: a belt of grooved treads on each, its texture scrolled the way it runs (see beltMesh)
  const beltPos = [], beltUV = [];
  const belt = (F, uTop, uFoot, v, hw, deckTop, oneWay) => {
    const slope = Math.hypot(uFoot - uTop, deckTop - Y_ZONE_GROUND), steps = slope/BELT_STEP, lift = 0.05;
    // (v along the texture runs the way the belt goes, so every belt scrolls the same way)
    const vTop = oneWay < 0 ? steps : 0, vFoot = steps - vTop;
    const c = [[uTop, v - hw, deckTop, 0, vTop], [uFoot, v - hw, Y_ZONE_GROUND, 0, vFoot], [uFoot, v + hw, Y_ZONE_GROUND, 1, vFoot], [uTop, v + hw, deckTop, 1, vTop]]
      .map(([u, w, y, s, t]) => ({ ...F.at(u, w, y + lift), s, t }));
    [0, 1, 2, 0, 2, 3].forEach(k => { beltPos.push(c[k].x, c[k].y, c[k].z); beltUV.push(c[k].s, c[k].t); });
  };
  if (upper) {
    const deckTop = MALL_LEVEL, deckBottom = MALL_LEVEL - 0.35, escalators = [], ramps = [];
    const bridgeRects = bridges.map(b => { const F = frameOf(b.at, b.dx, b.dz); return [[-BH, -VH - 0.3], [BH, -VH - 0.3], [BH, VH + 0.3], [-BH, VH + 0.3]].map(([u, v]) => clip(F.at(u, v))); });
    const lanesV = VH >= 1.4 ? [-0.65, 0.65] : [0];
    bridges.forEach((b, bi) => {
      const F = frameOf(b.at, b.dx, b.dz), uTop = b.dir*BH, uFoot = uTop + b.dir*L;
      // (the landing at the top of each pair, kept clear of the balustrade)
      const vl = Math.max(...lanesV) + ESCALATOR_W/2; // (as wide as the escalators, so the balustrade meets their glass)
      escalators.push([[uTop, -vl], [uTop + b.dir*1.2, -vl], [uTop + b.dir*1.2, vl], [uTop, vl]].map(([u, v]) => clip(F.at(u, v))));
      lanesV.forEach((v, li) => {
        const top = F.at(uTop, v, deckTop), foot = F.at(uFoot, v, Y_ZONE_GROUND), hw = ESCALATOR_W/2;
        // (one of a pair up and the other down — a lone one either, bridge by bridge; oneWay is the way along its points,
        // top to foot, that it carries people)
        const oneWay = lanesV.length > 1 ? (li ? 1 : -1) : (bi % 2 ? 1 : -1);
        belt(F, uTop, uFoot, v, hw - 0.08, deckTop, oneWay);
        const along = new THREE.Vector3(top.x - foot.x, top.y - foot.y, top.z - foot.z).normalize();
        const across = new THREE.Vector3(-F.dz, 0, F.dx), up = new THREE.Vector3().crossVectors(across, along);
        const truss = new THREE.BoxGeometry(Math.hypot(L, MALL_LEVEL) + 0.6, 0.6, ESCALATOR_W);
        truss.applyMatrix4(new THREE.Matrix4().makeBasis(along, up, across));
        steel.addGeometry(truss.translate((top.x + foot.x)/2, (top.y + foot.y)/2 - 0.32, (top.z + foot.z)/2), 0, 0, 0);
        [-1, 1].forEach(sv => {
          const a = F.at(uTop, v + sv*hw), c = F.at(uFoot, v + sv*hw);
          glass.addQuad({ ...a, y: deckTop }, { ...c, y: Y_ZONE_GROUND }, { ...c, y: Y_ZONE_GROUND + 0.95 }, { ...a, y: deckTop + 0.95 }, { x: -F.dz, y: 0, z: F.dx });
          bars.push(bar({ ...a, y: deckTop + 1 }, { ...c, y: Y_ZONE_GROUND + 1 }, 0.08));
          // (and at either end the rail runs on level a little way, then down to the floor)
          const a2 = F.at(uTop - b.dir*0.9, v + sv*hw), c2 = F.at(uFoot + b.dir*0.9, v + sv*hw);
          [[a, a2, deckTop], [c, c2, Y_ZONE_GROUND]].forEach(([e, e2, y]) => {
            glass.addQuad({ ...e, y }, { ...e2, y }, { ...e2, y: y + 0.95 }, { ...e, y: y + 0.95 }, { x: -F.dz, y: 0, z: F.dx });
            bars.push(bar({ ...e, y: y + 1 }, { ...e2, y: y + 1 }, 0.08), bar({ ...e2, y: y + 1.04 }, { ...e2, y }, 0.08));
          });
        });
        // for people: from the top (on the bridge's edge) down to the foot
        const steps = Math.ceil(L/0.5), pts = [], ys = [];
        for (let i = 0; i <= steps; i++) { const t = i/steps, p = F.at(uTop + (uFoot - uTop)*t, v); pts.push({ x: p.x, z: p.z }); ys.push(deckTop + (Y_ZONE_GROUND - deckTop)*t); }
        // (and on from the foot, off the landing and across the floor to the nearest lane by the shopfronts — a point
        // spliced into it there, for its end to join: see rampFeet in peoplePathing.js; the belt ends at `beltEnd`)
        const beltEnd = pts.length - 1, off = F.at(uFoot + b.dir*1.5, v);
        let near = null;
        lanes.forEach(lane => { for (let i = 0; i + 1 < lane.length; i++) {
          const a = lane[i], c = lane[i+1], len2 = (c.x - a.x)**2 + (c.z - a.z)**2 || 1;
          const t = Math.max(0, Math.min(1, ((off.x - a.x)*(c.x - a.x) + (off.z - a.z)*(c.z - a.z))/len2));
          const q = { x: a.x + (c.x - a.x)*t, z: a.z + (c.z - a.z)*t }, d = dist(off, q);
          if (!near || d < near.d) near = { lane, i, t, q, d };
        } });
        if (near && near.d < CW*1.5) {
          if (near.t > 1e-3 && near.t < 1 - 1e-3) near.lane.splice(near.i + 1, 0, near.q);
          [off, near.q].forEach(q => {
            const from = pts[pts.length-1], k = Math.max(1, Math.ceil(dist(from, q)/0.5));
            for (let j = 1; j <= k; j++) { pts.push({ x: from.x + (q.x - from.x)*j/k, z: from.z + (q.z - from.z)*j/k }); ys.push(Y_ZONE_GROUND); }
          });
        }
        ramps.push({ pts, ys, top: pts[0], foot: pts[pts.length-1], end: false, lateral: 0.15, walk: hw - 0.2, escalator: ESCALATOR_SPEED, beltEnd, oneWay });
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
      if (!o || !inUpperC(o.out.x, o.out.z) && !inC(o.out.x, o.out.z)) return;
      // (and a neon tube along its edge, under the balustrade)
      const off = { x: o.n.x*0.05, z: o.n.z*0.05 };
      tube(theme.neon[0], { x: p.x + off.x, y: deckBottom + 0.14, z: p.z + off.z }, { x: q.x + off.x, y: deckBottom + 0.14, z: q.z + off.z });
      // (the glass in runs, broken only where an escalator's top meets it — a bridge's edge is one long edge)
      const at = t => ({ x: p.x + (q.x - p.x)*t, z: p.z + (q.z - p.z)*t }), n = Math.max(1, Math.ceil(o.len/0.1));
      const open = k => { const m = at((k + 0.5)/n); return onLanding(m.x + o.n.x*0.3, m.z + o.n.z*0.3); };
      for (let k = 0; k < n;) {
        if (open(k)) { k++; continue; }
        let j = k; while (j < n && !open(j)) j++;
        const a = at(k/n), b = at(j/n);
        wallQuad(glass, a, b, deckTop, deckTop + 1.05);
        railBars.push(bar({ ...a, y: deckTop + 1.1 }, { ...b, y: deckTop + 1.1 }, 0.08));
        k = j;
      }
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
        // (never across a void: only where the ring's deck is under it all the way)
        if (arc.slice(1, -1).every(p => inDeck0(p.x, p.z))) galleries.push(arc);
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
  // (neighbours share a corner, near enough: one pier there, square to the fronts either side of it on average — across
  // the corner, where the fronts turn)
  const placedPiers = [];
  piers.forEach(pr => {
    const o = placedPiers.find(o => o.y0 === pr.y0 && dist(o, pr) < 1.3);
    if (o) { o.n = { x: o.n.x + pr.n.x, z: o.n.z + pr.n.z }; return; }
    placedPiers.push({ ...pr });
  });
  placedPiers.forEach(pr => {
    const nl = Math.hypot(pr.n.x, pr.n.z);
    if (nl > 1e-3) { pr.n = { x: pr.n.x/nl, z: pr.n.z/nl }; pr.dx = -pr.n.z; pr.dz = pr.n.x; }
    let F = frameOf(pr, pr.dx, pr.dz);
    const out = Math.sign(F.uv({ x: pr.x + pr.n.x, z: pr.z + pr.n.z }).v) || 1;
    // (one at the end of a row, against the outer wall, slides along the fronts till it is clear of the wall)
    const clearOfWalls = G => [-0.66, 0.66].every(u => [-out*WALL_IN/2, 0.64*out].every(v => { const q = G.at(u, v); return inWalls(q.x, q.z); }));
    if (!clearOfWalls(F)) for (let k = 1; k <= 20; k++) {
      const G = [k*0.05, -k*0.05].map(du => frameOf(F.at(du, 0), pr.dx, pr.dz)).find(clearOfWalls);
      if (G) { F = G; break; }
    }
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
  // (nothing down here stands on a bridge's footprint, in an escalator's way or on the landing at its foot)
  const LANDING = 4;
  const underEscalator = (p, pad) => upper && bridges.some(b => {
    const { u, v } = frameOf(b.at, b.dx, b.dz).uv(p), uFoot = b.dir*(BH + L + LANDING);
    return u > Math.min(-BH, uFoot) - pad && u < Math.max(BH, uFoot) + pad && Math.abs(v) < VH + 0.3 + pad;
  });
  const bedW = Math.min(1.8, 2*(lv - 0.9) - 1.2);
  if (bedW >= 0.8) spine.edges.forEach((e, ei) => {
    const len = lengthOf(e.pts), na = spine.byId.get(e.a), nb = spine.byId.get(e.b), from = na.entrance ? CW + 1 : 0;
    let k = Math.floor(deco()*3);
    for (let t = (na.entrance ? CW + 12 : 7); t < len - (nb.entrance ? CW + 12 : 7) + 1e-6; t += 12) {
      const at = pointAlong(e.pts, t), hu = 2.6, F = frameOf(at, at.dx, at.dz), ends = [F.at(-hu - 0.3, 0), F.at(hu + 0.3, 0)];
      if (nearCourt(at, 3)) continue;
      const foot = [];
      for (let u = -hu - 0.3; u <= hu + 0.8 + 1e-6; u += 0.5) [-bedW/2, 0, bedW/2].forEach(v => foot.push(F.at(u, v)));
      if (foot.some(p => underEscalator(p, 0.5))) continue;
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
      if (!nearLane(p, 1) && inC(p.x, p.z) && !underEscalator(p, 0.5)) lampPost(p);
    }
    for (let k = 0; k < 4; k++) {
      const a = Math.PI/4 + k*Math.PI/2, p = { x: c.x + Math.cos(a)*(c.fountain + 1.5), z: c.z + Math.sin(a)*(c.fountain + 1.5) };
      if (nearLane(p, 1.2) || !inC(p.x, p.z) || underEscalator(p, 0.8)) continue;
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
      pendant(p, glassAt(p), upper ? MALL_LEVEL + 2.5 : 5.5);
    }
    // round tables in rows, four chairs each, clear of the lanes and the middle where they meet
    const step = 3.9; // (about three tables for every four a 3.4 m grid would hold)
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
    // (the outer walls are closed, so they cast from their far faces: the near ones, in the sun, don't shadow themselves)
    meshOf(built(outerWalls), plain(theme.walls, { roughness: 0.9, shadowSide: THREE.BackSide }), 'Building'),
    meshOf(built(outerStripe), plain(theme.inlay, { roughness: 0.45, shadowSide: THREE.BackSide }), 'Building'),
    meshOf(built(outerTrim), plain(theme.accent, { roughness: 0.45, shadowSide: THREE.BackSide }), 'Building'),
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
  ].flatMap(m => splitRoof(m, levels*MALL_LEVEL - 0.01, roofTiles)).forEach(m => shell.add(m)); // (from the shops' tops up: see splitRoof)
  zone.buildingsGroup.add(shell);
  roofTiles.forEach(tile => zone.buildingsGroup.add(tile));
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
  if (beltPos.length) lights.add(beltMesh(beltPos, beltUV));
  zone.buildingsGroup.add(lights);
}

Object.assign(App, { mallFootprints, rebuildMalls });
