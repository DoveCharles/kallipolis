import * as THREE from 'three';
import { S } from '../core/shared.js';
import { scene, computeWindowGlowFactor } from '../core/scene.js';
import { createBatchedWindowMaterial, addBaseShade } from './windows.js';
import { pedViewOn } from '../ui/ped-view.js';

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
// drawn). Anything that shows buildings one by one hands them back for as long as it lasts, for that zone: a building
// the camera's inside (see-through.js) or has gone into (interior.js), and ped view, which tints them per building.
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
  if (!materials.has(key)) materials.set(key, kind.window ? createBatchedWindowMaterial(kind.specular, kind.side) : plainMaterial(kind.flat, kind.side, kind.baseShade));
  const mat = materials.get(key);
  if (kind.window) mat.emissiveIntensity = computeWindowGlowFactor(S.sunElevation); // (in case it's been a while since this class was last used)
  return mat;
}

const MAPS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap'];
// which merged mesh a building part joins, or null to leave it drawn as it is
function kindOf(mesh) {
  if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.userData.isBlinkLight) return null;
  const m = mesh.material, geo = mesh.geometry;
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
  return { window: false, flat: !!m.flatShading, side: m.side, baseShade,
    key: ['plain', !!m.flatShading, m.side, baseShade, mesh.castShadow, mesh.receiveShadow].join() };
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
  const geo = mesh.geometry, m = mesh.material, pos = geo.attributes.position, nor = geo.attributes.normal;
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
  source.children.forEach(group => {
    if (!group.userData.batchable) return;
    group.traverse(o => {
      const kind = kindOf(o);
      if (!kind) return;
      if (!byKind.has(kind.key)) byKind.set(kind.key, { kind, c: collector(kind.window) });
      append(byKind.get(kind.key).c, o);
      originals.push(o);
    });
  });
  const meshes = [];
  byKind.forEach(({ kind, c }, key) => {
    const mesh = new THREE.Mesh(geometryOf(c), materialFor(key, kind));
    const [castShadow, receiveShadow] = key.split(',').slice(-2).map(s => s === 'true');
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    mesh.name = 'Building';
    mesh.matrixAutoUpdate = false;
    mesh.userData.noExport = true;
    batchesGroup.add(mesh);
    meshes.push(mesh);
  });
  originals.forEach(o => { o.visible = false; o.userData.batched = true; });
  return { source, count: source.children.length, meshes, originals, shown: false };
}
function unbatchZone(entry) {
  entry.meshes.forEach(mesh => { batchesGroup.remove(mesh); mesh.geometry.dispose(); });
  entry.originals.forEach(o => { o.visible = true; delete o.userData.batched; });
}
// the originals drawn instead of the merged meshes (true), or the other way round
function showOriginals(entry, on) {
  if (entry.shown === on) return;
  entry.shown = on;
  entry.meshes.forEach(mesh => { mesh.visible = !on; });
  entry.originals.forEach(o => { o.visible = on; });
}

// each frame, just before drawing: merge any zone whose buildings have been (re)built, let go of any that's gone, and
// hand the buildings back for a zone that needs them drawn one by one
export function updateBuildingBatches() {
  const live = new Set();
  for (const zone of S.zones) {
    const source = zone.buildingsGroup;
    if (!source || source.parent !== scene) continue;
    live.add(zone);
    let entry = zoneBatches.get(zone);
    if (entry && (entry.source !== source || entry.count !== source.children.length)) { unbatchZone(entry); entry = null; }
    if (!entry) { entry = batchZone(zone); zoneBatches.set(zone, entry); }
    showOriginals(entry, pedViewOn() || source.children.some(g => g.userData.batchable && !g.visible));
  }
  zoneBatches.forEach((entry, zone) => { if (!live.has(zone)) { unbatchZone(entry); zoneBatches.delete(zone); } });
}
