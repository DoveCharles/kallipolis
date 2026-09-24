import * as THREE from 'three';
import { App } from '../core/shared.js';
import { Y_ZONE_GROUND } from '../core/scene.js';
import { mulberry32, lerp, polygonArea, centroid, recursiveSubdivide, insetPolygon } from '../core/math.js';
import { BUILDING_GROUND_COLORS, resolveParkTint, resolveGrassNoiseStrength } from '../core/splines.js';
import { CLIPPER_SCALE, clipPolygons } from '../roads/roads.js';
import { distPointSegment } from '../buildings/footprints.js';
import { WINDOW_TILE_WORLD_SIZE, computeFacadeRuns, createWindowMaterial, mergeGeometryList, buildWallGeometry } from '../buildings/windows.js';
import { makeFlatZoneMesh, makeParkMesh, addStreetFront } from './surface-detail.js';
import { extrudeFootprintGeo } from './zone-visuals.js';
import { cutLotByCutouts, insetPolygonExact } from './cutouts.js';
import { streetSegmentsNear, streetFor } from './suburbs.js';

// ---------------------------------------------------------- town
// A British town: the zone is cut into lots like a Buildings zone, but each lot is a two-to-four storey terrace house
// or shop built right up to the edge of it (so neighbours stand wall to wall down a street), in red or yellow brick,
// white stucco or a painted pastel, under a pitched slate roof with its ridge along the street — a double-pile "M" roof
// where the lot's too deep for one span — and chimney stacks with pots on the gable ends. Houses have tall sash windows
// from the ground up and a painted front door; shops have a shopfront, a fascia over it and now and then awnings, with
// the flat above. Unbuilt lots are back gardens. Each lot is a building like any other: people go in (see "town" and its
// kinds in assets/buildings.txt), cars hit it, and its zone draws them merged (see building-batches.js).

const FLOOR = 3.1, SHOP = 4.0, EAVES = 0.6; // a storey; a shop's ground floor; wall above the top windows
const TOWN_LOOK = { floor: FLOOR, parapet: EAVES - 0.2, pier: 0.5, glassTints: [0x252a31, 0x2b3035, 0x30343c],
  styles: [ // sash windows: tall, narrow and well apart
    { bay: 2.4, glassW: 0.42, glassH: 0.55, sill: 0.26, mullion: 0 },
    { bay: 2.8, glassW: 0.38, glassH: 0.52, sill: 0.28, mullion: 0 },
    { bay: 3.1, glassW: 0.46, glassH: 0.5, sill: 0.28, mullion: 0 },
  ] };
const WALLS = [ // [weight, colours, brick?] — the unpainted ones; the rest (the "paint" setting) are any colour at all
  [3.5, [0x8e4a36, 0x9a5540, 0x7c3f30, 0xa0604a], true],   // red brick
  [1.5, [0xb8a27a, 0xc2ae84, 0xa99670], true],             // yellow stock brick
  [2, [0xe9e4d8, 0xf0ebe0, 0xdcd6c6], false],              // white stucco
];
const ROOFS = [0x4a4f57, 0x3f444b, 0x565a60, 0x4a4f57, 0x8a4b36]; // mostly slate, the odd clay tile
const DOORS = [0x1b1b1b, 0x8a1c1c, 0x1d3557, 0x2d5a3d, 0xd8c35a, 0x5b8a9a];
const FASCIAS = [0x1f3d2b, 0x1b2a4a, 0x5a1a22, 0x151515, 0xe8e2d2, 0x2c5f6b];
const CHIMNEY_BRICK = 0x8e4a36, POT = 0xa0583a, TRIM = 0xefece4, STONE = 0xd6cdb8;

const plain = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, flatShading: true, side: THREE.DoubleSide, ...extra });
function part(group, geo, mat) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'Building';
  group.add(mesh);
  return mesh;
}
function pickWall(rng, paint) {
  if (rng() < paint) return { color: new THREE.Color().setHSL(rng(), lerp(0.25, 0.55, rng()), lerp(0.62, 0.8, rng())), brick: false };
  let r = rng()*WALLS.reduce((sum, w) => sum + w[0], 0);
  const [, colors, brick] = WALLS.find(w => (r -= w[0]) < 0) || WALLS[0];
  return { color: new THREE.Color(colors[Math.floor(rng()*colors.length)]).offsetHSL((rng()-0.5)*0.02, 0, (rng()-0.5)*0.05), brick };
}

// The roof over footprint `pts` (the building's own frame: x, y across the ground, z up) with its ridge running along
// (rx, ry): a gable across the whole depth, or several side by side when it's deep, each pitched from eaves at h. The
// pitched faces go in `roof`, the gable-end walls filling in under them in `gables`; returns the ridges, for chimneys.
function buildRoof(pts, rx, ry, h, rng) {
  const ax = -ry, ay = rx, across = p => p.x*ax + p.y*ay, along = p => p.x*rx + p.y*ry;
  let dMin = Infinity, dMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  pts.forEach(p => { const d = across(p), t = along(p); dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); });
  const spans = Math.max(1, Math.round((dMax - dMin)/10)), w = (dMax - dMin)/spans, half = w/2;
  const rise = Math.min(half*lerp(0.7, 0.95, rng()), 4.5);
  const zAt = d => { const t = Math.min(Math.max(d - dMin, 0), dMax - dMin) % w; return h + rise*(1 - Math.abs(t - half)/half); };
  const roof = [], gables = [];
  const tri = (out, a, b, c, up) => { // wound to face up (a roof) or away from the middle (a wall)
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2], vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    if (up ? nz < 0 : nx*up_[0] + ny*up_[1] < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    out.push({ p: [a, b, c], n: [nx/l, ny/l, nz/l] });
  };
  let up_ = [0, 0];
  // the pitched faces: the footprint cut into strips between each ridge and valley, every strip one flat plane
  const S = CLIPPER_SCALE, at = (t, d) => ({ X: Math.round((rx*t + ax*d)*S), Y: Math.round((ry*t + ay*d)*S) });
  const subject = [pts.map(p => ({ X: Math.round(p.x*S), Y: Math.round(p.y*S) }))];
  for (let k = 0; k < spans*2; k++) {
    const d0 = dMin + k*half - (k === 0 ? 1 : 0), d1 = dMin + (k+1)*half + (k === spans*2-1 ? 1 : 0);
    const strip = [at(tMin-1, d0), at(tMax+1, d0), at(tMax+1, d1), at(tMin-1, d1)];
    clipPolygons(ClipperLib.ClipType.ctIntersection, subject, [strip]).forEach(path => {
      const contour = path.map(q => new THREE.Vector2(q.X/S, q.Y/S));
      THREE.ShapeUtils.triangulateShape(contour, []).forEach(ids => tri(roof, ...ids.map(i => {
        const v = contour[i]; return [v.x, v.y, zAt(v.x*ax + v.y*ay)];
      }), true));
    });
  }
  // the gable ends: each wall carried on up to the roof above it, broken wherever a ridge or valley crosses it
  const c = pts.reduce((m, p) => ({ x: m.x + p.x/pts.length, y: m.y + p.y/pts.length }), { x: 0, y: 0 });
  pts.forEach((p, i) => {
    const q = pts[(i+1)%pts.length], dp = across(p), dq = across(q);
    const cuts = [0, 1];
    for (let k = 1; k < spans*2; k++) { const d = dMin + k*half, s = (d - dp)/(dq - dp); if (s > 0 && s < 1) cuts.push(s); }
    cuts.sort((a, b) => a - b);
    up_ = [(p.x + q.x)/2 - c.x, (p.y + q.y)/2 - c.y];
    for (let k = 0; k+1 < cuts.length; k++) {
      const a = { x: lerp(p.x, q.x, cuts[k]), y: lerp(p.y, q.y, cuts[k]) }, b = { x: lerp(p.x, q.x, cuts[k+1]), y: lerp(p.y, q.y, cuts[k+1]) };
      const za = zAt(across(a)), zb = zAt(across(b));
      if (Math.max(za, zb) - h < 0.01) continue; // an eave: nothing above the wall
      tri(gables, [a.x, a.y, h], [b.x, b.y, h], [b.x, b.y, zb], false);
      tri(gables, [a.x, a.y, h], [b.x, b.y, zb], [a.x, a.y, za], false);
    }
  });
  // where each ridge starts and ends over the footprint: its crossings of the outline
  const ridges = [];
  for (let k = 0; k < spans; k++) {
    const d = dMin + (k + 0.5)*w, ts = [];
    pts.forEach((p, i) => {
      const q = pts[(i+1)%pts.length], dp = across(p), dq = across(q);
      if ((dp - d)*(dq - d) < 0) ts.push(lerp(along(p), along(q), (d - dp)/(dq - dp)));
    });
    if (ts.length >= 2) ridges.push({ d, t0: Math.min(...ts), t1: Math.max(...ts), z: h + rise });
  }
  return { roof, gables, ridges, ax, ay, rise };
}
function trianglesGeo(tris) {
  const pos = [], nor = [];
  tris.forEach(({ p, n }) => p.forEach(v => { pos.push(...v); nor.push(...n); }));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

// One terrace house or shop on `fp` (a lot, world {x, z}), its front on edge `front` — the one nearest the street.
function makeTownBuilding(fp, front, rng, s) {
  const texRng = mulberry32(Math.floor(rng()*0xffffffff)>>>0); // (everything about the windows, as in makeBuildingMesh)
  const shop = rng() < (s.townShops ?? 0.4);
  const lo = Math.round(s.townStoreysMin ?? 2), hi = Math.max(lo, Math.round(s.townStoreysMax ?? 3));
  const storeys = lo + Math.floor(rng()*(hi - lo + 1));
  const h = (shop ? SHOP + (storeys-1)*FLOOR : storeys*FLOOR) + EAVES;
  const { color, brick } = pickWall(rng, s.townPaint ?? 0.3);
  const lit = texRng() < 0.85, litIntensity = lit ? 0.9 + texRng()*0.5 : 0;
  const windowMat = createWindowMaterial(color, texRng, lit, litIntensity, 1, !!s.specularWindows, { ...TOWN_LOOK, lobby: shop ? SHOP : 0 });
  const win = windowMat.userData.windowUniforms;
  const group = new THREE.Group();
  group.name = 'Building';
  Object.assign(group.userData, { footprint: fp, height: h, buildingKind: shop ? 'shop' : 'terrace' }); // (see building-types.js)
  if (shop && lit) Object.assign(group.userData, { lobbyLight: litIntensity, lobbyColor: windowMat.userData.litColor });

  part(group, buildWallGeometry(fp, h, { c0: [0.9, 0.9, 0.9], c1: [1.03, 1.03, 1.03] }, WINDOW_TILE_WORLD_SIZE, 0), windowMat);
  // a stone or painted band at the eaves; then either a string course along every floor, or a pilaster between each
  // column of windows in the wall's own colour (at the bay lines the window shader draws to, from above any shopfront up
  // to the eaves) with a white block on it at every floor, and on half of them a white string course as tall as the blocks
  const trimHex = brick ? STONE : TRIM, trimMat = plain(trimHex);
  const band = (z, height, out) => { const g = extrudeFootprintGeo(insetPolygon(fp, -out), height); g.translate(0, 0, z); return g; };
  const trims = [band(h - 0.3, 0.3, 0.36)] /* out past the pilasters, which stop under it */, floorLines = [];
  for (let k = 0; k < storeys - 1; k++) floorLines.push((shop ? SHOP : FLOOR) + k*FLOOR);
  if (rng() < 0.4) {
    const runs = computeFacadeRuns(fp), wind = polygonArea(fp) > 0 ? -1 : 1, colBase = shop ? SHOP : 0, colH = h - 0.3 - colBase;
    const [bayW] = win.uWinBay.value.toArray(), cornerPier = win.uWinFloor.value.w, cols = [], blocks = [];
    fp.forEach((p, i) => {
      const q = fp[(i+1)%fp.length], el = Math.hypot(q.x-p.x, q.z-p.z);
      if (el < 1e-3) return;
      const { u0, runLen } = runs[i], closed = runLen < 0, pier = closed ? 0 : cornerPier;
      const usable = Math.abs(runLen) - 2*pier, bays = Math.floor(usable/bayW + 0.5);
      if (bays < 1) return;
      const ux = (q.x-p.x)/el, uy = -(q.z-p.z)/el, nx = uy*wind, ny = -ux*wind, angle = Math.atan2(uy, ux);
      for (let k = closed ? 0 : 1; k < bays; k++) {
        const t = pier + k*usable/bays - u0;
        if (t < 0.25 || t > el - 0.25) continue;
        const at = (out) => [p.x + ux*t + nx*out, -p.z + uy*t + ny*out];
        cols.push(new THREE.BoxGeometry(0.5, 0.26, colH).rotateZ(angle).translate(...at(0.13), colBase + colH/2));
        floorLines.forEach(z => blocks.push(new THREE.BoxGeometry(0.75, 0.4, 0.28).rotateZ(angle).translate(...at(0.2), z)));
      }
    });
    if (cols.length) part(group, mergeGeometryList(cols), plain(color, { roughness: 0.9 }));
    if (rng() < 0.5) floorLines.forEach(z => blocks.push(band(z - 0.14, 0.28, 0.26)));
    part(group, mergeGeometryList(blocks), plain(TRIM));
  } else floorLines.forEach(z => trims.push(band(z - 0.15, 0.3, 0.14)));
  part(group, mergeGeometryList(trims), trimMat);

  // the roof, its ridge along the street
  const pts = fp.map(p => ({ x: p.x, y: -p.z }));
  const a = pts[front], b = pts[(front+1)%pts.length], len = Math.hypot(b.x-a.x, b.y-a.y) || 1;
  const { roof, gables, ridges, ax, ay, rise } = buildRoof(pts, (b.x-a.x)/len, (b.y-a.y)/len, h, rng);
  if (roof.length) part(group, trianglesGeo(roof), plain(ROOFS[Math.floor(rng()*ROOFS.length)], { roughness: 0.7 }));
  if (gables.length) part(group, trianglesGeo(gables), plain(color, { roughness: 0.9 }));
  // chimney stacks astride the ridge at the party walls, with a row of pots on each
  const rx = ay, ry = -ax, stacks = [], pots = [];
  ridges.forEach(r => [r.t0 + 0.55, r.t1 - 0.55].forEach(t => {
    if (r.t1 - r.t0 < 3 || rng() < 0.3) return;
    const x = rx*t + ax*r.d, y = ry*t + ay*r.d, angle = Math.atan2(ry, rx), top = r.z + lerp(0.9, 1.6, rng());
    const stack = new THREE.BoxGeometry(0.7, 1.3, top - (r.z - rise*0.4));
    stack.rotateZ(angle).translate(x, y, (top + r.z - rise*0.4)/2);
    const cap = new THREE.BoxGeometry(0.84, 1.44, 0.1);
    cap.rotateZ(angle).translate(x, y, top + 0.05);
    stacks.push(stack, cap);
    const n = rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const o = (i - (n-1)/2)*0.6, pot = new THREE.CylinderGeometry(0.19, 0.23, 0.5, 9).rotateX(Math.PI/2);
      pots.push(pot.translate(x + ax*o, y + ay*o, top + 0.1 + 0.25));
    }
  }));
  if (stacks.length) part(group, mergeGeometryList(stacks), plain(brick ? color : CHIMNEY_BRICK));
  if (pots.length) part(group, mergeGeometryList(pots), plain(POT));

  // the front: a painted door in one of the ground-floor bays (the top of the window behind it left as a fanlight), or
  // a shopfront with a fascia board across it
  const nx0 = -(b.y-a.y)/len, ny0 = (b.x-a.x)/len, c = centroid(fp), outward = ((a.x+b.x)/2 - c.x)*nx0 + ((a.y+b.y)/2 + c.z)*ny0 >= 0 ? 1 : -1;
  const e = { ux: (b.x-a.x)/len, uy: (b.y-a.y)/len, nx: nx0*outward, ny: ny0*outward };
  const place = (geo, t, out, z) => geo.rotateZ(Math.atan2(e.ny, e.nx) - Math.PI/2).translate(a.x + e.ux*t + e.nx*out, a.y + e.uy*t + e.ny*out, z);
  let doorT = null;
  if (shop) {
    const storeTop = 0.78*SHOP;
    part(group, place(new THREE.BoxGeometry(Math.max(len - 0.3, 0.5), 0.16, SHOP - storeTop - 0.45), len/2, 0.08, (SHOP + storeTop + 0.35)/2 + 0.05),
      plain(FASCIAS[Math.floor(rng()*FASCIAS.length)], { roughness: 0.5 }));
    addStreetFront(group, fp, win, texRng, new THREE.Color(FASCIAS[Math.floor(texRng()*FASCIAS.length)]).getHex(), win.uWinGlass.value.getHex(), null);
  } else {
    const run = computeFacadeRuns(fp)[front], pier = run.runLen < 0 ? 0 : TOWN_LOOK.pier;
    const usable = Math.abs(run.runLen) - 2*pier, bays = Math.floor(usable/win.uWinBay.value.x + 0.5);
    const spots = [];
    for (let k = 0; k < bays; k++) { const t = pier + (k + 0.5)*usable/bays - run.u0; if (t > 0.8 && t < len - 0.8) spots.push(t); }
    if (spots.length) {
      const t = doorT = spots[Math.floor(rng()*spots.length)];
      part(group, mergeGeometryList([place(new THREE.BoxGeometry(1.35, 0.06, 2.2), t, 0.03, 1.1), place(new THREE.BoxGeometry(1.5, 0.4, 0.16), t, 0.2, 0.08)]), plain(TRIM));
      part(group, place(new THREE.BoxGeometry(1.0, 0.1, 2.0), t, 0.06, 1.0), plain(DOORS[Math.floor(rng()*DOORS.length)], { roughness: 0.4 }));
    }
  }
  // on some, a sill under every window: a plain block where the window shader draws each one (none under the door)
  if (rng() < 0.5) {
    const [floorH, lobbyH, parapet, cornerPier] = win.uWinFloor.value.toArray(), [bayW, glassW, , sillF] = win.uWinBay.value.toArray();
    const runs = computeFacadeRuns(fp), wind = polygonArea(fp) > 0 ? -1 : 1, floors = Math.floor((h - parapet - lobbyH)/floorH);
    const sills = [];
    fp.forEach((p, i) => {
      const q = fp[(i+1)%fp.length], el = Math.hypot(q.x-p.x, q.z-p.z);
      if (el < 1e-3) return;
      const { u0, runLen } = runs[i], pier = runLen < 0 ? 0 : cornerPier;
      const usable = Math.abs(runLen) - 2*pier, bays = Math.floor(usable/bayW + 0.5);
      if (runLen === 0 || bays < 1) return;
      const bay = usable/bays, w = glassW*bay + 0.2;
      const ux = (q.x-p.x)/el, uy = -(q.z-p.z)/el, nx = uy*wind, ny = -ux*wind, angle = Math.atan2(uy, ux);
      for (let k = 0; k < bays; k++) {
        const t = pier + (k + 0.5)*bay - u0;
        if (t - w/2 < 0 || t + w/2 > el) continue; // a window across a bend in the wall
        for (let f = 0; f < floors; f++) {
          if (f === 0 && i === front && doorT != null && Math.abs(t - doorT) < 0.5) continue;
          sills.push(new THREE.BoxGeometry(w, 0.3, 0.2).rotateZ(angle)
            .translate(p.x + ux*t + nx*0.15, -p.z + uy*t + ny*0.15, lobbyH + f*floorH + sillF*floorH - 0.1));
        }
      }
    });
    if (sills.length) part(group, mergeGeometryList(sills), plain(brick ? STONE : TRIM));
  }
  group.rotation.x = -Math.PI/2;
  group.userData.batchable = true;
  return group;
}

export function generateTownContent(zone, poly, cutouts, blockers) {
  const s = zone.settings;
  const ground = makeFlatZoneMesh(poly, s.groundColor!=null ? s.groundColor : BUILDING_GROUND_COLORS[0], Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
  if (ground) zone.buildingsGroup.add(ground);
  const targetLots = Math.max(1, Math.round(s.townLots ?? 40)), avgLotArea = Math.abs(polygonArea(poly))/targetLots;
  const lots = [];
  recursiveSubdivide(poly, 0, { minArea: avgLotArea, maxDepth: 10, jitter: 0.25, minSplitDim: 4 }, mulberry32(s.seed>>>0), lots);
  const streets = streetSegmentsNear(poly), setback = s.townSetback ?? 0;
  lots.forEach((lot, li) => cutLotByCutouts(lot, blockers).pieces.forEach((piece, pi) => {
    const area = Math.abs(polygonArea(piece));
    if (area < Math.max(avgLotArea*0.12, 12)) return;
    // each lot on its own stream, as in a Buildings zone, so one slider never reshuffles the rest
    const rng = mulberry32(((s.seed>>>0) ^ Math.imul(li+1, 0x9E3779B1) ^ Math.imul(pi+1, 0x85EBCA6B)) >>> 0);
    const plot = setback > 0 ? insetPolygonExact(piece, setback)[0] : piece;
    if (!plot || plot.length < 3) return;
    if (rng() >= (s.townDensity ?? 0.92)) { zone.buildingsGroup.add(makeParkMesh(plot, resolveParkTint(zone), resolveGrassNoiseStrength(zone))); return; }
    const street = streetFor(centroid(plot), streets);
    let front = 0, best = Infinity;
    plot.forEach((p, i) => {
      const q = plot[(i+1)%plot.length], d = street ? distPointSegment(street, p, q) : -Math.hypot(q.x-p.x, q.z-p.z);
      if (d < best - 1e-6 && Math.hypot(q.x-p.x, q.z-p.z) > 2) { best = d; front = i; }
    });
    zone.buildingsGroup.add(makeTownBuilding(plot, front, rng, s));
  }));
}

Object.assign(App, { generateTownContent });
