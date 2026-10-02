import * as THREE from 'three';
import { S } from '../core/shared.js';
import { Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { pointInPolygon, polygonArea } from '../core/math.js';
import { tessellateClosedPath } from '../core/splines.js';
import { CLIPPER_SCALE, CURB_COLOR, clipPolygons, createMeshBuilder, forEachPolyTreeEdge } from '../roads/roads.js';
import { rebuildRoadMeshes } from '../roads/paths.js';
import { makeFlatZoneMesh } from './surface-detail.js';
import { longAxisOf } from './farmland.js';
import { toClipperPath, insetPolygonExact, createRegionTester, cutLotByCutouts } from './cutouts.js';

// Car parks: painted bays on the ground (storeys 0), or one multi-storey building of decks joined by two ramp strips.
// Where one touches a road, the pavement gets a dropped kerb (kerbDrops). Cars use them via life/traffic/parking.js.
const BAY_W = 2.5, BAY_L = 5, AISLE = 6, H = 5.25, SLAB = 0.3, Y0 = 0.05, BAND = 6.5, WALL = 1;
export const CARPARK_COLOR = 0x3b3d40;
const levelY = k => Y0 + k*H;
export const deckOf = k => levelY(k) - Y_ROAD; // (a car's deckY on level k)
const sharedMat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });
let mats = null;
const materials = () => mats ??= {
  concrete: sharedMat(0x9a978f), ramp: sharedMat(0x6c6d70), lines: sharedMat(0xe8e6df, { polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
  kerb: sharedMat(CURB_COLOR, { roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  post: sharedMat(0x555a60), lamp: new THREE.MeshBasicMaterial({ color: 0xf4f8ff, side: THREE.DoubleSide }), sign: new THREE.MeshBasicMaterial({ map: signTexture() }),
};
function signTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#1f5fbf'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#fff'; g.lineWidth = 4; g.strokeRect(4, 4, 56, 56);
  g.fillStyle = '#fff'; g.font = 'bold 46px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P', 32, 35);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const meshOf = (builder, mat, name) => {
  const geo = builder.build();
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.sharedMaterial = true;
  return mesh;
};

// ============================================================ kerb drops
// Each car park's contact with each pavemented road: { zoneId, x, z (centreline), tx, tz (along), nx, nz (toward the
// zone), hw, cw, sw, half, flare }, and the Clipper rects cut from the kerb and pavement for them.
export function kerbDrops(strokes) {
  const drops = [], rects = [];
  S.zones.forEach(zone => {
    if (zone.zoneType !== 'carpark' || zone.drawing || zone.points.length < 3) return;
    const poly = tessellateClosedPath(zone.points);
    strokes.forEach(s => {
      if (s.sw < 0.5) return;
      const pts = s.path.map(p => ({ x: p.X/CLIPPER_SCALE, z: p.Y/CLIPPER_SCALE })), reach = s.hw + s.cw + s.sw + 0.6;
      let run = [];
      const flush = () => { if (run.length >= 8) addDrop(zone, poly, run[run.length >> 1], s); run = []; };
      for (let i = 0; i < pts.length-1; i++) {
        const a = pts[i], b = pts[i+1], len = Math.hypot(b.x-a.x, b.z-a.z);
        for (let d = 0; d < len; d += 1) {
          const p = { x: a.x + (b.x-a.x)*d/len, z: a.z + (b.z-a.z)*d/len, tx: (b.x-a.x)/len, tz: (b.z-a.z)/len };
          const q = closestOn(poly, p);
          if (!pointInPolygon(p, poly) && Math.hypot(q.x-p.x, q.z-p.z) <= reach) { p.q = q; run.push(p); } else flush();
        }
      }
      flush();
    });
  });
  function addDrop(zone, poly, p, s) {
    let nx = p.q.x - p.x, nz = p.q.z - p.z;
    const along = nx*p.tx + nz*p.tz; nx -= along*p.tx; nz -= along*p.tz;
    const len = Math.hypot(nx, nz);
    if (len < 0.5) return;
    const d = { zoneId: zone.id, x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: nx/len, nz: nz/len, hw: s.hw, cw: s.cw, sw: s.sw, half: 3, flare: 1.2 };
    drops.push(d);
    const L = d.half + d.flare, b0 = d.hw - 0.02, b1 = d.hw + d.cw + d.sw + 0.02;
    rects.push(toClipperPath([[-L, b0], [L, b0], [L, b1], [-L, b1]].map(([a, b]) => ({ x: d.x + d.tx*a + d.nx*b, z: d.z + d.tz*a + d.nz*b }))));
  }
  return { drops, rects };
}
function closestOn(poly, p) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i+1) % poly.length], abx = b.x-a.x, abz = b.z-a.z;
    const t = Math.max(0, Math.min(1, ((p.x-a.x)*abx + (p.z-a.z)*abz)/((abx*abx + abz*abz) || 1)));
    const x = a.x + abx*t, z = a.z + abz*t, d = Math.hypot(x-p.x, z-p.z);
    if (d < bestD) { bestD = d; best = { x, z }; }
  }
  return best;
}
// the lowered stretch itself: down to the road at its lip, rising to pavement height at either flank
export function kerbDropMesh(drops) {
  const pos = [], idx = [];
  const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t*t*(3 - 2*t);
  drops.forEach(d => {
    const L = d.half + d.flare, outer = d.hw + d.cw + d.sw, lip = Math.max(d.cw, 0.4);
    const bs = [d.hw, d.hw + lip*0.5, d.hw + lip, outer];
    const height = (a, b) => {
      const mid = b < d.hw + lip ? Y_ROAD + 0.03 + (0.03 - Y_ROAD - 0.03)*(b - d.hw)/lip : 0.03;
      return mid + (Y_SIDEWALK - mid)*smooth((Math.abs(a) - d.half)/d.flare);
    };
    const at = (a, b, y) => pos.push(d.x + d.tx*a + d.nx*b, y, d.z + d.tz*a + d.nz*b);
    const steps = Math.ceil(2*L/0.3), base = pos.length/3;
    for (let i = 0; i <= steps; i++) { const a = -L + 2*L*i/steps; bs.forEach(b => at(a, b, height(a, b))); }
    for (let i = 0; i < steps; i++) for (let j = 0; j < bs.length-1; j++) {
      const p = base + i*bs.length + j, q = p + bs.length;
      idx.push(p, p+1, q, q, p+1, q+1);
    }
    // skirts down to the road at the lip and to the ground at the back
    [[d.hw, Y_ROAD], [outer, 0]].forEach(([b, yb]) => {
      const s0 = pos.length/3;
      for (let i = 0; i <= steps; i++) { const a = -L + 2*L*i/steps; at(a, b, yb); at(a, b, height(a, b)); }
      for (let i = 0; i < steps; i++) { const p = s0 + i*2; idx.push(p, p+2, p+1, p+1, p+2, p+3); }
    });
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, materials().kerb);
  mesh.name = 'KerbDrop'; mesh.receiveShadow = true; mesh.userData.sharedMaterial = true;
  return mesh;
}

// ============================================================ the zone
export function generateCarParkContent(zone, poly, cutouts, blockers) {
  // (the kerb drops are made with the roads: rebuild those when this outline is new to them)
  const key = JSON.stringify([zone.points, !!zone.drawing]);
  if (S.zones.includes(zone) && zone.kerbKey !== key) { zone.kerbKey = key; rebuildRoadMeshes(); }
  zone.carPark = null;
  const ground = makeFlatZoneMesh(poly, CARPARK_COLOR, Y0, 'CarParkGround', null, cutouts);
  if (ground) zone.buildingsGroup.add(ground);
  const pieces = cutLotByCutouts(poly, blockers).pieces.filter(p => p.length >= 3);
  if (!pieces.length) return;
  const F = pieces.reduce((a, b) => Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a);
  if (Math.abs(polygonArea(F)) < 60) return;
  const lot = layOut(zone, F, Math.max(0, Math.round(zone.settings.carParkStoreys ?? 0)));
  zone.carPark = lot;
  const group = new THREE.Group(); group.name = 'CarPark'; group.userData.buildingKind = 'carpark';
  buildLot(lot, group);
  zone.buildingsGroup.add(group);
}

function layOut(zone, F, storeys) {
  const { dx: ux, dz: uz } = longAxisOf(F), vx = -uz, vz = ux;
  const toU = p => p.x*ux + p.z*uz, toV = p => p.x*vx + p.z*vz;
  const world = (u, v) => ({ x: u*ux + v*vx, z: u*uz + v*vz });
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  F.forEach(p => { const u = toU(p), v = toV(p); uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); });
  const testerOf = inset => { const ps = insetPolygonExact(F, inset); return ps.length ? createRegionTester(ps.map(toClipperPath)) : () => false; };
  const inBays = testerOf(0.3), inDrive = testerOf(1.3);
  const entrances = (S.kerbDrops || []).filter(d => d.zoneId === zone.id).map(d => {
    const outer = d.hw + d.cw + d.sw, pt = b => ({ x: d.x + d.nx*b, z: d.z + d.nz*b });
    return { drop: d, road: pt(d.hw - 0.8), side: pt(d.hw + d.cw + d.sw*0.5), x: pt(outer + 1.5).x, z: pt(outer + 1.5).z };
  });
  // ramps: two strips along the long axis through the middle, with room to turn at both ends
  let ramps = null;
  if (storeys > 0) {
    const uc = (uMin + uMax)/2, vc = (vMin + vMax)/2;
    for (const len of [42, 36, 30, 24]) {
      const uA = uc - len/2, uB = uc + len/2;
      let fits = true;
      for (let u = uA - 9; u <= uB + 9 && fits; u += 1.5) for (const v of [vc - BAND, vc, vc + BAND]) { const w = world(u, v); if (!inDrive(w.x, w.z)) { fits = false; break; } }
      if (fits) { ramps = { uA, uB, vc }; break; }
    }
  }
  const N = ramps ? storeys : 0;
  // bays, in rows along the long axis: back to back, an aisle between each facing pair
  const bays = [], backs = [];
  const addRows = (vStart, sign, uLo, uHi, firstLimited) => {
    for (let v0 = vStart, m = 0; sign > 0 ? v0 < vMax : v0 > vMin; v0 += sign*(2*BAY_L + AISLE), m++) {
      backs.push(v0);
      [[v0, sign, m === 0 && firstLimited], [v0 + sign*(2*BAY_L + AISLE), -sign, false]].forEach(([back, facing, limited]) => {
        for (let u0 = uMin + 0.3; u0 + BAY_W <= uMax; u0 += BAY_W) {
          if (limited && (u0 < uLo || u0 + BAY_W > uHi)) continue;
          if (!limited && ramps && Math.abs(back + facing*BAY_L/2 - ramps.vc) < BAND) continue;
          const corners = [[u0, back], [u0 + BAY_W, back], [u0, back + facing*BAY_L], [u0 + BAY_W, back + facing*BAY_L]].map(([u, v]) => world(u, v));
          if (!corners.every(c => inBays(c.x, c.z))) continue;
          const c = world(u0 + BAY_W/2, back + facing*BAY_L/2), f = { x: vx*facing, z: vz*facing };
          if (entrances.some(e => Math.hypot(e.x - c.x, e.z - c.z) < 8)) continue;
          bays.push({ cx: c.x, cz: c.z, fx: f.x, fz: f.z, u0, back, facing });
        }
      });
    }
  };
  if (ramps) { addRows(ramps.vc + BAND, 1, ramps.uA, ramps.uB, true); addRows(ramps.vc - BAND, -1, ramps.uA, ramps.uB, true); }
  else addRows(vMin + 0.3, 1);
  // the drivable grid, the same on every level
  const CELL = Math.max(1, Math.sqrt((uMax - uMin)*(vMax - vMin)/120000)), nu = Math.ceil((uMax - uMin)/CELL), nv = Math.ceil((vMax - vMin)/CELL);
  const grid = new Uint8Array(nu*nv);
  const inBayRect = (u, v) => bays.some(b => u > b.u0 - 0.3 && u < b.u0 + BAY_W + 0.3 && (v - b.back)*b.facing > -0.3 && (v - b.back)*b.facing < BAY_L + 0.3);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = uMin + (i + 0.5)*CELL, v = vMin + (j + 0.5)*CELL, w = world(u, v);
    if (!inDrive(w.x, w.z)) continue;
    if (ramps && u > ramps.uA - 0.6 && u < ramps.uB + 0.6 && Math.abs(v - ramps.vc) < BAND + 0.6) continue;
    if (inBayRect(u, v)) continue;
    grid[i*nv + j] = 1;
  }
  const lot = { zoneId: zone.id, F, N, ux, uz, vx, vz, uMin, vMin, nu, nv, CELL, grid, ramps, entrances, backs, fields: new Map(), toU, toV, world, bayList: bays };
  // levels: every bay on every level, kept only if a car can reach it
  const reach = entrances.length ? fieldFrom(lot, entrances[0]) : null;
  lot.bays = [];
  for (let k = 0; k <= N; k++) {
    const from = k === 0 ? reach : fieldFrom(lot, portOf(lot, k));
    bays.forEach(b => {
      const m = mouthOf(b), c = cellNear(lot, m.x, m.z, from);
      if (entrances.length && (c < 0 || (k > 0 && !reach) || (k > 0 && cellNear(lot, portOf(lot, 0).x, portOf(lot, 0).z, reach) < 0))) return;
      lot.bays.push({ ...b, level: k, car: null, routes: new Map() });
    });
  }
  return lot;
}
const mouthOf = b => ({ x: b.cx + b.fx*(BAY_L/2 + 3), z: b.cz + b.fz*(BAY_L/2 + 3) });
const frontOf = b => ({ x: b.cx + b.fx*BAY_L/2, z: b.cz + b.fz*BAY_L/2 });
// where level k's ramps meet: ramp k-1 arrives and ramp k leaves at the same end, alternating
const endOf = (lot, k) => k % 2 ? lot.ramps.uB : lot.ramps.uA;
const outOf = k => k % 2 ? 1 : -1;
const stripOf = (lot, k) => lot.ramps.vc + (k % 2 ? BAND/2 : -BAND/2);
const portOf = (lot, k) => lot.ramps ? lot.world(endOf(lot, k) + outOf(k)*5, lot.ramps.vc) : lot.entrances[0];

// ---------------------------------------------------------------- grid routes
const cellXY = (lot, x, z) => {
  const i = Math.floor((lot.toU({ x, z }) - lot.uMin)/lot.CELL), j = Math.floor((lot.toV({ x, z }) - lot.vMin)/lot.CELL);
  return i < 0 || j < 0 || i >= lot.nu || j >= lot.nv ? -1 : i*lot.nv + j;
};
const cellCentre = (lot, c) => lot.world(lot.uMin + (Math.floor(c/lot.nv) + 0.5)*lot.CELL, lot.vMin + (c % lot.nv + 0.5)*lot.CELL);
function cellNear(lot, x, z, field) {
  const ok = c => c >= 0 && lot.grid[c] && (!field || field[c] >= 0);
  const c0 = cellXY(lot, x, z);
  if (ok(c0)) return c0;
  const i0 = Math.floor((lot.toU({ x, z }) - lot.uMin)/lot.CELL), j0 = Math.floor((lot.toV({ x, z }) - lot.vMin)/lot.CELL);
  for (let r = 1; r <= 6; r++) {
    let best = -1, bestD = Infinity;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= lot.nu || j >= lot.nv) continue;
      const c = i*lot.nv + j, d = di*di + dj*dj;
      if (ok(c) && d < bestD) { best = c; bestD = d; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
const NEIGHBOURS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const stepOK = (lot, i, j, di, dj) => {
  const { nu, nv, grid } = lot, ni = i + di, nj = j + dj;
  if (ni < 0 || nj < 0 || ni >= nu || nj >= nv || !grid[ni*nv + nj]) return false;
  return !(di && dj) || (grid[ni*nv + j] && grid[i*nv + nj]);
};
// steps from a point to every cell, breadth first (cached per point)
function fieldFrom(lot, p) {
  const key = p.x.toFixed(2) + ',' + p.z.toFixed(2);
  if (lot.fields.has(key)) return lot.fields.get(key);
  const field = new Int32Array(lot.nu*lot.nv).fill(-1), start = cellNear(lot, p.x, p.z);
  lot.fields.set(key, start < 0 ? null : field);
  if (start < 0) return null;
  const queue = new Int32Array(lot.nu*lot.nv);
  let head = 0, tail = 0;
  field[start] = 0; queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++], i = Math.floor(c/lot.nv), j = c % lot.nv;
    for (const [di, dj] of NEIGHBOURS) {
      if (!stepOK(lot, i, j, di, dj)) continue;
      const n = (i + di)*lot.nv + j + dj;
      if (field[n] < 0) { field[n] = field[c] + 1; queue[tail++] = n; }
    }
  }
  return field;
}
// from a point downhill to the field's source, string-pulled
function walkTo(lot, field, x, z, y) {
  let c = cellNear(lot, x, z, field);
  if (c < 0) return [];
  const cells = [c];
  while (field[c] > 0) {
    const i = Math.floor(c/lot.nv), j = c % lot.nv;
    let next = -1;
    for (const [di, dj] of NEIGHBOURS) if (stepOK(lot, i, j, di, dj) && field[(i + di)*lot.nv + j + dj] === field[c] - 1) { next = (i + di)*lot.nv + j + dj; break; }
    if (next < 0) break;
    cells.push(c = next);
  }
  const pts = cells.map(k => cellCentre(lot, k)), out = [pts[0]];
  for (let a = 0; a < pts.length - 1;) {
    let b = a + 1;
    while (b + 1 < pts.length && clearLine(lot, pts[a], pts[b + 1])) b++;
    out.push(pts[b]); a = b;
  }
  return out.map(p => ({ x: p.x, y, z: p.z }));
}
function clearLine(lot, a, b) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)/(lot.CELL*0.4));
  for (let k = 1; k < n; k++) { const c = cellXY(lot, a.x + (b.x - a.x)*k/n, a.z + (b.z - a.z)*k/n); if (c < 0 || !lot.grid[c]) return false; }
  return true;
}
// ramp k, up or down, between the two levels' ports, keeping left
function rampLeg(lot, k, up) {
  const lo = endOf(lot, k), hi = endOf(lot, k + 1), dirU = Math.sign(hi - lo)*(up ? 1 : -1), v = stripOf(lot, k) - dirU*1.6;
  const at = (u, vv, y) => ({ ...lot.world(u, vv), y });
  const P0 = portOf(lot, k), P1 = portOf(lot, k + 1);
  const leg = [{ x: P0.x, y: deckOf(k), z: P0.z }, at(lo, v, deckOf(k)), at(hi, v, deckOf(k + 1)), { x: P1.x, y: deckOf(k + 1), z: P1.z }];
  return up ? leg : leg.reverse();
}
/** Route from entrance ei to a bay, ending in it (unsmoothed points {x, y, z}); null if there's none. */
export function routeIn(lot, bay, ei) {
  const key = 'in' + ei;
  if (bay.routes.has(key)) return bay.routes.get(key);
  const e = lot.entrances[ei], L = bay.level, m = mouthOf(bay), f = frontOf(bay);
  let pts = null;
  const fe = fieldFrom(lot, e);
  if (fe) {
    const first = L > 0 ? portOf(lot, 0) : m;
    pts = [{ x: e.x, y: deckOf(0), z: e.z }, ...walkTo(lot, fe, first.x, first.z, deckOf(0)).reverse()];
    for (let k = 0; k < L; k++) pts.push(...rampLeg(lot, k, true));
    if (L > 0) { const fp = fieldFrom(lot, portOf(lot, L)); pts.push(...(fp ? walkTo(lot, fp, m.x, m.z, deckOf(L)).reverse() : [])); }
    pts.push({ x: m.x, y: deckOf(L), z: m.z }, { x: f.x, y: deckOf(L), z: f.z }, { x: bay.cx, y: deckOf(L), z: bay.cz });
  }
  bay.routes.set(key, pts);
  return pts;
}
/** Out of a bay to entrance ei: { back } reversing out, then { ahead } driving to the entrance. */
export function routeOut(lot, bay, ei) {
  const key = 'out' + ei;
  if (bay.routes.has(key)) return bay.routes.get(key);
  const e = lot.entrances[ei], L = bay.level, m = mouthOf(bay), f = frontOf(bay), y = deckOf(L);
  const fe = fieldFrom(lot, e);
  let out = null;
  if (fe) {
    const ahead = [];
    const last = L > 0 ? portOf(lot, L) : e;
    const fl = L > 0 ? fieldFrom(lot, last) : fe;
    if (fl) ahead.push(...walkTo(lot, fl, m.x, m.z, y));
    for (let k = L - 1; k >= 0; k--) ahead.push(...rampLeg(lot, k, false));
    if (L > 0) { const p0 = portOf(lot, 0); ahead.push(...walkTo(lot, fe, p0.x, p0.z, deckOf(0))); }
    ahead.push({ x: e.x, y: deckOf(0), z: e.z });
    const next = ahead.find(p => Math.hypot(p.x - m.x, p.z - m.z) > 1.5) || e;
    let dx = next.x - m.x, dz = next.z - m.z; const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    const K = { x: f.x + bay.fx*2.8 - dx*2.5, y, z: f.z + bay.fz*2.8 - dz*2.5 };
    out = { back: [{ x: bay.cx, y, z: bay.cz }, { x: f.x, y, z: f.z }, { x: f.x + bay.fx*1.5, y, z: f.z + bay.fz*1.5 }, K], ahead: [K, ...ahead] };
  }
  bay.routes.set(key, out);
  return out;
}
/** Chaikin-rounded copy of a path, its ends kept. */
export function smoothPath(pts, iters = 2) {
  for (let n = 0; n < iters; n++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-3) continue;
      const mix = t => ({ x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t });
      if (i > 0) out.push(mix(0.25));
      if (i < pts.length - 2) out.push(mix(0.75));
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
/** The deck height (as a car's deckY) under (x, z): the highest floor no more than a step above `y`; 0 off any car park. */
export function carParkFloorAt(x, z, y) {
  for (const zone of S.zones) {
    const lot = zone.carPark;
    if (!lot || !pointInPolygon({ x, z }, lot.F)) continue;
    const u = lot.toU({ x, z }), v = lot.toV({ x, z });
    let best = deckOf(0);
    const take = h => { if (h <= y + 0.6 && h > best) best = h; };
    for (let k = 1; k <= lot.N; k++) if (!inHole(lot, k, u, v)) take(deckOf(k));
    if (lot.ramps) for (let k = 0; k < lot.N; k++) {
      const { uA, uB } = lot.ramps;
      if (u < uA || u > uB || Math.abs(v - stripOf(lot, k)) > BAND/2) continue;
      const lo = endOf(lot, k), hi = endOf(lot, k + 1);
      take(deckOf(k) + H*(u - lo)/(hi - lo));
    }
    return best;
  }
  return 0;
}
const holesAt = (lot, k) => !lot.ramps || k < 1 ? [] : (k < lot.N ? [k - 1, k] : [k - 1]);
const inHole = (lot, k, u, v) => lot.ramps && u > lot.ramps.uA && u < lot.ramps.uB && holesAt(lot, k).some(r => Math.abs(v - stripOf(lot, r)) < BAND/2);

// ---------------------------------------------------------------- meshes
function buildLot(lot, group) {
  const M = materials(), { N, F, world, ramps } = lot;
  const lines = createMeshBuilder(), concrete = createMeshBuilder(), rampB = createMeshBuilder(), posts = createMeshBuilder(), lamps = createMeshBuilder();
  const up = { x: 0, y: 1, z: 0 };
  // bay lines
  lot.bays.forEach(b => {
    const y = levelY(b.level) + 0.012;
    [b.u0, b.u0 + BAY_W].forEach(u => {
      const p = (uu, v) => ({ ...world(uu, v), y });
      lines.addQuad(p(u - 0.05, b.back), p(u + 0.05, b.back), p(u + 0.05, b.back + b.facing*BAY_L), p(u - 0.05, b.back + b.facing*BAY_L), up);
    });
    // (the line down the middle of a back-to-back pair, or along a lone row's back)
    const p = (uu, v) => ({ ...world(uu, v), y }), u1 = b.u0 + BAY_W;
    lines.addQuad(p(b.u0 - 0.05, b.back - 0.05), p(u1 + 0.05, b.back - 0.05), p(u1 + 0.05, b.back + 0.05), p(b.u0 - 0.05, b.back + 0.05), up);
  });
  const wall2 = (a, b, y0, y1, builder = concrete) => {
    const nx = -(b.z - a.z), nz = b.x - a.x, len = Math.hypot(nx, nz) || 1, n = { x: nx/len, y: 0, z: nz/len }, m = { x: -n.x, y: 0, z: -n.z };
    const q = [{ x: a.x, y: y0, z: a.z }, { x: b.x, y: y0, z: b.z }, { x: b.x, y: y1, z: b.z }, { x: a.x, y: y1, z: a.z }];
    builder.addQuad(...q, n); builder.addQuad(...q, m);
  };
  if (N > 0) {
    const { uA, uB, vc } = ramps;
    const rectPath = (u0, u1, v0, v1) => toClipperPath([world(u0, v0), world(u1, v0), world(u1, v1), world(u0, v1)]);
    const fPath = [toClipperPath(F)], inner = insetPolygonExact(F, 0.25).map(toClipperPath);
    const ring = clipPolygons(ClipperLib.ClipType.ctDifference, fPath, inner, true);
    for (let k = 1; k <= N; k++) {
      const yt = levelY(k), yb = yt - SLAB;
      const holes = holesAt(lot, k).map(r => rectPath(uA, uB, stripOf(lot, r) - BAND/2, stripOf(lot, r) + BAND/2));
      const deck = clipPolygons(ClipperLib.ClipType.ctDifference, fPath, holes, true);
      concrete.addTops(deck, yt); concrete.addTops(deck, yb, true);
      forEachPolyTreeEdge(deck, (p, q, out) => concrete.addWall(p, q, yb, yt, out));
      concrete.addTops(ring, yt + WALL);
      forEachPolyTreeEdge(ring, (p, q, out) => concrete.addWall(p, q, yt, yt + WALL, out));
      // barriers round the holes, but not where the ramps join this deck
      const vs = holesAt(lot, k).map(r => stripOf(lot, r)), v0 = Math.min(...vs) - BAND/2, v1 = Math.max(...vs) + BAND/2;
      wall2(world(uA, v0), world(uB, v0), yt, yt + WALL); wall2(world(uA, v1), world(uB, v1), yt, yt + WALL);
      const far = endOf(lot, k) === uA ? uB : uA;
      wall2(world(far, v0), world(far, v1), yt, yt + WALL);
    }
    // ramps: sloped slabs with walls both sides
    for (let k = 0; k < N; k++) {
      const lo = endOf(lot, k), hi = endOf(lot, k + 1), v = stripOf(lot, k), w = BAND/2 - 0.1;
      const y0 = levelY(k), y1 = levelY(k + 1), s = (y1 - y0)/(hi - lo), nl = Math.hypot(s, 1);
      const nTop = { x: -s*lot.ux/nl, y: 1/nl, z: -s*lot.uz/nl }, nBot = { x: -nTop.x, y: -nTop.y, z: -nTop.z };
      const p = (u, vv, y) => ({ ...world(u, vv), y });
      rampB.addQuad(p(lo, v - w, y0), p(hi, v - w, y1), p(hi, v + w, y1), p(lo, v + w, y0), nTop);
      rampB.addQuad(p(lo, v - w, y0 - SLAB), p(hi, v - w, y1 - SLAB), p(hi, v + w, y1 - SLAB), p(lo, v + w, y0 - SLAB), nBot);
      [v - w, v + w].forEach(vv => {
        const q = [p(lo, vv, y0 - SLAB), p(hi, vv, y1 - SLAB), p(hi, vv, y1 + WALL), p(lo, vv, y0 + WALL)];
        concrete.addQuad(...q, { x: lot.vx, y: 0, z: lot.vz }); concrete.addQuad(...q, { x: -lot.vx, y: 0, z: -lot.vz });
      });
    }
    // columns: along the bay rows' backs, and round the outside
    const top = levelY(N) - SLAB, inCols = (() => { const ps = insetPolygonExact(F, 0.6); return ps.length ? createRegionTester(ps.map(toClipperPath)) : () => false; })();
    const col = c => concrete.addBox(c.x, c.z, lot.ux, lot.uz, 0.25, 0.25, 0, top);
    lot.backs.forEach(v => {
      for (let u = lot.uMin + 0.3; u <= lot.uMin + lot.nu*lot.CELL; u += 3*BAY_W) {
        const c = world(u, v);
        if (inCols(c.x, c.z) && !(u > uA - 9 && u < uB + 9 && Math.abs(v - vc) < BAND - 0.1)) col(c);
      }
    });
    // strip lights under each ceiling, clear of the ramp holes
    for (let k = 1; k <= N; k++) {
      const y = levelY(k) - SLAB;
      for (let u = lot.uMin + 3; u < lot.uMin + lot.nu*lot.CELL; u += 6) for (let v = lot.vMin + 3; v < lot.vMin + lot.nv*lot.CELL; v += 5) {
        const c = world(u, v);
        if (inCols(c.x, c.z) && !inHole(lot, k, u, v) && !(u > uA - 1 && u < uB + 1 && Math.abs(v - vc) < BAND*1.5)) lamps.addBox(c.x, c.z, lot.ux, lot.uz, 0.7, 0.12, y - 0.08, y);
      }
    }
    for (let i = 0; i < F.length; i++) {
      const a = F[i], b = F[(i + 1) % F.length], len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.round(len/8));
      for (let t = 0; t < n; t++) {
        const x = a.x + (b.x - a.x)*t/n, z = a.z + (b.z - a.z)*t/n, nx = -(b.z - a.z)/len, nz = (b.x - a.x)/len;
        const c = [{ x: x + nx*0.35, z: z + nz*0.35 }, { x: x - nx*0.35, z: z - nz*0.35 }].find(c => pointInPolygon(c, F));
        if (c && !lot.entrances.some(e => Math.hypot(e.x - c.x, e.z - c.z) < 7)) col(c);
      }
    }
  }
  // a "P" sign by each entrance
  lot.entrances.forEach(e => {
    const d = e.drop, outer = d.hw + d.cw + d.sw, a = d.half + 1.2;
    const x = d.x + d.nx*(outer + 0.6) + d.tx*a, z = d.z + d.nz*(outer + 0.6) + d.tz*a;
    posts.addBox(x, z, d.tx, d.tz, 0.05, 0.05, 0, 2.6);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), M.sign);
    sign.position.set(x - d.nx*0.07, 2.4, z - d.nz*0.07); sign.rotation.y = Math.atan2(-d.nx, -d.nz);
    sign.name = 'CarParkSign'; sign.userData.sharedMaterial = true;
    group.add(sign);
  });
  [[lines, M.lines, 'BayLines'], [concrete, M.concrete, 'CarParkConcrete'], [rampB, M.ramp, 'CarParkRamps'], [posts, M.post, 'SignPosts'], [lamps, M.lamp, 'CarParkLights']]
    .forEach(([b, m, name]) => { const mesh = meshOf(b, m, name); if (mesh) group.add(mesh); });
}
