import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, Y_PARK, Y_PATH, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { closestPointOnSegment } from '../buildings/footprints.js';
import { tessellateOpenPath, tessellateClosedPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, roadLineWidths, clipPolygons } from '../roads/roads.js';
import { isPathLine, isRiverLine } from '../roads/paths.js';
import { isTrainLine } from '../trains/trains.js';
import { Y_PLAZA } from '../zones/plazas.js';
import { getWaterRegion } from '../water/water.js';
import { toClipperPath, pathsArea, offsetPaths, createRegionTester, zoneCutoutsNear } from '../zones/cutouts.js';
import { FOOTBRIDGE_TOP } from '../water/bridges.js';

// ============================================================ people
// Lil people: tiny cuboids in random colors, all drawn as one instanced mesh. Most walk the walkways — the sidewalks either
// side of sidewalk roads, and paths — carrying on through junctions or turning off, and turning back at dead ends. They
// gather in plazas and parks: someone walking past one sometimes wanders in, drifts from spot to spot (often over to
// someone already there), stands around for a while, and eventually heads back out to the nearest walkway. The walkways
// are worked out again whenever the roads or zones change, and anyone whose walkway moved is set back on the nearest one.
const PEOPLE_MAX = 2000;
const PERSON_WALK_SPEED = 1.4;   // world units per second at speed 1
export const PEOPLE_NAV_SPACING = 4;    // walkways are resampled to a point at least this often, for entrances and re-seating
S.peopleEnabled = false, S.peopleAmount = 300, S.peopleSpeed = 1, S.peopleSize = 1;
let peopleNav = null, peopleNavBuiltAt = -Infinity, lastPeopleTime = null;
const people = [];
const peopleRng = mulberry32(90210);
const peopleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8 }), PEOPLE_MAX);
peopleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
{
  const color = new THREE.Color();
  for (let i=0;i<PEOPLE_MAX;i++) peopleMesh.setColorAt(i, color.setHSL(peopleRng(), 0.45 + peopleRng()*0.4, 0.42 + peopleRng()*0.25));
}
peopleMesh.count = 0;
peopleMesh.frustumCulled = false;
peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
peopleMesh.visible = false;
peopleMesh.name = 'People';
scene.add(peopleMesh);

// The people model (assets/models/Man.glb, made in Blender) replaces the cuboids once it's loaded. Its
// parts — skin, shirt, pants and hair — are each an instanced mesh of their own, so every person gets their own color for
// each (skin from a range of natural skin tones; hair mostly natural, sometimes dyed), and all of them share one set of
// instance matrices. The model's shape keys are applied per person by a small addition to the vertex shader, driven by an
// instanceMorph value per person — a plain morph target would set them the same for everyone:
//   x  'Walk'  swings between -1 and 1 as they walk (updatePeople)
//   y  'Sex'   0 or 1, chosen once per person
//   z  'Hair'  their hair length, chosen once per person
const SKIN_TONES = [0x3b2219, 0x5a3825, 0x7a4b2f, 0x9a6441, 0xb57f58, 0xcc9a73, 0xdeb28d, 0xecc7a6, 0xf5d9c0];
const PANTS_COLORS = [0x26344f, 0x3e5a82, 0x5a7aa6, 0x232326, 0x4d5057, 0x8f8f93, 0xb09a72, 0x6b5038, 0x46503a];
const HAIR_TONES = [0x0f0d0c, 0x2a1d15, 0x4a3223, 0x6f4e33, 0x8a4f2a, 0xa0692f, 0xc49a5a, 0xdcc08a, 0xb9b5ad, 0xe3ddd2]; // black to platinum
const PERSON_SHAPE_KEYS = ['Walk', 'Sex', 'Hair']; // in instanceMorph's x, y, z order
let personModel = null; // { parts, matrix, morph, height, minY, yaw } once loaded
function injectPersonMorphs(shader, withNormals) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PERSON_SHAPE_KEYS.map(key => `attribute vec3 morph${key};\nattribute vec3 morph${key}Normal;`).join('\n') + '\nattribute vec3 instanceMorph;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += morphWalk*instanceMorph.x + morphSex*instanceMorph.y + morphHair*instanceMorph.z;');
  if (withNormals) shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
    '#include <beginnormal_vertex>\nobjectNormal = normalize(objectNormal + morphWalkNormal*instanceMorph.x + morphSexNormal*instanceMorph.y + morphHairNormal*instanceMorph.z);');
}
// Smooth vertex normals for an indexed mesh whose vertices are split per face: vertices in the same place are grouped
// (or grouped as `groups` says, to reuse another pose's grouping), and each group gets the area-weighted average of the
// normals of every face touching it. Returns { normals, groups }.
function smoothVertexNormals(count, index, positionAt, groups) {
  if (!groups) {
    const ids = new Map();
    groups = new Int32Array(count);
    for (let i=0;i<count;i++) {
      const [x, y, z] = positionAt(i), key = Math.round(x*1e4) + ',' + Math.round(y*1e4) + ',' + Math.round(z*1e4);
      if (!ids.has(key)) ids.set(key, ids.size);
      groups[i] = ids.get(key);
    }
  }
  const sums = new Float32Array(count*3);
  const corners = index ? index.count : count;
  for (let t=0;t+2<corners;t+=3) {
    const a = index ? index.getX(t) : t, b = index ? index.getX(t+1) : t+1, c = index ? index.getX(t+2) : t+2;
    const pa = positionAt(a), pb = positionAt(b), pc = positionAt(c);
    const ux = pb[0]-pa[0], uy = pb[1]-pa[1], uz = pb[2]-pa[2], vx = pc[0]-pa[0], vy = pc[1]-pa[1], vz = pc[2]-pa[2];
    const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx; // length is twice the face's area, so bigger faces count more
    [a, b, c].forEach(v => { const g = groups[v]*3; sums[g] += nx; sums[g+1] += ny; sums[g+2] += nz; });
  }
  const normals = new Float32Array(count*3);
  for (let i=0;i<count;i++) {
    const g = groups[i]*3, len = Math.hypot(sums[g], sums[g+1], sums[g+2]) || 1;
    normals[i*3] = sums[g]/len; normals[i*3+1] = sums[g+1]/len; normals[i*3+2] = sums[g+2]/len;
  }
  return { normals, groups };
}
// A GLB with every accessor that has no data of its own given a zero-filled buffer view. glTF lets an accessor leave its
// data out to mean "all zeros" — Blender writes one for a shape key that doesn't move a part (the Walk key on the hair,
// say) — but three.js r128's GLTFLoader can't read those. The zeros are appended to the binary chunk.
function withEmptyAccessorsFilled(buffer) {
  const view = new DataView(buffer), jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  const binChunk = 20 + jsonLength, binLength = binChunk + 8 <= buffer.byteLength ? view.getUint32(binChunk, true) : 0;
  const COMPONENTS = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 }, BYTES = { 5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4 };
  let added = 0;
  (json.accessors || []).forEach(accessor => {
    if (accessor.bufferView !== undefined || accessor.sparse !== undefined) return;
    const byteLength = accessor.count*COMPONENTS[accessor.type]*BYTES[accessor.componentType];
    json.bufferViews = json.bufferViews || [];
    json.bufferViews.push({ buffer: 0, byteOffset: binLength + added, byteLength });
    accessor.bufferView = json.bufferViews.length - 1;
    added += Math.ceil(byteLength/4)*4;
  });
  if (!added) return buffer;
  json.buffers[0].byteLength = binLength + added;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json)), jsonPadded = Math.ceil(jsonBytes.length/4)*4;
  const out = new ArrayBuffer(12 + 8 + jsonPadded + 8 + binLength + added), outView = new DataView(out), outBytes = new Uint8Array(out);
  outView.setUint32(0, 0x46546C67, true); outView.setUint32(4, 2, true); outView.setUint32(8, out.byteLength, true); // 'glTF', version 2
  outView.setUint32(12, jsonPadded, true); outView.setUint32(16, 0x4E4F534A, true);                                   // 'JSON'
  outBytes.fill(0x20, 20, 20 + jsonPadded); outBytes.set(jsonBytes, 20);
  const bin = 20 + jsonPadded;
  outView.setUint32(bin, binLength + added, true); outView.setUint32(bin + 4, 0x004E4942, true);                        // 'BIN'
  outBytes.set(new Uint8Array(buffer, binChunk + 8, binLength), bin + 8); // the rest of the new chunk stays zero
  return out;
}
const PERSON_MODEL_URL = 'assets/models/Man.glb';
export async function loadPersonModel() {
  let buffer;
  try {
    buffer = await fetch(PERSON_MODEL_URL).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  } catch (err) {
    console.warn('Blockout: the people model failed to load; people stay cuboids', err);
    return;
  }
  new GLTFLoader().parse(withEmptyAccessorsFilled(buffer), '', (gltf) => {
    const sources = [];
    gltf.scene.traverse(o => { if (o.isMesh) sources.push(o); });
    if (!sources.length) return;
    const box = new THREE.Box3();
    sources.forEach(o => { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); });
    // each person's shape keys: walk (set as they go), and a sex (0 or 1, even odds) and hair length that stay with them
    const morph = new THREE.InstancedBufferAttribute(new Float32Array(PEOPLE_MAX*3), 3);
    morph.setUsage(THREE.DynamicDrawUsage);
    const traitRng = mulberry32(777);
    for (let i=0;i<PEOPLE_MAX;i++) { morph.array[i*3+1] = traitRng() < 0.5 ? 0 : 1; morph.array[i*3+2] = traitRng(); }
    const colorRng = mulberry32(4242), color = new THREE.Color(), next = new THREE.Color();
    const colorFor = {
      skin: () => { const f = colorRng()*(SKIN_TONES.length - 1), k = Math.floor(f); return color.set(SKIN_TONES[k]).lerp(next.set(SKIN_TONES[k+1]), f - k); },
      // three in four have a natural hair color; the rest have dyed it something bright
      hair: () => colorRng() < 0.75 ? color.set(HAIR_TONES[Math.floor(colorRng()*HAIR_TONES.length)]).multiplyScalar(0.9 + colorRng()*0.2) : color.setHSL(colorRng(), 0.65 + colorRng()*0.3, 0.45 + colorRng()*0.15),
      shirt: () => colorRng() < 0.22 ? color.setHSL(0, 0, [0.1, 0.3, 0.55, 0.88][Math.floor(colorRng()*4)]) : color.setHSL(colorRng(), 0.35 + colorRng()*0.45, 0.35 + colorRng()*0.3),
      pants: () => colorRng() < 0.8 ? color.set(PANTS_COLORS[Math.floor(colorRng()*PANTS_COLORS.length)]) : color.setHSL(colorRng(), 0.25 + colorRng()*0.3, 0.25 + colorRng()*0.25),
    };
    let matrix = null;
    const parts = sources.map(source => {
      const src = source.geometry, geo = new THREE.BufferGeometry(), count = src.attributes.position.count;
      geo.setAttribute('position', src.attributes.position);
      geo.setIndex(src.index);
      // each shape key's offsets, found by name (a part a key doesn't move gets none)
      const targets = src.morphAttributes && src.morphAttributes.position || [], dictionary = source.morphTargetDictionary || {};
      const offsetsFor = key => {
        const name = Object.keys(dictionary).find(n => n.toLowerCase() === key.toLowerCase());
        return name != null && targets[dictionary[name]] ? targets[dictionary[name]] : null;
      };
      // smooth shading: the model's normals are per face, so they're replaced with normals averaged over every face meeting
      // at each point — worked out for its base shape and again with each shape key fully on, so it stays smooth-shaded
      // however they're set
      const pos = src.attributes.position;
      const shapeWith = offsets => i => offsets ? [pos.getX(i) + offsets.getX(i), pos.getY(i) + offsets.getY(i), pos.getZ(i) + offsets.getZ(i)] : [pos.getX(i), pos.getY(i), pos.getZ(i)];
      const base = smoothVertexNormals(count, src.index, shapeWith(null), null);
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(base.normals, 3));
      PERSON_SHAPE_KEYS.forEach(key => {
        const offsets = offsetsFor(key);
        geo.setAttribute('morph' + key, offsets || new THREE.Float32BufferAttribute(new Float32Array(count*3), 3));
        const shaped = offsets ? smoothVertexNormals(count, src.index, shapeWith(offsets), base.groups).normals : base.normals;
        geo.setAttribute('morph' + key + 'Normal', new THREE.Float32BufferAttribute(shaped.map((n, k) => n - base.normals[k]), 3));
      });
      geo.setAttribute('instanceMorph', morph);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
      mat.onBeforeCompile = shader => injectPersonMorphs(shader, true);
      const mesh = new THREE.InstancedMesh(geo, mat, PEOPLE_MAX);
      if (matrix) mesh.instanceMatrix = matrix; else { matrix = mesh.instanceMatrix; matrix.setUsage(THREE.DynamicDrawUsage); }
      const pick = colorFor[((source.material && source.material.name) || '').toLowerCase()] || colorFor.shirt;
      for (let i=0;i<PEOPLE_MAX;i++) mesh.setColorAt(i, pick());
      // shadows take the shape keys too
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = shader => injectPersonMorphs(shader, false);
      mesh.customDepthMaterial = depth;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.name = 'People';
      scene.add(mesh);
      return mesh;
    });
    // the model faces along -X (its toes point that way, and its walk swings the legs along X); people face along +Z
    personModel = { parts, matrix, morph, height: box.max.y - box.min.y, minY: box.min.y, yaw: Math.PI/2 };
    peopleMesh.visible = false;
  }, (err) => console.warn('Blockout: the people model failed to load; people stay cuboids', err));
}

export function syncPeopleUI() {
  document.getElementById('s-people').classList.toggle('on', S.peopleEnabled);
  document.getElementById('people-settings').style.display = S.peopleEnabled ? 'block' : 'none';
  document.getElementById('s-peopleamount').value = S.peopleAmount;
  document.getElementById('dv-peopleamount').textContent = Math.round(S.peopleAmount);
  document.getElementById('s-peoplespeed').value = S.peopleSpeed;
  document.getElementById('dv-peoplespeed').textContent = S.peopleSpeed.toFixed(1);
  document.getElementById('s-peoplesize').value = S.peopleSize;
  document.getElementById('dv-peoplesize').textContent = S.peopleSize.toFixed(1);
  document.getElementById('s-traffic').value = S.trafficAmount;
  document.getElementById('dv-traffic').textContent = Math.round(S.trafficAmount);
}

// The walkways ({ pts, cum, lateral, jitter, y… } per road or path line, with each point's junction links and park or
// plaza entrance) and the hangouts ({ inside, bounds, y, exits } per plaza and park).
function buildPeopleNav() {
  const areas = [], lines = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'plaza' && zone.zoneType !== 'park')) return;
    const poly = tessellateClosedPath(zone.points);
    const paths = offsetPaths(clipPolygons(ClipperLib.ClipType.ctDifference, [toClipperPath(poly)], zoneCutoutsNear(zone, poly)), -1.2, ClipperLib.JoinType.jtMiter);
    const size = pathsArea(paths);
    if (size < 20) return;
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    paths.forEach(path => path.forEach(p => { minX=Math.min(minX,p.X); maxX=Math.max(maxX,p.X); minZ=Math.min(minZ,p.Y); maxZ=Math.max(maxZ,p.Y); }));
    const inArea = createRegionTester(paths), fountain = zone.zoneType==='plaza' ? zone.fountainSpot : null;
    const inside = fountain ? (x, z) => inArea(x, z) && Math.hypot(x - fountain.x, z - fountain.z) > fountain.r + 0.8 : inArea;
    areas.push({ inside, fountain, minX: minX/CLIPPER_SCALE, maxX: maxX/CLIPPER_SCALE, minZ: minZ/CLIPPER_SCALE, maxZ: maxZ/CLIPPER_SCALE,
      size, y: zone.zoneType==='plaza' ? Y_PLAZA : Y_PARK, exits: [] });
  });
  const inWater = createRegionTester(getWaterRegion());
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isRiverLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const pts = [nodes[0]];
    for (let i=1;i<nodes.length;i++) {
      const a = nodes[i-1], b = nodes[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
      for (let k=1;k<=steps;k++) pts.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    }
    const cum = [0];
    for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
    if (cum[cum.length-1] < 1) return;
    const path = isPathLine(line), { hw, cw, sw } = roadLineWidths(line);
    lines.push({ pts, cum, total: cum[cum.length-1], path,
      y: path ? Y_PATH : (cw + sw > 0 ? Y_SIDEWALK : Y_ROAD),
      lateral: path ? hw*0.55 : hw + cw + sw*0.5, jitter: path ? 0 : Math.min(sw*0.3, 0.8),
      overWater: path ? pts.map(p => inWater(p.x, p.z)) : null,
      vertices: pts.map(() => ({ links: [], entrances: [] })) });
  });
  // junctions: points of different lines in the same place
  const byPlace = new Map();
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const key = Math.round(p.x*2) + ',' + Math.round(p.z*2);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push({ li, vi });
  }));
  byPlace.forEach(list => { if (list.length > 1) list.forEach(a => { lines[a.li].vertices[a.vi].links = list.filter(b => b.li !== a.li); }); });
  // entrances: points beside (or, for a path, in) a plaza or park; and a grid of every point, for finding the nearest
  const grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ li, vi });
    if (!areas.length) return;
    const a = nav.pts[Math.max(0, vi-1)], b = nav.pts[Math.min(nav.pts.length-1, vi+1)], len = Math.hypot(b.x-a.x, b.z-a.z) || 1;
    // look straight out from the walkway on each side (side is the sign of a walker's lateral offset), a few steps further
    // each time — a zone's edge can sit well back from the sidewalk — and, for a path, at the path itself (running through a
    // park). A road between a park and a plaza gets an entrance to each, one per side.
    const nx = -(b.z-a.z)/len, nz = (b.x-a.x)/len, edge = nav.lateral + nav.jitter;
    const areaAt = (x, z) => areas.findIndex(ar => x >= ar.minX && x <= ar.maxX && z >= ar.minZ && z <= ar.maxZ && ar.inside(x, z));
    const entrances = nav.vertices[vi].entrances;
    [1, -1].forEach(side => {
      const offsets = (nav.path ? [0] : []).concat([2, 5, 9, 14].map(extra => side*(edge + extra)));
      for (const off of offsets) {
        const x = p.x + nx*off, z = p.z + nz*off, area = areaAt(x, z);
        if (area >= 0) { entrances.push({ area, side, x, z }); if (!areas[area].exits.some(e => e.li === li && e.vi === vi)) areas[area].exits.push({ li, vi }); break; }
      }
    });
  }));
  return { areas, lines, grid, CELL };
}

function newPerson() {
  return { x:0, y:0, z:0, heading: peopleRng()*Math.PI*2, stride: 0.8 + peopleRng()*0.4, height: 0.85 + peopleRng()*0.27, phase: peopleRng()*10,
    mode: 'none', li: 0, u: 0, dir: 1, seg: 0, lat: 0, area: -1, tx: 0, tz: 0, wait: 0, exit: null, moving: false, walk: 0 };
}
export function pickWeighted(items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let r = peopleRng()*total;
  for (let i=0;i<items.length;i++) { r -= weightOf(items[i]); if (r <= 0) return i; }
  return items.length - 1;
}
// a random spot inside a hangout — near `near` if one can be found there
function randomSpotIn(area, near) {
  for (let k=0;k<24;k++) {
    const x = near && k < 12 ? near.x + (peopleRng()-0.5)*24 : area.minX + peopleRng()*(area.maxX-area.minX);
    const z = near && k < 12 ? near.z + (peopleRng()-0.5)*24 : area.minZ + peopleRng()*(area.maxZ-area.minZ);
    if (area.inside(x, z)) return { x, z };
  }
  return near ? { x: near.x, z: near.z } : { x: (area.minX+area.maxX)/2, z: (area.minZ+area.maxZ)/2 };
}
// puts a person on walkway `li` at distance u along it, heading `dir`, on a random side
function joinWalkway(p, li, u, dir) {
  const nav = peopleNav.lines[li];
  p.mode = 'line'; p.li = li; p.dir = dir; p.u = Math.max(0, Math.min(nav.total, u));
  p.seg = 0;
  while (p.seg < nav.pts.length-2 && nav.cum[p.seg+1] <= p.u) p.seg++;
  p.lat = nav.path ? (peopleRng()-0.5)*2*nav.lateral : (peopleRng() < 0.5 ? -1 : 1)*(nav.lateral + (peopleRng()-0.5)*2*nav.jitter);
}
function wanderInto(p, areaIndex, near) {
  const spot = randomSpotIn(peopleNav.areas[areaIndex], near);
  p.mode = 'wander'; p.area = areaIndex; p.tx = spot.x; p.tz = spot.z; p.wait = 0;
}
function spawnPerson(p) {
  const { areas, lines } = peopleNav;
  if (areas.length && (!lines.length || peopleRng() < 0.45)) {
    const ai = pickWeighted(areas, a => a.size), spot = randomSpotIn(areas[ai]);
    p.x = spot.x; p.z = spot.z; p.y = areas[ai].y;
    wanderInto(p, ai, spot);
    p.wait = peopleRng()*6;
  } else if (lines.length) {
    const li = pickWeighted(lines, l => l.total);
    joinWalkway(p, li, peopleRng()*lines[li].total, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else {
    p.mode = 'none';
  }
}
// after the walkways are rebuilt: back into the hangout they're standing in, else onto the nearest walkway, else anywhere
function reseatPerson(p) {
  const { areas, lines, grid, CELL } = peopleNav;
  if (p.mode === 'wander' || p.mode === 'leaving') {
    const ai = areas.findIndex(a => p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ && a.inside(p.x, p.z));
    if (ai >= 0) { wanderInto(p, ai, p); return; }
  }
  if (p.mode !== 'none') {
    let best = null;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-2;ox<=2;ox++) for (let oz=-2;oz<=2;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      const q = lines[li].pts[vi], d = Math.hypot(q.x-p.x, q.z-p.z);
      if (!best || d < best.d) best = { li, vi, d };
    });
    if (best) { joinWalkway(p, best.li, lines[best.li].cum[best.vi], p.dir || 1); return; }
  }
  spawnPerson(p);
}
// where a person on a walkway should be: the walkway's point at their distance along it, set off to their side
function walkwayPoint(p) {
  const nav = peopleNav.lines[p.li];
  const i = Math.max(0, Math.min(nav.pts.length-2, p.seg));
  const a = nav.pts[i], b = nav.pts[i+1], segLen = (nav.cum[i+1] - nav.cum[i]) || 1;
  const t = Math.max(0, Math.min(1, (p.u - nav.cum[i])/segLen));
  const dx = (b.x-a.x)/segLen, dz = (b.z-a.z)/segLen;
  const y = nav.path && nav.overWater[i] && nav.overWater[i+1] ? FOOTBRIDGE_TOP : nav.y;
  return { x: a.x + (b.x-a.x)*t - dz*p.lat, y, z: a.z + (b.z-a.z)*t + dx*p.lat };
}
// moves a person `dist` along their walkway, dealing with each point they pass: maybe wandering into a hangout, maybe
// turning off at a junction, and turning back at a dead end
function walkAlong(p, dist) {
  let nav = peopleNav.lines[p.li];
  let u = p.u + p.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const ahead = p.dir > 0 ? p.seg + 1 : p.seg;
    const at = nav.cum[ahead];
    if (p.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead], isEnd = ahead === 0 || ahead === nav.pts.length-1;
    // someone on a sidewalk only turns in on their own side of the road; on a path, either side will do
    const entrance = vertex.entrances.length ? vertex.entrances.find(e => e.side === Math.sign(p.lat)) || (nav.path ? vertex.entrances[0] : null) : null;
    if (entrance && peopleRng() < 0.12) { p.u = at; wanderInto(p, entrance.area, entrance); return; }
    if (vertex.links.length && peopleRng() < (isEnd ? 0.85 : 0.3)) {
      const link = vertex.links[Math.floor(peopleRng()*vertex.links.length)];
      const other = peopleNav.lines[link.li], remaining = Math.abs(u - at);
      const dir = link.vi === 0 ? 1 : link.vi === other.pts.length-1 ? -1 : (peopleRng() < 0.5 ? 1 : -1);
      joinWalkway(p, link.li, other.cum[link.vi], dir);
      p.seg = dir > 0 ? Math.min(link.vi, other.pts.length-2) : Math.max(link.vi-1, 0);
      nav = other;
      u = p.u + dir*remaining;
      continue;
    }
    if (isEnd) { p.dir = -p.dir; u = 2*at - u; continue; }
    p.seg += p.dir;
  }
  p.u = Math.max(0, Math.min(nav.total, u));
}
export function updatePeople(t) {
  const dt = lastPeopleTime == null ? 0 : Math.min(0.1, Math.max(0, t - lastPeopleTime));
  lastPeopleTime = t;
  peopleMesh.visible = S.peopleEnabled && !personModel;
  if (personModel) personModel.parts.forEach(mesh => { mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) return;
  if (!peopleNav || (S.peopleNavDirty && t - peopleNavBuiltAt > 0.25)) {
    S.peopleNavDirty = false;
    peopleNavBuiltAt = t;
    peopleNav = buildPeopleNav();
    people.forEach(reseatPerson);
  }
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  while (people.length < wanted) { const p = newPerson(); spawnPerson(p); people.push(p); }
  if (people.length > wanted) people.length = wanted;
  peopleMesh.count = people.length;
  if (personModel) personModel.parts.forEach(mesh => { mesh.count = people.length; });
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  people.forEach((p, i) => {
    if (p.mode === 'none' && (peopleNav.lines.length || peopleNav.areas.length)) spawnPerson(p);
    const speed = PERSON_WALK_SPEED*S.peopleSpeed*p.stride;
    let goal = null;
    if (p.mode === 'line') {
      walkAlong(p, speed*dt);
      if (p.mode === 'line') goal = walkwayPoint(p);
    }
    if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      if (p.wait > 0) {
        p.wait -= dt;
      } else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.wait = 1 + peopleRng()*7;
        const roll = peopleRng();
        if (area.exits.length && roll < 0.22) {
          // head for the nearest of a few of the hangout's entrances
          let exit = null;
          for (let k=0;k<6;k++) {
            const e = area.exits[Math.floor(peopleRng()*area.exits.length)], q = peopleNav.lines[e.li].pts[e.vi], d = Math.hypot(q.x-p.x, q.z-p.z);
            if (!exit || d < exit.d) exit = { ...e, d };
          }
          // they'll join that walkway where it passes the entrance, so that's where they walk to
          joinWalkway(p, exit.li, peopleNav.lines[exit.li].cum[exit.vi], peopleRng() < 0.5 ? -1 : 1);
          p.exit = walkwayPoint(p);
          p.mode = 'leaving'; p.wait = 0;
        } else if (roll < 0.6) {
          // over to someone else hanging out here
          let friend = null;
          for (let k=0;k<8 && !friend;k++) { const q = people[Math.floor(peopleRng()*people.length)]; if (q !== p && q.mode === 'wander' && q.area === p.area) friend = q; }
          const spot = friend ? { x: friend.tx + (peopleRng()-0.5)*3, z: friend.tz + (peopleRng()-0.5)*3 } : null;
          if (spot && area.inside(spot.x, spot.z)) { p.tx = spot.x; p.tz = spot.z; } else { const s = randomSpotIn(area, p); p.tx = s.x; p.tz = s.z; }
        } else {
          const s = randomSpotIn(area); p.tx = s.x; p.tz = s.z;
        }
      }
      if (p.mode === 'wander') goal = { x: p.tx, y: area.y, z: p.tz };
    }
    if (p.mode === 'leaving') {
      // already placed on their walkway by joinWalkway; once they've reached it they carry on along it
      goal = p.exit;
      if (Math.hypot(p.exit.x - p.x, p.exit.z - p.z) < 0.5) p.mode = 'line';
    }
    // in a plaza, walk around its fountain rather than through the pool: while the straight line to where they're going
    // passes over it, head instead for the point on its rim nearest that line — which moves round as they do
    const hangout = (p.mode === 'wander' || p.mode === 'leaving') && p.area >= 0 ? peopleNav.areas[p.area] : null;
    if (goal && hangout && hangout.fountain) {
      const f = hangout.fountain, clearance = f.r + 1.2;
      const c = closestPointOnSegment(f, p, goal);
      let dx = c.x - f.x, dz = c.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < clearance) {
        if (d < 1e-3) { dx = -(goal.z - p.z); dz = goal.x - p.x; }
        const len = Math.hypot(dx, dz) || 1;
        goal = { x: f.x + dx/len*(clearance + 0.3), y: goal.y, z: f.z + dz/len*(clearance + 0.3) };
      }
    }
    // walk towards where they should be — faster if they've fallen behind (cutting across at a junction, say)
    p.moving = false;
    if (goal) {
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
      const step = speed*dt*(p.mode === 'line' ? 1 + Math.min(2, d*0.5) : 1);
      if (d > 1e-4) {
        const k = Math.min(1, step/d), mx = dx*k, mz = dz*k;
        p.x += mx; p.z += mz;
        // which way they face, and whether they're walking, go by how far they actually moved this frame — someone
        // keeping pace with their walkway is always right on top of the point they're heading for
        if (Math.hypot(mx, mz) > speed*dt*0.25) {
          const facing = Math.atan2(mx, mz);
          p.heading += Math.atan2(Math.sin(facing - p.heading), Math.cos(facing - p.heading))*Math.min(1, dt*8);
          p.moving = true;
        }
      }
      p.y += (goal.y - p.y)*Math.min(1, dt*6);
    }
    // the walk cycle: a full stride (the shape key swung from -1 to 1 and back) every couple of units walked — further for
    // bigger people — easing back to standing still when they stop
    if (p.moving) { p.phase += dt*speed*Math.PI/S.peopleSize; p.walk = Math.sin(p.phase); }
    else p.walk -= p.walk*Math.min(1, dt*5);
    if (personModel) {
      // the model, scaled to the same height as a cuboid person
      const s = p.mode === 'none' ? 0 : 1.7*p.height*S.peopleSize/personModel.height;
      rotation.setFromAxisAngle(up, p.heading + personModel.yaw);
      matrix.compose(position.set(p.x, p.y - personModel.minY*s, p.z), rotation, scale.set(s, s, s));
      personModel.parts[0].setMatrixAt(i, matrix);
      personModel.morph.array[i*3] = p.walk; // (their sex and hair length, the other two, are set once — see loadPersonModel)
    } else {
      const bob = p.moving ? Math.abs(Math.sin(p.phase))*0.08*S.peopleSize : 0;
      rotation.setFromAxisAngle(up, p.heading);
      if (p.mode === 'none') scale.set(0, 0, 0); else scale.set(0.5*S.peopleSize, 1.7*p.height*S.peopleSize, 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y + bob, p.z), rotation, scale);
      peopleMesh.setMatrixAt(i, matrix);
    }
  });
  if (personModel) { personModel.matrix.needsUpdate = true; personModel.morph.needsUpdate = true; }
  else peopleMesh.instanceMatrix.needsUpdate = true;
}

Object.assign(App, { syncPeopleUI });
