import * as THREE from 'three';
import { S, buildingHolders } from '../core/shared.js';
import { scene, computeWindowGlowFactor } from '../core/scene.js';
import { createBatchedWindowMaterial, addBaseShade } from './windows.js';
import { pedViewTinted, pedViewRepaint } from '../ui/ped-view.js';

// ============================================================ merged buildings
// A city block's buildings are each a handful of meshes with materials of their own (every building has its own color,
// window style and glow), so a few hundred buildings are thousands of draw calls, drawn again for the sun's shadow — by
// far the most expensive thing in a frame. Here each zone's buildings are drawn instead as a few merged meshes, one per
// kind of surface (walls with windows, reflective or not; plain surfaces, flat- or smooth-shaded, one- or two-sided,
// casting and taking shadows or not), with everything a building's own material held — its color, how rough and metallic
// it is, what it glows, its window layout — carried on the vertices instead, so it looks just as it did.
//
// The buildings themselves stay where they were, only not drawn (visible = false, userData.batched): picking, following,
// the card's thumbnail, exports, people's pathing all still find them as before (a raycast doesn't care whether a mesh is
// drawn). A building that has to be drawn on its own — one the camera's inside and has faded (see-through.js), or one
// hidden (a building gone into, and its neighbours: interior.js) — is cut out of its zone's merged meshes (each building
// is one run of each merged mesh's triangles, left out through the geometry's draw groups) and its own parts drawn
// instead, for as long as it lasts; the rest of the zone stays merged. Ped view cuts out the buildings it lights up
// the same way, the merged rest drawn grey.
//
// Left out, and drawn as they were: see-through surfaces (glass domes, balcony rails — they're sorted back to front one
// by one), blinking lights (animated), and anything not built with a plain MeshStandardMaterial.

const batchesGroup = new THREE.Group();
batchesGroup.name = 'BuildingBatches';
scene.add(batchesGroup);
const zoneBatches = new Map(); // zone -> { source, count, meshes, originals }
const materials = new Map();   // class key -> the shared material its merged mesh draws with

// the flat-varying plain material: a building part's roughness, metalness and glow, per vertex — and, for a building's
// own walls and caps, the shade toward the ground its material draws (see addBaseShade)
function plainMaterial(flat, side, baseShade) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 1, flatShading: flat, side,
    emissive: 0xffffff, emissiveIntensity: 1 });
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 batchPbr;\nattribute vec3 batchEmissive;\nflat varying vec2 vBatchPbr;\nflat varying vec3 vBatchEmissive;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBatchPbr = batchPbr; vBatchEmissive = batchEmissive;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying vec2 vBatchPbr;\nflat varying vec3 vBatchEmissive;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vBatchPbr.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vBatchPbr.y;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vBatchEmissive;');
    if (baseShade) addBaseShade(shader);
  };
  mat.customProgramCacheKey = () => 'batchedPlain' + !!baseShade;
  return mat;
}
function materialFor(key, kind) {
  if (!materials.has(key)) {
    const mat = kind.window ? createBatchedWindowMaterial(kind.specular, kind.side) : plainMaterial(kind.flat, kind.side, kind.baseShade);
    if (kind.shadowSide != null) mat.shadowSide = kind.shadowSide; // (a closed shell casting from its far faces: see roads/mall.js)
    materials.set(key, mat);
  }
  const mat = materials.get(key);
  if (kind.window) mat.emissiveIntensity = computeWindowGlowFactor(S.sunElevation); // (in case it's been a while since this class was last used)
  return mat;
}

const MAPS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap'];
// which merged mesh a building part joins, or null to leave it drawn as it is
function kindOf(mesh) {
  if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.userData.isBlinkLight) return null;
  const m = mesh.userData.ownMaterial ?? mesh.material, geo = mesh.geometry;
  if (!m || Array.isArray(m) || m.type !== 'MeshStandardMaterial' || m.transparent || m.alphaTest > 0 || !m.visible || m.polygonOffset || m.depthWrite === false || m.wireframe) return null;
  if (!geo?.attributes.position || !geo.attributes.normal || geo.morphAttributes.position) return null;
  const windows = m.userData.windowUniforms;
  if (windows) {
    if (!geo.attributes.facade || !geo.attributes.facadeRun) return null;
    const specular = !!m.envMap;
    return { window: true, specular, side: m.side, key: ['win', specular, m.side, mesh.castShadow, mesh.receiveShadow].join() };
  }
  const baseShade = !!m.userData.baseShade;
  if ((!baseShade && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) || MAPS.some(k => m[k])) return null;
  return { window: false, flat: !!m.flatShading, side: m.side, shadowSide: m.shadowSide, baseShade,
    key: ['plain', !!m.flatShading, m.side, m.shadowSide, baseShade, mesh.castShadow, mesh.receiveShadow].join() };
}

const tmpV = new THREE.Vector3(), normalMatrix = new THREE.Matrix3(), color = new THREE.Color();
// one merged mesh's worth of building parts, as flat arrays
function collector(window) {
  return { window, position: [], normal: [], color: [], index: [], count: 0,
    pbr: window ? null : [], emissive: window ? null : [],
    facade: window ? [] : null, facadeRun: window ? [] : null, bay: window ? [] : null, floor: window ? [] : null,
    glass: window ? [] : null, lit: window ? [] : null, litMix: window ? [] : null };
}
function append(c, mesh) {
  const geo = mesh.geometry, m = mesh.userData.ownMaterial ?? mesh.material, pos = geo.attributes.position, nor = geo.attributes.normal;
  const col = m.vertexColors ? geo.attributes.color : null;
  const n = pos.count, base = c.count;
  normalMatrix.getNormalMatrix(mesh.matrixWorld);
  let w = null;
  if (c.window) {
    const u = m.userData.windowUniforms;
    const litIntensity = m.emissive.r > 0 ? (m.userData.baseEmissiveIntensity || 0) : 0;
    w = { bay: u.uWinBay.value.toArray(), floor: u.uWinFloor.value.toArray(), glass: [...u.uWinGlass.value.toArray(), u.uWinMullion.value],
      lit: [...u.uWinLit.value.toArray(), litIntensity], litMix: u.uWinLitMix.value.toArray() };
  }
  const glow = c.window ? null : [m.emissive.r*m.emissiveIntensity, m.emissive.g*m.emissiveIntensity, m.emissive.b*m.emissiveIntensity];
  for (let i = 0; i < n; i++) {
    tmpV.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    c.position.push(tmpV.x, tmpV.y, tmpV.z);
    tmpV.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
    c.normal.push(tmpV.x, tmpV.y, tmpV.z);
    if (col) color.fromBufferAttribute(col, i).multiply(m.color); else color.copy(m.color);
    c.color.push(color.r, color.g, color.b);
    if (c.window) {
      const f = geo.attributes.facade, fi = i*f.itemSize;
      for (let k = 0; k < 4; k++) c.facade.push(k < f.itemSize ? f.array[fi + k] : 0);
      c.facadeRun.push(geo.attributes.facadeRun.getX(i));
      c.bay.push(...w.bay); c.floor.push(...w.floor); c.glass.push(...w.glass); c.lit.push(...w.lit); c.litMix.push(...w.litMix);
    } else {
      c.pbr.push(m.roughness, m.metalness);
      c.emissive.push(...glow);
    }
  }
  if (geo.index) for (let i = 0; i < geo.index.count; i++) c.index.push(base + geo.index.getX(i));
  else for (let i = 0; i < n; i++) c.index.push(base + i);
  c.count += n;
}
function geometryOf(c) {
  const geo = new THREE.BufferGeometry(), f = (a, s) => new THREE.Float32BufferAttribute(a, s);
  geo.setAttribute('position', f(c.position, 3));
  geo.setAttribute('normal', f(c.normal, 3));
  geo.setAttribute('color', f(c.color, 3));
  if (c.window) {
    geo.setAttribute('facade', f(c.facade, 4));
    geo.setAttribute('facadeRun', f(c.facadeRun, 1));
    geo.setAttribute('winBay', f(c.bay, 4));
    geo.setAttribute('winFloor', f(c.floor, 4));
    geo.setAttribute('winGlass', f(c.glass, 4));
    geo.setAttribute('winLit', f(c.lit, 4));
    geo.setAttribute('winLitMix', f(c.litMix, 4));
  } else {
    geo.setAttribute('batchPbr', f(c.pbr, 2));
    geo.setAttribute('batchEmissive', f(c.emissive, 3));
  }
  geo.setIndex(new THREE.Uint32BufferAttribute(c.index, 1));
  geo.computeBoundingSphere();
  return geo;
}

function batchZone(zone) {
  const source = zone.buildingsGroup;
  source.updateMatrixWorld(true);
  const byKind = new Map(), originals = [];
  const parts = new Map(); // building -> { originals: its parts merged, runs: { class key -> [first index, end] } }
  source.children.forEach(group => {
    if (!group.userData.batchable) return;
    const part = { originals: [], runs: {} };
    group.traverse(o => {
      const kind = kindOf(o);
      if (!kind) return;
      if (!byKind.has(kind.key)) byKind.set(kind.key, { kind, c: collector(kind.window) });
      const c = byKind.get(kind.key).c, start = c.index.length;
      append(c, o);
      const run = part.runs[kind.key] ??= [start, start]; // (a building's parts of one class go in one after another)
      run[1] = c.index.length;
      originals.push(o);
      part.originals.push(o);
    });
    parts.set(group, part);
  });
  const meshes = [], meshOf = {};
  byKind.forEach(({ kind, c }, key) => {
    const mesh = new THREE.Mesh(geometryOf(c), materialFor(key, kind));
    mesh.userData.batchMaterial = mesh.material;
    meshOf[key] = mesh;
    const [castShadow, receiveShadow] = key.split(',').slice(-2).map(s => s === 'true');
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    mesh.name = 'Building';
    mesh.matrixAutoUpdate = false;
    mesh.userData.noExport = true;
    batchesGroup.add(mesh);
    meshes.push(mesh);
  });
  originals.forEach(o => { o.visible = false; o.userData.batched = true; });
  // The buildings can't move without leaving their merged copies behind, so neither they nor the zone's group holding them
  // have their matrices worked out again every frame (three.js does, for anything left to matrixAutoUpdate, and all that's
  // under it). Anything else in the zone that does move (an airport's planes) still does, under a group that stays put.
  const frozen = [source];
  source.children.forEach(group => { if (group.userData.batchable) group.traverse(o => frozen.push(o)); });
  const wasAuto = frozen.map(o => o.matrixAutoUpdate);
  frozen.forEach(o => { o.matrixAutoUpdate = false; });
  // (a building's runs by merged mesh rather than class)
  parts.forEach(part => { part.runs = Object.entries(part.runs).map(([key, run]) => [meshOf[key], ...run]); });
  return { source, count: source.children.length, meshes, originals, parts, frozen, wasAuto, shown: null };
}
function unbatchZone(entry) {
  entry.meshes.forEach(mesh => { batchesGroup.remove(mesh); mesh.geometry.dispose(); });
  entry.originals.forEach(o => { o.visible = true; delete o.userData.batched; });
  entry.frozen.forEach((o, k) => { o.matrixAutoUpdate = entry.wasAuto[k]; });
}
// the originals drawn instead of the merged meshes (all), or the merged meshes with the buildings `apart` cut out of them
// and drawn by their own parts instead
function showOriginals(entry, all, apart) {
  const shown = all ? 'all' : apart.map(g => g.id).join();
  if (entry.shown === shown) return;
  entry.shown = shown;
  entry.originals.forEach(o => { o.visible = all; });
  const cuts = new Map(); // merged mesh -> the runs left out of it
  if (!all) apart.forEach(group => {
    const part = entry.parts.get(group);
    if (!part) return;
    part.originals.forEach(o => { o.visible = true; });
    part.runs.forEach(([mesh, start, end]) => { if (!cuts.has(mesh)) cuts.set(mesh, []); cuts.get(mesh).push([start, end]); });
  });
  entry.meshes.forEach(mesh => {
    mesh.visible = !all;
    const geo = mesh.geometry, cut = cuts.get(mesh);
    geo.clearGroups();
    if (!cut) { mesh.material = mesh.userData.batchMaterial; pedViewRepaint(mesh); return; }
    // what's left between the runs cut out, drawn as groups of one material (a mesh with an array of materials draws
    // its geometry's groups only)
    let at = 0;
    cut.sort((a, b) => a[0] - b[0]).forEach(([start, end]) => { if (start > at) geo.addGroup(at, start - at, 0); at = end; });
    if (geo.index.count > at) geo.addGroup(at, geo.index.count - at, 0);
    mesh.material = [mesh.userData.batchMaterial];
    pedViewRepaint(mesh);
  });
}

// a zone's merged meshes, the same array until it's merged again (see node-highlight.js)
export const zoneBatchMeshes = zone => zoneBatches.get(zone)?.meshes ?? null;

// each frame, just before drawing: merge any zone whose buildings have been (re)built, let go of any that's gone, and
// hand the buildings back for a zone that needs them drawn one by one
export function updateBuildingBatches() {
  const live = new Set();
  for (const zone of buildingHolders()) {
    const source = zone.buildingsGroup;
    if (!source || source.parent !== scene) continue;
    live.add(zone);
    let entry = zoneBatches.get(zone);
    if (entry && (entry.source !== source || entry.count !== source.children.length)) { unbatchZone(entry); entry = null; }
    if (!entry) { entry = batchZone(zone); zoneBatches.set(zone, entry); }
    showOriginals(entry, false, source.children.filter(g => g.userData.batchable && (!g.visible || g.userData.seeThrough != null || pedViewTinted(g))));
  }
  zoneBatches.forEach((entry, zone) => { if (!live.has(zone)) { unbatchZone(entry); zoneBatches.delete(zone); } });
}
