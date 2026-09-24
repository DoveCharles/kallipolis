import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S } from '../../core/shared.js';
import { scene, computeWindowGlowFactor, SKY_ENV_MAP } from '../../core/scene.js';
import { mulberry32 } from '../../core/math.js';
import { createMeshBuilder } from '../../roads/roads.js';
import { buildCarWreck } from '../car-wrecks.js';
import { makeCarMesh } from './materials.js';
import { CAR_PAINTS, TRAFFIC_MAX, trafficRng } from './state.js';

// How a car is built: the box car, and the designs loaded from assets/models/Cars.glb (loadCarModels), plus its paint.

// the box car, built around its own origin on the ground facing +Z — what a car draws as until the models load, at
// BOX_CAR_LENGTH long and BOX_CAR_WIDTH wide (times the car's own size scale)
export const BOX_CAR_LENGTH = 4.4, BOX_CAR_WIDTH = 1.8;
export const carParts = (() => {
  const body = createMeshBuilder(), glass = createMeshBuilder(), wheels = createMeshBuilder(), heads = createMeshBuilder(), tails = createMeshBuilder();
  body.addBox(0, 0, 0, 1, 2.2, 0.9, 0.3, 0.95);           // lower body
  body.addBox(0, -0.25, 0, 1, 1.08, 0.78, 1.38, 1.48);    // roof
  glass.addBox(0, -0.25, 0, 1, 1.15, 0.76, 0.95, 1.38);   // cabin windows
  [[-0.78, 1.35], [0.78, 1.35], [-0.78, -1.35], [0.78, -1.35]].forEach(([x, z]) => wheels.addBox(x, z, 0, 1, 0.34, 0.16, 0, 0.62));
  [-0.55, 0.55].forEach(x => { heads.addBox(x, 2.2, 0, 1, 0.04, 0.2, 0.62, 0.8); tails.addBox(x, -2.2, 0, 1, 0.04, 0.2, 0.62, 0.8); });
  const matrix = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*16), 16);
  matrix.setUsage(THREE.DynamicDrawUsage);
  const glow = (color, emissive, intensity) => {
    const mat = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity*computeWindowGlowFactor(S.sunElevation), roughness: 0.35 });
    mat.userData.baseEmissiveIntensity = intensity; // emissiveIntensity at full dark (see updateWindowGlowForSun)
    return mat;
  };
  const make = (builder, material, shadows) => {
    const mesh = new THREE.InstancedMesh(builder.build(), material, TRAFFIC_MAX);
    mesh.instanceMatrix = matrix;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows; mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = 'Traffic';
    scene.add(mesh);
    return mesh;
  };
  const parts = {
    body: make(body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, envMap: SKY_ENV_MAP, envMapIntensity: 0.8 }), true),
    glass: make(glass, new THREE.MeshStandardMaterial({ color: 0x1f2a35, roughness: 0.15, metalness: 0.3, envMap: SKY_ENV_MAP }), true),
    wheels: make(wheels, new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.9 }), true),
    heads: make(heads, glow(0xfff4d6, 0xffe3a3, 1.6), false),
    tails: make(tails, glow(0x7a1010, 0xff2a1a, 1.2), false),
  };
  const paintTotal = CAR_PAINTS.reduce((sum, [, weight]) => sum + weight, 0), paintRng = mulberry32(2718), color = new THREE.Color();
  parts.body.count = TRAFFIC_MAX; // (the instance color buffer is allocated at the count on its first write)
  for (let i=0;i<TRAFFIC_MAX;i++) {
    let r = paintRng()*paintTotal, k = 0;
    while (k < CAR_PAINTS.length-1 && (r -= CAR_PAINTS[k][1]) > 0) k++;
    parts.body.setColorAt(i, color.set(CAR_PAINTS[k][0]).multiplyScalar(0.92 + paintRng()*0.16));
  }
  parts.body.count = 0;
  return { ...parts, all: Object.values(parts), matrix };
})();
/**
 * Pick a car color from CAR_PAINTS, weighted by how common each is, varied 0.92-1.08 in brightness.
 * @returns {number[]} r, g, b
 */
export function pickCarPaint() {
  const total = CAR_PAINTS.reduce((sum, [, weight]) => sum + weight, 0), color = new THREE.Color();
  let r = trafficRng()*total, k = 0;
  while (k < CAR_PAINTS.length-1 && (r -= CAR_PAINTS[k][1]) > 0) k++;
  color.set(CAR_PAINTS[k][0]).multiplyScalar(0.92 + trafficRng()*0.16);
  return [color.r, color.g, color.b];
}
// ============================================================ CAR MODELS ============================================================
// (assets/models/Cars.glb): one top-level mesh per design (Ambulance, Bus, Taxi…), given to cars at
// random. CarCol parts are repainted per car (pickCarPaint); Lights, Backlights and TaxiLight emit, scaled by the sun
// (carGlowFactor); Window parts get a see-through material; Plate parts carry the registration (plateCoordinates,
// carPlate); every other part keeps its exported Blender color. Shading is flat. A design whose long side is X is turned a
// quarter, so every design's length runs along Z; all are centered on X and Z and sat on y = 0.
const CARS_MODEL_URL = 'assets/models/Cars.glb';
const CAR_PAINT_MATERIAL = 'CarCol';
export const CAR_GLOW_MATERIALS = {
  Lights: { diffuse: 0xfff4d6, emissive: 0xffe3a3, intensity: 1.6 },
  Backlights: { diffuse: 0x7a1010, emissive: 0xff2a1a, intensity: 1.2 },
  TaxiLight: { diffuse: 0x3a2410, emissive: 0xffb347, intensity: 1.5 },
};
const CAR_PLATE_MATERIAL = 'Plate';
const CAR_GLASS_MATERIAL = 'Window'; // give its own material, see-through as the model has it (see makeCarMaterials)
export const CAR_SLOT_NAMES = [CAR_PAINT_MATERIAL, 'Lights', 'Backlights', 'TaxiLight', CAR_PLATE_MATERIAL]; // index + 1 is carSlot's value; 0 is every other part
export let carMeshes = []; // [{ mesh, paint, wheels, plates, glowUniform, wheelRadius, wheelbase, length, height, name, thumbMesh, thumbCamera, thumbPaint, thumbPlate }], one per design, once loaded
export let designNumbers = []; // how many cars of each design have been given out (their number within the design, see updateTraffic)

/**
 * Fetch a GLB and parse it.
 * @param {string} url
 * @returns {Promise<object>} the parsed glTF
 */
async function loadGLB(url) {
  const buffer = await fetch(url).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  return new GLTFLoader().parseAsync(buffer, '');
}
/**
 * Load the car models and build one instanced mesh per design, falling back to the box car if any of it fails.
 * @returns {Promise<void>}
 */
export async function loadCarModels() {
  let gltf;
  try {
    gltf = await loadGLB(CARS_MODEL_URL);
  } catch (err) {
    console.warn('Kallipolis: the car models failed to load; traffic uses the built-in box car', err);
    return;
  }
  try {
    const designs = buildCarDesigns(gltf);
    if (designs.length) { carMeshes = designs.map(makeCarMesh); designNumbers = designs.map(() => 0); }
  } catch (err) {
    console.warn('Kallipolis: the car models failed to build; traffic uses the built-in box car', err);
    return;
  }
  // (a design whose wreck fails to build just blows up into chunks, as the box car does)
  const paintSlot = CAR_SLOT_NAMES.indexOf(CAR_PAINT_MATERIAL) + 1;
  carMeshes.forEach(cm => {
    try { cm.wreck = buildCarWreck(cm.mesh.geometry, paintSlot, cm.name); }
    catch (err) { console.warn(`Kallipolis: the ${cm.name} wreck failed to build`, err); }
  });
}
/**
 * Build one merged, indexed geometry per top-level mesh in the model.
 *
 * Vertex attributes:
 * - carSlot: what the vertex is — CAR_SLOT_NAMES.indexOf(material) + 1, or 0 for any other part
 * - carColor: its color where it isn't repainted or lit (a glow part's unlit diffuse, otherwise its exported color)
 * - carPlate: where the vertex lies on a registration plate (see plateCoordinates)
 * - carWheel: for a wheel's vertices, the hub xyz and 1 for a wheel that only rolls or 2 for one that also steers (the
 *   front wheels at +Z, unless the design marks them WheelSteer…); all zeros for anything else (see injectCarShader, which
 *   turns them, and turnWheels). A vertex belongs to the nearest parent named Wheel…
 *
 * The geometry carries two draw groups: the opaque parts, then the glass.
 * @param {object} gltf - the loaded Cars.glb
 * @returns {object[]} one design per top-level mesh that has meshes under it
 */
function buildCarDesigns(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3(), v = new THREE.Vector3(), normalMatrix = new THREE.Matrix3(), baseColor = new THREE.Color();
  const designs = [];
  gltf.scene.children.forEach(node => {
    const parts = [];
    node.traverse(o => { if (o.isMesh) parts.push(o); });
    if (!parts.length) return;
    const positions = [], normals = [], slots = [], colors = [], indices = [], glassIndices = [], wheelIds = [], wheels = [];
    let glass = null, hasPaint = false;
    const bodyColors = new Map(); // (each unpainted body color, by how much of the design it covers, for its explosion)
    parts.forEach(part => {
      let wheel = part;
      while (wheel && wheel !== node && !wheel.name.startsWith('Wheel')) wheel = wheel.parent;
      if (wheel === node || !wheel) wheel = null;
      if (wheel && !wheels.includes(wheel)) wheels.push(wheel);
      const wheelId = wheel ? wheels.indexOf(wheel) : -1;
      const geo = part.geometry, pos = geo.attributes.position, matName = (part.material && part.material.name) || '';
      const glow = CAR_GLOW_MATERIALS[matName], slot = CAR_SLOT_NAMES.indexOf(matName) + 1; // 0 for anything else
      if (glow) baseColor.set(glow.diffuse);
      else if (part.material && part.material.color) baseColor.copy(part.material.color).convertLinearToSRGB();
      else baseColor.set(0xffffff);
      const isGlass = matName === CAR_GLASS_MATERIAL;
      if (slot === CAR_SLOT_NAMES.indexOf(CAR_PAINT_MATERIAL) + 1) hasPaint = true;
      else if (!glow && !isGlass && !wheel && matName !== CAR_PLATE_MATERIAL) {
        const key = baseColor.r + ',' + baseColor.g + ',' + baseColor.b;
        bodyColors.set(key, (bodyColors.get(key) ?? 0) + pos.count);
      }
      if (isGlass && !glass) glass = { opacity: part.material.opacity, roughness: part.material.roughness, metalness: part.material.metalness };
      const first = positions.length/3, normal = geo.attributes.normal;
      normalMatrix.getNormalMatrix(part.matrixWorld);
      for (let i=0;i<pos.count;i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld);
        positions.push(v.x, v.y, v.z);
        v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
        normals.push(v.x, v.y, v.z);
        slots.push(slot);
        colors.push(baseColor.r, baseColor.g, baseColor.b);
        wheelIds.push(wheelId);
      }
      const index = geo.index, corners = index ? index.count : pos.count;
      for (let t=0;t<corners;t++) (isGlass ? glassIndices : indices).push(first + (index ? index.getX(t) : t));
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); // the model's own, split where its edges are sharp
    geometry.setIndex(indices.concat(glassIndices)); // the glass last, as a group of its own
    geometry.addGroup(0, indices.length, 0);
    geometry.addGroup(indices.length, glassIndices.length, 1);
    geometry.computeBoundingBox();
    box.copy(geometry.boundingBox);
    box.getSize(size);
    // the longer of X and Z is the length; turned a quarter when that's X, so the design's length lies along Z
    if (size.x > size.z) { geometry.rotateY(-Math.PI/2); geometry.computeBoundingBox(); box.copy(geometry.boundingBox); box.getSize(size); }
    box.getCenter(center);
    geometry.translate(-center.x, -box.min.y, -center.z); // centered on X and Z, sitting on y = 0
    geometry.setAttribute('carSlot', new THREE.Float32BufferAttribute(slots, 1));
    geometry.setAttribute('carColor', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('carPlate', plateCoordinates(geometry.attributes.position, slots));
    // each wheel's middle and size, from where its vertices ended up (turned and centered, as above)
    const position = geometry.attributes.position, hubs = wheels.map(() => new THREE.Box3());
    wheelIds.forEach((w, k) => { if (w >= 0) hubs[w].expandByPoint(v.fromBufferAttribute(position, k)); });
    const namedSteer = wheels.some(w => w.name.startsWith('WheelSteer'));
    const hubInfo = hubs.map((hub, w) => {
      const c = hub.getCenter(new THREE.Vector3());
      return { c, r: (hub.max.y - hub.min.y)*0.5, steers: namedSteer ? wheels[w].name.startsWith('WheelSteer') : c.z > 0 };
    });
    const wheelData = new Float32Array(wheelIds.length*4);
    wheelIds.forEach((w, k) => {
      if (w < 0) return;
      const { c, steers } = hubInfo[w];
      wheelData.set([c.x, c.y, c.z, steers ? 2 : 1], k*4);
    });
    geometry.setAttribute('carWheel', new THREE.BufferAttribute(wheelData, 4));
    // (how far the steering wheels are ahead of the others, for how sharply they're turned — see turnWheels)
    const meanZ = list => list.reduce((sum, h) => sum + h.c.z, 0)/list.length;
    const steering = hubInfo.filter(h => h.steers), rolling = hubInfo.filter(h => !h.steers);
    const wheelbase = steering.length && rolling.length ? meanZ(steering) - meanZ(rolling) : 0;
    const wheelRadius = hubInfo.length ? hubInfo.reduce((sum, h) => sum + h.r, 0)/hubInfo.length : 0;
    // the rear axle, (z, y), that the body pitches about on its springs (see swayBody): the rolling wheels' hubs, or the
    // hindmost where none only roll, or the back of the design at the ground where it has no wheels
    const axleHubs = rolling.length ? rolling : hubInfo;
    const rearAxle = axleHubs.length ? [meanZ(axleHubs), axleHubs.reduce((sum, h) => sum + h.c.y, 0)/axleHubs.length] : [-size.z/2, 0];
    geometry.computeBoundingSphere();
    const [mainColor] = [...bodyColors].sort((a, b) => b[1] - a[1])[0] ?? [];
    designs.push({ name: node.name, geometry, bodyColor: !hasPaint && mainColor ? mainColor.split(',').map(Number) : null, length: size.z/BOX_CAR_LENGTH, width: size.x, height: size.y, radius: geometry.boundingSphere.radius, wheelRadius, wheelbase, rearAxle,
      glass: glass || { opacity: 1, roughness: 0.35, metalness: 0.25 } });
  });
  gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material) o.material.dispose(); } });
  return designs;
}
/**
 * Plate coordinates, per vertex of a Plate part: (u, v, side). u runs 0 at the left to 1 at the right as the plate reads
 * from outside the car, v 0 at the top to 1 at the bottom, and side is 1 for the front plate (+Z) or 2 for the back; all
 * zeros for any other vertex. u and v come from the plate's per-side vertex bounding box, not from the model's UVs.
 * @param {object} position - the geometry's position attribute
 * @param {number[]} slots - each vertex's carSlot value
 * @returns {object} a BufferAttribute of three floats per vertex
 */
function plateCoordinates(position, slots) {
  const plateSlot = CAR_SLOT_NAMES.indexOf(CAR_PLATE_MATERIAL) + 1, data = new Float32Array(position.count*3);
  const bounds = [1, 2].map(() => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
  const sideOf = k => position.getZ(k) > 0 ? 1 : 2;
  for (let k=0;k<position.count;k++) {
    if (slots[k] !== plateSlot) continue;
    const b = bounds[sideOf(k) - 1], x = position.getX(k), y = position.getY(k);
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  }
  for (let k=0;k<position.count;k++) {
    if (slots[k] !== plateSlot) continue;
    const side = sideOf(k), b = bounds[side - 1], x = position.getX(k), y = position.getY(k);
    const across = (x - b.minX)/Math.max(1e-6, b.maxX - b.minX);
    data.set([side === 1 ? across : 1 - across, (b.maxY - y)/Math.max(1e-6, b.maxY - b.minY), side], k*3);
  }
  return new THREE.BufferAttribute(data, 3);
}
