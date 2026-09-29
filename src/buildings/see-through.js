import * as THREE from 'three';
import { camera, scene, renderer } from '../core/scene.js';
import { S, App, buildingHolders } from '../core/shared.js';
import { pointInPolygon } from '../core/math.js';
import { distToPolygonBoundary, footprintBounds } from './footprints.js';
import { stillLoading, loadingTask } from '../ui/loading.js';
import { warmThumbnails } from '../life/thumbnail.js';

// ============================================================ seeing through buildings near the camera
// A building the camera's inside fades to FADED, one within NEAR fades part way (by distance), on see-through copies of
// its materials (as interior.js fadeWhatsInTheWay). Buildings go by footprint and height; a group without a footprint
// (a mall's shell) fades only its meshes marked userData.fadesNear, by their boxes. Off while possessing.
const NEAR = 8;
const FADED = 0.15, FADE_EASE = 0.08;
const fading = new Set(); // groups not fully solid (userData.seeThrough: how solid)
let copies = new WeakMap(); // group -> Map(material -> see-through copy): kept, and a group's own (materials are shared across buildings, fading apart)

// how far the camera is from a group (0 inside), or Infinity if it's no candidate
function distanceTo(group, p) {
  const u = group.userData, fp = u.footprint;
  if (!fp) {
    u.fadeBoxes ??= collectFadeBoxes(group);
    let d = Infinity;
    for (const b of u.fadeBoxes) d = Math.min(d, b.distanceToPoint(p));
    return d;
  }
  if (fp.length < 3) return Infinity;
  const up = Math.max(0, p.y - (u.height || 0));
  if (up > NEAR) return Infinity;
  const { c, r } = footprintBounds(group);
  if (Math.hypot(p.x - c.x, p.z - c.z) > r + NEAR) return Infinity;
  return Math.hypot(pointInPolygon(p, fp) ? 0 : distToPolygonBoundary(p, fp), up);
}
function collectFadeBoxes(group) {
  const boxes = [];
  group.updateMatrixWorld(true);
  group.traverse(o => { if (o.isMesh && o.userData.fadesNear) boxes.push(new THREE.Box3().setFromObject(o)); });
  return boxes;
}

// Each frame, once the camera's moved.
export function fadeBuildingsAroundCamera() {
  warmUp();
  const goals = new Map();
  const p = camera.position;
  if (!App.isPossessing?.()) buildingHolders().forEach(zone => (zone.buildingsGroup?.children || []).forEach(group => {
    if (!group.visible) return;
    const d = distanceTo(group, p);
    if (d >= NEAR) return;
    goals.set(group, FADED + (1 - FADED)*(d/NEAR)**2); // (squared: well under way by halfway, not left till the last metres)
    fading.add(group);
  }));
  fading.forEach(group => {
    const u = group.userData;
    const goal = group.parent ? goals.get(group) ?? 1 : 1;
    u.seeThrough ??= 1;
    u.seeThrough = Math.abs(goal - u.seeThrough) < 0.01 ? goal : u.seeThrough + (goal - u.seeThrough)*FADE_EASE;
    fadeBuilding(group, u.seeThrough);
    if (u.seeThrough === 1) { delete u.seeThrough; fading.delete(group); }
  });
}
// All faded buildings back at once (for the export).
export function unfadeBuildings() {
  fading.forEach(group => { fadeBuilding(group, 1); delete group.userData.seeThrough; });
  fading.clear();
}

const fades = (group, o) => o.isMesh && o.material && !Array.isArray(o.material) && (group.userData.footprint || o.userData.fadesNear);
function fadeBuilding(group, solid) {
  group.traverse(o => {
    if (!fades(group, o)) return;
    const own = o.userData.ownMaterial;
    if (solid === 1) {
      if (own) { o.material = own; delete o.userData.ownMaterial; }
      return;
    }
    if (!own) {
      o.userData.ownMaterial = o.material;
      o.material = copyOf(o.material, group);
    }
    o.material.seeSolid.value = solid;
    o.material.emissiveIntensity = o.userData.ownMaterial.emissiveIntensity; // (glow follows the sun)
  });
}
// A material's see-through copy, per group. Dithered (S.ditherSeeThrough, opaque parts only) or blended; a mall roof's
// parts (no footprint) also by each pixel's own distance, so a part reaching far off stays solid away from the camera.
function copyOf(material, group) {
  if (!copies.has(group)) copies.set(group, new Map());
  const own = copies.get(group);
  let copy = own.get(material);
  if (!copy) {
    copy = material.clone();
    copy.userData = material.userData;
    own.set(material, copy);
    const dither = S.ditherSeeThrough && !material.transparent, local = !group.userData.footprint;
    copy.transparent = !dither;
    const seeSolid = copy.seeSolid = { value: 1 };
    copy.onBeforeCompile = (shader, r) => { material.onBeforeCompile(shader, r); addSeeThrough(shader, seeSolid, dither, local); };
    copy.customProgramCacheKey = () => material.customProgramCacheKey() + '|see' + (dither ? 'D' : 'B') + (local ? 'L' : '');
  }
  return copy;
}

// Dithered: a 4x4 ordered (Bayer) dither in screen pixels, drawn with the solid parts (no sorting to pop), clearest
// mid-view and EDGE_SOLID of the way back to solid by the edges. Blended: alpha scaled.
const EDGE_SOLID = 0.6;
function addSeeThrough(shader, seeSolid, dither, local) {
  shader.uniforms.uSeeSolid = seeSolid;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSeeClip;\nvarying vec3 vSeeView;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvSeeClip = gl_Position.xyw;\nvSeeView = mvPosition.xyz;');
  const solid = `float seeSolid = uSeeSolid;` + (local
    ? `\nseeSolid = max(seeSolid, ${FADED.toFixed(2)} + ${(1 - FADED).toFixed(2)}*pow(clamp(length(vSeeView)/${NEAR.toFixed(1)}, 0.0, 1.0), 2.0));` : '');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vSeeClip;
varying vec3 vSeeView;
uniform float uSeeSolid;
const float SEE_BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${solid}` + (dither ? `
{
  ivec2 cell = ivec2(mod(gl_FragCoord.xy, 4.0));
  float edge = smoothstep(0.2, 1.0, length(vSeeClip.xy/vSeeClip.z));
  if (mix(seeSolid, 1.0, edge*${EDGE_SOLID.toFixed(2)}) <= (SEE_BAYER[cell.x + cell.y*4] + 0.5)/16.0) discard;
}` : ''))
    .replace('#include <opaque_fragment>', dither ? '#include <opaque_fragment>' : '#include <opaque_fragment>\ngl_FragColor.a *= seeSolid;');
}
// Options > Game > Dithered See-Through changed: copies made afresh in the new way (and warmed again).
export function resetSeeThrough() {
  unfadeBuildings();
  copies = new WeakMap();
  warmed = new WeakSet();
  kinds.clear();
}

// ---------------------------------------------------------------- warm-up
// New buildings' shader kinds compiled ahead: as drawn on their own (cut out of the merged meshes), faded, and as a
// card thumbnail (thumbnail.js), so none of those stutters the first time.
let warmed = new WeakSet();
const kinds = new Set();
const MAPS = ['map', 'alphaMap', 'normalMap', 'bumpMap', 'envMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'lightMap'];
// what three.js picks a shader program by, near enough
const kindOf = (o, m) => [m.type, m.customProgramCacheKey(), m.side, m.flatShading, m.vertexColors, m.transparent, m.alphaTest > 0,
  m.fog, m.toneMapped, m.dithering, ...MAPS.map(k => !!m[k]), o.receiveShadow, !!o.isInstancedMesh, !!o.instanceColor,
  Object.keys(o.geometry.attributes).sort().join('|'), o.geometry.attributes.color?.itemSize].join();
function warmUp() {
  const main = new THREE.Group(), plain = new THREE.Group();
  buildingHolders().forEach(zone => (zone.buildingsGroup?.children || []).forEach(group => {
    if (warmed.has(group)) return;
    warmed.add(group);
    group.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh || !o.material || Array.isArray(o.material)) return;
      const m = o.userData.ownMaterial ?? o.material;
      const key = kindOf(o, m) + (group.userData.footprint ? '' : '|local');
      if (kinds.has(key)) return;
      kinds.add(key);
      const twin = material => {
        const t = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, material, 1) : new THREE.Mesh(o.geometry, material);
        t.castShadow = o.castShadow; t.receiveShadow = o.receiveShadow;
        if (o.instanceColor) t.instanceColor = o.instanceColor;
        return t;
      };
      plain.add(twin(m));
      main.add(twin(m));
      if (fades(group, o)) main.add(twin(copyOf(m, group)));
    });
  }));
  if (!plain.children.length) return;
  const done = Promise.all([
    renderer.compileAsync(main, camera, scene).catch(err => console.warn('Kallipolis: fade warm-up failed', err)),
    warmThumbnails(plain),
  ]);
  if (stillLoading()) loadingTask('Preparing buildings...', done, 0);
}

Object.assign(App, { fadeBuildingsAroundCamera, unfadeBuildings, resetSeeThrough });
