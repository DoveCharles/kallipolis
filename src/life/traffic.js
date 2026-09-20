import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, renderer, computeWindowGlowFactor, SKY_ENV_MAP, Y_ROAD } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { hashLicensePlate, hashNameToNumber, mulberry32 } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder, navRebuildOnHold } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { placeKey, signalState } from '../roads/markings.js';
import { isTrainLine } from '../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted, isPedInDanger } from './people/people.js';
import { explodeCar } from './giblets.js';
import { carTypeOf } from './car-types.js';
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
    let glass = null;
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
    designs.push({ name: node.name, geometry, length: size.z/BOX_CAR_LENGTH, width: size.x, height: size.y, radius: geometry.boundingSphere.radius, wheelRadius, wheelbase,
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
/** Vehicle types that always get a UK-format plate, and never a vanity one. */
const UK_ONLY_TYPES = ['bus', 'ambulance', 'police car', 'taxi'];
/** Vanity registrations, at most nine characters. */
const VANITY_PLATES = ['IM SO BIG','BUCKET','NICE DICK','JEREMY','BOOB HONK','IPOD NANO','YAY CRIME','MINECRAFT',
  'STEVE JOB','KILL YOU','LASTCHANCE','IBUPROFEN','STALKER','SUCK MAMA','MAOZEDONG','JILLSTEIN','HAI COWOC','BREAKTEST',
  'SLEEPYBOY','SPEEDBUMP','ROADHEAD','ELLIPSIS','CATTLEGUN','SHRAPNEL','BIGRAGER','KILLMENOW','POOMOBILE','RESPNSBLE','RESPAWN','BREASTMLK',
  'SAWDUST','UCNTRSTME','ROADRUNNR','PRIORITYS','STINKBUG','SODRUNKRN']
/**
 * A car's registration, from its type's name and its number within that type, packed for its plates (packPlate).
 * A sports car takes a vanity plate 60% of the time, and any other type outside UK_ONLY_TYPES 10% of the time; the rest
 * come from hashLicensePlate, UK-formatted for UK_ONLY_TYPES.
 * @param {object} car
 * @returns {{ text: string, packed: number[] }}
 */
function carPlate(car) {
  const carRNG = mulberry32(hashNameToNumber(carMeshes[car.design].name+ car.number));
  const type = carTypeOf(carMeshes[car.design].name, car.number), name = (type.name || '').trim().toLowerCase();
  const text = ((name === 'sports car' && carRNG() > 0.4) || !UK_ONLY_TYPES.includes(name) && carRNG() > 0.9) ? VANITY_PLATES[Math.round(carRNG()*(VANITY_PLATES.length-1))] :
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
 * @returns {void}
 */
function injectCarShader(shader, glowUniform, paintUniform, plateUniform) {
  shader.uniforms.carGlowFactor = glowUniform;
  shader.uniforms.carPlateAtlas = { value: plateAtlas };
  if (paintUniform) shader.uniforms.instanceCarPaint = paintUniform;
  if (paintUniform) shader.uniforms.instanceCarWheel = { value: new THREE.Vector2() };
  if (plateUniform) shader.uniforms.instanceCarPlate = plateUniform;
  const paintDecl = paintUniform
    ? 'uniform vec3 instanceCarPaint;\nuniform vec2 instanceCarWheel;\nuniform vec4 instanceCarPlate;'
    : 'attribute vec3 instanceCarPaint;\nattribute vec2 instanceCarWheel;\nattribute vec4 instanceCarPlate;';
  const plateDecl = 'varying vec3 vCarPlateUv;\nflat varying vec4 vCarPlate;';
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
    .replace('#include <common>', '#include <common>\nattribute float carSlot;\nattribute vec3 carColor;\nattribute vec3 carPlate;\n' + paintDecl + wheelTurn + '\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\n' + plateDecl)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = carWheelTurn(objectNormal);')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = carWheelTurn(transformed - carWheel.xyz) + carWheel.xyz;
      vCarColor = carSlot > 0.5 && carSlot < 1.5 ? instanceCarPaint : carColor;
      vCarPlateUv = carPlate;
      vCarPlate = instanceCarPlate;
      vCarEmissive = ${CAR_SLOT_NAMES.map((name, k) => CAR_GLOW_MATERIALS[name] ? glowTerm(name, k + 1) : '').join('')}vec3(0.0);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\nuniform float carGlowFactor;\n' + plateDecl + plateColor)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vCarPlateUv.z > 0.5 ? carPlateColor() : vCarColor;')
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
    material.onBeforeCompile = shader => injectCarShader(shader, glowUniform, paintUniform, plateUniform);
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
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.name = 'Traffic';
  scene.add(mesh);
  const thumb = makeCarThumbnail(design);
  return { mesh, paint, wheels, plates, glowUniform, length: design.length, width: design.width, height: design.height,
    wheelRadius: design.wheelRadius, wheelbase: design.wheelbase,
    name: design.name,
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
  for (let tries = 0; tries < 8; tries++) {
    const li = pickWeighted(lines, nav => nav.total);
    carJoinLane(car, li, trafficRng()*lines[li].total, trafficRng() < 0.5 ? -1 : 1);
    const at = lanePoint(car);
    if (spotTaken(car, at.x, at.z)) continue;
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
  car.traits = carTypeOf(carMeshes[car.design].name, car.number).traits;
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
  carParts.all.forEach(mesh => { mesh.visible = S.peopleEnabled; });
  carMeshes.forEach(cm => { cm.mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) return;
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
    if (car === drivenCar) { driveByHand(car, dt); turnWheels(car, dt); placeCar(car, i, designCounts); return; }
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
    if (checkYield(car, dt)) target = 0;
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
    const front = routePoint(car, back);
    const pullX = front.x - (car.x - back*Math.sin(car.heading)), pullZ = front.z - (car.z - back*Math.cos(car.heading));
    if (Math.hypot(pullX, pullZ) > 1e-6) {
      car.heading = Math.atan2(pullX, pullZ);
      car.x = front.x - back*Math.sin(car.heading);
      car.z = front.z - back*Math.cos(car.heading);
    }
    const lane = lanePoint(car), offLane = Math.abs(Math.atan2(Math.sin(lane.heading - car.heading), Math.cos(lane.heading - car.heading)));
    if (car.speed > 0.3 && offLane < TURN_SAFE_ANGLE) runOverPeople(car);
    turnWheels(car, dt);
    placeCar(car, i, designCounts);
  });
  wreckedCars.splice(0).forEach(other => { const i = cars.indexOf(other); if (i >= 0) killCar(i); });
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
/**
 * Put car `i` where it is: at Y_ROAD, turned to its heading and scaled by S.peopleSize. It goes into its design's mesh at
 * the next free instance slot (counted up in designCounts), with its paint, wheel angles and plate packed alongside, or
 * into the box car when it has no design; its place in the other mesh is zeroed either way. Also writes its debug hitbox.
 * @param {object} car
 * @param {number} i - the car's index, for the box car's instance slot
 * @param {number[]} designCounts - one running instance count per design
 * @returns {void}
 */
function placeCar(car, i, designCounts) {
  const { matrix, rotation, scale, position, up } = placing;
  rotation.setFromAxisAngle(up, car.heading);
  position.set(car.x, Y_ROAD, car.z);
  if (car.design != null && carMeshes[car.design]) {
    const cm = carMeshes[car.design], idx = designCounts[car.design]++;
    scale.setScalar(S.peopleSize);
    matrix.compose(position, rotation, scale);
    cm.mesh.setMatrixAt(idx, matrix);
    cm.paint.setXYZ(idx, car.paint[0], car.paint[1], car.paint[2]);
    cm.wheels.setXY(idx, car.wheelSpin, car.wheelSteer);
    cm.plates.setXYZW(idx, ...car.plate.packed);
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
/**
 * The hitbox a car runs people over with: half its length and width, each with a 0.25 margin, scaled by CAR_HITBOX_SCALE —
 * so a car hits someone under its middle rather than at its very corners.
 * @param {object} car
 * @returns {{ halfLength: number, halfWidth: number }}
 */
function carHitbox(car) {
  const length = carLength(car), width = carWidth(car);
  return { halfLength: (length*0.5 + 0.25)*CAR_HITBOX_SCALE, halfWidth: (width*0.5 + 0.25)*CAR_HITBOX_SCALE };
}

/**
 * Kill every pedestrian whose position falls inside carHitbox, turned to the car's heading (killPerson in people.js,
 * crediting the driver). A normal car reaches only someone out on the road, over it or halfway, and never anyone it has
 * waved over; the car being driven reaches anyone within carHeight of Y_ROAD.
 * @param {object} car
 * @returns {void}
 */
function runOverPeople(car) {
  const { halfLength, halfWidth } = carHitbox(car), reach = Math.hypot(halfLength, halfWidth), cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  const driven = car === drivenCar;
  App.people.forEach((p, i) => {
    if (driven ? Math.abs(p.y - Y_ROAD) > carHeight(car) : (!isPedInDanger(p) && p.crossStage !== 'mid') || p.jc?.waved) return; // only while out on the road, over it or halfway (and not waved over)
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out most people before the exact check)
    const right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    if (Math.abs(right) < halfWidth && Math.abs(forward) < halfLength) App.killPerson(i, driven ? 'player' : 'car');
  });
}

/**
 * Kill every pedestrian and car an aircraft is touching: whatever lies within its footprint (a box turned to `heading`)
 * and whose height overlaps the aircraft's. Called each frame by whatever is flying one low enough to matter (see
 * flyByHand in zones/airport.js); anything killed is credited to the player.
 * @param {{x: number, y: number, z: number, heading: number, halfLength: number, halfWidth: number, below: number, above: number}} aircraft
 *   Its middle, its heading, half its length and wingspan, and how far its body reaches below and above `y`.
 * @returns {void}
 */
function strikeWithAircraft({ x, y, z, heading, halfLength, halfWidth, below, above }) {
  const cos = Math.cos(heading), sin = Math.sin(heading), reach = Math.hypot(halfLength, halfWidth);
  const inFootprint = (px, pz) => {
    const dx = px - x, dz = pz - z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return false; // (cheaply rules out most of them before the exact check)
    return Math.abs(dx*cos - dz*sin) < halfWidth && Math.abs(dx*sin + dz*cos) < halfLength;
  };
  const sharesHeight = (base, height) => base < y + above && base + height > y - below;
  App.people.forEach((p, i) => { if (sharesHeight(p.y, p.height*S.peopleSize) && inFootprint(p.x, p.z)) App.killPerson(i, 'player'); });
  for (let i = cars.length - 1; i >= 0; i--) {
    const car = cars[i];
    if (car.li >= 0 && sharesHeight(Y_ROAD, carHeight(car)) && inFootprint(car.x, car.z)) killCar(i);
  }
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
  followedCar = i;
  const h = carHeight(cars[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9));
  const car = cars[i];
  const type = carTypeOf(car.design != null ? carMeshes[car.design].name : null, car.number);
  App.showCarCard(i, { ...type, name: carLabel(car) });
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
  if (i !== followedCar || !car || car.li < 0 || drivenCar === car || !startDriving()) return;
  drivenCar = car;
  car.yieldFor = null;
  controls.goalRadius = Math.max(controls.minRadius, carLength(car)*2.2);
}

/**
 * Put the driven car back in traffic: its speed floored at 0, on the nearest point of any line, in whichever direction
 * along that line its heading most nearly matches — or spawned afresh if the roads are empty.
 * @returns {void}
 */
function stopDriving() {
  if (!drivenCar) return;
  const car = drivenCar;
  drivenCar = null;
  endDriving();
  car.speed = Math.max(0, car.speed);
  // onto the nearest lane
  let best = null;
  S.trafficNav.lines.forEach((nav, li) => nav.pts.forEach((q, vi) => {
    const d = Math.hypot(q.x - car.x, q.z - car.z);
    if (!best || d < best.d) best = { li, vi, d };
  }));
  if (!best) { spawnCar(car); return; }
  const nav = S.trafficNav.lines[best.li], a = nav.pts[Math.max(0, best.vi - 1)], b = nav.pts[Math.min(nav.pts.length - 1, best.vi + 1)];
  carJoinLane(car, best.li, nav.cum[best.vi], (b.x - a.x)*Math.sin(car.heading) + (b.z - a.z)*Math.cos(car.heading) >= 0 ? 1 : -1);
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
  const { forward, right, run, brake } = controlInput();
  // its speed and boost traits scale the top speed and the boost (see cars.txt)
  const boost = run ? DRIVE_BOOST*(car.traits?.boost ?? 1) : 1;
  const top = DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost;
  const braking = DRIVE_BRAKE*(car.traits?.braking ?? 1);
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
  if (Math.abs(car.speed) > 0.3) runOverPeople(car);
}

const BUMP_BOUNCE = 0.3, BUMP_SHOVE = 0.15;
const WRECK_SPEED = 14, WRECK_SLOWDOWN = 0.75; // (how fast it has to be going; how much of its speed it keeps per car)
const wreckedCars = [];
/**
 * Settle what the driven car has run into. At under WRECK_SPEED, a car it overlaps is shoved away from it (BUMP_SHOVE of
 * its speed, scaled by the distance) and stopped dead, and the driven car goes back to where it was this frame with its
 * speed reversed by BUMP_BOUNCE. At WRECK_SPEED or more it instead pushes each car it meets onto wreckedCars, keeping
 * WRECK_SLOWDOWN of its speed per car, and carries on through them — updateTraffic blows them up after its own loop,
 * since killing one takes it out of the cars list.
 * @param {object} car - the driven car
 * @param {object} was - its position, heading and speed before this frame
 * @returns {void}
 */
function bumpIntoCars(car, was) {
  const reach = carLength(car)*1.5 + 4*S.peopleSize, before = { ...car, ...was };
  const wrecking = Math.abs(car.speed) >= WRECK_SPEED;
  let hit = false;
  forCarsNear(car.x, car.z, reach, other => {
    if (other === car || wreckedCars.includes(other) || !carsOverlap(car, other)) return;
    const d = Math.hypot(other.x - car.x, other.z - car.z), dWas = Math.hypot(other.x - was.x, other.z - was.z);
    if (carsOverlap(before, other) && d >= dWas) return; // (moving off it)
    if (wrecking) { wreckedCars.push(other); car.speed *= WRECK_SLOWDOWN; return; }
    const push = Math.min(1, Math.abs(car.speed)*BUMP_SHOVE)/(d || 1);
    other.x += (other.x - car.x)*push; other.z += (other.z - car.z)*push;
    other.speed = 0;
    hit = true;
  });
  if (!hit) return;
  Object.assign(car, was);
  car.speed *= -BUMP_BOUNCE;
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
  const behind = car.speed < -0.5 ? car.heading : car.heading + Math.PI; // (reversing, it looks back over the boot)
  controls.goalTheta = controls.theta + CHASE_EASE*Math.atan2(Math.sin(behind - controls.theta), Math.cos(behind - controls.theta));
  controls.goalPhi = controls.phi + CHASE_EASE*(CHASE_PHI - controls.phi);
}

/**
 * The car card's Kill button: explode the car where it stands, in its own paint, through explodeCar — and take it out of
 * cars, so a replacement spawns in elsewhere as usual.
 * @param {number} i - index in cars
 * @returns {void}
 */
function killCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  App.recordMoralityEvent?.('cars destroyed by player', car.plate ? car.plate.text : undefined);
  if (followedCar === i) stopFollowingCar();
  const paint = new THREE.Color(car.paint[0], car.paint[1], car.paint[2]);
  explodeCar({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), { paint });
  cars.splice(i, 1);
  if (followedCar > i) followedCar--; // (a car ahead of it in the array, still being followed, keeps its place)
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

Object.assign(App, { pickCar, followCarAt, stopFollowingCar, driveCar, stopDriving, killCar, strikeWithAircraft, carsNearby, carsWhere });

