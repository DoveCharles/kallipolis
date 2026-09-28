import * as THREE from 'three';
import { App } from '../core/shared.js';
import { Y_ZONE_GROUND } from '../core/scene.js';
import { mulberry32, polygonArea, centroid } from '../core/math.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { makeFlatZoneMesh } from './surface-detail.js';
import { longAxisOf } from './farmland.js';
import { cutLotByCutouts, insetPolygonExact, toClipperPath, fromClipperPath } from './cutouts.js';

// ---------------------------------------------------------- shopping centre
// A mall is one building filling its zone, but walked like the outdoors: a concourse runs straight down the zone's long
// axis from an entrance at one end to an entrance at the other, under a glass gable roof, with shop units along both
// sides on two storeys. Each unit is a building like any other (a clothes shop, a salon, a bar — a pub's layout — or a
// vacant unit), so people go into them, the camera follows them in, and each has its own card.
//
// People walk it on the ground by two lanes down the concourse (zone.walkGaps, as a suburb's lanes: see buildPeopleNav),
// which come out through the entrances onto whatever pavement's there; upstairs, by the galleries in front of the upper
// shops, the bridges across the void between them and the escalators up to the bridges — all walked as a raised walkway
// is (zone.mallNav: the same shape as a raised network's nav in roads/raised.js). A unit's door is onto whichever of those
// is on its own floor (see buildingDoors in peoplePathing.js: an upper unit keeps `base`, its floor's height).

export const MALL_LEVEL = 5;          // floor to floor
const EDGE = 0.4;                     // the mall's walls stand this far in from the zone's own edge (off the pavement)
const UNIT_GAP = 0.35;                // between the units' backs and the outer walls
const PARAPET = 0.8;                  // outer walls above the units' roofs
const DOOR_H = 4.2;                   // the entrances' glass, and the lintel over it
const LANE_IN = 1.8;                  // the ground lanes, in from the shopfronts
const MIN_LENGTH = 20, MIN_GALLERY = 24;
const ESCALATOR_SLOPE = Math.tan(Math.PI/6), ESCALATOR_W = 1.1;
const GLASS = 0xbfd9e6, FRAME = 0x3a3f46, HANDRAIL = 0x9aa0a8, CANOPY = 0x2e3238;
const FASCIAS = {
  clothes: [0x1a1a1c, 0xf2f0ea, 0xa82a2a, 0x2a3a5a, 0x3a3a3c, 0xd46a2a],
  salon: [0xe890b0, 0x8ec8d8, 0xb0a0d8, 0x60b0a0],
  pub: [0x121212, 0x1f3d2b, 0x5a1a22],
  vacant: [0xe6e3dc],
};
const INSIDE_WALLS = [0xf1ece2, 0xe8eef0, 0xf3e6e6, 0xe9f0e4, 0xeee8f4, 0xf4efe0];

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

// A frame on the zone: u along its long axis, v across it, both from `c`.
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
// A rectangle in the frame, as a Clipper path.
const rectPath = (F, u0, u1, v0, v1) => [F.at(u0, v0), F.at(u1, v0), F.at(u1, v1), F.at(u0, v1)]
  .map(p => ({ X: Math.round(p.x*CLIPPER_SCALE), Y: Math.round(p.z*CLIPPER_SCALE) }));
const piecesOf = paths => paths.map(fromClipperPath).filter(p => p.length >= 3);

// A box in the frame (all six sides): centred on (u, v), `hu` along and `hv` across, from y0 to y1.
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
  const len = Math.hypot(q.x - p.x, q.z - p.z) || 1, n = { x: -(q.z - p.z)/len, y: 0, z: (q.x - p.x)/len };
  b.addQuad({ x: p.x, y: y0, z: p.z }, { x: q.x, y: y0, z: q.z }, { x: q.x, y: y1, z: q.z }, { x: p.x, y: y1, z: p.z }, n);
}
// The flat tops of Clipper `paths` at y, into builder b.
function tops(b, paths, y) {
  if (paths.length) b.addTops(clipPolygons(ClipperLib.ClipType.ctUnion, paths, [], true), y);
}

// One shop unit on `fp` ({x, z}[]), its floor at y0: the walls round it but for the front (the edges on the concourse),
// which is glass under a fascia board; a floor (upstairs), a ceiling, and a counter and a few display stands inside.
function makeUnit(F, fp, side, CW, y0, kind, rng, level) {
  const group = new THREE.Group();
  group.name = 'Building';
  const top = y0 + MALL_LEVEL - 0.35;
  Object.assign(group.userData, { footprint: fp, height: y0 + MALL_LEVEL, base: y0, buildingKind: kind, mallLevel: level, batchable: true });
  const walls = createMeshBuilder(), glass = createMeshBuilder(), fascia = createMeshBuilder(), fittings = createMeshBuilder();
  const onFront = p => Math.abs(F.uv(p).v - side*CW) < 0.6;
  const vacant = kind === 'vacant';
  fp.forEach((p, i) => {
    const q = fp[(i+1) % fp.length];
    if (Math.hypot(q.x - p.x, q.z - p.z) < 1e-3) return;
    if (onFront(p) && onFront(q)) {
      wallQuad(vacant ? walls : glass, p, q, y0, top - 1.1); // (a vacant unit's boarded up)
      wallQuad(walls, p, q, top - 1.1, y0 + MALL_LEVEL);
      // the fascia, stood just out from the front
      const a = F.uv(p), b = F.uv(q), len = Math.abs(b.u - a.u);
      if (len > 1) frameBox(fascia, F, (a.u + b.u)/2, side*(CW + 0.08), len/2 - 0.1, 0.1, top - 1.0, top - 0.2);
    } else wallQuad(walls, p, q, y0, y0 + MALL_LEVEL);
  });
  const path = [toClipperPath(fp)];
  tops(walls, path, top);             // the ceiling
  tops(walls, path, y0 + MALL_LEVEL); // and the roof or floor over it
  if (level > 0) tops(walls, path, y0 + 0.02);
  // inside: a counter by the door and stands down the middle — enough that a lit shopfront has something in it
  if (!vacant) {
    const uvs = fp.map(p => F.uv(p)), u0 = Math.min(...uvs.map(p => p.u)), u1 = Math.max(...uvs.map(p => p.u));
    const um = (u0 + u1)/2, width = u1 - u0;
    const depth = Math.min(...uvs.map(p => Math.abs(p.v))) + 0.001, deep = Math.max(...uvs.map(p => Math.abs(p.v)));
    const inside = (u, v) => pointIn(fp, F.at(u, v));
    const put = (u, v, hu, hv, h) => { if ([[-1,-1],[1,-1],[1,1],[-1,1]].every(([a, b]) => inside(u + a*hu, v + b*hv))) frameBox(fittings, F, u, v, hu, hv, y0, y0 + h); };
    put(u0 + width*0.25, side*(depth + 2.2), Math.min(1.2, width*0.15), 0.4, 1.05);
    const stands = Math.max(1, Math.floor((deep - depth - 5)/3));
    for (let k = 0; k < stands; k++) put(um + (rng() - 0.5)*width*0.3, side*(depth + 4.5 + k*3), Math.min(1.4, width*0.2), 0.45, kind === 'pub' ? 1.05 : 1.4);
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
function pointIn(poly, p) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x)*(p.z - a.z)/(b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
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
  // the frame: along the long axis, centred across the outline
  const axis = longAxisOf(outline);
  let F = frameOf(centroid(outline), axis.dx, axis.dz);
  let uvPoly = outline.map(F.uv);
  const vMin = Math.min(...uvPoly.map(p => p.v)), vMax = Math.max(...uvPoly.map(p => p.v));
  F = frameOf(F.at(0, (vMin + vMax)/2), axis.dx, axis.dz);
  uvPoly = outline.map(F.uv);
  const halfWidth = (vMax - vMin)/2;
  // the concourse: as wide as asked, but leaving at least 6 m of shops either side
  const CW = Math.min((s.mallConcourse ?? 14)/2, halfWidth - 6);
  if (CW < 3) return;
  const ends = spanAt(uvPoly, 0), left = spanAt(uvPoly, CW - 0.01), right = spanAt(uvPoly, -CW + 0.01);
  if (!ends || !left || !right) return;
  const [uA, uB] = ends, uLo = Math.max(uA, left[0], right[0]), uHi = Math.min(uB, left[1], right[1]);
  if (uHi - uLo < MIN_LENGTH) return;
  const G = Math.max(2.5, Math.min(4, CW*0.5)), VH = CW - G; // the galleries' width, and half the void between them
  const gu0 = uLo + 1, gu1 = uHi - 1;
  const upper = s.mallUpper !== false && gu1 - gu0 >= MIN_GALLERY && VH >= 0.8;
  const levels = upper ? 2 : 1, HW = levels*MALL_LEVEL + PARAPET, ROOF = HW - 0.2;
  const extent = Math.max(...uvPoly.map(p => Math.abs(p.u))) + 20;

  // ---- the units: strips from the concourse out to the walls either side, cut across every shop width
  const unitArea = insetPolygonExact(outline, UNIT_GAP)[0] || outline;
  const unitPath = [toClipperPath(unitArea)];
  const n = Math.max(1, Math.round((uHi - uLo)/Math.max(5, s.mallShopWidth ?? 10))), w = (uHi - uLo)/n;
  let li = 0;
  [1, -1].forEach(side => {
    for (let k = 0; k < n; k++) {
      const u0 = k === 0 ? -extent : uLo + k*w, u1 = k === n-1 ? extent : uLo + (k+1)*w;
      const v0 = side > 0 ? CW : -extent, v1 = side > 0 ? extent : -CW;
      piecesOf(clipPolygons(ClipperLib.ClipType.ctIntersection, unitPath, [rectPath(F, u0, u1, v0, v1)])).forEach((fp, pi) => {
        if (Math.abs(polygonArea(fp)) < 25) return;
        for (let level = 0; level < levels; level++) {
          // each unit on its own stream, as in a town, so one slider never reshuffles the rest
          const rng = mulberry32(((s.seed>>>0) ^ Math.imul(li+1, 0x9E3779B1) ^ Math.imul(pi+1, 0x85EBCA6B) ^ Math.imul(level+1, 0xC2B2AE35)) >>> 0);
          const front = fp.some(p => Math.abs(F.uv(p).v - side*CW) < 0.6);
          const uvs = fp.map(p => F.uv(p).u), onGallery = Math.min(Math.max(...uvs), gu1) - Math.max(Math.min(...uvs), gu0) > 3;
          const kind = !front || (level > 0 && !onGallery) ? 'vacant' : kindOf(rng, s);
          zone.buildingsGroup.add(makeUnit(F, fp, side, CW, level*MALL_LEVEL, kind, rng, level));
        }
      });
      li++;
    }
  });

  // ---- the shell: outer walls (glass doors at the two entrances), the roof over the units, the glass roof over the concourse
  const shell = new THREE.Group();
  shell.name = 'MallShell';
  shell.userData.batchable = true;
  const walls = createMeshBuilder(), trim = createMeshBuilder(), glass = createMeshBuilder(), frame = createMeshBuilder(), roof = createMeshBuilder();
  const EH = Math.min(4, CW - 0.5);
  const entrances = [uA, uB];
  const doorway = p => { const q = F.uv(p); return Math.abs(q.v) < EH && entrances.some(u => Math.abs(q.u - u) < 2.5); };
  outline.forEach((p, i) => {
    const q = outline[(i+1) % outline.length], len = Math.hypot(q.x - p.x, q.z - p.z), steps = Math.max(1, Math.ceil(len/0.5));
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
  entrances.forEach((u, e) => {
    const out = e === 0 ? -1 : 1;
    frameBox(frame, F, u + out*1.6, 0, 1.8, EH + 0.8, DOOR_H + 0.2, DOOR_H + 0.55);
    [-1, 1].forEach(sv => frameBox(frame, F, u + out*3.1, sv*(EH + 0.5), 0.12, 0.12, 0, DOOR_H + 0.2));
  });
  // the flat roof over the units, everywhere but the concourse
  const strip = rectPath(F, -extent, extent, -CW, CW);
  tops(roof, clipPolygons(ClipperLib.ClipType.ctDifference, [toClipperPath(outline)], [strip]), ROOF);
  // the glass gable over the concourse: each half of it pitched up from the eaves (over the shopfronts) to the ridge
  const rise = Math.min(3, CW*0.45), roofY = v => ROOF + rise*(1 - Math.min(1, Math.abs(v)/CW));
  [1, -1].forEach(side => {
    const half = rectPath(F, -extent, extent, side > 0 ? 0 : -CW, side > 0 ? CW : 0);
    clipPolygons(ClipperLib.ClipType.ctIntersection, [toClipperPath(outline)], [half]).forEach(path => {
      const pts = path.map(P => ({ x: P.X/CLIPPER_SCALE, z: P.Y/CLIPPER_SCALE }));
      const tris = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p.x, p.z)), []);
      const nrm = { x: -F.dz*side*rise/CW, y: 1, z: F.dx*side*rise/CW };
      tris.forEach(([a, b, c]) => { const v3 = i => ({ x: pts[i].x, y: roofY(F.uv(pts[i]).v), z: pts[i].z }); glass.addQuad(v3(a), v3(b), v3(c), v3(c), nrm); });
    });
  });
  // its gable ends, glazed from the top of the wall up under it
  outline.forEach((p, i) => {
    const q = outline[(i+1) % outline.length], a = F.uv(p), b = F.uv(q);
    const cuts = [0, 1];
    [-CW, 0, CW].forEach(v => { const t = (v - a.v)/(b.v - a.v); if (t > 0 && t < 1) cuts.push(t); });
    cuts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const t0 = cuts[k], t1 = cuts[k+1], mid = a.v + (b.v - a.v)*(t0 + t1)/2;
      if (Math.abs(mid) >= CW) continue;
      const P = t => ({ x: p.x + (q.x - p.x)*t, z: p.z + (q.z - p.z)*t }), vy = t => roofY(a.v + (b.v - a.v)*t);
      const p0 = P(t0), p1 = P(t1);
      glass.addQuad({ ...p0, y: ROOF }, { ...p1, y: ROOF }, { ...p1, y: vy(t1) }, { ...p0, y: vy(t0) }, { x: 0, y: 0, z: 1 });
    }
  });
  // and its frame: the ridge, the eaves, and a rafter every few metres where the whole span's inside
  const bars = [];
  const rafterAt = u => [-CW, 0, CW].every(v => pointIn(outline, F.at(u, v)));
  const r0 = spanAt(uvPoly, 0);
  bars.push(bar(F.at(r0[0], 0, ROOF + rise), F.at(r0[1], 0, ROOF + rise), 0.18));
  [CW, -CW].forEach(v => { const sp = spanAt(uvPoly, v*0.999); if (sp) bars.push(bar(F.at(sp[0], v, ROOF), F.at(sp[1], v, ROOF), 0.22)); });
  for (let u = Math.ceil(r0[0]/3)*3; u <= r0[1]; u += 3) {
    if (!rafterAt(u)) continue;
    bars.push(bar(F.at(u, -CW, ROOF), F.at(u, 0, ROOF + rise), 0.1), bar(F.at(u, 0, ROOF + rise), F.at(u, CW, ROOF), 0.1));
  }

  // ---- upstairs: a gallery along each side, bridges across the void, and a pair of escalators up to each bridge
  const nets = [];
  if (upper) {
    const deckTop = MALL_LEVEL, deckBottom = MALL_LEVEL - 0.35;
    const nb = Math.max(1, Math.floor((gu1 - gu0)/32)), BH = 1.5, L = MALL_LEVEL/ESCALATOR_SLOPE;
    const bridges = Array.from({ length: nb }, (_, k) => gu0 + (k + 0.5)*(gu1 - gu0)/nb);
    [1, -1].forEach(side => frameBox(frame, F, (gu0 + gu1)/2, side*(CW - G/2), (gu1 - gu0)/2, G/2, deckBottom, deckTop));
    bridges.forEach(ub => frameBox(frame, F, ub, 0, BH, VH, deckBottom, deckTop));
    // columns under the galleries' inner edge
    const cols = Math.max(2, Math.round((gu1 - gu0)/9));
    for (let k = 0; k <= cols; k++) {
      const u = gu0 + 0.3 + k*(gu1 - gu0 - 0.6)/cols;
      [1, -1].forEach(side => frameBox(trim, F, u, side*(VH + 0.35), 0.25, 0.25, 0, deckBottom));
    }
    // glass balustrades round the void, open where the bridges join; a handrail along the top
    const rail = (u0, v0, u1, v1) => {
      const a = F.at(u0, v0), b = F.at(u1, v1);
      wallQuad(glass, a, b, deckTop, deckTop + 1.05);
      bars.push(bar({ ...a, y: deckTop + 1.1 }, { ...b, y: deckTop + 1.1 }, 0.07));
    };
    [1, -1].forEach(side => {
      let u = gu0;
      bridges.forEach(ub => { rail(u, side*VH, ub - BH, side*VH); u = ub + BH; });
      rail(u, side*VH, gu1, side*VH);
      rail(gu0, side*VH, gu0, side*CW); rail(gu1, side*VH, gu1, side*CW); // (the galleries' ends)
    });
    bridges.forEach(ub => [-1, 1].forEach(su => rail(ub + su*BH, -VH, ub + su*BH, VH)));
    // the escalators: from the ground, side by side, up onto the near edge of a bridge — whichever side has room
    const ramps = [], lanesV = VH >= 1.4 ? [-0.65, 0.65] : [0];
    bridges.forEach((ub, k) => {
      const dir = ub - BH - L - 1 >= (k > 0 ? bridges[k-1] + BH : gu0) ? -1 : 1;
      const uTop = ub + dir*BH, uFoot = uTop + dir*L;
      lanesV.forEach(v => {
        const top = F.at(uTop, v, deckTop), foot = F.at(uFoot, v, Y_ZONE_GROUND);
        const hw = ESCALATOR_W/2;
        // the truss: a sloped box; glass sides, and a handrail each side
        const along = new THREE.Vector3(top.x - foot.x, top.y - foot.y, top.z - foot.z).normalize();
        const across = new THREE.Vector3(-F.dz, 0, F.dx), up = new THREE.Vector3().crossVectors(across, along);
        const truss = new THREE.BoxGeometry(Math.hypot(L, MALL_LEVEL) + 0.6, 0.6, ESCALATOR_W);
        truss.applyMatrix4(new THREE.Matrix4().makeBasis(along, up, across));
        bars.push(truss.translate((top.x + foot.x)/2, (top.y + foot.y)/2 - 0.32, (top.z + foot.z)/2));
        [-1, 1].forEach(sv => {
          const a = F.at(uTop, v + sv*hw, deckTop), b = F.at(uFoot, v + sv*hw, Y_ZONE_GROUND);
          glass.addQuad({ ...a, y: deckTop }, { ...b, y: Y_ZONE_GROUND }, { ...b, y: Y_ZONE_GROUND + 0.95 }, { ...a, y: deckTop + 0.95 }, { x: -F.dz, y: 0, z: F.dx });
          bars.push(bar({ ...a, y: deckTop + 1 }, { ...b, y: Y_ZONE_GROUND + 1 }, 0.08));
        });
        // for people: from the top (on the bridge's edge) down to the foot
        const steps = Math.ceil(L/0.5), pts = [], ys = [];
        for (let i = 0; i <= steps; i++) { const t = i/steps; pts.push(F.at(uTop + (uFoot - uTop)*t, v)); ys.push(deckTop + (Y_ZONE_GROUND - deckTop)*t); }
        ramps.push({ pts: pts.map(p => ({ x: p.x, z: p.z })), ys, top: pts[0], foot: pts[pts.length-1], end: false, lateral: 0.15, walk: hw - 0.2 });
      });
    });
    // nav: each gallery with a point where every bridge meets it, and each bridge between them (sharing those points)
    const gv = CW - G/2;
    const galleries = [1, -1].map(side => [gu0 + 0.5, ...bridges, gu1 - 0.5].map(u => { const p = F.at(u, side*gv); return { x: p.x, z: p.z }; }));
    const spans = bridges.map(ub => [-gv, gv].map(v => { const p = F.at(ub, v); return { x: p.x, z: p.z }; }));
    nets.push({ H: deckTop, lateral: Math.max(0.3, G/2 - 0.9), walk: Math.max(0.4, G/2 - 0.3), decks: galleries, ramps: [], indoor: true });
    nets.push({ H: deckTop, lateral: 0.6, walk: BH - 0.3, decks: spans, ramps, indoor: true });
  }
  zone.mallNav = nets;

  // ---- the ground lanes: in at one entrance, down the concourse by the shopfronts either side, out at the other
  const lv = CW - LANE_IN;
  zone.walkGaps = [1, -1].map(side => {
    const sp = spanAt(uvPoly, side*lv) || [uLo, uHi];
    const a = Math.max(sp[0] + 1.5, uA + 3), b = Math.min(sp[1] - 1.5, uB - 3);
    return [F.at(uA - 2, 0), F.at(uA + 1, 0), F.at(a, side*lv), F.at(b, side*lv), F.at(uB - 1, 0), F.at(uB + 2, 0)].map(p => ({ x: p.x, z: p.z }));
  });

  if (bars.length) frame.addGeometry(mergeGeometryList(bars), 0, 0, 0);
  const wallColor = s.mallWallColor ?? 0xd9d2c5;
  [
    meshOf(built(walls), plain(wallColor, { roughness: 0.9 }), 'Building'),
    meshOf(built(trim), plain(s.mallAccentColor ?? 0x2f6f8f, { roughness: 0.5 }), 'Building'),
    meshOf(built(roof), plain(0x8a8d90, { roughness: 0.95 }), 'Building'),
    meshOf(built(frame), plain(FRAME, { roughness: 0.5, metalness: 0.4 }), 'Building'),
    meshOf(built(glass), glassMaterial(), 'MallGlass', false),
  ].forEach(m => m && shell.add(m));
  zone.buildingsGroup.add(shell);
}

Object.assign(App, { generateMallContent });
