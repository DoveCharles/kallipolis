import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { Y_ZONE_GROUND, Y_PARK, computeWindowGlowFactor } from '../core/scene.js';
import { roadNodes } from '../core/state.js';
import { mulberry32, lerp, polygonArea, pointInPolygon, centroid, insetPolygon, recursiveSubdivide } from '../core/math.js';
import { tessellateOpenPath, resolveParkTint, resolveGrassNoiseStrength } from '../core/splines.js';
import { distPointSegment, closestPointOnSegment } from '../buildings/footprints.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { createMeshBuilder } from '../roads/roads.js';
import { makeFlatZoneMesh, makeParkMesh } from './surface-detail.js';
import { builderMesh } from './farmland.js';

// ---------------------------------------------------------- suburbs
// Streets of houses, cut from one model (assets/models/Houses.glb, made in Blender: five designs). The zone is split into
// plots the way a Buildings zone is split into lots, only much coarser — a plot has to hold a house and the garden round
// it — and each plot gets a lawn, a hedge round it and, usually, a house.
//
// A house always faces the nearest road. Every road centerline near the zone is tessellated once, the plot's middle finds
// the closest point on any of them, and the house is turned to look at it and slid as near to it as its front setback
// allows — then pulled back toward the middle of the plot until all of it fits inside the plot and clear of the roads,
// paths and higher zones cut out of it. A front path runs from the door out to wherever the road starts, and the hedge
// leaves a gap for it. Where there's no road within reach the walkways stand in for one, and failing those the zone's own
// edge does, so a suburb out on its own still faces outward rather than all one way at some road across the map.
//
// Each house is painted a color of its own — the model's `HouseCol` material, the siding — baked into the vertices of a
// copy of the design's geometry, which is why a house is a mesh of its own rather than one instance of many: the GLB
// export skips instanced meshes, and see-through, the cards and people going indoors all want a group a house
// (see cutouts.js for how a Buildings zone does the same).
//
// The model carries no colors at all — every material in it is Blender's default grey, and the window frames come
// through on a nameless one — so every color here is this file's, and HOUSE_PALETTE below is the whole of it.
const HOUSE_MODEL_URL = 'assets/models/Houses.glb';
const HOUSE_NODES = ['House1', 'House2', 'House3', 'House4', 'House5'];
const HOUSE_WIDTH = 11;       // how wide the widest design stands, in world units; the others keep their proportion to it

// the model's materials, by name. `HouseCol` (the siding) isn't here: it's painted per house — see paintFor.
const HOUSE_PALETTE = {
  Roof: 0x4a4340,             // roof tiles
  White: 0xe8e6e0,            // fascia, corner boards, window and garage surrounds
  Foliage: 0x4e7a3a,          // the bushes out front
  'Material.001': 0xc9a227,   // door handles
  'Material.013': 0x9c958b,   // the foundation slab the house stands on
  'Material.014': 0xe8e6e0,   // porch columns
  'Material.015': 0xdcd8d0,   // porch railing, low wall and steps
  'Material.016': 0x6b4630,   // the front and back doors
  'Material.017': 0x3f3a37,   // the garage roof
};
const HOUSE_TRIM_COLOR = 0xe8e6e0;      // anything the palette doesn't name, which is the window frames
const HOUSE_PAINT_MATERIAL = 'HouseCol';
const HOUSE_GLASS_MATERIAL = 'Windows';
const HOUSE_LIT_CHANCE = 0.75;          // a house's chance of its windows being lit after dark
const HOUSE_GLOW = 1.3;                 // how brightly a lit house's windows glow once the sun's down
const HOUSE_GLASS_COLOR = 0x2f3d49, HOUSE_GLASS_LIT = 0xffd7a0;

const SUBURB_GROUND_COLOR = 0x9b968c;   // the ground between the plots, where the pavement and driveways run
const PLOT_MIN_DIM = 15;    // narrowest a plot is ever split to: a house is 11 across, and turning it needs room either side
const PLOT_MIN_ROOM = HOUSE_WIDTH*0.5;  // a plot with nowhere to fit a circle this wide can't hold a house turned any way at all
const PLOT_MARGIN = 1.2;    // gap left between a plot and whatever it was cut from
const FRONT_SETBACK = 4;    // the front garden: how much plot a house leaves between itself and the street side of it
const PLACE_TRIES = 6;      // steps back toward the middle of the plot before giving up on fitting a house in
const STREET_REACH = 90;    // how far outside a zone a road still counts as one of its streets
const DRIVE_WIDTH = 2.6, DRIVE_MAX = 20;
const DRIVE_COLOR = 0xb0ac9f;  // paving rather than bare ground, so the path off the door reads against the lawn
// A suburb stacks three flat surfaces within five hundredths of each other — the zone's ground, a lawn on each plot, and
// the front path over that — which the depth buffer can't keep apart once the camera pulls back. Each one takes a polygon
// offset below the one under it, the way a farmland field sits over its tracks (see makeFlatZoneMesh).
const LAWN_BIAS = -3, DRIVE_BIAS = -4;
const HEDGE_HEIGHT = 0.85, HEDGE_WIDTH = 0.35, HEDGE_COLOR = 0x4a6b33;
const LANE_JOIN = 0.05;     // how near a lane's end has to come to another lane to be counted as ending on it

// The five designs, baked once when the model loads: null until then, and a suburb generated in the meantime gets its
// lawns and hedges and no houses, until loadHouseModels re-subdivides it.
let designs = null;
// Shared by every house in every suburb, and never disposed — each mesh using them is marked shared, so a zone rebuilding
// doesn't take them down with it (see disposeObject). The body takes its color from its vertices, so one material does for
// every house however it's painted.
const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 });
const darkGlassMaterial = new THREE.MeshStandardMaterial({ color: HOUSE_GLASS_COLOR, roughness: 0.15, metalness: 0.1 });
const litGlassMaterial = new THREE.MeshStandardMaterial({ color: HOUSE_GLASS_COLOR, roughness: 0.15, metalness: 0.1, emissive: new THREE.Color(HOUSE_GLASS_LIT) });
// lit after dark, like building windows (see updateWindowGlowForSun, which rescales this every time the sun moves). It's
// set here as well as tracked, since the sun has already been placed by the time this file loads and nothing would turn
// the glow down until the next time it moved — a lit window in broad daylight otherwise.
litGlassMaterial.userData.baseEmissiveIntensity = HOUSE_GLOW;
litGlassMaterial.emissiveIntensity = HOUSE_GLOW*computeWindowGlowFactor(S.sunElevation);

// One geometry from several, in the order given — `parts` are { geometry, color }, each part's color written flat into its
// vertices. The parts flagged `paint` come first and their vertex count comes back as `paintCount`, which is all a house
// needs to know to repaint its siding without hunting through the buffer for it.
function mergeParts(parts) {
  let vertices = 0, corners = 0;
  parts.forEach(p => { vertices += p.geometry.attributes.position.count; corners += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count; });
  if (!vertices) return null;
  const position = new Float32Array(vertices*3), normal = new Float32Array(vertices*3), color = new Float32Array(vertices*3);
  const index = new Uint32Array(corners);
  const tint = new THREE.Color();
  let v = 0, c = 0, paintCount = 0;
  parts.forEach(part => {
    const p = part.geometry.attributes.position, n = part.geometry.attributes.normal, count = p.count;
    tint.setHex(part.color);
    for (let i=0;i<count;i++) {
      position[(v+i)*3] = p.getX(i); position[(v+i)*3+1] = p.getY(i); position[(v+i)*3+2] = p.getZ(i);
      normal[(v+i)*3] = n.getX(i); normal[(v+i)*3+1] = n.getY(i); normal[(v+i)*3+2] = n.getZ(i);
      color[(v+i)*3] = tint.r; color[(v+i)*3+1] = tint.g; color[(v+i)*3+2] = tint.b;
    }
    if (part.geometry.index) for (let i=0;i<part.geometry.index.count;i++) index[c++] = part.geometry.index.getX(i) + v;
    else for (let i=0;i<count;i++) index[c++] = v + i;
    v += count;
    if (part.paint) paintCount += count;
    part.geometry.dispose();
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return { geometry: geo, paintCount };
}
// One design's geometry, split in two: the body, colored in by material name, and the glass, which is shared between every
// house of that design and lit or not as a whole.
function partsOfHouse(node) {
  const body = [], glass = [];
  node.traverse(o => {
    if (!o.isMesh || Array.isArray(o.material) || !o.geometry.attributes.position) return;
    const geo = o.geometry.clone();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    ['uv', 'uv1', 'uv2', 'tangent'].forEach(name => geo.deleteAttribute(name));
    geo.applyMatrix4(o.matrixWorld);
    const name = (o.material && o.material.name) || '';
    if (name === HOUSE_GLASS_MATERIAL) glass.push({ geometry: geo, color: 0xffffff });
    // the siding goes to the front of the body, so every vertex a house repaints sits in one run at the start of it
    else if (name === HOUSE_PAINT_MATERIAL) body.unshift({ geometry: geo, color: 0xffffff, paint: true });
    else body.push({ geometry: geo, color: HOUSE_PALETTE[name] != null ? HOUSE_PALETTE[name] : HOUSE_TRIM_COLOR });
  });
  return { body, glass };
}
export async function loadHouseModels() {
  let gltf;
  try {
    const buffer = await fetch(HOUSE_MODEL_URL).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.arrayBuffer(); });
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch (err) {
    console.warn('Blockout: the house model failed to load; suburbs go without houses', err);
    return;
  }
  try {
    gltf.scene.updateMatrixWorld(true);
    // (three.js puts underscores in place of the spaces in a glTF node's name, so "House 1" would arrive as "House_1")
    const built = HOUSE_NODES.map(name => {
      const node = gltf.scene.getObjectByName(name) || gltf.scene.getObjectByName(name.replace(/\s+/g, '_'));
      if (!node) throw new Error(`the model has no "${name}"`);
      const parts = partsOfHouse(node);
      const body = mergeParts(parts.body);
      if (!body) throw new Error(`"${name}" has nothing in it`);
      const glass = mergeParts(parts.glass);
      const box = new THREE.Box3().setFromBufferAttribute(body.geometry.attributes.position);
      if (glass) box.union(new THREE.Box3().setFromBufferAttribute(glass.geometry.attributes.position));
      return { body, glass, box };
    });
    // all five to one scale, so the widest stands HOUSE_WIDTH across and the others keep their proportion to it
    const widest = Math.max(...built.map(h => h.box.getSize(new THREE.Vector3()).x));
    designs = built.map(({ body, glass, box }) => {
      const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3()), scale = HOUSE_WIDTH/(widest || 1);
      // centered on its own plot, stood on the ground, and turned to face +Z like everything else here that has a front:
      // the model is modelled facing -Z (the porch, the door and the bushes are all on that side), so that's a half turn
      const place = new THREE.Matrix4().makeRotationY(Math.PI)
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
        .multiply(new THREE.Matrix4().makeTranslation(-mid.x, -box.min.y, -mid.z));
      body.geometry.applyMatrix4(place);
      if (glass) glass.geometry.applyMatrix4(place);
      return {
        body: body.geometry, paintCount: body.paintCount, glass: glass ? glass.geometry : null,
        half: { x: size.x*scale/2, z: size.z*scale/2 }, height: size.y*scale,
      };
    });
  } catch (err) {
    console.warn('Blockout: the house model failed to build; suburbs go without houses', err);
    designs = null;
    return;
  }
  S.zones.forEach(zone => { if (zone.zoneType === 'suburbs') App.subdivideZone(zone); });
}

// A house's own color: any hue at all, but only ever at the saturation and lightness house paint comes in, so a street of
// them is varied without any of them being a color nobody would side a house in.
function paintFor(rng) {
  return new THREE.Color().setHSL(rng(), lerp(0.10, 0.42, rng()), lerp(0.56, 0.84, rng()));
}
// A house of `design`, painted `paint`. The body is a copy, since the paint is baked into its vertices; the glass is the
// design's own and shared by every house cut from it.
function houseMesh(design, paint, lit) {
  const geo = design.body.clone(), color = geo.attributes.color;
  for (let i=0;i<design.paintCount;i++) color.setXYZ(i, paint.r, paint.g, paint.b);
  color.needsUpdate = true;
  const group = new THREE.Group();
  const body = new THREE.Mesh(geo, bodyMaterial);
  body.name = 'House';
  body.castShadow = true; body.receiveShadow = true;
  body.userData.sharedMaterial = true;
  group.add(body);
  if (design.glass) {
    const glass = new THREE.Mesh(design.glass, lit ? litGlassMaterial : darkGlassMaterial);
    glass.name = 'HouseWindows';
    glass.receiveShadow = true;
    glass.userData.sharedGeometry = true; glass.userData.sharedMaterial = true;
    group.add(glass);
  }
  return group;
}

// ---- which way a house looks
// Every road, walkway and zone edge near `poly`, as segments, kept apart so a house prefers a real road to a footpath.
function streetSegmentsNear(poly) {
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  poly.forEach(p => { if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x; if (p.z<minZ) minZ=p.z; if (p.z>maxZ) maxZ=p.z; });
  minX -= STREET_REACH; maxX += STREET_REACH; minZ -= STREET_REACH; maxZ += STREET_REACH;
  const roads = [], paths = [], edges = [];
  for (let i=0;i<poly.length;i++) edges.push([poly[i], poly[(i+1)%poly.length]]);
  S.roadLines.forEach(line => {
    if (line.drawing || App.isTrainLine(line) || isRiverLine(line)) return; // nobody's front door looks onto a railway or a river
    const pts = line.nodeIds.map(id => roadNodes[id]).filter(Boolean);
    if (pts.length < 2) return;
    const into = isWalkwayLine(line) ? paths : roads, tess = tessellateOpenPath(pts);
    for (let i=0;i<tess.length-1;i++) {
      const a = tess[i], b = tess[i+1];
      if (Math.max(a.x,b.x)<minX || Math.min(a.x,b.x)>maxX || Math.max(a.z,b.z)<minZ || Math.min(a.z,b.z)>maxZ) continue;
      into.push([a, b]);
    }
  });
  return { roads, paths, edges };
}
function nearestOn(segments, p) {
  let best = null, bestD = Infinity;
  for (const [a, b] of segments) {
    const d = distPointSegment(p, a, b);
    if (d < bestD) { bestD = d; best = [a, b]; }
  }
  return best ? { at: closestPointOnSegment(p, best[0], best[1]), d: bestD } : null;
}
// The street a plot looks onto: the nearest road, however far into the zone the plot is. Only a suburb with no road
// anywhere near it falls back — to the walkways, and failing those to the zone's own edge, so it faces outward rather
// than every house on it turning to look at some road right across the map.
function streetFor(p, streets) {
  const near = nearestOn(streets.roads.length ? streets.roads : streets.paths.length ? streets.paths : streets.edges, p);
  return near ? near.at : null;
}
// The world corners and edge middles of a house `half` across and deep, centered on `at` and turned by `yaw`.
function houseOutline(at, yaw, half) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw), out = [];
  [[-1,-1],[1,-1],[1,1],[-1,1],[0,-1],[1,0],[0,1],[-1,0]].forEach(([sx, sz]) => {
    const lx = sx*half.x, lz = sz*half.z;
    out.push({ x: at.x + lx*cos + lz*sin, z: at.z - lx*sin + lz*cos });
  });
  return out;
}
// Where a house goes on `plot`: up against the street side of the plot bar a front garden, eased back toward the middle
// of the plot until all of it sits inside the plot and clear of every road, path and higher zone. null if it never fits.
function placeHouse(plot, half, street, inBlocker) {
  const c = centroid(plot);
  if (!pointInPolygon(c, plot)) return null;
  const dx = c.x - street.x, dz = c.z - street.z, d = Math.hypot(dx, dz);
  if (d < 1e-4) return null;
  const ux = dx/d, uz = dz/d;                    // from the street toward the middle of the plot
  const yaw = Math.atan2(-ux, -uz);              // a house is baked facing +Z, so this turns its front onto the street
  // How much plot there is between the middle and the street side of it — which is what the house has to sit in, since
  // the road itself is usually a good way further out again (the plot stops at the pavement, and is inset from there).
  let reach = 0;
  while (reach < 200) {
    const t = reach + 0.5, p = { x: c.x - ux*t, z: c.z - uz*t };
    if (!pointInPolygon(p, plot) || inBlocker(p.x, p.z)) break;
    reach = t;
  }
  const want = -Math.max(0, reach - half.z - FRONT_SETBACK); // slide toward the street, leaving a garden in front
  for (let k=0;k<=PLACE_TRIES;k++) {
    const slide = want*(1 - k/PLACE_TRIES);      // easing back to the middle, which is the last thing tried
    const at = { x: c.x + ux*slide, z: c.z + uz*slide };
    if (houseOutline(at, yaw, half).every(p => pointInPolygon(p, plot) && !inBlocker(p.x, p.z))) return { at, yaw };
  }
  return null;
}

/**
 * The lanes between the hedges: the lines the subdivision cut along, which are the middles of the gaps it left.
 *
 * A plot is its lot inset by PLOT_MARGIN all round, and its hedge stands on its edge — so between two plots cut from the
 * same piece there's a gap 2*PLOT_MARGIN wide with the cut line down the middle of it, which is a lane people can walk.
 *
 * Each cut is broken wherever another one ends part-way along it, and the two keep the one point between them rather than
 * each rounding its own: the nav grid joins walkways that share a point, so that's what turns a heap of separate lines
 * into a network people can walk from one end of a block to the other (see buildPeopleNav).
 * @param {Array<[Vec2, Vec2]>} cuts - the splits, in the order they were made
 * @returns {Array<[Vec2, Vec2]>} the lanes, meeting at shared points
 */
function gapLanes(cuts) {
  const ends = cuts.flatMap(cut => cut);
  return cuts.flatMap(([a, b]) => {
    const dx = b.x-a.x, dz = b.z-a.z, len2 = dx*dx + dz*dz;
    if (len2 < 1e-6) return [];
    const at = [{ t: 0, p: a }, { t: 1, p: b }];
    ends.forEach(p => {
      const t = ((p.x-a.x)*dx + (p.z-a.z)*dz)/len2;
      if (t > 1e-4 && t < 1-1e-4 && Math.hypot(p.x - (a.x+dx*t), p.z - (a.z+dz*t)) < LANE_JOIN) at.push({ t, p });
    });
    at.sort((m, n) => m.t - n.t);
    const lanes = [];
    for (let i=1;i<at.length;i++) if (at[i].t - at[i-1].t > 1e-4) lanes.push([at[i-1].p, at[i].p]);
    return lanes;
  });
}

export function generateSuburbsContent(zone, poly, cutouts, blockers) {
  const s = zone.settings, layoutRng = mulberry32(s.seed>>>0);
  zone.walkGaps = []; // (filled in below, once the plots are laid out; people walk these — see buildPeopleNav)
  // How far back from the lane outside it a house stands: its plot's margin, and the front garden behind that. A suburb
  // has no setback setting to say so with, so it tells the door-finder here instead (see doorReach).
  zone.doorSetback = PLOT_MARGIN + FRONT_SETBACK;
  const ground = makeFlatZoneMesh(poly, s.groundColor!=null ? s.groundColor : SUBURB_GROUND_COLOR, Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
  if (ground) zone.buildingsGroup.add(ground);
  const boundary = s.borderSetback>0 ? insetPolygon(poly, s.borderSetback) : poly;
  if (boundary.length < 3) return;
  // The roads and the zones above are taken out first, and each block they leave behind is then split on its own. Laid
  // the other way round — one grid of plots over the whole zone, sliced by the roads afterwards — every road left a row
  // of offcuts down its side: strips too narrow ever to hold a house, each still drawing a lawn and a hedge of its own.
  // Plots are lots by another name, only never split below PLOT_MIN_DIM across: a house wants room to turn on the spot
  // without its corners leaving the plot, whichever way the road runs.
  const blocks = App.cutLotByCutouts(boundary, blockers).pieces
    .filter(b => b.length >= 3 && App.insetPolygonExact(b, PLOT_MARGIN + PLOT_MIN_ROOM).length > 0);
  if (!blocks.length) return;
  const targetPlots = Math.max(1, Math.round(s.suburbPlots!=null ? s.suburbPlots : 40));
  // taken over the blocks rather than the whole zone, so the ground the roads cover doesn't count toward the plot count
  const plotArea = blocks.reduce((a, b) => a + Math.abs(polygonArea(b)), 0)/targetPlots;
  const lots = [], cuts = [];
  blocks.forEach(block => recursiveSubdivide(block, 0,
    { minArea: plotArea, maxDepth: 9, jitter: 0.3, minSplitDim: PLOT_MIN_DIM, onSplit: (a, b) => cuts.push([a, b]) }, layoutRng, lots));
  zone.walkGaps = gapLanes(cuts);
  const streets = streetSegmentsNear(poly);
  // shrunk a hair so a house merely touching a cut-out's edge doesn't count as in it
  const inBlocker = App.createRegionTester(blockers.length ? App.offsetPaths(blockers, -0.01, ClipperLib.JoinType.jtMiter) : []);
  const tint = resolveParkTint(zone), noise = resolveGrassNoiseStrength(zone);
  const drives = createMeshBuilder(), hedges = createMeshBuilder();
  const density = s.suburbDensity!=null ? s.suburbDensity : 0.9;
  lots.forEach(lot => {
    App.insetPolygonExact(lot, PLOT_MARGIN).forEach(plot => {
      if (plot.length < 3) return;
      // What's left over at the awkward corners of a block is left as bare zone ground, which reads as the verge it is.
      if (!App.insetPolygonExact(plot, PLOT_MIN_ROOM).length) return;
      // Each plot draws from its own stream, keyed to the ground it stands on rather than to how far down the list it
      // is, so a plot going from built to empty can't reshuffle the ones after it — the same reasoning as a Buildings
      // zone's lots — and a plot keeps the house it had across an edit to the road beside it.
      const key = centroid(plot);
      const rng = mulberry32(((s.seed>>>0) ^ Math.imul(Math.round(key.x*4), 0x9E3779B1) ^ Math.imul(Math.round(key.z*4), 0x85EBCA6B)) >>> 0);
      const lawn = makeParkMesh(plot, tint, noise, null, null, 0, LAWN_BIAS);
      if (lawn) zone.buildingsGroup.add(lawn);
      const street = streetFor(centroid(plot), streets);
      const design = designs && rng() < density ? designs[Math.floor(rng()*designs.length)] : null;
      const spot = design && street ? placeHouse(plot, design.half, street, inBlocker) : null;
      let drive = null;
      if (spot) {
        const group = houseMesh(design, paintFor(rng), rng() < HOUSE_LIT_CHANCE);
        group.name = 'Building';
        group.userData.buildingKind = 'house'; // what its card says about it: see building-types.js
        group.position.set(spot.at.x, Y_PARK, spot.at.z);
        group.rotation.y = spot.yaw;
        // its own corners and its height, kept on it so people can find a door on its wall and go in (see
        // buildingDoors in people.js) and so it stops being drawn when the camera's inside it (see see-through.js)
        group.userData.footprint = houseOutline(spot.at, spot.yaw, design.half).slice(0, 4);
        group.userData.height = design.height;
        zone.buildingsGroup.add(group);
        drive = frontPath(spot, design.half, lot, inBlocker, drives);
      }
      if (s.suburbHedges !== false) hedgeRound(plot, drive, hedges, rng);
    });
  });
  const driveMesh = builderMesh(drives, DRIVE_COLOR, 'Driveway', { polygonOffset: true, polygonOffsetFactor: DRIVE_BIAS, polygonOffsetUnits: DRIVE_BIAS });
  if (driveMesh) zone.buildingsGroup.add(driveMesh);
  const hedgeMesh = builderMesh(hedges, HEDGE_COLOR, 'Hedge', { roughness: 1 });
  if (hedgeMesh) zone.buildingsGroup.add(hedgeMesh);
}
// The path from a house's door out toward its street, stopping at the road (or at the edge of the lot, whichever comes
// first) so it doesn't run out over the tarmac. Returns the segment it covers, for the hedge to leave a gap in.
// It's bounded by `lot` rather than by the inset plot, so it carries on through the gap it leaves in the hedge and out
// across the margin to where the pavement starts, instead of stopping dead at the hedge line.
function frontPath(spot, half, lot, inBlocker, drives) {
  const fx = Math.sin(spot.yaw), fz = Math.cos(spot.yaw);
  const from = { x: spot.at.x + fx*half.z, z: spot.at.z + fz*half.z };
  let len = 0;
  while (len < DRIVE_MAX) {
    const step = len + 0.5, p = { x: from.x + fx*step, z: from.z + fz*step };
    if (!pointInPolygon(p, lot) || inBlocker(p.x, p.z)) break;
    len = step;
  }
  if (len < 1) return null;
  const to = { x: from.x + fx*len, z: from.z + fz*len };
  drives.addBox((from.x+to.x)/2, (from.z+to.z)/2, fx, fz, len/2, DRIVE_WIDTH/2, Y_PARK, Y_PARK + 0.03);
  return [from, to];
}
// A hedge round a plot: a chain of leafy blocks along its outline, broken wherever the front path crosses it.
function hedgeRound(plot, drive, hedges, rng) {
  for (let i=0;i<plot.length;i++) {
    const a = plot[i], b = plot[(i+1)%plot.length], len = Math.hypot(b.x-a.x, b.z-a.z);
    if (len < 0.3) continue;
    const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len, pieces = Math.max(1, Math.round(len/1.4));
    for (let k=0;k<pieces;k++) {
      const t = (k+0.5)/pieces, at = { x: a.x + (b.x-a.x)*t, z: a.z + (b.z-a.z)*t };
      if (drive && distPointSegment(at, drive[0], drive[1]) < DRIVE_WIDTH/2 + 0.7) continue;
      hedges.addBox(at.x, at.z, dx, dz, len/pieces/2 + 0.08, HEDGE_WIDTH + rng()*0.1, Y_PARK, Y_PARK + HEDGE_HEIGHT + rng()*0.25);
    }
  }
}
