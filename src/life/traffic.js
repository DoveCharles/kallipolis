import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, renderer, computeWindowGlowFactor, SKY_ENV_MAP, Y_ROAD } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { hashLicensePlate, hashNameToNumber, mulberry32, pointInPolygon } from '../core/math.js';
import { footprintBounds } from '../buildings/footprints.js';
import { getWaterRegion, WATER_LEVEL } from '../water/water.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder, navRebuildOnHold } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { placeKey, signalState } from '../roads/markings.js';
import { isTrainLine } from '../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted, isPedInDanger, voiceOfPerson } from './people/people.js';
import { exclaim } from '../audio/voices.js';
import { isFavoritePerson } from '../ui/favorites.js';
import { strikeLightning } from './lightning.js';
import { updateEngines } from '../audio/engine.js';
import { explodeCar, puffSmoke, sparks, burnFx, tyreSmoke, igniteFx, engineSmoke, terribleSmoke, sparkleFx } from './giblets.js';
import { playSound } from '../audio/sfx.js';
import { carTypeOf, vanityChanceOf, vanityPlatesOf } from './car-types.js';
import { driving, controlInput, startDriving, endDriving } from './possession.js';

// ============================================================ TRAFFIC ============================================================
// Cars, drawn with the people and scaled by the same speed and size settings. A car drives one sidewalk road line in one of
// two lanes (`lane` either side of the centerline, buildTrafficNav): it turns onto a linked line at some junctions and at
// its line's end (driveAlong, pickTurn), U-turns at dead ends (routePoint), slows approaching a junction and holds its gap
// to the car ahead. A road takes at most one car per TRAFFIC_LANE_PER_CAR of lane, however high the slider goes. A car
// draws as a design from assets/models/Cars.glb picked at random, or as the box car until that has loaded.
const TRAFFIC_MAX = 1000;          // the most cars, and the instance count the car meshes and buffers are sized for
const CAR_SPEED = 9;               // world units per second at speed 1
const TRAFFIC_LANE_PER_CAR = 16;   // lane length, in world units, that a road needs per car it takes
const PED_YIELD_RADIUS = 10, PED_YIELD_CHANCE = 0.25; // how far ahead a car notices someone waiting in the road, and how often it stops for them
const TURN_SAFE_ANGLE = 0.35; // ~20°: while its heading is off its lane's by more than this — swinging round a corner or a dead-end U-turn (see routePoint) — a car runs nobody over, though it's still a hazard for a ped's roadsafety check
const CAR_PAINTS = [ // [color, how common]: the PICO-8 palette
  [0x000000, 1], [0x1d2b53, 1], [0x7e2553, 1], [0x008751, 1], [0xab5236, 1], [0x5f574f, 1], [0xc2c3c7, 1], [0xfff1e8, 1],
  [0xff004d, 1], [0xffa300, 1], [0xffec27, 1], [0x00e436, 1], [0x29adff, 1], [0x83769c, 1], [0xff77a8, 1], [0xffccaa, 1]];
S.trafficAmount = 150, S.trafficNav = null, S.trafficNavBuiltAt = -Infinity, S.lastTrafficTime = null; // cars asked for; the lanes, grid and capacity (see buildTrafficNav); when they were built; the last update's time
const cars = [];
let carIds = 0;
const trafficRng = mulberry32(31337);
// Debug wireframe (World → Peds → Roadsafety radius (debug)): a box of carHitbox around each car, off by default and
// written only while the toggle is on (see placeCar).
const carHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), TRAFFIC_MAX);
carHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
carHitboxDebugMesh.count = 0;
carHitboxDebugMesh.frustumCulled = false;
carHitboxDebugMesh.visible = false;
carHitboxDebugMesh.name = 'CarHitboxDebug';
scene.add(carHitboxDebugMesh);
// the box car, built around its own origin on the ground facing +Z — what a car draws as until the models load, at
// BOX_CAR_LENGTH long and BOX_CAR_WIDTH wide (times the car's own size scale)
const BOX_CAR_LENGTH = 4.4, BOX_CAR_WIDTH = 1.8;
const carParts = (() => {
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
function pickCarPaint() {
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
const CAR_GLOW_MATERIALS = {
  Lights: { diffuse: 0xfff4d6, emissive: 0xffe3a3, intensity: 1.6 },
  Backlights: { diffuse: 0x7a1010, emissive: 0xff2a1a, intensity: 1.2 },
  TaxiLight: { diffuse: 0x3a2410, emissive: 0xffb347, intensity: 1.5 },
};
const CAR_PLATE_MATERIAL = 'Plate';
const CAR_GLASS_MATERIAL = 'Window'; // give its own material, see-through as the model has it (see makeCarMaterials)
const CAR_SLOT_NAMES = [CAR_PAINT_MATERIAL, 'Lights', 'Backlights', 'TaxiLight', CAR_PLATE_MATERIAL]; // index + 1 is carSlot's value; 0 is every other part
let carMeshes = []; // [{ mesh, paint, wheels, plates, glowUniform, wheelRadius, wheelbase, length, height, name, thumbMesh, thumbCamera, thumbPaint, thumbPlate }], one per design, once loaded
let designNumbers = []; // how many cars of each design have been given out (their number within the design, see updateTraffic)

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
    console.warn('Blockout: the car models failed to load; traffic uses the built-in box car', err);
    return;
  }
  try {
    const designs = buildCarDesigns(gltf);
    if (designs.length) { carMeshes = designs.map(makeCarMesh); designNumbers = designs.map(() => 0); }
  } catch (err) {
    console.warn('Blockout: the car models failed to build; traffic uses the built-in box car', err);
  }
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
  const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3(), v = new THREE.Vector3(), baseColor = new THREE.Color();
  const designs = [];
  gltf.scene.children.forEach(node => {
    const parts = [];
    node.traverse(o => { if (o.isMesh) parts.push(o); });
    if (!parts.length) return;
    const positions = [], slots = [], colors = [], indices = [], glassIndices = [], wheelIds = [], wheels = [];
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
      const first = positions.length/3;
      for (let i=0;i<pos.count;i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld);
        positions.push(v.x, v.y, v.z);
        slots.push(slot);
        colors.push(baseColor.r, baseColor.g, baseColor.b);
        wheelIds.push(wheelId);
      }
      const index = geo.index, corners = index ? index.count : pos.count;
      for (let t=0;t<corners;t++) (isGlass ? glassIndices : indices).push(first + (index ? index.getX(t) : t));
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const [mainColor] = [...bodyColors].sort((a, b) => b[1] - a[1])[0] ?? [];
    designs.push({ name: node.name, geometry, bodyColor: !hasPaint && mainColor ? mainColor.split(',').map(Number) : null, length: size.z/BOX_CAR_LENGTH, width: size.x, height: size.y, radius: geometry.boundingSphere.radius, wheelRadius, wheelbase,
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

// ============================================================ NUMBER PLATES ============================================================
// a car's registration (carPlate) is drawn by the car shader itself (injectCarShader) from one shared
// atlas of plate characters, so it adds no draw calls. instanceCarPlate carries each car's characters — six bits each,
// three to a float — with length*4 + format (0 UK, 1 EU, 2 US) in the fourth float.
const PLATE_GLYPHS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'; // (glyph index 0, the space, is drawn blank)
const PLATE_MAX_CHARS = 9, PLATE_ATLAS_COLUMNS = 8, PLATE_ATLAS_ROWS = 5, PLATE_CELL_W = 48, PLATE_CELL_H = 96;
const plateAtlas = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = PLATE_ATLAS_COLUMNS*PLATE_CELL_W;
  canvas.height = PLATE_ATLAS_ROWS*PLATE_CELL_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  // each capital is drawn at most of the cell's height, thickened by a stroke round it, then scaled on X to the width a
  // typical character needs (wider ones such as M and W get their own fit), leaving a sliver either side of the cell
  const font = size => `900 ${size}px "Arial Black", "Arial Narrow", Arial, sans-serif`;
  ctx.font = font(100);
  const capHeight = ctx.measureText('W').actualBoundingBoxAscent/100, stroke = PLATE_CELL_H*0.06;
  ctx.font = font((PLATE_CELL_H*0.86 - stroke)/capHeight);
  ctx.lineWidth = stroke;
  const fit = ch => (PLATE_CELL_W*0.96 - stroke)/ctx.measureText(ch).width, typical = fit('0');
  const baseline = PLATE_CELL_H*0.5 + ctx.measureText('W').actualBoundingBoxAscent*0.5;
  [...PLATE_GLYPHS].forEach((ch, g) => {
    ctx.save();
    ctx.translate((g % PLATE_ATLAS_COLUMNS + 0.5)*PLATE_CELL_W, Math.floor(g/PLATE_ATLAS_COLUMNS)*PLATE_CELL_H + baseline);
    ctx.scale(Math.min(typical, fit(ch)), 1);
    ctx.fillText(ch, 0, 0);
    ctx.strokeText(ch, 0, 0);
    ctx.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
})();
/**
 * Pack a registration into the floats the plate shader reads: six bits per character, three characters to a float, and in
 * the fourth float length*4 + format (0 UK, 1 EU, 2 US, worked out from the text's shape).
 * @param {string} text
 * @returns {number[]} four floats
 */
function packPlate(text) {
  const format = text.includes('-') ? 1 : text[3] === ' ' ? 2 : 0; // (AB-123-CD is EU, ABC 1234 US, AB12 CDE UK)
  const length = Math.min(PLATE_MAX_CHARS, text.length), packed = [0, 0, 0, length*4 + format];
  for (let k=0;k<length;k++) packed[Math.floor(k/3)] += Math.max(0, PLATE_GLYPHS.indexOf(text[k]))*64**(k % 3);
  return packed;
}
/** Vehicle types that always get a UK-format plate. */
const UK_ONLY_TYPES = ['bus', 'ambulance', 'police car', 'taxi'];
/**
 * A car's registration, from its type's name and its number within that type, packed for its plates (packPlate).
 * It takes a vanity plate, at the chance and from the list assets/cars.txt gives its type; otherwise it comes from
 * hashLicensePlate, UK-formatted for UK_ONLY_TYPES.
 * @param {object} car
 * @returns {{ text: string, packed: number[] }}
 */
function carPlate(car) {
  const carRNG = mulberry32(hashNameToNumber(carMeshes[car.design].name+ car.number));
  const type = carTypeOf(carMeshes[car.design].name, car.number), name = (type.name || '').trim().toLowerCase();
  const vanity = vanityPlatesOf(carMeshes[car.design].name); // (from the `plate` lines in assets/cars.txt)
  // a legendary car's registration stands out too: each legendary love/hate doubles the chance of a vanity plate,
  // capped at 100% — the same tally refreshCarTraits does for legendaryCount, but car.legendaryCount isn't set yet
  // this early (carPlate runs before refreshCarTraits, see the spawn loop), so it's read straight off type here.
  const legendaryCount = [...(type.lovesTier || []), ...(type.hatesTier || [])].filter(tier => tier === 'legendary').length;
  const vanityChance = Math.min(1, vanityChanceOf(carMeshes[car.design].name)*Math.pow(2, legendaryCount));
  const text = (carRNG() < vanityChance && vanity.length) ? vanity[Math.round(carRNG()*(vanity.length-1))].toUpperCase() :
  hashLicensePlate(`${type.name} #${car.number}`, UK_ONLY_TYPES.includes(name) ? 0 : undefined);
  return { text, packed: packPlate(text) };
}


/**
 * Adding a car design's coloring to its material's shader.
 *
 * vCarColor is per vertex: its instance's paint (instanceCarPaint) for a CarCol vertex, otherwise its own baked carColor.
 * vCarEmissive is for the lit slots, added to what the material emits and scaled by carGlowFactor. Wheels (carWheel) turn
 * about their hubs — rolled by instanceCarWheel.x, and where carWheel.w is 2 steered by instanceCarWheel.y, for position
 * and normal both (see turnWheels). Plates shade a Plate vertex by the character cell vCarPlateUv.xy falls in, that
 * character's glyph from instanceCarPlate, and its shape from the atlas, sampled with the gradients of the whole plate
 * rather than the per-cell ones, and faded to blank as the characters shrink below a readable size.
 * @param {object} shader - the material's shader, patched in place
 * @param {object} glowUniform - the shared carGlowFactor uniform
 * @param {?object} paintUniform - set to draw one car un-instanced, for a card thumbnail (makeCarThumbnail): paint and
 *   plates arrive as uniforms set before each draw, and the wheels sit still. Null for the instanced crowd.
 * @param {?object} plateUniform - the per-instance plate glyph uniform, or null as with paintUniform
 * @param {boolean} isGlass - true for the glass material, which never wears the holo sheen (see applyCarHolo)
 * @param {number} halfLength - half the design's own local-space length (design.length*BOX_CAR_LENGTH/2), so the foil
 *   sheen's ring can sit a fixed real distance behind this design specifically (carFoilCentreZ, see applyCarFoilField)
 * @returns {void}
 */
const carHoloTimeUniform = { value: 0 }; // the shared clock for every car's holo sheen (see updateTraffic, applyCarHolo)
function injectCarShader(shader, glowUniform, paintUniform, plateUniform, isGlass = false, halfLength = 0) {
  shader.uniforms.carGlowFactor = glowUniform;
  shader.uniforms.carPlateAtlas = { value: plateAtlas };
  shader.uniforms.carHoloTime = carHoloTimeUniform;
  shader.uniforms.carFoilCentreZ = { value: halfLength };
  shader.uniforms.carRustColor = { value: TERRIBLE_RUST };
  if (paintUniform) shader.uniforms.instanceCarPaint = paintUniform;
  if (paintUniform) shader.uniforms.instanceCarWheel = { value: new THREE.Vector2() };
  if (paintUniform) shader.uniforms.instanceCarHolo = { value: new THREE.Vector4() }; // (a thumbnail never shows the holo sheen or rust spots)
  if (paintUniform) shader.uniforms.instanceCarRust = { value: new THREE.Vector2() };
  if (plateUniform) shader.uniforms.instanceCarPlate = plateUniform;
  const paintDecl = paintUniform
    ? 'uniform vec3 instanceCarPaint;\nuniform vec2 instanceCarWheel;\nuniform vec4 instanceCarPlate;\nuniform vec4 instanceCarHolo;\nuniform vec2 instanceCarRust;'
    : 'attribute vec3 instanceCarPaint;\nattribute vec2 instanceCarWheel;\nattribute vec4 instanceCarPlate;\nattribute vec4 instanceCarHolo;\nattribute vec2 instanceCarRust;';
  const plateDecl = 'varying vec3 vCarPlateUv;\nflat varying vec4 vCarPlate;';
  const holoVaryingDecl = 'varying vec4 vCarHolo;\nvarying vec2 vCarRust;\nvarying vec3 vHoloPos;\nvarying float vCarPainted;';
  const holoFns = `
    uniform float carHoloTime;
    uniform float carFoilCentreZ;
    uniform vec3 carRustColor;
    vec3 carHoloHsv(vec3 c) {
      vec4 k = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + k.xyz)*6.0 - k.www);
      return c.z*mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
    }
    // foil shine: ported from a Balatro-style card shader (four overlapping sine/cosine interference terms over a flat
    // surface coordinate, driven by a two-phase "foil" driver, clamped and summed into "maxfac" — the shine's
    // moment-to-moment intensity). uv stands in for the card's own UV, foilR/foilG for its foil phase.
    float carFoilFac(vec2 uv, float foilR, float foilG) {
      float len1 = length(90.0*uv), len2 = length(113.1121*uv);
      float fac = clamp(2.0*sin(len1 + foilR*2.0 + 3.0*(1.0 + 0.8*cos(len2 - foilR*3.121))) - 1.0 - max(5.0 - len1, 0.0), 0.0, 1.0);
      vec2 rotater = vec2(cos(foilR*0.1221), sin(foilR*0.3512));
      float angle = dot(rotater, uv)/(length(rotater)*max(length(uv), 0.0001));
      float fac2 = clamp(5.0*cos(foilG*0.3 + angle*3.14159*(2.2 + 0.9*sin(foilR*1.65 + 0.2*foilG))) - 4.0 - max(2.0 - length(20.0*uv), 0.0), 0.0, 1.0);
      float fac3 = 0.3*clamp(2.0*sin(foilR*5.0 + uv.x*3.0 + 3.0*(1.0 + 0.5*cos(foilR*7.0))) - 1.0, -1.0, 1.0);
      float fac4 = 0.3*clamp(2.0*sin(foilR*6.66 + uv.y*3.8 + 3.0*(1.0 + 0.5*cos(foilR*3.414))) - 1.0, -1.0, 1.0);
      return max(max(fac, max(fac2, max(fac3, max(fac4, 0.0)))) + 2.2*(fac + fac2 + fac3 + fac4), 0.0);
    }
    // a legendary car's sheen, both kinds driven by the same carFoilFac glint moving over the body (drifting over time,
    // shifting whenever the car turns via holo.w folded into the phase) — foil (one legendary, or a two-legendary car
    // with any terrible) tints the glint with carFoilTint below (a lightened, hue-shifted echo of the car's own paint,
    // or a fixed lightened electric blue where there's no paint to echo); polychrome (a spotless two-legendary car)
    // tints it with a shifting rainbow hue instead. Both are purely maxfac-driven — off the bright bands maxfac is 0,
    // so the result is exactly base, unchanged, not a permanent tint. See carHoloOf/placeCar for what's packed into holo.
    //
    // standard GLSL rgb->hsv (the inverse of carHoloHsv above), used by carFoilTint to shift and lighten the paint's own hue
    vec3 carRgb2Hsv(vec3 c) {
      vec4 k = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
      vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y), e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y)/(6.0*d + e)), d/(q.x + e), q.x);
    }
    // Tuning knobs — edit these directly, no need to touch the maths below them.
    const float FOIL_ROTATION_REACTIVITY = 0.05; // how much the car's own turning shifts the pattern's phase; higher = twitchier
    const float FOIL_CENTRE_CAR_LENGTHS = 20.0; // how many car lengths behind the car the ring's own centre sits
    const float FOIL_SWING_DEGREES = 20.0; // how far that centre swings side to side, each direction, pivoting about the car
    const float FOIL_SWING_PERIOD = 4.0; // seconds for one full left-right-left swing
    const float FOIL_ZOOM = 0.0006; // the pattern's spatial scale — smaller = more zoomed out, bigger bands
    const float FOIL_OPACITY = 0.62; // how strongly the glint shows over the paint, never fully opaque
    const float FOIL_HUE_SHIFT = -40.0; // degrees the paint's own hue turns for the level-1 glint's own tint
    const float FOIL_TINT_LIGHTEN = 0.55; // how far that tint is pulled toward white; 0 keeps the full colour, 1 is white
    // the level-1 glint's own colour: painted (vCarPainted, see placeCar's vertex shader) shifts and lightens the
    // car's own paint; unpainted (trim that keeps its baked colour regardless of the car, or a whole design with no
    // paintable body) has no car colour to shift, so it gets a fixed lightened electric blue instead.
    vec3 carFoilTint(vec3 paintBase, float painted) {
      vec3 hsv = painted > 0.5 ? carRgb2Hsv(paintBase) : vec3(0.58, 0.85, 1.0); // 0.58 turns ~ electric blue
      if (painted > 0.5) hsv.x = fract(hsv.x + FOIL_HUE_SHIFT/360.0);
      hsv.y *= 1.0 - FOIL_TINT_LIGHTEN;
      hsv.z = mix(hsv.z, 1.0, FOIL_TINT_LIGHTEN);
      return carHoloHsv(hsv);
    }
    vec3 applyCarHolo(vec3 base, vec4 holo, vec3 localPos, float painted) {
      float strength = holo.x, kind = holo.y, seed = holo.z;
      // sin() of the bearing, not the raw angle: holo.w (placeCar) jumps from +pi to -pi at the instant the camera
      // crosses directly behind the car — the same angle, just written the other way round, but foilR below multiplies
      // it into several different non-whole frequencies, so a raw 2*pi jump there doesn't cancel out and the whole
      // pattern would visibly snap. sin() is continuous straight through that wrap (it already treats +pi and -pi as
      // the same point), so the phase stays smooth all the way around the car regardless.
      float turn = sin(holo.w)*FOIL_ROTATION_REACTIVITY;
      // carFoilCentreZ is half this design's own local-space length (injectCarShader), so *2.0*FOIL_CENTRE_CAR_LENGTHS
      // puts the ring's own centre (uv = (0,0)) that many car lengths behind the car — off the body, so only the near
      // curve of the ring reaches it. That centre also swings side to side, pivoting about the car.
      float swingAngle = radians(FOIL_SWING_DEGREES)*sin(carHoloTime*6.283185/FOIL_SWING_PERIOD);
      vec2 behind = vec2(-sin(swingAngle), cos(swingAngle))*carFoilCentreZ*2.0*FOIL_CENTRE_CAR_LENGTHS;
      vec2 uv = (localPos.xz + behind)*FOIL_ZOOM;
      float foilR = carHoloTime*0.5 + seed*40.0 + turn, foilG = carHoloTime*0.25 + seed*21.0; // slow flicker
      float maxfac = carFoilFac(uv, foilR, foilG);
      float low = min(base.r, min(base.g, base.b)), high = max(base.r, max(base.g, base.b));
      float delta = min(high, max(0.5, 1.0 - low)); // how much headroom this particular paint colour has for a shine
      if (kind > 0.5) { // polychrome
        float hue = fract(localPos.z*0.2 - carHoloTime*0.3 + seed);
        vec3 rainbow = carHoloHsv(vec3(hue, 0.85, 1.0));
        return base + rainbow*delta*maxfac*0.9*strength*FOIL_OPACITY;
      }
      // foil: a bright glint tinted by carFoilTint above, not the flat white it used to be
      return base + carFoilTint(base, painted)*delta*maxfac*0.9*strength*FOIL_OPACITY;
    }
    // rust spots: a terrible car's own colour left alone, with round rust-brown blobs scattered over it — the same
    // technique as a bloodied person's splotches (see src/life/people/peopleModel.js's BLOOD_GLSL), at three times the
    // scale, so the spots read as rust rather than a uniform tint. carRustOf packs [strength, seed] into rust.
    float carRustHash(vec3 p) { p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
    float carRustBlobs(vec3 at) {
      vec3 base = floor(at - 0.5);
      float field = 0.0;
      for (int k = 0; k < 8; k++) {
        vec3 cell = base + vec3(mod(float(k), 2.0), mod(floor(float(k)/2.0), 2.0), floor(float(k)/4.0));
        vec3 centre = cell + 0.5 + (vec3(carRustHash(cell), carRustHash(cell + 17.1), carRustHash(cell + 31.3)) - 0.5)*0.4;
        float radius = 1.0 + 0.15*carRustHash(cell + 41.7);
        vec3 off = at - centre;
        float fall = max(0.0, 1.0 - dot(off, off)/(radius*radius));
        field += step(0.4, carRustHash(cell + 7.9))*fall*fall*fall; // (a good deal more than half the cells host a blob, for dense coverage)
      }
      return field;
    }
    const float RUST_ZOOM = 0.75; // the blob pattern's spatial scale — bigger = more zoomed in, smaller blobs relative to the car
    vec3 applyCarRust(vec3 base, vec2 rust, vec3 localPos) {
      float strength = rust.x, seed = rust.y;
      vec3 spot = localPos*RUST_ZOOM + vec3(seed*13.7, seed*7.1, seed*3.3);
      return mix(base, carRustColor, smoothstep(0.14, 0.22, carRustBlobs(spot))*strength);
    }`;
  const plateColor = `
    uniform sampler2D carPlateAtlas;
    vec3 carPlateColor() {
      int format = int(vCarPlate.w + 0.5) % 4, count = int(vCarPlate.w + 0.5) / 4;
      bool back = vCarPlateUv.z > 1.5;
      vec3 background = format == 0 && back ? vec3(0.98, 0.72, 0.02) : vec3(0.92);
      // the text: ${PLATE_MAX_CHARS} cells across the plate, inside a margin, the characters centered among them
      const vec2 grid = vec2(${PLATE_ATLAS_COLUMNS}.0, ${PLATE_ATLAS_ROWS}.0), toAtlas = vec2(1.0, -1.0)/grid;
      float left = format == 1 ? 0.09 : 0.05; // (clear of the EU's blue band)
      vec2 inner = (vCarPlateUv.xy - vec2(left, 0.06))/vec2(0.95 - left, 0.88);
      vec2 p = vec2(inner.x*${PLATE_MAX_CHARS}.0 - float(${PLATE_MAX_CHARS} - count)*0.5, inner.y);
      vec2 dx = dFdx(p)*toAtlas, dy = dFdy(p)*toAtlas; // (before any branching, where derivatives aren't to be trusted)
      float tiny = smoothstep(0.35, 0.8, max(fwidth(p.x), fwidth(p.y))); // (characters only a pixel or two across)
      if (format == 1 && vCarPlateUv.x < 0.07) return vec3(0.0, 0.12, 0.6); // (the EU's blue band)
      float cell = floor(p.x);
      if (p.y < 0.0 || p.y > 1.0 || cell < 0.0 || cell >= float(count)) return background;
      int k = int(cell), glyph = (int(vCarPlate[k/3] + 0.5) >> (6*(k % 3))) & 63;
      if (glyph == 0) return background;
      vec2 corner = vec2(float(glyph % ${PLATE_ATLAS_COLUMNS}), float(glyph / ${PLATE_ATLAS_COLUMNS}));
      vec2 atlasUv = vec2((corner.x + p.x - cell)/grid.x, 1.0 - (corner.y + p.y)/grid.y);
      float ink = mix(textureGrad(carPlateAtlas, atlasUv, dx, dy).r, 0.3, tiny);
      return mix(background, vec3(0.03), ink);
    }`;
  const wheelTurn = `
    attribute vec4 carWheel;
    vec3 carWheelTurn(vec3 v) {
      if (carWheel.w < 0.5) return v;
      float s = sin(instanceCarWheel.x), c = cos(instanceCarWheel.x);
      v = vec3(v.x, c*v.y - s*v.z, s*v.y + c*v.z);
      if (carWheel.w > 1.5) { float ss = sin(instanceCarWheel.y), cs = cos(instanceCarWheel.y); v = vec3(cs*v.x + ss*v.z, v.y, cs*v.z - ss*v.x); }
      return v;
    }`;
  const glowTerm = (name, slot) => { const g = CAR_GLOW_MATERIALS[name], c = new THREE.Color(g.emissive).multiplyScalar(g.intensity);
    return `carSlot > ${slot - 0.5} && carSlot < ${slot + 0.5} ? vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)}) : `; };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float carSlot;\nattribute vec3 carColor;\nattribute vec3 carPlate;\n' + paintDecl + wheelTurn + '\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\n' + plateDecl + '\n' + holoVaryingDecl)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = carWheelTurn(objectNormal);')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = carWheelTurn(transformed - carWheel.xyz) + carWheel.xyz;
      vCarColor = carSlot > 0.5 && carSlot < 1.5 ? instanceCarPaint : carColor;
      // whether this fragment is the paintable CarCol slot (instanceCarPaint above) or keeps its own baked colour
      // regardless of the car — see carFoilTint, which only has a car colour to work from in the first case
      vCarPainted = carSlot > 0.5 && carSlot < 1.5 ? 1.0 : 0.0;
      vCarPlateUv = carPlate;
      vCarPlate = instanceCarPlate;
      // the holo sheen and rust spots only ever play on the body (paintable or not) — never lights, plate or glass
      vCarHolo = ${isGlass ? 'vec4(0.0)' : 'carSlot < 1.5 ? instanceCarHolo : vec4(0.0)'};
      vCarRust = ${isGlass ? 'vec2(0.0)' : 'carSlot < 1.5 ? instanceCarRust : vec2(0.0)'};
      vHoloPos = position;
      vCarEmissive = ${CAR_SLOT_NAMES.map((name, k) => CAR_GLOW_MATERIALS[name] ? glowTerm(name, k + 1) : '').join('')}vec3(0.0);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\nuniform float carGlowFactor;\n' + plateDecl + plateColor + '\n' + holoVaryingDecl + holoFns)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 carBodyColor = vCarRust.x > 0.0 ? applyCarRust(vCarColor, vCarRust, vHoloPos) : vCarColor;
      carBodyColor = vCarHolo.x > 0.0 ? applyCarHolo(carBodyColor, vCarHolo, vHoloPos, vCarPainted) : carBodyColor;
      diffuseColor.rgb = vCarPlateUv.z > 0.5 ? carPlateColor() : carBodyColor;`)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCarEmissive*carGlowFactor;');
}

/**
 * A design's two materials — the body, and the glass (the Window parts) at the opacity, roughness and metalness the model
 * gives that material. Both take the car shader through onBeforeCompile.
 * @param {object} design - one entry from buildCarDesigns
 * @param {string} key - the custom program cache key prefix, distinguishing instanced from thumbnail programs
 * @param {object} glowUniform - the shared carGlowFactor uniform
 * @param {?object} paintUniform - per-draw paint, for a thumbnail, or null for the instanced crowd
 * @param {?object} plateUniform - per-draw plate glyphs, for a thumbnail, or null
 * @returns {object[]} [body, glass]
 */
function makeCarMaterials(design, key, glowUniform, paintUniform, plateUniform) {
  const { opacity, roughness, metalness } = design.glass;
  const body = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, envMap: SKY_ENV_MAP, envMapIntensity: 0.8, flatShading: true });
  const glass = new THREE.MeshStandardMaterial({ roughness, metalness, envMap: SKY_ENV_MAP, envMapIntensity: 0.8, flatShading: true,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  [body, glass].forEach((material, k) => {
    material.onBeforeCompile = shader => injectCarShader(shader, glowUniform, paintUniform, plateUniform, k === 1, design.length*BOX_CAR_LENGTH/2);
    material.customProgramCacheKey = () => key + (k ? '-glass' : '');
  });
  return [body, glass];
}

/**
 * The card's thumbnail: the design's own geometry, drawn un-instanced through injectCarShader's paint and plate uniforms,
 * from an isometric orthographic camera sized and aimed at the design (carThumbnailScene sets the paint and plate before
 * the card draws it).
 * @param {object} design - one entry from buildCarDesigns
 * @returns {{ mesh: object, camera: object, paint: object, plate: object }}
 */
function makeCarThumbnail(design) {
  const glowUniform = { value: 1 }, paintUniform = { value: new THREE.Color(0xffffff) }, plateUniform = { value: new THREE.Vector4() };
  const material = makeCarMaterials(design, 'car-thumb', glowUniform, paintUniform, plateUniform);
  const mesh = new THREE.Mesh(design.geometry, material);
  const r = design.radius, elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = r*4;
  const thumbCamera = new THREE.OrthographicCamera(-r*1.15, r*1.15, r*1.15, -r*1.15, 0.1, distance*2);
  thumbCamera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  thumbCamera.up.set(0, 1, 0);
  thumbCamera.lookAt(0, design.height*0.5, 0);
  return { mesh, camera: thumbCamera, paint: paintUniform, plate: plateUniform };
}

/**
 * The instanced mesh the crowd of this design is drawn with, with its per-instance paint, wheel and plate attributes.
 * @param {object} design - one entry from buildCarDesigns
 * @returns {object} the carMeshes entry for this design
 */
function makeCarMesh(design) {
  const glowUniform = { value: 1 };
  const material = makeCarMaterials(design, 'car', glowUniform, null, null);
  const mesh = new THREE.InstancedMesh(design.geometry, material, TRAFFIC_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const paint = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*3), 3);
  paint.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarPaint', paint);
  const wheels = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*2), 2);
  wheels.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarWheel', wheels);
  const plates = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*4), 4);
  plates.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarPlate', plates);
  const holo = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*4), 4); // [strength, kind, seed, heading] — a legendary car's foil/polychrome sheen (see carHoloOf, applyCarHolo); heading is written fresh each frame, the rest cached
  holo.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarHolo', holo);
  const rust = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*2), 2); // [strength, seed] — a terrible car's rust spots (see carRustOf, applyCarRust)
  rust.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarRust', rust);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.name = 'Traffic';
  scene.add(mesh);
  const thumb = makeCarThumbnail(design);
  return { mesh, paint, wheels, plates, holo, rust, glowUniform, length: design.length, width: design.width, height: design.height,
    wheelRadius: design.wheelRadius, wheelbase: design.wheelbase,
    name: design.name, bodyColor: design.bodyColor, // (null where the design is repainted per car)
    thumbMesh: thumb.mesh, thumbCamera: thumb.camera, thumbPaint: thumb.paint, thumbPlate: thumb.plate };
}

/**
 * Rebuild the lanes from the road lines.
 *
 * Per sidewalk road line: { pts, cum, total, lane (its offset from the centerline), loop (whether the line ends where it
 * started, so cars carry on round), vertices (each { links }: the { li, vi } of any other line's point at the same place),
 * stretchOf (which stretch each segment is in) }. Points are tessellated at PEOPLE_NAV_SPACING, and a line under 4 units
 * long is left out. Also built: the points in a grid of CELL-sized cells, for re-seating cars (reseatCar); the stretches
 * between junctions and line ends, each { li, from, to, length, deadEnd }; and how many cars the roads take.
 * @returns {object} the nav: { lines, grid, CELL, stretches, capacity, … }
 */
function buildTrafficNav() {
  const lines = [];
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const pts = [nodes[0]];
    for (let i=1;i<nodes.length;i++) {
      const a = nodes[i-1], b = nodes[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
      for (let k=1;k<=steps;k++) pts.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    }
    const cum = [0];
    for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
    if (cum[cum.length-1] < 4) return;
    const loop = line.nodeIds.length > 3 && line.nodeIds[0] === line.nodeIds[line.nodeIds.length-1];
    lines.push({ pts, cum, total: cum[cum.length-1], lane: Math.max(0.8, roadLineWidths(line).hw*0.5), loop, vertices: pts.map(() => ({ links: [] })) });
  });
  const byPlace = new Map(), grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const place = Math.round(p.x*2) + ',' + Math.round(p.z*2), cell = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!byPlace.has(place)) byPlace.set(place, []);
    byPlace.get(place).push({ li, vi });
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push({ li, vi });
  }));
  byPlace.forEach(list => { if (list.length > 1) list.forEach(a => { lines[a.li].vertices[a.vi].links = list.filter(b => b.li !== a.li); }); });
  // each line's stretches between junctions and ends, and which one each of its segments is in
  const stretches = [];
  lines.forEach((nav, li) => {
    nav.stretchOf = [];
    let from = 0;
    for (let v=1; v<nav.pts.length; v++) {
      if (!nav.vertices[v].links.length && v < nav.pts.length-1) continue;
      const deadEnd = !nav.loop && ((from === 0 && !nav.vertices[0].links.length) || (v === nav.pts.length-1 && !nav.vertices[v].links.length));
      for (let seg=from; seg<v; seg++) nav.stretchOf[seg] = stretches.length;
      stretches.push({ li, from, to: v, length: nav.cum[v] - nav.cum[from], deadEnd });
      from = v;
    }
  });
  const capacity = Math.floor(lines.reduce((sum, nav) => sum + nav.total*2, 0)/TRAFFIC_LANE_PER_CAR);
  return { lines, grid, CELL, capacity, stretches };
}

/**
 * A new car at rest, off any lane, with its own id.
 * @returns {object}
 */
function newCar() {
  return { id: ++carIds, x: 0, z: 0, heading: 0, li: -1, u: 0, dir: 1, seg: 0, speed: 0, ahead: null,
    length: 0.9 + trafficRng()*0.3, width: 0.95 + trafficRng()*0.12, height: 0.9 + trafficRng()*0.35,
    design: null, paint: pickCarPaint(),
    // how far its wheels have rolled and how far its steering wheels are turned, both in radians, and the heading it had
    // last frame, from which turnWheels gets how fast it's turning
    wheelSpin: 0, wheelSteer: 0, lastHeading: null,
    // how far the steering's held over, -1 (left) to 1 (right), while it's being driven (see driveByHand)
    steerHeld: 0,
    // the person it's stopped for, if any (see checkYield) — and the last person it rolled PED_YIELD_CHANCE against, so
    // it doesn't re-roll for them every frame while it's still coming up to them
    yieldFor: null, yieldChecked: -1, yielded: 0,
    // seconds it's stood waiting for another car to move, seconds of pushing on left once it gives up (see waitOrGiveUp),
    // and seconds it's waited to turn round at a dead end (see updateTraffic)
    waited: 0, pushing: 0, uTurnWaited: 0,
    // its turn at the junction ahead, if it has picked one ({ li, vi, from, link, dir, stretch }, see planTurn), and how
    // long it's waited at the stop line for room on the road it's turning onto
    plan: null, held: 0 };
}

/**
 * Put a car in lane `li` at distance `u` along it, heading `dir`, and find the segment that puts it in.
 * @param {object} car
 * @param {number} li - lane index
 * @param {number} u - distance along the lane
 * @param {number} dir - 1 or -1
 * @returns {void}
 */
function carJoinLane(car, li, u, dir) {
  const nav = S.trafficNav.lines[li];
  car.li = li; car.dir = dir; car.u = Math.max(0, Math.min(nav.total, u)); car.turned = null;
  car.seg = 0;
  while (car.seg < nav.pts.length-2 && nav.cum[car.seg+1] <= car.u) car.seg++;
}

/**
 * Where a car should be: its lane's smoothed point at its distance along the lane, offset `lane` to one side for its
 * direction, with the direction the lane runs there.
 * @param {object} car
 * @returns {{ x: number, z: number, heading: number }}
 */
function lanePoint(car) {
  const nav = S.trafficNav.lines[car.li], sm = laneSmoothed(nav), side = car.dir*nav.lane;
  const at = Math.max(0, Math.min(sm.length-1.001, car.u/sm.spacing)), k = Math.floor(at), t = at - k;
  const ax = sm[k].x + sm[k].mx*side, az = sm[k].z + sm[k].mz*side, bx = sm[k+1].x + sm[k+1].mx*side, bz = sm[k+1].z + sm[k+1].mz*side;
  let hx = bx-ax, hz = bz-az;
  if (Math.hypot(hx, hz) < 1e-6) {
    const i = Math.max(0, Math.min(nav.pts.length-2, car.seg));
    hx = nav.pts[i+1].x - nav.pts[i].x; hz = nav.pts[i+1].z - nav.pts[i].z;
  }
  return { x: ax + (bx-ax)*t, z: az + (bz-az)*t, heading: Math.atan2(hx*car.dir, hz*car.dir) };
}
const LANE_SMOOTH = 2.5, LANE_SAMPLE = 0.5;
/**
 * The road's middle at LANE_SAMPLE apart along it (its `spacing`), each averaged over LANE_SMOOTH lane offsets either side
 * of the point, with { mx, mz } the unit left of the line there. Bends are rounded off, so a car turns in before a corner
 * and the inside lane keeps no kink at a sharp one. Each point also carries `along` and `alongBack`, its distance along
 * that lane from the start (laneLength). Cached as `smoothed` on the line.
 * @param {object} nav - a traffic nav line
 * @returns {object} the smoothed sampling, with a `spacing` property
 */
function laneSmoothed(nav) {
  if (nav.smoothed) return nav.smoothed;
  const { pts, cum, total } = nav, n = pts.length, reach = LANE_SMOOTH*nav.lane, STEPS = 32;
  // the road's middle at distance u — round a loop, or carried on straight past either end
  const raw = u => {
    if (nav.loop) u = ((u % total) + total) % total;
    let lo = 0, hi = n-2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= u) lo = mid; else hi = mid - 1; }
    const a = pts[lo], b = pts[lo+1], t = (u - cum[lo])/((cum[lo+1] - cum[lo]) || 1), at = nav.loop ? Math.max(0, Math.min(1, t)) : t;
    return { x: a.x + (b.x-a.x)*at, z: a.z + (b.z-a.z)*at };
  };
  const count = Math.ceil(total/LANE_SAMPLE) + 1, spacing = total/(count-1);
  const middle = Array.from({ length: count }, (_, j) => {
    let x = 0, z = 0;
    for (let k=0; k<=STEPS; k++) { const p = raw(j*spacing + (k/STEPS*2 - 1)*reach); x += p.x; z += p.z; }
    return { x: x/(STEPS+1), z: z/(STEPS+1) };
  });
  nav.smoothed = middle.map((p, j) => {
    const before = middle[j > 0 ? j-1 : nav.loop ? count-2 : 0], after = middle[j < count-1 ? j+1 : nav.loop ? 1 : count-1];
    const dx = after.x - before.x, dz = after.z - before.z, len = Math.hypot(dx, dz) || 1;
    return { x: p.x, z: p.z, mx: -dz/len, mz: dx/len };
  });
  nav.smoothed.spacing = spacing;
  // (and how far along each lane each point is — see laneLength)
  for (const side of [1, -1]) {
    let length = 0;
    nav.smoothed.forEach((p, j) => {
      const q = nav.smoothed[j-1];
      if (q) length += Math.hypot(p.x + p.mx*side*nav.lane - q.x - q.mx*side*nav.lane, p.z + p.mz*side*nav.lane - q.z - q.mz*side*nav.lane);
      p[side > 0 ? 'along' : 'alongBack'] = length;
    });
  }
  return nav.smoothed;
}

/**
 * How far a car going `dir` has driven along the road when it is at distance `u` along the line: further than u round the
 * outside of a bend, less round the inside (laneSmoothed's along/alongBack).
 * @param {object} nav - a traffic nav line
 * @param {number} dir - 1 or -1
 * @param {number} u - distance along the line
 * @returns {number} distance driven along the road
 */
function laneLength(nav, dir, u) {
  const sm = laneSmoothed(nav), key = dir > 0 ? 'along' : 'alongBack';
  const at = Math.max(0, Math.min(sm.length-1.001, u/sm.spacing)), k = Math.floor(at);
  return sm[k][key] + (sm[k+1][key] - sm[k][key])*(at - k);
}

/** The lane's point at distance `u` along it, going `dir`. */
function lanePointAt(li, u, dir) {
  const spot = {};
  carJoinLane(spot, li, u, dir);
  return lanePoint(spot);
}

// ---- a car's route: the path its front axle follows — along its lane, through a cubic curve where it turns onto another
// line (planned or taken on the spot) and round a U at a dead end — where its lane point alone would jump the junction.
const TURN_CURVE = 2.5; // how far either side of a junction a turn's curve reaches, in lane offsets
const ROUTE_SAMPLE = 0.25; // how far along the road to look ahead for how much further its route goes (see updateTraffic)
/**
 * The point `ahead` further along a car's route than its lane point, following whatever turn it has planned at the
 * junction ahead and any U-turn it is partway through.
 * @param {object} car
 * @param {number} ahead - how far further along the route to look
 * @returns {{ x: number, z: number, heading: number }}
 */
function routePoint(car, ahead) {
  const probe = { li: car.li, u: car.u, seg: car.seg, dir: car.dir, plan: car.plan, turned: car.turned, probe: true };
  if (ahead > 0) driveAlong(probe, ahead);
  const nav = S.trafficNav.lines[probe.li];
  // turning round at a dead end: a U of radius nav.lane, reaching `depth` back from the end, swept by `angle` as the car
  // comes up to the end and goes back out
  const depth = Math.min(1.5*nav.lane, nav.total*0.5);
  if (!nav.loop && depth >= nav.lane) {
    for (const end of [1, -1]) {
      const vi = end > 0 ? nav.pts.length-1 : 0, left = end > 0 ? nav.total - probe.u : probe.u;
      if (nav.vertices[vi].links.length || left >= depth) continue;
      const angle = Math.PI*0.5*(probe.dir === end ? 1 - left/depth : 1 + left/depth);
      const mid = lanePointAt(probe.li, nav.cum[vi] - end*depth, end); // (in the lane going in, so off the middle)
      const fx = Math.sin(mid.heading), fz = Math.cos(mid.heading), lx = -fz, lz = fx;
      const cx = mid.x - lx*nav.lane, cz = mid.z - lz*nav.lane, across = nav.lane*Math.cos(angle), along = depth*Math.sin(angle);
      const tx = -nav.lane*Math.sin(angle)*lx + depth*Math.cos(angle)*fx, tz = -nav.lane*Math.sin(angle)*lz + depth*Math.cos(angle)*fz;
      return { x: cx + lx*across + fx*along, z: cz + lz*across + fz*along, heading: Math.atan2(tx, tz) };
    }
  }
  // turning off at a junction: a cubic curve reaching `curve` back along the line it's leaving and `curve` on along the
  // line it joins, picked up before the junction (turn planned) or after it (turn taken)
  const curve = TURN_CURVE*nav.lane;
  let turn = null, at = 0;
  const plan = probe.plan;
  if (plan && plan.link && plan.li === probe.li && plan.from === probe.dir) {
    const d = (nav.cum[plan.vi] - probe.u)*probe.dir;
    if (d >= 0 && d < curve) { turn = { from: { li: plan.li, vi: plan.vi, dir: plan.from }, to: { li: plan.link.li, vi: plan.link.vi, dir: plan.dir } }; at = -d; }
  }
  const turned = probe.turned;
  if (!turn && turned && turned.nav === S.trafficNav && turned.to.li === probe.li && turned.to.dir === probe.dir) {
    const d = (probe.u - nav.cum[turned.to.vi])*probe.dir;
    if (d >= 0 && d < curve) { turn = turned; at = d; }
  }
  if (!turn) return lanePoint(probe);
  const from = S.trafficNav.lines[turn.from.li], to = S.trafficNav.lines[turn.to.li];
  const p0 = lanePointAt(turn.from.li, from.cum[turn.from.vi] - turn.from.dir*curve, turn.from.dir);
  const p3 = lanePointAt(turn.to.li, to.cum[turn.to.vi] + turn.to.dir*curve, turn.to.dir);
  const reach = 0.4*Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const p1 = { x: p0.x + Math.sin(p0.heading)*reach, z: p0.z + Math.cos(p0.heading)*reach };
  const p2 = { x: p3.x - Math.sin(p3.heading)*reach, z: p3.z - Math.cos(p3.heading)*reach };
  const t = (at + curve)/(2*curve), s = 1 - t;
  const bez = k => s*s*s*p0[k] + 3*s*s*t*p1[k] + 3*s*t*t*p2[k] + t*t*t*p3[k];
  const slope = k => 3*s*s*(p1[k] - p0[k]) + 6*s*t*(p2[k] - p1[k]) + 3*t*t*(p3[k] - p2[k]);
  return { x: bez('x'), z: bez('z'), heading: Math.atan2(slope('x'), slope('z')) };
}

/**
 * Put a car somewhere at random along some line, chosen in proportion to its length, if no other car is already sitting
 * there. Gives up after 8 tries and leaves the car at li -1, which keeps it hidden until the next frame's try.
 * @param {object} car
 * @returns {void}
 */
function spawnCar(car) {
  const { lines } = S.trafficNav;
  car.li = -1;
  if (!lines.length) return;
  let nearSpot = null; // (a free spot inside S.carSpawnDistance of the camera, only used if no farther one turns up)
  for (let tries = 0; tries < 8; tries++) {
    const li = pickWeighted(lines, nav => nav.total), u = trafficRng()*lines[li].total, dir = trafficRng() < 0.5 ? -1 : 1;
    carJoinLane(car, li, u, dir);
    const at = lanePoint(car);
    if (spotTaken(car, at.x, at.z)) continue;
    if (Math.hypot(at.x - camera.position.x, Y_ROAD - camera.position.y, at.z - camera.position.z) < S.carSpawnDistance) {
      nearSpot ??= { li, u, dir };
      continue;
    }
    car.x = at.x; car.z = at.z; car.heading = at.heading; car.speed = 0;
    return;
  }
  if (nearSpot) {
    carJoinLane(car, nearSpot.li, nearSpot.u, nearSpot.dir);
    const at = lanePoint(car);
    car.x = at.x; car.z = at.z; car.heading = at.heading; car.speed = 0;
    return;
  }
  car.li = -1;
}

/**
 * Put a car on the nearest line point within two grid cells of it, keeping its direction, after the roads have been
 * rebuilt — or spawn it afresh if it has no line or nothing is near enough.
 * @param {object} car
 * @returns {void}
 */
function reseatCar(car) {
  const { lines, grid, CELL } = S.trafficNav;
  if (car.li >= 0) {
    let best = null;
    const cx = Math.floor(car.x/CELL), cz = Math.floor(car.z/CELL);
    for (let ox=-2;ox<=2;ox++) for (let oz=-2;oz<=2;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      const q = lines[li].pts[vi], d = Math.hypot(q.x-car.x, q.z-car.z);
      if (!best || d < best.d) best = { li, vi, d };
    });
    if (best) { carJoinLane(car, best.li, lines[best.li].cum[best.vi], car.dir); return; }
  }
  spawnCar(car);
}

/**
 * Move a car `dist` along its line, point to point. At each point it reaches: it takes its planned turn if it has one
 * (planTurn), otherwise picks one where the point is linked to another line; it carries on from the start at the seam of a
 * loop; and it turns back into the other lane at a dead end. The result is clamped into the line.
 * @param {object} car
 * @param {number} dist
 * @returns {void}
 */
function driveAlong(car, dist) {
  let nav = S.trafficNav.lines[car.li], u = car.u + car.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const ahead = car.dir > 0 ? car.seg + 1 : car.seg, at = nav.cum[ahead];
    if (car.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead], isEnd = ahead === 0 || ahead === nav.pts.length-1;
    const planned = planFor(car, ahead);
    const plan = planned ? car.plan : vertex.links.length && !car.probe ? pickTurn(car.li, ahead, car.dir) : null;
    if (planned || vertex.links.length || isEnd) car.plan = null; // (a plain point on the way to the junction leaves its plan alone)
    if (plan && plan.link) {
      const link = plan.link, other = S.trafficNav.lines[link.li], remaining = Math.abs(u - at), dir = plan.dir;
      const from = { li: car.li, vi: ahead, dir: car.dir };
      carJoinLane(car, link.li, other.cum[link.vi], dir);
      car.turned = { nav: S.trafficNav, from, to: { li: link.li, vi: link.vi, dir } }; // (see routePoint)
      car.seg = dir > 0 ? Math.min(link.vi, other.pts.length-2) : Math.max(link.vi-1, 0);
      nav = other;
      u = car.u + dir*remaining;
      continue;
    }
    if (isEnd && nav.loop) { u -= car.dir*nav.total; car.seg = car.dir > 0 ? 0 : nav.pts.length-2; continue; } // (round again)
    if (isEnd) { car.dir = -car.dir; u = 2*at - u; car.turned = null; continue; }
    car.seg += car.dir;
  }
  car.u = Math.max(0, Math.min(nav.total, u));
}

/**
 * The next linked point or dead end ahead of a car, looking at most `lookahead` points on. `dist` is measured along the
 * line and keeps counting round a loop.
 * @param {object} car
 * @param {number} lookahead - how many points on to look
 * @returns {object|null} { dist, x, z, vi, deadEnd }, or null if there is none that far on
 */
function junctionAhead(car, lookahead) {
  const nav = S.trafficNav.lines[car.li], last = nav.pts.length-1, seam = car.dir > 0 ? last : 0;
  let v = car.dir > 0 ? car.seg + 1 : car.seg, round = null; // (past a loop's start: how far away that was)
  for (let k=0; k<lookahead && v >= 0 && v <= last; k++, v += car.dir) {
    const links = nav.vertices[v].links.length;
    const dist = round == null ? Math.abs(nav.cum[v] - car.u) : round + Math.abs(nav.cum[v] - nav.cum[last - seam]);
    if (links || (!nav.loop && (v === 0 || v === last))) return { dist, x: nav.pts[v].x, z: nav.pts[v].z, vi: v, deadEnd: !links };
    if (nav.loop && v === seam && round == null) { round = dist; v = last - seam; } // (on round from the other end)
  }
  return null;
}

/**
 * Whether any car on a line — moving or not, since a stopped one can pull away at any moment — is within `radius` of
 * (x, z): the roadsafety radius a pedestrian checks before crossing (crossingClear in people.js).
 * @param {number} x
 * @param {number} z
 * @param {number} radius
 * @returns {boolean}
 */
function carsNearby(x, z, radius) {
  return cars.some(car => car.li >= 0 && Math.hypot(car.x - x, car.z - z) < radius);
}

/**
 * Whether any car on a line is somewhere `test(x, z, car)` says — carsNearby for a shape other than a circle, with the car
 * itself passed to the test.
 * @param {(x: number, z: number, car: object) => boolean} test
 * @returns {boolean}
 */
function carsWhere(test) {
  return cars.some(car => car.li >= 0 && test(car.x, car.z, car));
}

const YIELD_GIVE_UP = 8; // (seconds)
/**
 * Whether the car stops for a pedestrian: someone mid-road ahead of it within PED_YIELD_RADIUS is stopped for with chance
 * PED_YIELD_CHANCE, or always on a junction's zebra crossing. A car committed to someone keeps stopping for them with no
 * further rolls, until they are across, gone, or YIELD_GIVE_UP seconds pass — when they are waved on (p.jc.waved) and it
 * drives on. runOverPeople spares anyone mid-road the car has waved over.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {boolean} whether it is yielding
 */
function checkYield(car, dt) {
  if (car.yieldFor != null) {
    const p = App.people[car.yieldFor];
    car.yielded += dt;
    if (p?.jc && car.yielded > YIELD_GIVE_UP) p.jc.waved = true;
    if (!p || (p.crossStage !== 'mid' && !isPedInDanger(p)) || car.yielded > YIELD_GIVE_UP) { car.yieldFor = null; car.yielded = 0; }
    return car.yieldFor != null;
  }
  const cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  for (let i = 0; i < App.people.length; i++) {
    const p = App.people[i];
    if ((p.crossStage !== 'mid' && !isPedInDanger(p)) || i === car.yieldChecked) continue;
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.hypot(dx, dz) > PED_YIELD_RADIUS) continue;
    const forward = dx*sin + dz*cos;
    if (forward < 0.5 || forward > PED_YIELD_RADIUS) continue; // (only ahead of it, not behind)
    car.yieldChecked = i;
    // (someone on a junction's zebra crossing always gets let across)
    if (p.crossStage === 'jcross' || trafficRng() < PED_YIELD_CHANCE) car.yieldFor = i;
    return car.yieldFor === i;
  }
  return false;
}


/**
 * Set car.traits from its type's entries in assets/cars.txt (see carTypeOf), once per design and number. Cars without a
 * design have no traits; the readers below treat a missing trait as 1.
 * @param {object} car
 * @returns {void}
 */
function refreshCarTraits(car) {
  const key = car.design + ':' + car.number;
  if (car.traitsKey === key) return;
  car.traitsKey = key;
  const type = carTypeOf(carMeshes[car.design].name, car.number);
  car.traits = type.traits;
  // legendary/terrible are 'on' traits (core/traits.js) — combineTraits caps the aggregate at 1 even when several of a
  // car's loves/hates are individually marked legendary or terrible, so updateSpecialTraits' net level can't read the
  // real count from car.traits. Tallied here instead from each love/hate entry's own tier (type.lovesTier/hatesTier,
  // from carTypeOf/core/type-text.js).
  const tiers = [...(type.lovesTier || []), ...(type.hatesTier || [])];
  car.legendaryCount = tiers.filter(tier => tier === 'legendary').length;
  car.terribleCount = tiers.filter(tier => tier === 'terrible').length;
}

/**
 * One frame of traffic: show or hide the car meshes with the people; rebuild the lanes if the roads have changed and
 * re-seat the cars on them (reseatCar); make the car count match S.trafficAmount, capped by TRAFFIC_MAX and the roads'
 * capacity; give a design to any car without one; sort each lane's cars into `ahead` order; then drive every car —
 * chosen speed, steering, route, wheels, placement, and running over anyone in its way.
 * @param {number} t - seconds since page load
 * @returns {void}
 */
export function updateTraffic(t) {
  if (followedCar >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingCar();
  const dt = S.lastTrafficTime == null ? 0 : Math.min(0.1, Math.max(0, t - S.lastTrafficTime));
  S.lastTrafficTime = t;
  carHoloTimeUniform.value = t;
  carParts.all.forEach(mesh => { mesh.visible = S.peopleEnabled; });
  carMeshes.forEach(cm => { cm.mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) { updateEngines([], null, null, dt); return; }
  if (!S.trafficNav || (S.trafficNavDirty && t - S.trafficNavBuiltAt > 0.25 && !navRebuildOnHold())) {
    S.trafficNavDirty = false;
    S.trafficNavBuiltAt = t;
    S.trafficNav = buildTrafficNav();
    cars.forEach(car => { if (car !== drivenCar) reseatCar(car); });
  }
  const wanted = Math.min(TRAFFIC_MAX, Math.round(S.trafficAmount), S.trafficNav.capacity);
  while (cars.length < wanted) { const car = newCar(); spawnCar(car); cars.push(car); }
  if (cars.length > wanted) cars.length = wanted;
  if (followedCar >= cars.length) stopFollowingCar();
  carParts.all.forEach(mesh => { mesh.count = cars.length; });
  // who's in front of whom: cars in the same lane going the same way, in order along it
  const lanes = new Map();
  cars.forEach(car => {
    if (car.li < 0 && S.trafficNav.lines.length) spawnCar(car);
    car.ahead = null;
    if (car.li < 0 || car === drivenCar) return; // (the one being driven isn't in any lane — see "driving a car")
    const key = car.li*2 + (car.dir > 0 ? 1 : 0);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(car);
  });
  lanes.forEach(list => {
    list.sort((a, b) => (a.u - b.u)*a.dir);
    for (let k=0;k<list.length-1;k++) list[k].ahead = list[k+1];
    if (list.length > 1 && S.trafficNav.lines[list[0].li].loop) list[list.length-1].ahead = list[0]; // (round the loop)
  });
  buildCarGrid();
  const { matrix } = placing;
  const designCounts = carMeshes.map(() => 0);
  cars.forEach((car, i) => {
    if (car.li < 0) { matrix.makeScale(0, 0, 0); carParts.body.setMatrixAt(i, matrix); if (S.showRoadsafetyDebug) carHitboxDebugMesh.setMatrixAt(i, matrix); return; }
    if (car.design == null && carMeshes.length) {
      car.design = Math.floor(trafficRng()*carMeshes.length);
      car.length = carMeshes[car.design].length;
      car.number = ++designNumbers[car.design];
      car.plate =  carPlate(car);
    }
    if (car.design != null) refreshCarTraits(car);
    if (car === drivenCar) { if (car.sinking) sinkCar(car, dt); else driveByHand(car, dt); turnWheels(car, dt); updateSpecialTraits(car, t, dt); placeCar(car, i, designCounts); return; }
    if (car.fuse != null) { burnFuse(car, dt); placeCar(car, i, designCounts); return; } // (about to blow: it neither drives nor turns)
    // cruise, but ease off for the car in front and slow down into junctions
    const cruise = CAR_SPEED*S.peopleSpeed*(car.traits?.speed ?? 1);
    let target = cruise;
    if (car.ahead) {
      // (along each car's own lane rather than the road, since a lane runs quicker round the inside of a bend)
      const nav = S.trafficNav.lines[car.li], along = (laneLength(nav, car.dir, car.ahead.u) - laneLength(nav, car.dir, car.u))*car.dir;
      const gap = (along < 0 ? along + laneLength(nav, car.dir, nav.total) : along) - 2.2*S.peopleSize*(car.length + car.ahead.length); // (round a loop)
      target = Math.min(target, Math.max(0, (gap - 2*S.peopleSize)*1.2*S.peopleSpeed));
    }
    // (and for whichever other car gapAhead finds in its way, in its lane or not)
    const block = gapAhead(car);
    if (block.gap < Infinity) target = Math.min(target, Math.max(0, (block.gap - CAR_STOP_GAP*S.peopleSize)*1.2*S.peopleSpeed));
    waitOrGiveUp(car, block.by, dt);
    const ahead = junctionAhead(car, 8);
    // (and, coming up to a dead end within 12 sizes of it, stays short of the end while another car sits where it would
    // come round into — but only for 2*GIVE_UP_AFTER seconds, since that car may be queued behind this car's own lane)
    const uTurnWait = ahead && ahead.deadEnd && ahead.dist < 12*S.peopleSize && uTurnBlocked(car);
    car.uTurnWaited = uTurnWait ? car.uTurnWaited + (car.speed < 0.3 ? dt : 0) : 0;
    if (uTurnWait && car.uTurnWaited < GIVE_UP_AFTER*2) {
      target = Math.min(target, Math.max(0, (ahead.dist - carLength(car)*0.5)*1.5*S.peopleSpeed));
    }
    if (ahead && ahead.dist < 10) target = Math.min(target, cruise*(0.45 + 0.055*ahead.dist));
    // stop for a red light — or an amber one there's still room to stop for — with the front bumper at the stop line
    const junction = ahead && S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
    const stopAt = junction ? junction.r + 3.2 + 2.2*car.length*S.peopleSize : carLength(car)*0.5 + S.peopleSize;
    if (junction) {
      const lane = lanePoint(car), tx = Math.sin(lane.heading), tz = Math.cos(lane.heading);
      const arm = junction.arms.reduce((best, a) => -(a.x*tx + a.z*tz) > -(best.x*tx + best.z*tz) ? a : best, junction.arms[0]); // the arm it's coming in on
      const state = signalState(junction, arm.phase, t);
      if (state !== 2 && ahead.dist > stopAt - 0.5 && (state === 0 || ahead.dist > stopAt + 3)) {
        target = Math.min(target, Math.max(0, (ahead.dist - stopAt)*1.5*S.peopleSpeed));
      }
    }
    // (and at the stop line while the road it's turning onto is full — see "not filling up dead ends")
    if (ahead && !ahead.deadEnd && ahead.dist < 30*S.peopleSize && waitToTurn(car, ahead, dt) && ahead.dist > stopAt - 0.5) {
      target = Math.min(target, Math.max(0, (ahead.dist - stopAt)*1.5*S.peopleSpeed));
    }
    if (checkYield(car, dt) || car.kick) target = 0; // (or knocked off its route, and waiting to be back on it)
    car.speed += Math.max(-CAR_BRAKE*(car.traits?.braking ?? 1)*S.peopleSpeed*dt, Math.min(5*S.peopleSpeed*dt, target - car.speed));
    // (its point on the route is further than u along the middle of the road round the outside of a bend, a U or a turn
    // across a junction, and nearer round the inside, so it's driven as much further as holds its speed steady)
    const back = CAR_REAR_AXLE*carLength(car);
    let travel = car.speed*dt;
    if (travel > 0) {
      const here = routePoint(car, back), on = routePoint(car, back + ROUTE_SAMPLE);
      const moved = Math.hypot(on.x - here.x, on.z - here.z);
      if (moved > 1e-6) travel *= Math.max(0.25, Math.min(4, ROUTE_SAMPLE/moved));
    }
    driveAlong(car, travel);
    // its front axle is put on its route (see routePoint) and its back axle, CAR_REAR_AXLE of its length behind, follows
    // it round, so the back end cuts in on a bend
    let knocked = null; // (how a knocked car is moving)
    if (car.kick) { car.x -= car.kick.x; car.z -= car.kick.z; knocked = stepKick(car, dt); } // (knocked off its route by a bump: the offset is taken off while it's put back on it, so it can't turn it round)
    const front = routePoint(car, back);
    const pullX = front.x - (car.x - back*Math.sin(car.heading)), pullZ = front.z - (car.z - back*Math.cos(car.heading));
    if (car.kick) { // (off its route: it keeps the heading the knock left it, turning only to face the way back)
      car.heading = car.kick.heading;
      car.x = front.x - back*Math.sin(car.heading) + car.kick.x;
      car.z = front.z - back*Math.cos(car.heading) + car.kick.z;
    } else if (Math.hypot(pullX, pullZ) > 1e-6) {
      car.heading = Math.atan2(pullX, pullZ);
      car.x = front.x - back*Math.sin(car.heading);
      car.z = front.z - back*Math.cos(car.heading);
    }
    const lane = lanePoint(car), offLane = Math.abs(Math.atan2(Math.sin(lane.heading - car.heading), Math.cos(lane.heading - car.heading)));
    if (knocked && Math.hypot(knocked.x, knocked.z) > 0.3) runOverPeople(car, knocked);
    else if (car.speed > 0.3 && offLane < TURN_SAFE_ANGLE) runOverPeople(car);
    turnWheels(car, dt);
    updateSpecialTraits(car, t, dt);
    placeCar(car, i, designCounts);
  });
  // (each car that has burnt out blows up, and any car near it too — as an ordinary explosion, so they set nothing else off)
  const burntOut = wreckedCars.splice(0), blasted = new Set(burntOut);
  const reach = DETONATION_REACH*S.peopleSize;
  burntOut.forEach(car => App.people.forEach((p, i) => { // (people in the blast die, thrown clear of it)
    const dx = p.x - car.x, dz = p.z - car.z, d = Math.hypot(dx, dz);
    if (!p.indoors && d <= reach && Math.abs(p.y - Y_ROAD) <= reach) App.killPerson(i, 'player', { x: dx/(d || 1)*BLAST_THROW, y: 0, z: dz/(d || 1)*BLAST_THROW });
  }));
  burntOut.forEach(car => forCarsNear(car.x, car.z, reach, other => { if (Math.hypot(other.x - car.x, other.z - car.z) <= reach) blasted.add(other); }));
  if (drivenCar && blasted.has(drivenCar)) { const driven = drivenCar; stopDriving(); blasted.add(driven); } // (the driver is thrown out of it, and it goes too)
  blasted.forEach(car => { const i = cars.indexOf(car); if (i >= 0) killCar(i); });
  if (drivenCar?.sinking?.under) { const driven = drivenCar, at = { x: driven.x, z: driven.z }; stopDriving(); Object.assign(driven, at); killCar(cars.indexOf(driven), WATER_LEVEL); } // (gone under: it blows up at the surface)
  updateEngines(cars, drivenCar, engineOf, dt);
  carHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) { carHitboxDebugMesh.count = cars.length; carHitboxDebugMesh.instanceMatrix.needsUpdate = true; }
  carParts.matrix.needsUpdate = true;
  const glowFactor = computeWindowGlowFactor(S.sunElevation);
  carMeshes.forEach((cm, d) => {
    cm.mesh.count = designCounts[d];
    cm.mesh.instanceMatrix.needsUpdate = true;
    cm.paint.needsUpdate = true;
    cm.wheels.needsUpdate = true;
    cm.plates.needsUpdate = true;
    cm.holo.needsUpdate = true;
    cm.rust.needsUpdate = true;
    cm.glowUniform.value = glowFactor;
  });
  // the camera onto whoever it's following, at about their roof — and driving it, round behind it
  if (followedCar >= 0) { const car = cars[followedCar]; controls.goalTarget.set(car.x, Y_ROAD + carHeight(car)*(drivenCar ? 1.1 : 0.6), car.z); }
  if (drivenCar) chaseCamera(drivenCar);
}

const WHEEL_STEER_MAX = 0.6; // (radians)
/**
 * Roll a car's wheels by the distance it has covered (wheelSpin), and steer its steering wheels: the driven car by
 * steerHeld (so they turn standing still too), any other by the angle a wheelbase this long needs to turn as fast as the
 * car is going. Both are eased toward, so a jolt — being re-seated, say — doesn't flick them.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function turnWheels(car, dt) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  const turned = car.lastHeading == null ? 0 : Math.atan2(Math.sin(car.heading - car.lastHeading), Math.cos(car.heading - car.lastHeading));
  car.lastHeading = car.heading;
  if (!cm || !cm.wheelRadius || dt <= 0) return;
  car.wheelSpin = (car.wheelSpin + car.speed*dt/(cm.wheelRadius*S.peopleSize)) % (Math.PI*2);
  let steer = 0;
  if (car === drivenCar) steer = -car.steerHeld*WHEEL_STEER_MAX;
  else if (Math.abs(car.speed) > 0.5 && cm.wheelbase) steer = Math.atan(turned/dt*cm.wheelbase*S.peopleSize/car.speed);
  steer = Math.max(-WHEEL_STEER_MAX, Math.min(WHEEL_STEER_MAX, steer));
  car.wheelSteer += (steer - car.wheelSteer)*Math.min(1, dt*10);
}

const placing = { matrix: new THREE.Matrix4(), rotation: new THREE.Quaternion(), scale: new THREE.Vector3(), position: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
const tilting = new THREE.Quaternion(), sideways = new THREE.Vector3(1, 0, 0); // (a sinking car's pitch, about its own sideways axis)
const rolling = new THREE.Quaternion(), forward = new THREE.Vector3(0, 0, 1); // (a terrible car's rock side to side while it hops, about its own length axis — see updateSpecialTraits)
/**
 * Put car `i` where it is: at Y_ROAD (plus its bumpY, sunk by its sinking.drop), turned to its heading and scaled by
 * S.peopleSize. It goes into its design's mesh at the next free instance slot (counted up in designCounts), with its
 * paint and wheel angles and plate packed alongside, or into the box car when it has no design; its place in the other
 * mesh is zeroed either way. Also writes its debug hitbox.
 * @param {object} car
 * @param {number} i - the car's index, for the box car's instance slot
 * @param {number[]} designCounts - one running instance count per design
 * @returns {void}
 */
function placeCar(car, i, designCounts) {
  const { matrix, rotation, scale, position, up } = placing;
  rotation.setFromAxisAngle(up, car.heading);
  if (car.sinking) rotation.multiply(tilting.setFromAxisAngle(sideways, car.sinking.pitch)); // (nose down, into the water)
  if (car.bumpShake) rotation.multiply(rolling.setFromAxisAngle(forward, car.bumpShake)); // (rocking side to side while it hops, like a plane landing — see updateSpecialTraits)
  position.set(car.x, Y_ROAD - (car.sinking?.drop ?? 0) + (car.bumpY ?? 0), car.z); // (bumpY: a terrible car hopping — see updateSpecialTraits)
  if (car.design != null && carMeshes[car.design]) {
    const cm = carMeshes[car.design], idx = designCounts[car.design]++;
    const holo = car.holo ?? DEFAULT_HOLO; // (a legendary car's foil/polychrome sheen, drawn by the shader itself — see carHoloOf)
    const rust = car.rust ?? DEFAULT_RUST; // (a terrible car's rust spots, likewise — see carRustOf)
    scale.setScalar(S.peopleSize);
    matrix.compose(position, rotation, scale);
    cm.mesh.setMatrixAt(idx, matrix);
    cm.paint.setXYZ(idx, car.paint[0], car.paint[1], car.paint[2]);
    cm.wheels.setXY(idx, car.wheelSpin, car.wheelSteer);
    cm.plates.setXYZW(idx, ...car.plate.packed);
    // the camera's bearing from the car, in the car's own local frame (world bearing to the camera, minus the car's
    // own heading) — not the car's raw heading, so the foil glint (applyCarHolo) reacts to where the camera is
    // looking from, not to the car simply turning under a viewer whose own relative angle hasn't changed.
    const toCamera = Math.atan2(camera.position.x - car.x, camera.position.z - car.z) - car.heading;
    cm.holo.setXYZW(idx, holo[0], holo[1], holo[2], toCamera);
    cm.rust.setXY(idx, rust[0], rust[1]);
    matrix.makeScale(0, 0, 0);
    carParts.body.setMatrixAt(i, matrix);
  } else {
    scale.set(car.width*S.peopleSize, car.height*S.peopleSize, car.length*S.peopleSize);
    matrix.compose(position, rotation, scale);
    carParts.body.setMatrixAt(i, matrix);
  }
  if (S.showRoadsafetyDebug) {
    const { halfLength, halfWidth } = carHitbox(car), h = carHeight(car);
    scale.set(halfWidth*2, h, halfLength*2);
    matrix.compose(position.setY(Y_ROAD + h*0.5), rotation, scale);
    carHitboxDebugMesh.setMatrixAt(i, matrix);
  }
}

// ============================================================ CAR CAMERA  ============================================================
// The view stays on the car clicked in World mode, and the car card (car-card.js,
// App.showCarCard) names it, its mood, and what it loves and hates from assets/cars.txt by its type (carTypeOf in
// car-types.js).
let followedCar = -1;
/**
 * A car's height in world units: its design's, or the box car's own until it has a design.
 * @param {object} car
 * @returns {number}
 */
function carHeight(car) { return (car.design != null && carMeshes[car.design] ? carMeshes[car.design].height : car.height)*S.peopleSize; }

/**
 * A car's design mesh data, or null before the models have loaded.
 * @param {object} car
 * @returns {?object}
 */
function carModelOf(car) { return car.design != null ? carMeshes[car.design] : null; }

/**
 * A car's length in world units, from its design or from the box car. Asked for separately from carWidth, as the gap and
 * overlap tests want one without the other.
 * @param {object} car
 * @returns {number}
 */
// what the engine sounds need of a car (see audio/engine.js): where its engine is, how big it is against an ordinary car
// (bigger, lower), whether it's running — not stalled, sinking or burning — and its design, for the kind of engine
const engineOf = car => ({ y: Y_ROAD + carHeight(car)/2, size: carLength(car)/(BOX_CAR_LENGTH*S.peopleSize), running: !car.sinking && !(car.stall > 0) && car.fuse == null, design: carModelOf(car)?.name });
function carLength(car) { const cm = carModelOf(car); return (cm ? cm.length : car.length)*BOX_CAR_LENGTH*S.peopleSize; }

/**
 * A car's width in world units, from its design or from the box car.
 * @param {object} car
 * @returns {number}
 */
function carWidth(car) { const cm = carModelOf(car); return (cm ? cm.width : car.width*BOX_CAR_WIDTH)*S.peopleSize; }

const CAR_REAR_AXLE = 0.3;
/**
 * Turn a car by `by` radians about a point CAR_REAR_AXLE of its length back from car.x/car.z, keeping that point fixed, so
 * the back end follows the front round a turn.
 * @param {object} car
 * @param {number} by - radians
 * @returns {void}
 */
function turnCar(car, by) {
  const back = CAR_REAR_AXLE*carLength(car), heading = car.heading + by;
  car.x += back*(Math.sin(heading) - Math.sin(car.heading));
  car.z += back*(Math.cos(heading) - Math.cos(car.heading));
  car.heading = heading;
}

const CAR_HITBOX_SCALE = 0.6;
const CAR_KILL_SCALE = 0.7, CAR_CLIP_SCALE = 1.5, CAR_STUN_SCALE = 2; // of CAR_HITBOX_SCALE: anyone within the first is killed, anyone else within the second is knocked over, and anyone else within the third is shocked
const CAR_SHOCK_TIME = 1; // how long, in seconds, someone stays shocked
const CAR_PUSH_PER_SPEED = 0.1, CAR_KNOCK_PUSH_FACTOR = 0.15; // how far a car throws someone back, per unit of its speed — the shocked, and (by the factor) the knocked over
const CAR_FALL_SPEEDUP = 5; // how many times faster than normal someone knocked over by a car goes down
/**
 * The hitbox a car runs people over with: half its length and width, each with a 0.25 margin, scaled by CAR_HITBOX_SCALE —
 * so a car hits someone under its middle rather than at its very corners.
 * @param {object} car
 * @returns {{ halfLength: number, halfWidth: number }}
 */
function carHitbox(car, scale = CAR_HITBOX_SCALE*CAR_KILL_SCALE) {
  const length = carLength(car), width = carWidth(car);
  return { halfLength: (length*0.5 + 0.25)*scale, halfWidth: (width*0.5 + 0.25)*scale };
}

/**
 * Throw someone away from a car, `factor` times CAR_PUSH_PER_SPEED of its speed.
 * @param {object} p - the person
 * @param {object} car
 * @param {number} factor
 * @returns {void}
 */
function throwBack(p, car, factor, speed = car.speed) {
  const away = { x: p.x - car.x, z: p.z - car.z };
  if (Math.hypot(away.x, away.z) < 1e-3) { away.x = Math.sin(car.heading); away.z = Math.cos(car.heading); }
  App.pushPerson?.(p, away.x, away.z, Math.abs(speed)*CAR_PUSH_PER_SPEED*factor);
}

/**
 * Kill every pedestrian whose position falls inside carHitbox, turned to the car's heading (killPerson in people.js,
 * crediting the driver — including anyone falling or lying knocked down), and knock over anyone else inside the larger clipping box (knockOverPerson). A normal car reaches only someone out on the road, over it or halfway, and never anyone it has
 * waved over; the car being driven, or one knocked and moving (`motion`, its velocity { x, z }), reaches anyone within carHeight of Y_ROAD.
 * @param {object} car
 * @param {?{x: number, z: number, thrown?: boolean, by?: string}} motion - a knocked car's velocity, or null to go by its speed and heading; `thrown` if the knock is still carrying it, `by` 'player' to credit the player with the kills
 * @returns {void}
 */
function runOverPeople(car, motion = null) {
  const { halfLength, halfWidth } = carHitbox(car, motion?.thrown ? 1 : undefined), clip = carHitbox(car, CAR_HITBOX_SCALE*CAR_CLIP_SCALE), stun = carHitbox(car, CAR_HITBOX_SCALE*CAR_STUN_SCALE);
  const reach = Math.hypot(stun.halfLength, stun.halfWidth), cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  const driven = car === drivenCar, reachesAll = driven || !!motion, shocked = new Set();
  const velocity = motion ?? { x: Math.sin(car.heading)*car.speed, z: Math.cos(car.heading)*car.speed }, speed = Math.hypot(velocity.x, velocity.z);
  App.people.forEach((p, i) => {
    if (reachesAll ? Math.abs(p.y - Y_ROAD) > carHeight(car) : (!isPedInDanger(p) && p.crossStage !== 'mid' && !p.punched) || p.jc?.waved) return; // only while out on the road, over it or halfway (and not waved over), or knocked down
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out most people before the exact check)
    const right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    // (anyone hearted is knocked down instead, below: they can't be killed. See ui/favorites.js)
    if (Math.abs(right) < halfWidth && Math.abs(forward) < halfLength && !isFavoritePerson(i)) { impactSound('thump', p, speed); if (speed >= 0.5) exclaim({ x: p.x, y: p.y + App.personHeight(p)*0.9, z: p.z }, voiceOfPerson(p)); App.killPerson(i, driven || motion?.by === 'player' ? 'player' : 'car', { x: velocity.x, y: 0, z: velocity.z }); slowedBy(car, 'person', p.traits?.weight); }
    else if (p.mode === 'possessed') return;
    else if (Math.abs(right) < clip.halfWidth && Math.abs(forward) < clip.halfLength) { if (App.knockOverPerson(p, car)) { impactSound('thump', p, speed); throwBack(p, car, CAR_KNOCK_PUSH_FACTOR, speed); p.shotRate = CAR_FALL_SPEEDUP; slowedBy(car, 'person', p.traits?.weight); } }
    else if (Math.abs(right) < stun.halfWidth && Math.abs(forward) < stun.halfLength) {
      shocked.add(p);
      if (!car.shocked?.has(p) && !p.stun && !p.fright && !p.please && !p.punched && !p.attack) {
        p.stun = { stage: 'notice', timer: 0.15, from: { x: car.x, z: car.z }, hold: CAR_SHOCK_TIME };
        throwBack(p, car, 1, speed);
      }
    }
  });
  car.shocked = shocked; // (each is shocked once, as the car comes within reach)
  // and any bee it hits (see life/bees.js)
  App.strikeBees?.({ x: car.x, z: car.z, heading: car.heading, halfLength, halfWidth, height: carHeight(car) });
}

/**
 * Strike whoever an aircraft is touching — whatever lies within its footprint (a box turned to `heading`) and whose height
 * overlaps the aircraft's — by weight, as a driven car does (AIRCRAFT_WEIGHT against theirs): a person is killed, a car is
 * destroyed if `speed` reaches WRECK_SPEED_PER_SLOWDOWN times the slow-down hitting it costs, or else shoved away (jolted, from
 * JOLT_SPEED_PER_SLOWDOWN times) and stopped. Called each frame by whatever is flying one low enough to matter (see flyByHand in
 * zones/airport.js); anything killed is credited to the player. A car is struck once as the aircraft meets it.
 * @param {{x: number, y: number, z: number, heading: number, halfLength: number, halfWidth: number, below: number, above: number, speed?: number, velocity?: {x: number, y: number, z: number}}} aircraft
 *   Its middle, its heading, half its length and wingspan, how far its body reaches below and above `y`, its speed, and its velocity (which anyone it kills keeps as chunks).
 * @returns {number} the share of its speed the aircraft loses to what it has newly struck (0 to 1)
 */
function strikeWithAircraft({ x, y, z, heading, halfLength, halfWidth, below, above, speed = 0, velocity = null }) {
  const cos = Math.cos(heading), sin = Math.sin(heading), reach = Math.hypot(halfLength, halfWidth);
  const inFootprint = (px, pz) => {
    const dx = px - x, dz = pz - z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return false; // (cheaply rules out most of them before the exact check)
    return Math.abs(dx*cos - dz*sin) < halfWidth && Math.abs(dx*sin + dz*cos) < halfLength;
  };
  const sharesHeight = (base, height) => base < y + above && base + height > y - below;
  const aircraft = { traits: { weight: AIRCRAFT_WEIGHT } };
  let keep = 1;
  App.people.forEach((p, i) => {
    if (!sharesHeight(p.y, p.height*S.peopleSize) || !inFootprint(p.x, p.z)) return;
    App.killPerson(i, 'player', velocity);
    keep *= 1 - Math.min(PERSON_MAX_SLOWDOWN, PERSON_SLOWDOWN*(p.traits?.weight ?? 1)/AIRCRAFT_WEIGHT);
  });
  for (let i = cars.length - 1; i >= 0; i--) {
    const car = cars[i];
    if (car.li < 0) continue;
    if (!sharesHeight(Y_ROAD, carHeight(car)) || !inFootprint(car.x, car.z)) { car.struckByAircraft = false; continue; }
    if (car.struckByAircraft) continue;
    car.struckByAircraft = true;
    const share = slowdownShare(aircraft, car.traits?.weight);
    keep *= 1 - Math.min(CAR_MAX_SLOWDOWN, share);
    if (speed >= WRECK_SPEED_PER_SLOWDOWN*share) { killCar(i); continue; }
    const jolted = speed >= JOLT_SPEED_PER_SLOWDOWN*share;
    kickCar(car, car.x - x, car.z - z, jolted ? speed*BUMP_JOLT_SHOVE : Math.min(1, speed*BUMP_SHOVE + BUMP_PUSH_POWER*AIRCRAFT_WEIGHT));
    car.speed = 0;
  }
  return 1 - keep;
}

/**
 * What a car's called, for its card and for the morality notices: its registration, and its type and number within it
 * — "AB12 CDE (Taxi #3)" — or just the type while its model is still loading.
 * @param {object} car
 * @returns {string}
 */
function carLabel(car) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  const type = carTypeOf(cm ? cm.name : null, car.number);
  return cm ? `${car.plate.text} (${type.name} #${car.number})` : type.name;
}

/**
 * The car whose screen-space line from its wheels to its roof lies nearest (clientX, clientY) — within 35% of that line's
 * length or 10 pixels, whichever is greater — and of those the one nearest the camera, or -1 if there is none.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {number} the car's index in cars, or -1
 */
function pickCar(clientX, clientY) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), roof = new THREE.Vector3();
  let best = -1, bestDepth = Infinity;
  cars.forEach((car, i) => {
    if (car.li < 0) return;
    foot.set(car.x, Y_ROAD, car.z).project(camera);
    roof.set(car.x, Y_ROAD + carHeight(car), car.z).project(camera);
    if (Math.abs(foot.z) > 1 || Math.abs(roof.z) > 1) return;
    const ax = (foot.x + 1)/2*width, ay = (1 - foot.y)/2*height, bx = (roof.x + 1)/2*width, by = (1 - roof.y)/2*height;
    const lengthSq = (bx - ax)**2 + (by - ay)**2;
    const k = lengthSq > 0 ? Math.max(0, Math.min(1, ((clientX - ax)*(bx - ax) + (clientY - ay)*(by - ay))/lengthSq)) : 0;
    const off = Math.hypot(clientX - (ax + (bx - ax)*k), clientY - (ay + (by - ay)*k));
    if (off <= Math.max(10, Math.sqrt(lengthSq)*0.35) && foot.z < bestDepth) { best = i; bestDepth = foot.z; }
  });
  return best;
}

/**
 * Follow the car pickCar finds at a point on the screen: the camera's radius limits are set from the car's height, and its
 * card is shown with its type's name, plate and number. With no car there it stops following.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {void}
 */
function followCarAt(clientX, clientY) {
  const i = pickCar(clientX, clientY);
  if (i < 0) { stopFollowingCar(); return; }
  followCar(cars[i]);
}
/**
 * Follow a car, as a click on it would (see followCarAt) — for the favorites (ui/favorites.js), which keep hold of the
 * car itself, since its place in cars shifts as others are blown up.
 * @param {object} car
 * @returns {boolean} false if it's gone (blown up, or the traffic thinned out)
 */
function followCar(car) {
  const i = cars.indexOf(car);
  if (i < 0) return false;
  followedCar = i;
  const h = carHeight(cars[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9));
  const type = carTypeOf(car.design != null ? carMeshes[car.design].name : null, car.number);
  App.showCarCard(i, { ...type, name: carLabel(car) }, car);
  return true;
}

/**
 * Stop driving and following (stopDriving), reset the camera's radius limits and hide the card.
 * @returns {void}
 */
function stopFollowingCar() {
  if (followedCar < 0) return;
  stopDriving();
  followedCar = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hideCarCard();
}

//  ============================================================ DEAD ENDS  ============================================================
// Roads with ends only take only so many cars. A stretch takes at most stretchRoom cars, counted per frame in stretchCounts
// (buildCarGrid), and one whose way on is a full stretch either picks another or waits at the stop line (planTurn,
// waitToTurn). A dead end is never full.
const CAR_SLOT = 7; // how much lane a car stopped in a queue takes up (at size 1)
const stretchCounts = [];
const stretchOf = (li, seg) => S.trafficNav.lines[li].stretchOf[Math.max(0, Math.min(S.trafficNav.lines[li].pts.length-2, seg))];

/**
 * How many cars a stretch takes: both its lanes' worth of usable length, less the junctions at its ends, and one space
 * left over to turn round in. A dead end takes any number.
 * @param {number} si - stretch index
 * @returns {number}
 */
function stretchRoom(si) {
  const st = S.trafficNav.stretches[si];
  if (st === undefined || st.deadEnd) return Infinity;
  const nav = S.trafficNav.lines[st.li];
  const junctionAt = v => S.roadJunctionByPlace.get(placeKey(nav.pts[v].x, nav.pts[v].z))?.r || 0;
  const usable = st.length - junctionAt(st.from) - junctionAt(st.to);
  return Math.max(1, Math.floor(usable*2/(CAR_SLOT*S.peopleSize)) - 1);
}

const stretchFull = si => stretchCounts[si] >= stretchRoom(si);
/**
 * The ways a car on line `li` heading `dir` can go at vertex `vi`.
 * @param {number} li
 * @param {number} vi
 * @param {number} dir - 1 or -1
 * @returns {{ options: object[], straight: ?object }} each option { link, dir, stretch }; `straight` is null at the dead end
 *   of a non-loop line
 */
function turnOptions(li, vi, dir) {
  const nav = S.trafficNav.lines[li], options = [];
  nav.vertices[vi].links.forEach(link => {
    const other = S.trafficNav.lines[link.li], last = other.pts.length-1;
    (link.vi === 0 ? [1] : link.vi === last ? [-1] : [1, -1]).forEach(d =>
      options.push({ link, dir: d, stretch: stretchOf(link.li, d > 0 ? link.vi : link.vi-1) }));
  });
  const last = nav.pts.length-1, isEnd = vi === 0 || vi === last;
  if (isEnd && !nav.loop) return { options, straight: null };
  // (round a loop, straight on from its end is on from its start, and back past its start is the other way)
  const seg = dir > 0 ? (vi === last ? 0 : vi) : (vi === 0 ? last-1 : vi-1);
  return { options, straight: { link: null, dir, stretch: stretchOf(li, seg) } };
}

/**
 * Which way a car goes at a junction point: at random among its linked lines' options whenever there are any and either
 * it is the end of its line or a 0.35 roll comes up, otherwise straight on. There is no straight on at the dead end of a
 * non-loop line.
 * @param {number} li
 * @param {number} vi
 * @param {number} dir
 * @returns {object} the turn: { li, vi, from, link, dir, stretch }
 */
function pickTurn(li, vi, dir) {
  const { options, straight } = turnOptions(li, vi, dir);
  const turn = options.length && (!straight || trafficRng() < 0.35);
  return { li, vi, from: dir, ...(turn ? options[Math.floor(trafficRng()*options.length)] : straight) };
}

/**
 * Work out the car's turn at the point ahead if it hasn't already (planTurn), then say whether it has to hold at the stop
 * line for it: true while the stretch it is joining is full and isn't the one it is already on, with its plan re-picked
 * every GIVE_UP_AFTER seconds of waiting in case some other way now has room.
 * @param {object} car
 * @param {object} ahead - the junction ahead, from junctionAhead
 * @param {number} dt - seconds this frame
 * @returns {boolean} whether it must hold
 */
function waitToTurn(car, ahead, dt) {
  if (!planFor(car, ahead.vi)) { car.plan = planTurn(car, ahead.vi); car.held = 0; }
  if (!stretchFull(car.plan.stretch) || stretchOf(car.li, car.seg) === car.plan.stretch) { car.held = 0; return false; }
  car.held += dt;
  if (car.held > GIVE_UP_AFTER) { car.plan = planTurn(car, ahead.vi); car.held = 0; } // (maybe there's room some other way now)
  return true;
}

/** Whether the car's plan is a turn at vertex `vi` of the line it is on, taken in the direction it is going. */
const planFor = (car, vi) => car.plan && car.plan.li === car.li && car.plan.vi === vi && car.plan.from === car.dir;
/**
 * The car's turn at a junction point: pickTurn's choice, unless the stretch it joins is full, in which case one is picked
 * at random from the options and the straight on whose stretches aren't — or, with none free, pickTurn's choice stands.
 * @param {object} car
 * @param {number} vi - the junction point's index
 * @returns {object} the plan
 */
function planTurn(car, vi) {
  const { options, straight } = turnOptions(car.li, vi, car.dir);
  const picked = pickTurn(car.li, vi, car.dir);
  if (!stretchFull(picked.stretch)) return picked;
  const free = [...options, ...(straight ? [straight] : [])].filter(o => !stretchFull(o.stretch));
  return free.length ? { li: car.li, vi, from: car.dir, ...free[Math.floor(trafficRng()*free.length)] } : picked;
}

// ---- keeping clear of other cars: gapAhead finds the nearest car whose footprint lies in the strip senseRange long and
// carWidth wide directly ahead — in its lane or not, including the one being driven — and the car eases off for it. A car
// in the oncoming lane going the other way is left out (inOncomingLane), as is the car behind it in its own lane; the
// `ahead` car is held at a distance separately. Where two cars are each in the other's way, goesFirst decides.
const CAR_STOP_GAP = 1.5;  // how far short of the car in front one stops (at size 1)
const CAR_BRAKE = 30;      // the hardest a car brakes, per second
const LANE_OVERLAP = 1;    // how much of the two cars' widths has to overlap for one to count as in the other's way
const CAR_GRID_CELL = 12;
const carGrid = new Map();
const cellKey = (cx, cz) => cx + ',' + cz;

/**
 * Rebuild the car grid: every car on a lane bucketed into its CAR_GRID_CELL-sized cell, and the stretch counts reset.
 * @returns {void}
 */
function buildCarGrid() {
  carGrid.clear();
  stretchCounts.length = S.trafficNav.stretches.length;
  stretchCounts.fill(0);
  cars.forEach(car => {
    if (car.li < 0) return;
    stretchCounts[stretchOf(car.li, car.seg)]++;
    const key = cellKey(Math.floor(car.x/CAR_GRID_CELL), Math.floor(car.z/CAR_GRID_CELL));
    if (!carGrid.has(key)) carGrid.set(key, []);
    carGrid.get(key).push(car);
  });
}

/**
 * Call `fn` on every car in the grid cells within `radius` of a point.
 * @param {number} x
 * @param {number} z
 * @param {number} radius
 * @param {(car: object) => void} fn
 * @returns {void}
 */
function forCarsNear(x, z, radius, fn) {
  const reach = Math.ceil(radius/CAR_GRID_CELL), cx = Math.floor(x/CAR_GRID_CELL), cz = Math.floor(z/CAR_GRID_CELL);
  for (let ox=-reach;ox<=reach;ox++) for (let oz=-reach;oz<=reach;oz++) (carGrid.get(cellKey(cx+ox, cz+oz)) || []).forEach(fn);
}

/** How far ahead a car looks: half its length, 6 units of clearance, and its stopping distance at its current speed. */
const senseRange = car => carLength(car)*0.5 + 6*S.peopleSize + Math.max(0, car.speed)*1.2;
/**
 * How far `car` can go before its front bumper reaches `other`, taking other's footprint as it lies along and across the
 * car's heading.
 * @param {object} car
 * @param {object} other
 * @param {number} range - how far ahead to consider
 * @returns {number} the gap, or Infinity if other is not in its way
 */
function gapTo(car, other, range) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading), dx = other.x - car.x, dz = other.z - car.z;
  const forward = dx*sin + dz*cos;
  if (forward <= 0 || forward > range) return Infinity;
  const turn = other.heading - car.heading, left = dx*cos - dz*sin; // (how far off to its left other is)
  if (other !== drivenCar && car !== drivenCar && inOncomingLane(car, other, turn)) return Infinity;
  const aLen = carLength(car), aWid = carWidth(car), bLen = carLength(other), bWid = carWidth(other);
  const c = Math.abs(Math.cos(turn)), s = Math.abs(Math.sin(turn));
  // (other's footprint, as seen along and across car's heading)
  const across = c*bWid*0.5 + s*bLen*0.5, along = c*bLen*0.5 + s*bWid*0.5;
  if (Math.abs(left) > (aWid*0.5 + across)*LANE_OVERLAP) return Infinity;
  return forward - aLen*0.5 - along;
}

/**
 * Whether `other` is ahead of a car but over in the oncoming lane, where the car ignores it. On the car's own line that
 * means the two are going opposite ways with both keeping to their lanes (keepingToLane). On another line it is judged by
 * where lanePoint puts each lane, since a car partway round a corner points across both lanes of the road it is entering.
 * @param {object} car
 * @param {object} other
 * @param {number} turn - other.heading - car.heading, in radians
 * @returns {boolean}
 */
function inOncomingLane(car, other, turn) {
  if (other.li === car.li) return other.dir !== car.dir && keepingToLane(car) && keepingToLane(other);
  if (Math.cos(turn) >= -0.3) return false;
  const a = lanePoint(car), b = lanePoint(other), sin = Math.sin(a.heading), cos = Math.cos(a.heading);
  const lane = S.trafficNav.lines[car.li].lane;
  return Math.cos(b.heading - a.heading) < -0.7 && (b.x - a.x)*cos - (b.z - a.z)*sin > lane;
}

/**
 * Whether a car is simply following its lane. False if it is within TURN_CURVE lanes of its own plus its length of a
 * junction it has planned a turn at, or that near either end of a line that dead-ends, where it will swing round into the
 * other lane.
 * @param {object} car
 * @returns {boolean}
 */
function keepingToLane(car) {
  const nav = S.trafficNav.lines[car.li], near = TURN_CURVE*nav.lane + carLength(car), plan = car.plan;
  if (plan && plan.link && plan.li === car.li && plan.from === car.dir && Math.abs(nav.cum[plan.vi] - car.u) < near) return false;
  const deadEnd = vi => !nav.loop && !nav.vertices[vi].links.length;
  return !(deadEnd(0) && car.u < near) && !(deadEnd(nav.pts.length-1) && nav.total - car.u < near);
}

/**
 * The nearest car in the car's way, and how far off it is.
 * @param {object} car
 * @returns {{ gap: number, by: ?object }} gap is Infinity and by null when nothing is in the way
 */
function gapAhead(car) {
  const range = senseRange(car);
  let best = Infinity, by = null;
  forCarsNear(car.x, car.z, range, other => {
    if (other === car || other.ahead === car) return; // (the car behind it in its own lane never is)
    if (car.pushing > 0 && other !== drivenCar && other !== car.ahead && Math.abs(other.speed) < 0.3) return; // (pushing past, see waitOrGiveUp)
    const gap = gapTo(car, other, range);
    if (gap >= best) return;
    if (other !== drivenCar && gapTo(other, car, senseRange(other)) < Infinity && goesFirst(car, other)) return;
    best = gap; by = other;
  });
  return { gap: best, by };
}
const GIVE_UP_AFTER = 2.5, PUSH_FOR = 3; // (seconds)
/**
 * A car that has stood still GIVE_UP_AFTER + (its id % 5)*0.4 seconds — a slightly different wait each, so they don't all
 * go at once — waiting on another car that is also standing still, and that is neither the car ahead of it in its lane nor
 * the one being driven, gives up and pushes on for PUSH_FOR seconds, ignoring any stationary car but those two (gapAhead).
 * Waiting for anything else resets its patience.
 * @param {object} car
 * @param {?object} by - the car it is waiting on
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function waitOrGiveUp(car, by, dt) {
  car.pushing = Math.max(0, car.pushing - dt);
  if (!by || by === car.ahead || by === drivenCar || car.speed > 0.3 || Math.abs(by.speed) > 0.3) {
    car.waited = 0;
    return;
  }
  car.waited += dt;
  if (car.waited < GIVE_UP_AFTER + (car.id % 5)*0.4) return;
  car.waited = 0;
  car.pushing = PUSH_FOR;
}

/**
 * Of two cars each in the other's way, whether `car` is the one to go: the one nearer where their paths cross, or — with
 * the paths near enough parallel, or equally near — the one with the lower id.
 * @param {object} car
 * @param {object} other
 * @returns {boolean}
 */
function goesFirst(car, other) {
  const sa = Math.sin(car.heading), ca = Math.cos(car.heading), sb = Math.sin(other.heading), cb = Math.cos(other.heading);
  const det = sb*ca - sa*cb, px = other.x - car.x, pz = other.z - car.z;
  if (Math.abs(det) < 0.3) return car.id < other.id;
  // (tCar and tOther: how far each is along its own heading from where the two paths cross)
  const tCar = (sb*pz - cb*px)/det, tOther = (sa*pz - ca*px)/det;
  return Math.abs(tCar) !== Math.abs(tOther) ? Math.abs(tCar) < Math.abs(tOther) : car.id < other.id;
}

/**
 * Whether a car coming up to a dead end has nowhere to turn round: another car, on the same line and going the other way,
 * sitting within half their lengths plus CAR_STOP_GAP of that end of the line.
 * @param {object} car
 * @returns {boolean}
 */
function uTurnBlocked(car) {
  const nav = S.trafficNav.lines[car.li], end = car.dir > 0 ? nav.total : 0, length = carLength(car);
  return cars.some(other => other !== car && other !== drivenCar && other.li === car.li && other.dir === -car.dir
    && Math.abs(other.u - end) < (length + carLength(other))*0.5 + CAR_STOP_GAP*S.peopleSize);
}

/**
 * Whether a car put at (x, z) would sit within half its and the other's lengths plus CAR_STOP_GAP of another car on a line.
 * @param {object} car
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
function spotTaken(car, x, z) {
  const length = carLength(car);
  return cars.some(other => other !== car && other.li >= 0
    && Math.hypot(other.x - x, other.z - z) < (length + carLength(other))*0.5 + CAR_STOP_GAP*S.peopleSize);
}

/**
 * Whether two cars' footprints overlap: their turned rectangles are tested along the two axes of each car — its forward
 * one and its sideways one — with each rectangle projected onto the axis as half its length and half its width.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function carsOverlap(a, b) {
  const aLen = carLength(a), aWid = carWidth(a), bLen = carLength(b), bWid = carWidth(b), dx = b.x - a.x, dz = b.z - a.z;
  const axes = [a.heading, b.heading].flatMap(h => [[Math.sin(h), Math.cos(h)], [Math.cos(h), -Math.sin(h)]]);
  const extent = (len, wid, h, [ax, az]) => {
    const along = Math.abs(Math.sin(h)*ax + Math.cos(h)*az), across = Math.abs(Math.cos(h)*ax - Math.sin(h)*az);
    return along*len*0.5 + across*wid*0.5;
  };
  return axes.every(axis => Math.abs(dx*axis[0] + dz*axis[1])
    < extent(aLen, aWid, a.heading, axis) + extent(bLen, bWid, b.heading, axis));
}

// ============================================================ DRIVING ============================================================
// (possession.js): the followed car is taken off its line and steered by hand anywhere, with the camera
// swung round behind it. Other cars hold back for it as for any car, and it runs over anyone it touches (runOverPeople).
// Letting go puts it back on the nearest lane, facing whichever way along it its heading most nearly matches.
const DRIVE_TOP_SPEED = 20, DRIVE_BOOST = 1.6, DRIVE_REVERSE_SPEED = 7;
const DRIVE_ACCEL = 10, DRIVE_BRAKE = 28, DRIVE_COAST = 4, DRIVE_TURN = 2.2; // per second (the turn in radians)
// how fast steerHeld goes over to full lock and back, per second — and the speed above walking pace at which the car
// turns half as sharply as at a crawl, a third as sharply at twice that speed, and so on
const DRIVE_STEER_RATE = 5, DRIVE_TURN_FADE = 12;
let drivenCar = null;
/**
 * Take the followed car for driving, if startDriving allows it and it is on a line; drops anyone it was yielding to.
 * @param {number} i - index in cars
 * @returns {void}
 */
function driveCar(i) {
  const car = cars[i];
  if (i !== followedCar || !car || car.li < 0 || car.fuse != null || drivenCar === car || !startDriving()) return;
  drivenCar = car;
  car.yieldFor = null;
  car.throttle = 0;
  controls.goalRadius = Math.max(controls.minRadius, carLength(car)*2.2);
}

/**
 * Put the driven car back in traffic: its speed floored at 0, and set to drive back to the nearest point of any line (see
 * seatKickedCar), in whichever direction along that line its heading most nearly matches — or spawned afresh if the roads are empty.
 * @returns {void}
 */
function stopDriving() {
  if (!drivenCar) return;
  const car = drivenCar;
  drivenCar = null;
  endDriving();
  car.speed = Math.max(0, car.speed);
  // it drives back to the nearest lane, as a knocked car does
  car.kick = { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 };
  if (!seatKickedCar(car, car.x, car.z)) { car.kick = null; spawnCar(car); }
}

/**
 * One frame of the driven car, from the keys held (controlInput): brake, forward at top speed (boosted by run), reverse,
 * or coast down to a standstill; steerHeld eased toward `right`; the turn scaled by speed up to a walking pace and fading
 * above it, and reversed when going backwards; then moved along its heading and bumped into any car it has run into (which
 * may stop it, or wreck them).
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function driveByHand(car, dt) {
  const input = controlInput(), { right, run, brake } = input;
  // a stalled engine gives no drive, and smokes from the bonnet
  const stalled = car.stall > 0, forward = stalled ? 0 : input.forward;
  if (stalled) {
    car.stall -= dt;
    if ((car.stallSmoke = (car.stallSmoke ?? 0) - dt) <= 0) {
      car.stallSmoke = STALL_SMOKE_EVERY;
      const nose = carLength(car)/2;
      engineSmoke({ x: car.x + Math.sin(car.heading)*nose, y: Y_ROAD, z: car.z + Math.cos(car.heading)*nose }, carHeight(car));
    }
  }
  if (run && forward > 0 && car.speed > 1) boostSmoke(car, dt);
  // its speed and boost traits scale the top speed and the boost (see cars.txt)
  const boost = run ? DRIVE_BOOST*(car.traits?.boost ?? 1) : 1;
  const top = DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost;
  const braking = DRIVE_BRAKE*(car.traits?.braking ?? 1);
  car.throttle = brake ? 0 : Math.abs(forward); // (for the engine's sound)
  const toward = (v, goal, rate) => v + Math.max(-rate*dt, Math.min(rate*dt, goal - v));
  if (brake) car.speed = toward(car.speed, 0, braking);
  else if (forward > 0) car.speed = toward(car.speed, top, car.speed < 0 ? braking : DRIVE_ACCEL*boost);
  else if (forward < 0) car.speed = toward(car.speed, -DRIVE_REVERSE_SPEED, car.speed > 0 ? braking : DRIVE_ACCEL*0.6);
  else car.speed = toward(car.speed, 0, DRIVE_COAST);
  // steering turns it at up to DRIVE_TURN radians a second, less the slower it's going below 4 units a second, and less
  // the faster above that (1/(1 + speed/DRIVE_TURN_FADE)); steerHeld is eased toward the key rather than jumping
  const was = { x: car.x, z: car.z, heading: car.heading };
  car.steerHeld = toward(car.steerHeld, right, DRIVE_STEER_RATE);
  const pace = Math.max(-1, Math.min(1, car.speed/4))/(1 + Math.abs(car.speed)/DRIVE_TURN_FADE);
  turnCar(car, -car.steerHeld*DRIVE_TURN*(car.traits?.control ?? 1)*dt*pace);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  bumpIntoCars(car, was);
  hitBuildings(car, was, dt);
  if (Math.abs(car.speed) > 0.3) runOverPeople(car);
  if (overOpenWater(car.x, car.z)) car.sinking = { drop: 0, fall: 0, pitch: 0, under: false };
}

// ---- the driven car in the water: driven off the land (or off the side of a bridge) and over water — a water zone or a
// river — it drops through the surface, nose first, carried on a little by its speed, and blows up once it's under
const SINK_GRAVITY = 20, SINK_DRAG = 1.5, SINK_PITCH = 0.7, SINK_PITCH_RATE = 2.5; // (units a second squared; the share of its speed the water takes each second; how far its nose goes down, in radians, and how fast)
let openWater = { region: null, roads: null, inWater: null, onRoad: null };
/**
 * Whether a point is over water with no road across it to hold a car up: in the water region (water zones and rivers),
 * and not on the road footprint (a bridge's deck, sidewalks and all). The two region testers are rebuilt whenever
 * either region is.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
function overOpenWater(x, z) {
  const region = getWaterRegion(), roads = S.roadFootprint;
  if (!region.length) return false;
  if (openWater.region !== region || openWater.roads !== roads)
    openWater = { region, roads, inWater: App.createRegionTester(region), onRoad: App.createRegionTester(roads) };
  return openWater.inWater(x, z) && !openWater.onRoad(x, z);
}
/**
 * One frame of a driven car going down in the water: the keys do nothing now; it runs on along its heading as the water
 * slows it, falls faster and faster, and tips its nose down (or its tail, going backwards) — until it's a car's height
 * below the surface, when it's marked `under` for updateTraffic to blow up.
 * @param {object} car - the driven car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function sinkCar(car, dt) {
  const sink = car.sinking;
  car.speed *= 1 - Math.min(1, SINK_DRAG*dt);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  sink.fall += SINK_GRAVITY*dt;
  sink.drop += sink.fall*dt;
  const goal = SINK_PITCH*(car.speed < 0 ? -1 : 1);
  sink.pitch += Math.max(-SINK_PITCH_RATE*dt, Math.min(SINK_PITCH_RATE*dt, goal - sink.pitch));
  if (sink.drop >= Y_ROAD - WATER_LEVEL + carHeight(car)) sink.under = true;
}

// ---- the driven car against buildings: each building's footprint (see see-through.js) is a wall it can't drive through
const WALL_HEAD_ON = 0.8, WALL_DRAG = 3, WALL_LET_GO = 0.25, WALL_SCRAPE_SPEED = 2, WALL_SCRAPE_EVERY = 0.08, WALL_SCRAPE_SPARKS = 3; // (the share of its travel going into the wall that counts as head-on; how fast scraping along one slows it, per second at full into; how long clear of walls, in seconds, before touching one counts as hitting it afresh; the least speed that scrapes sparks, how often, and how many)
/**
 * The building footprint a car's turned rectangle overlaps, or null: a circle round each footprint to reject it first,
 * then any corner of the car inside the footprint, or any corner of the footprint inside the car.
 * @param {object} car - anything with x, z and heading that carLength and carWidth can measure
 * @returns {?Array<{x: number, z: number}>}
 */
function buildingHit(car) {
  const halfLength = carLength(car)/2, halfWidth = carWidth(car)/2, reach = Math.hypot(halfLength, halfWidth);
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) =>
    ({ x: car.x + sin*halfLength*a + cos*halfWidth*b, z: car.z + cos*halfLength*a - sin*halfWidth*b }));
  const inCar = q => {
    const dx = q.x - car.x, dz = q.z - car.z;
    return Math.abs(dx*sin + dz*cos) < halfLength && Math.abs(dx*cos - dz*sin) < halfWidth;
  };
  for (const zone of S.zones) for (const group of zone.buildingsGroup?.children || []) {
    const fp = group.userData.footprint;
    if (!fp || fp.length < 3) continue;
    const { c, r } = footprintBounds(group);
    if (Math.hypot(car.x - c.x, car.z - c.z) > r + reach) continue;
    if (corners.some(q => pointInPolygon(q, fp)) || fp.some(inCar)) return fp;
  }
  return null;
}
/**
 * The wall of a footprint nearest a point, as the point on it nearest and the way out of the building, square to it.
 * @param {Array<{x: number, z: number}>} fp
 * @param {{x: number, z: number}} p
 * @returns {{ q: {x: number, z: number}, n: {x: number, z: number} }}
 */
function nearestWall(fp, p) {
  let best = null;
  fp.forEach((a, k) => {
    const b = fp[(k+1) % fp.length], ex = b.x - a.x, ez = b.z - a.z, len2 = ex*ex + ez*ez || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x)*ex + (p.z - a.z)*ez)/len2)), q = { x: a.x + ex*t, z: a.z + ez*t };
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (!best || d < best.d) {
      const len = Math.sqrt(len2), n = { x: ez/len, z: -ex/len }, out = (p.x - q.x)*n.x + (p.z - q.z)*n.z < 0 ? -1 : 1;
      best = { d, q, n: { x: n.x*out, z: n.z*out } };
    }
  });
  return best;
}
/**
 * Keep the driven car out of buildings. Run into one and it slides along the wall, keeping only the part of its move
 * that doesn't go into it (and, failing that, its turn or nothing at all); the first touch takes off the share of its
 * speed that was going into the wall, with sparks — and head-on (WALL_HEAD_ON) and fast enough, throws it back with its
 * engine dead, as hitting a much heavier car does. Held against the wall it slows the more it's pointed into it, and
 * scrapes sparks along it. A car that's somehow in one already can go anywhere but deeper in.
 * @param {object} car - the driven car
 * @param {object} was - its position and heading before this frame
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
function hitBuildings(car, was, dt) {
  const fp = buildingHit(car);
  if (!fp) { car.clearOfWalls = (car.clearOfWalls ?? Infinity) + dt; return; }
  const { q, n } = nearestWall(fp, was), moved = { x: car.x - was.x, z: car.z - was.z }, push = moved.x*n.x + moved.z*n.z;
  const stuck = buildingHit({ ...car, ...was }); // (already in it — shoved there by a car, say: free to go anywhere but deeper)
  if (stuck && push >= 0) return;
  const turned = { x: car.x, z: car.z, heading: car.heading };
  car.x = was.x + moved.x - n.x*Math.min(0, push); car.z = was.z + moved.z - n.z*Math.min(0, push);
  if (!stuck && buildingHit(car)) { Object.assign(car, turned, { x: was.x, z: was.z }); if (buildingHit(car)) Object.assign(car, was); }
  const travel = Math.sign(car.speed || 1), into = Math.max(0, -(Math.sin(car.heading)*n.x + Math.cos(car.heading)*n.z)*travel);
  const contact = { x: q.x, y: Y_ROAD + carHeight(car)*0.4, z: q.z };
  const fresh = !(car.clearOfWalls < WALL_LET_GO); // (sliding along a wall leaves it just clear of it now and then)
  car.clearOfWalls = 0;
  if (fresh) {
    impactSound('crash', contact, Math.abs(car.speed)*into);
    if (into > WALL_HEAD_ON && Math.abs(car.speed) >= BOUNCE_MIN_SPEED) {
      car.speed = -travel*Math.abs(car.speed)*BUMP_BOUNCE; car.stall = STALL_TIME;
      puffSmoke({ x: q.x, y: Y_ROAD, z: q.z }, carHeight(car), BUMP_SMOKE_PUFFS);
    } else car.speed *= 1 - into;
    sparks(contact, BUMP_SPARKS);
    car.scrapeSparks = WALL_SCRAPE_EVERY;
    return;
  }
  car.speed *= 1 - Math.min(1, WALL_DRAG*into*dt);
  if (Math.abs(car.speed) > WALL_SCRAPE_SPEED && (car.scrapeSparks -= dt) <= 0) { car.scrapeSparks = WALL_SCRAPE_EVERY; sparks(contact, WALL_SCRAPE_SPARKS); }
}

const BUMP_SHOVE = 0.15, BUMP_BOUNCE = 0.3, BOUNCE_BELOW_SPEED = 0.2, BUMP_SMOKE_PUFFS = 4, BUMP_SPARKS = 10;
const STALL_TIME = 1, STALL_SMOKE_EVERY = 0.2; // (seconds the engine stays dead after a car is thrown back; how often it smokes meanwhile)
const WRECK_SPEED_PER_SLOWDOWN = 30, JOLT_SPEED_PER_SLOWDOWN = 15, BUMP_JOLT_SHOVE = 0.2; // (a car wrecks one it hits if it's going this many times faster than the slow-down hitting it costs, as a share of speed; at half that it jolts it back, by this share of its speed)
const BUMP_PUSH_POWER = 0.03, BOUNCE_MIN_SPEED = 2; // (per unit of weight, how far a car shoves the one it's against each frame, even from a standstill; the least speed a car is thrown back from)
// The share of its speed a car of weight 1 loses hitting something of weight 1 (see the `weight` trait): 50% for a car; for a person
// far less, and never more than PERSON_MAX_SLOWDOWN (under a car's least, CAR_MIN_SLOWDOWN), however heavy they are.
const CAR_SLOWDOWN = 0.5, CAR_MIN_SLOWDOWN = 0.1, CAR_MAX_SLOWDOWN = 0.95, PERSON_SLOWDOWN = 0.05, PERSON_MAX_SLOWDOWN = 0.125;
/**
 * Slow a car for having hit something: it keeps its speed less a share set by the kind of thing (a car or a person) and
 * the weight of what it hit over its own weight — so the heavier the thing, or the lighter the car, the more it loses. A car that would be left going slower than BOUNCE_BELOW_SPEED after hitting
 * a car is thrown back instead, at BUMP_BOUNCE of the speed it hit at (times the same ratio, up to all of it) (the camera doesn't follow that: see chaseCamera), and its
 * engine dies for STALL_TIME, smoking (see driveByHand).
 * @param {object} car - the car that hit it
 * @param {'car'|'person'} kind - what it hit
 * @param {number} [weight] - the weight trait of what it hit
 * @returns {void}
 */
function slowedBy(car, kind, weight = 1) {
  const ratio = weight/(car.traits?.weight ?? 1);
  const loss = kind === 'person' ? Math.min(PERSON_MAX_SLOWDOWN, PERSON_SLOWDOWN*ratio) : Math.min(CAR_MAX_SLOWDOWN, slowdownShare(car, weight));
  if (kind === 'car' && Math.abs(car.speed) >= BOUNCE_MIN_SPEED && Math.abs(car.speed)*(1 - loss) < BOUNCE_BELOW_SPEED) { car.speed = -Math.sign(car.speed || 1)*Math.abs(car.speed)*Math.min(1, BUMP_BOUNCE*ratio); car.stall = STALL_TIME; } // (the knock back too grows with the ratio, up to its whole speed)
  else car.speed *= 1 - loss;
}
/** The share of its speed a car would lose hitting a car of weight `weight`, before it's kept to a range: more the heavier that car is against its own weight. */
const slowdownShare = (car, weight = 1) => Math.max(CAR_MIN_SLOWDOWN, CAR_SLOWDOWN*weight/(car.traits?.weight ?? 1));
const wreckedCars = [];
const IMPACT_FULL_SPEED = 12; // (how fast a car has to hit something to be heard at its loudest; slower, quieter)
/** The sound of a car hitting something at `speed`: louder the harder, and not at all for a nudge. */
function impactSound(name, at, speed) {
  if (speed < 0.5) return;
  playSound(name, { x: at.x, y: Y_ROAD + 0.8*S.peopleSize, z: at.z }, Math.min(1, 0.25 + speed/IMPACT_FULL_SPEED));
}
/** Small black smoke from a boosting car's rear tyres. */
function boostSmoke(car, dt) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading), back = carLength(car)*0.3, side = carWidth(car)*0.4;
  [-1, 1].forEach(end => tyreSmoke({ x: car.x - sin*back + cos*side*end, y: Y_ROAD, z: car.z - cos*back - sin*side*end }, carHeight(car), dt));
}

// ---- legendary and terrible cars (core/traits.js): legendary and terrible cancel out — a car's net level is legendary
// minus terrible, and only that net level ever shows (net 0, however it got there, is an ordinary car). A positive net
// gets a foil or polychrome sheen — a shine drawn by the shader itself (injectCarShader's applyCarHolo), from a
// per-instance strength/kind/seed (see carHoloOf, placeCar), so it shows even on a design with no paintable body. A
// negative net shows rust spots the same way (applyCarRust) and shakes and smokes, both worse the more negative it is.
// Neither steers a car anywhere; they're drawn on top of whatever it's already doing (see placeCar).
const LEGENDARY_SPARKLE_COLOR = 0xfff6c8, FOIL_SPARKLE_COLOR = 0xeaf6ff, LEGENDARY_SPARKLE_EVERY = 0.4; // (a net-1 glint's colour, a net-2 one's, and seconds between glints per net level)
const TERRIBLE_RUST = new THREE.Color(0x2a1208); // the spots a terrible car's paint shows through, see applyCarRust — dark enough to read against most colours
const TERRIBLE_BUMP_EVERY = 2.5, TERRIBLE_BUMP_RISE = 0.45, TERRIBLE_BUMP_HEIGHT = 0.12, TERRIBLE_BUMP_ROLL = 0.11/6; // (seconds between hops; how long one takes, eased up and down rather than snapping; how high; how far it rocks side to side, in radians)
const DEFAULT_HOLO = [0, 0, 0], DEFAULT_RUST = [0, 0]; // (no sheen, no rust spots — see carHoloOf/carRustOf, placeCar)
/**
 * A legendary or terrible car's own effects this frame, from its net level (legendary minus terrible — see the note
 * above): net > 0 gets a foil or polychrome sheen (car.holo, read by placeCar and drawn by the shader — see carHoloOf)
 * and an occasional sparkle glint; net < 0 gets rust spots (car.rust, likewise shader-drawn — see carRustOf) and a hop
 * on the spot (car.bumpY/car.bumpShake, read by placeCar) every TERRIBLE_BUMP_EVERY seconds, harder the more negative
 * the net, smoking from underneath while it's in the air; net === 0 gets neither, whatever legendary and terrible it
 * actually carries.
 * @param {object} car
 * @param {number} t - seconds since page load
 * @param {number} dt
 * @returns {void}
 */
function updateSpecialTraits(car, t, dt) {
  const net = (car.legendaryCount ?? 0) - (car.terribleCount ?? 0);
  car.holo = net > 0 ? carHoloOf(car, net) : null;
  car.rust = net < 0 ? carRustOf(car, -net) : null;
  if (net > 0) legendarySparkle(car, net, t, dt);
  if (net < 0) terribleBump(car, -net, dt); else { car.bumpY = 0; car.bumpShake = 0; }
}
/** The shader's per-instance holo attribute for a car with a positive net legendary/terrible level (see updateSpecialTraits,
 * placeCar, applyCarHolo): [strength (0.5 at net 1, 1 at net 2, higher still beyond), kind (0 foil glint at net 1,
 * 1 rainbow polychrome at net 2 or more), seed (its own glint phase, so cars don't shimmer in step)]. Cached on the
 * car, since none of it changes. */
function carHoloOf(car, level) {
  return car.holoAttrs ??= [level/2, level >= 2 ? 1 : 0, mulberry32(car.number*911 + 7)()];
}
/** The shader's per-instance rust attribute for a car with a negative net legendary/terrible level (see
 * updateSpecialTraits, placeCar, applyCarRust): [strength (how much the spots show, higher the more negative the net),
 * seed (so two cars' spots don't line up)]. Cached, like carHoloOf. */
function carRustOf(car, level) {
  return car.rustAttrs ??= [Math.min(0.95, 0.35 + level*0.2), mulberry32(car.number*613 + 53)()];
}
/** A sparkle glint somewhere on a net-legendary car, more often the higher its level; a net-2 car's (foil or polychrome
 * alike) is bigger and more brightly tinted than a plain net-1 foil's pale default. */
function legendarySparkle(car, level, t, dt) {
  const polychrome = level >= 2, bigger = level >= 2;
  if ((car.sparkleTimer = (car.sparkleTimer ?? 0) - dt) > 0) return;
  car.sparkleTimer = LEGENDARY_SPARKLE_EVERY/(level*(bigger ? 1.5 : 1));
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const along = (Math.random()*2 - 1)*carLength(car)*0.4, side = (Math.random()*2 - 1)*carWidth(car)*0.4, h = carHeight(car);
  const color = polychrome ? new THREE.Color().setHSL((t*0.35 + car.number*0.13) % 1, 0.9, 0.65)
    : bigger ? FOIL_SPARKLE_COLOR : LEGENDARY_SPARKLE_COLOR;
  sparkleFx({ x: car.x + sin*along + cos*side, y: Y_ROAD + h*(0.35 + Math.random()*0.55), z: car.z + cos*along - sin*side }, color, bigger ? 0.6 : 0.35);
}
/** A net-terrible car's hop this frame (car.bumpY) and side-to-side rock (car.bumpShake, a roll angle about its own
 * length axis, read by placeCar — like a plane rocking its wings on landing, not a lateral slide) — a smooth eased arc
 * rather than a snap, TERRIBLE_BUMP_RISE seconds up and down, harder and a touch quicker the more negative the net —
 * and its smoke from underneath while it's actually off the ground.
 * @param {object} car
 * @param {number} level - how far below zero the net legendary/terrible level is (1 or more)
 * @param {number} dt
 * @returns {void}
 */
function terribleBump(car, level, dt) {
  const cycle = TERRIBLE_BUMP_RISE/(1 + 0.15*(level - 1));
  car.terribleTimer = ((car.terribleTimer ?? 0) + dt) % TERRIBLE_BUMP_EVERY;
  const inAir = car.terribleTimer < cycle, phase = Math.min(1, car.terribleTimer/cycle);
  car.bumpY = inAir ? TERRIBLE_BUMP_HEIGHT*(1 + 0.25*(level - 1))*Math.sin(phase*Math.PI) : 0;
  car.bumpShake = inAir ? TERRIBLE_BUMP_ROLL*(1 + 0.2*(level - 1))*Math.sin(phase*Math.PI*2) : 0;
  if (inAir) terribleSmoke({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), carWidth(car), dt, level, car.heading, car.speed);
}
const BLAST_THROW = 8; // (how fast the blast throws what it kills, units a second)
const STALL_SPEED_SHARE = 0.5; // (of the speed that jolts a car: a car hit at least this fast, but not fast enough to jolt, cuts the engine of the car that hit it)
const STALL_WEIGHT_RATIO = 1.6; // (how many times its own weight the car it hits must be, to cut an engine)
const DETONATION_REACH = 8; // (how far from a car burning out cars and people are blown up, before scaling by size)
const FUSE_TIME = 3, FUSE_SPARK_EVERY = 0.05, FUSE_SPARKS = 5; // (seconds a wrecked car burns before it blows; seconds between its sparks; sparks each time)
/** Set a car burning: after FUSE_TIME it explodes, meanwhile it stays put, sparking and burning (burnFx). */
function lightFuse(car) {
  if (car.fuse != null) return;
  igniteFx({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car));
  car.fuse = FUSE_TIME; car.fuseSparks = 0; car.speed = 0;
  car.stall = 0; car.bumping = false;
}
/**
 * Burn a car's fuse down by `dt`, sparking as it goes, and queue it to explode (wreckedCars — updateTraffic blows them up after
 * its loop) when it's out. Any knock still carrying it goes on moving it and dies away, but it never returns to its road.
 * @param {object} car
 * @param {number} dt
 * @returns {void}
 */
function burnFuse(car, dt) {
  if (car.kick) {
    car.x += car.kick.vx*dt; car.z += car.kick.vz*dt;
    const slowing = Math.exp(-KICK_DECAY*dt);
    car.kick.vx *= slowing; car.kick.vz *= slowing;
    if (Math.hypot(car.kick.vx, car.kick.vz) < 0.05) car.kick = null;
  }
  car.speed = 0;
  runOverPeople(car, { x: 0, z: 0, thrown: true, by: 'player' }); // (anyone who touches it dies, and counts as killed by the player)
  burnFx({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), dt);
  if ((car.fuseSparks -= dt) <= 0) {
    car.fuseSparks = FUSE_SPARK_EVERY;
    sparks({ x: car.x, y: Y_ROAD + carHeight(car)*0.5, z: car.z }, FUSE_SPARKS);
  }
  if ((car.fuse -= dt) <= 0 && !wreckedCars.includes(car)) wreckedCars.push(car);
}
const AIRCRAFT_WEIGHT = 6; // (weight of an aircraft, in the same units as a car's weight trait)
// A car knocked by another is moved by an offset from where its route puts it (car.kick: x, z; the velocity vx, vz still moving
// it; and heading, which it keeps as the knock left it). Once it has stopped, it takes the nearest road (seatKickedCar), turns to
// face the nearest point on it (goal), drives back to it, accelerating as a driven car does from a standstill and boosting after KICK_BOOST_AFTER, then turns to the road's heading. A driven car
// let go off the road does the same (stopDriving). Any car in its way it has to push, as a heavier
// car pushes a lighter one from standing (BUMP_PUSH_POWER); if it can't, it stays where it is, holding still.
const KICK_DECAY = 5, KICK_SETTLED_SPEED = 0.5; // (per second: how fast a knock's speed dies away; the speed it counts as stopped at)
const KICK_TURN_RATE = 4, KICK_FACING_TOLERANCE = 0.3; // (per second; radians it may be off facing its goal while it drives)
const KICK_BOOST_AFTER = 1; // (seconds driving back before its boost comes in)
const turnBetween = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
/**
 * Knock a car `distance` along (dirX, dirZ), gradually (see KICK_DECAY).
 * @param {object} car - the car knocked
 * @param {number} dirX - direction, not necessarily unit length
 * @param {number} dirZ
 * @param {number} distance - how far the knock carries it
 * @returns {void}
 */
function kickCar(car, dirX, dirZ, distance) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || distance <= 0) return;
  const kick = car.kick ??= { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 }, speed = distance*KICK_DECAY/len;
  kick.vx += dirX*speed; kick.vz += dirZ*speed;
  kick.goal = null; kick.seated = false; kick.speed = 0; kick.driving = 0; // (knocked again: it picks the nearest road and faces the way back once it stops)
}
/**
 * The nearest lane to a spot, and the way along it a car facing `heading` would go.
 * @param {number} x
 * @param {number} z
 * @param {number} heading
 * @returns {{li: number, u: number, dir: number}|null} null if there are no lanes
 */
function nearestLaneSpot(x, z, heading) {
  const { lines, grid, CELL } = S.trafficNav;
  let best = null;
  const consider = (li, vi) => {
    const q = lines[li].pts[vi], d = Math.hypot(q.x - x, q.z - z);
    if (!best || d < best.d) best = { li, vi, d };
  };
  const cx = Math.floor(x/CELL), cz = Math.floor(z/CELL);
  for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) (grid.get((cx + ox) + ',' + (cz + oz)) || []).forEach(({ li, vi }) => consider(li, vi));
  if (!best) lines.forEach((nav, li) => nav.pts.forEach((_, vi) => consider(li, vi)));
  if (!best) return null;
  const nav = lines[best.li], last = nav.pts.length - 1, a = nav.pts[Math.max(0, best.vi - 1)], b = nav.pts[Math.min(last, best.vi + 1)];
  let u = nav.cum[best.vi], nearest = best.d, along = { x: b.x - a.x, z: b.z - a.z };
  for (const from of [best.vi - 1, best.vi]) { // (the nearest point may lie along either segment at that vertex)
    if (from < 0 || from >= last) continue;
    const p = nav.pts[from], q = nav.pts[from + 1], sx = q.x - p.x, sz = q.z - p.z;
    const t = Math.max(0, Math.min(1, ((x - p.x)*sx + (z - p.z)*sz)/((sx*sx + sz*sz) || 1))), d = Math.hypot(x - p.x - sx*t, z - p.z - sz*t);
    if (d < nearest) { nearest = d; u = nav.cum[from] + (nav.cum[from + 1] - nav.cum[from])*t; along = { x: sx, z: sz }; }
  }
  return { li: best.li, u, dir: along.x*Math.sin(heading) + along.z*Math.cos(heading) >= 0 ? 1 : -1 };
}
/**
 * Put a car with a knock (car.kick) on the nearest lane to where it really is, keeping it where it is by moving its offset from
 * the route to match.
 * @param {object} car
 * @param {number} realX - where the car is
 * @param {number} realZ
 * @returns {boolean} false if there is no lane to put it on
 */
function seatKickedCar(car, realX, realZ) {
  const k = car.kick, spot = nearestLaneSpot(realX, realZ, k.heading);
  if (!spot) return false;
  if (spot.li !== car.li) car.plan = null;
  carJoinLane(car, spot.li, spot.u, spot.dir);
  const back = CAR_REAR_AXLE*carLength(car), front = routePoint(car, back);
  k.x = realX - (front.x - back*Math.sin(k.heading));
  k.z = realZ - (front.z - back*Math.cos(k.heading));
  k.seated = true;
  return true;
}
/**
 * Whether a knocked car can take a step (sx, sz) back towards its route: any car it would overlap there is pushed away if the
 * car is heavier than it, and if any isn't, it can't.
 * @param {object} car - the knocked car, its route position in x and z
 * @param {number} sx
 * @param {number} sz
 * @returns {boolean}
 */
function canStepBack(car, sx, sz) {
  const at = { ...car, x: car.x + car.kick.x + sx, z: car.z + car.kick.z + sz };
  const weight = car.traits?.weight ?? 1;
  let clear = true;
  forCarsNear(at.x, at.z, carLength(car)*1.5 + 4*S.peopleSize, other => {
    if (other === car || !carsOverlap(at, other)) return;
    const otherWeight = other.traits?.weight ?? 1, dx = other.x - at.x, dz = other.z - at.z;
    if (weight <= otherWeight) { clear = false; return; }
    const push = BUMP_PUSH_POWER*weight/otherWeight;
    if (other === drivenCar) { const d = Math.hypot(dx, dz) || 1; other.x += dx/d*push; other.z += dz/d*push; } else kickCar(other, dx, dz, push);
  });
  return clear;
}
/** Move a knocked car's offset on by `dt`, and drop the knock once it has settled back on its route, facing along it. Returns how it moved, as a velocity { x, z }. */
function stepKick(car, dt) {
  const k = car.kick, slowing = Math.exp(-KICK_DECAY*dt), turnRate = Math.min(1, dt*KICK_TURN_RATE);
  k.x += k.vx*dt; k.z += k.vz*dt;
  k.vx *= slowing; k.vz *= slowing;
  k.blocked = false;
  const motion = { x: k.vx, z: k.vz, thrown: Math.hypot(k.vx, k.vz) >= KICK_SETTLED_SPEED }; // (thrown: still carried by the knock)
  if (Math.hypot(k.vx, k.vz) < KICK_SETTLED_SPEED) {
    if (!k.seated && !seatKickedCar(car, car.x + k.x, car.z + k.z)) { car.kick = null; return motion; }
    const away = Math.hypot(k.x, k.z);
    if (away > 0.02) {
      k.goal ??= Math.atan2(-k.x, -k.z); // (fixed, so it doesn't swing about as it goes)
      const off = turnBetween(k.goal - k.heading);
      k.heading += off*turnRate;
      if (Math.abs(off) < KICK_FACING_TOLERANCE) {
        const boosting = (k.driving += dt) >= KICK_BOOST_AFTER, boost = boosting ? DRIVE_BOOST*(car.traits?.boost ?? 1) : 1;
        k.speed = Math.min(DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost, k.speed + DRIVE_ACCEL*boost*dt);
        const step = Math.min(away, k.speed*dt), sx = -k.x/away*step, sz = -k.z/away*step;
        if (canStepBack(car, sx, sz)) { k.x += sx; k.z += sz; motion.x += sx/dt; motion.z += sz/dt; if (boosting) boostSmoke(car, dt); } else { k.blocked = true; k.speed = 0; k.driving = 0; }
      } else { k.speed = 0; k.driving = 0; }
    } else {
      const off = turnBetween(lanePoint(car).heading - k.heading);
      k.heading += off*turnRate;
      if (Math.abs(off) < 0.02 && Math.hypot(k.vx, k.vz) < 0.05) car.kick = null;
    }
  }
  return motion;
}
/**
 * Settle what the driven car has run into. Unless it's going WRECK_SPEED_PER_SLOWDOWN times faster than the slow-down hitting a car
 * costs it (slowdownShare), a car it overlaps is shoved away from it (BUMP_SHOVE of its speed plus BUMP_PUSH_POWER for each unit of
 * its weight, scaled by the distance, so a heavy car pushes one from standing — or, from JOLT_SPEED_PER_SLOWDOWN times, jolted back BUMP_JOLT_SHOVE of
 * its speed at once) and stopped dead, and the driven car goes back to where it was this frame, slowed
 * by that car's weight (slowedBy), with a little smoke where they met. Otherwise it instead sets each car
 * it meets burning (lightFuse), slowed by each one's weight, and carries on through them — but not through one already burning, which is bumped like any other.
 * @param {object} car - the driven car
 * @param {object} was - its position, heading and speed before this frame
 * @returns {void}
 */
function bumpIntoCars(car, was) {
  const reach = carLength(car)*1.5 + 4*S.peopleSize, before = { ...car, ...was }, hitSpeed = Math.abs(car.speed);
  let contact = null, cutsEngine = false;
  forCarsNear(car.x, car.z, reach, other => {
    if (other === car || wreckedCars.includes(other) || !carsOverlap(car, other)) return;
    const d = Math.hypot(other.x - car.x, other.z - car.z), dWas = Math.hypot(other.x - was.x, other.z - was.z);
    if (carsOverlap(before, other) && d >= dWas) return; // (moving off it)
    if (other.fuse == null && Math.abs(car.speed) >= WRECK_SPEED_PER_SLOWDOWN*slowdownShare(car, other.traits?.weight)) { lightFuse(other); impactSound('crash', other, hitSpeed); sparks({ x: (car.x + other.x)/2, y: Y_ROAD + carHeight(car)*0.4, z: (car.z + other.z)/2 }, BUMP_SPARKS); slowedBy(car, 'car', other.traits?.weight); return; }
    const joltSpeed = JOLT_SPEED_PER_SLOWDOWN*slowdownShare(car, other.traits?.weight), jolted = Math.abs(car.speed) >= joltSpeed;
    kickCar(other, other.x - car.x, other.z - car.z, jolted ? Math.abs(car.speed)*BUMP_JOLT_SHOVE : Math.min(1, Math.abs(car.speed)*BUMP_SHOVE + BUMP_PUSH_POWER*(car.traits?.weight ?? 1)));
    other.speed = 0;
    if (!jolted && Math.abs(car.speed) >= STALL_SPEED_SHARE*joltSpeed && (other.traits?.weight ?? 1) > STALL_WEIGHT_RATIO*(car.traits?.weight ?? 1)) cutsEngine = true; // (hit hard enough to hurt the engine, but not to jolt the car, and it's much heavier)
    slowedBy(car, 'car', other.traits?.weight);
    contact = { x: (car.x + other.x)/2, y: Y_ROAD, z: (car.z + other.z)/2 };
  });
  if (!contact) { car.bumping = false; return; }
  Object.assign(car, was);
  if (!car.bumping) { impactSound('crash', contact, hitSpeed); puffSmoke(contact, carHeight(car), BUMP_SMOKE_PUFFS); sparks({ ...contact, y: contact.y + carHeight(car)*0.4 }, BUMP_SPARKS); } // (once, as they meet)
  if (cutsEngine && !car.bumping) car.stall = STALL_TIME;
  car.bumping = true;
}

const CHASE_HOLD = 1500, CHASE_EASE = 0.3, CHASE_PHI = 1.25; // (ms; the share of the way back it's asked for each frame)
/**
 * Ease the camera round behind a driven car and a little above it (CHASE_PHI), unless the mouse has swung it somewhere
 * within the last CHASE_HOLD ms, or the car is standing still.
 * @param {object} car - the driven car
 * @returns {void}
 */
function chaseCamera(car) {
  if (performance.now() - driving.lookedAt < CHASE_HOLD || (Math.abs(car.speed) < 1 && driving.lookedAt > -Infinity)) return;
  const behind = car.speed < -0.5 && controlInput().forward < 0 ? car.heading : car.heading + Math.PI; // (reversing on purpose, it looks back over the boot — but not when it's been thrown back)
  controls.goalTheta = controls.theta + CHASE_EASE*Math.atan2(Math.sin(behind - controls.theta), Math.cos(behind - controls.theta));
  controls.goalPhi = controls.phi + CHASE_EASE*(CHASE_PHI - controls.phi);
}

/**
 * Explode a car where it stands, in its own paint, through explodeCar — and take it out of
 * cars, so a replacement spawns in elsewhere as usual.
 * @param {number} i - index in cars
 * @param {number} [y] - the height it blows up at: the road's, or the water's for a car that's gone under
 * @returns {void}
 */
function killCar(i, y = Y_ROAD) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  App.recordMoralityEvent?.('cars destroyed by player', car.plate ? car.plate.text : undefined);
  if (followedCar === i) stopFollowingCar();
  const paint = new THREE.Color(...(carModelOf(car)?.bodyColor ?? car.paint));
  if (/bus/i.test(carModelOf(car)?.name ?? '')) { // (a bus goes up in two blasts, one at each end)
    const offset = carLength(car)*0.25;
    [-1, 1].forEach(end => explodeCar({ x: car.x + Math.sin(car.heading)*offset*end, y, z: car.z + Math.cos(car.heading)*offset*end }, carHeight(car), { paint }));
  } else explodeCar({ x: car.x, y, z: car.z }, carHeight(car), { paint });
  cars.splice(i, 1);
  if (followedCar > i) followedCar--; // (a car ahead of it in the array, still being followed, keeps its place)
}

/**
 * The car card's Smite button: a bolt of lightning down on the car, and it blows up (killCar).
 * @param {number} i - index in cars
 * @returns {void}
 */
function smiteCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  strikeLightning({ x: car.x, y: Y_ROAD + carHeight(car), z: car.z });
  killCar(i);
}

/**
 * The card's thumbnail: a followed car's design mesh and framing camera, with the paint and plate uniforms set to that
 * car's.
 * @param {number} i - index in cars
 * @returns {object|null} null for a car with no design yet, or while the models are still loading
 */
export function carThumbnailScene(i) {
  const car = cars[i];
  if (!car || car.design == null || !carMeshes[car.design]) return null;
  const cm = carMeshes[car.design];
  cm.thumbPaint.value.setRGB(car.paint[0], car.paint[1], car.paint[2]);
  cm.thumbPlate.value.fromArray(car.plate.packed);
  return { mesh: cm.thumbMesh, camera: cm.thumbCamera };
}

Object.assign(App, { pickCar, followCarAt, followCar, stopFollowingCar, driveCar, stopDriving, killCar, smiteCar, strikeWithAircraft, carsNearby, carsWhere });