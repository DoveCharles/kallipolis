import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, computeWindowGlowFactor, SKY_ENV_MAP, Y_ROAD } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { hashLicensePlate, hashNameToString, mulberry32 } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder, navRebuildOnHold } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { placeKey, signalState } from '../roads/markings.js';
import { isTrainLine } from '../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted, isPedInDanger } from './people.js';
import { explodeCar } from './giblets.js';
import { carTypeOf } from './car-types.js';
import { driving, controlInput, startDriving, endDriving } from './possession.js';

// ============================================================ traffic
// Cars, switched on and off with the people (World → Peds, with speed and size shared too). They drive the sidewalk
// roads — one lane each way, either side of the centerline — turning off at junctions now and then, U-turning at dead
// ends, slowing as they near a junction and keeping their distance from the car in front. The roads only take so many
// (one car per TRAFFIC_LANE_PER_CAR of lane), however many the slider asks for, so they don't gridlock. Each car is one
// of the models in assets/models/Cars.glb (made in Blender), picked at random and repainted (see "the car models"
// below); until that's loaded, or for however many cars spawn before it has, they're plain boxes instead.
const TRAFFIC_MAX = 1000;
const CAR_SPEED = 9;               // world units per second at speed 1
const TRAFFIC_LANE_PER_CAR = 16;   // the most cars a road takes: one per this length of lane
const PED_YIELD_RADIUS = 10, PED_YIELD_CHANCE = 0.25; // how far ahead a car notices someone waiting in the road, and how often it stops for them
const TURN_SAFE_ANGLE = 0.35; // ~20°: while a car's heading is catching up to the lane by more than this (swinging round a corner or a dead-end U-turn — see driveAlong's junction/end handling), it can't run anyone over, though it's still a normal hazard for a ped's roadsafety check
const CAR_PAINTS = [[0xe9e9e6, 5], [0x1c1d20, 5], [0xa8adb3, 4], [0x5f646b, 3], [0x233a66, 2], [0x8f1f22, 2], [0x2f5d3a, 1],
  [0xd8b12c, 1], [0xd26a1f, 1], [0x2a8a9a, 1], [0x6b3d7a, 0.5], [0xb8c9d8, 1]]; // [color, how common]
S.trafficAmount = 150, S.trafficNav = null, S.trafficNavBuiltAt = -Infinity, S.lastTrafficTime = null;
const cars = [];
let carIds = 0;
const trafficRng = mulberry32(31337);
// Debug wireframe (World → Peds → Roadsafety radius (debug)): a box around each car showing the hitbox runOverPeople
// checks against — off by default, and only kept up to date while the toggle's on.
const carHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), TRAFFIC_MAX);
carHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
carHitboxDebugMesh.count = 0;
carHitboxDebugMesh.frustumCulled = false;
carHitboxDebugMesh.visible = false;
carHitboxDebugMesh.name = 'CarHitboxDebug';
scene.add(carHitboxDebugMesh);
// the box car, built around its own origin on the ground, facing +Z: about 4.4 long, 1.8 wide and 1.5 tall — what a car
// looks like until the models have loaded (or if they never do)
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
    mat.userData.baseEmissiveIntensity = intensity; // lit after dark (see updateWindowGlowForSun)
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
  parts.body.count = TRAFFIC_MAX; // the color buffer is sized by the count when it's first written
  for (let i=0;i<TRAFFIC_MAX;i++) {
    let r = paintRng()*paintTotal, k = 0;
    while (k < CAR_PAINTS.length-1 && (r -= CAR_PAINTS[k][1]) > 0) k++;
    parts.body.setColorAt(i, color.set(CAR_PAINTS[k][0]).multiplyScalar(0.92 + paintRng()*0.16));
  }
  parts.body.count = 0;
  return { ...parts, all: Object.values(parts), matrix };
})();
function pickCarPaint() {
  const total = CAR_PAINTS.reduce((sum, [, weight]) => sum + weight, 0), color = new THREE.Color();
  let r = trafficRng()*total, k = 0;
  while (k < CAR_PAINTS.length-1 && (r -= CAR_PAINTS[k][1]) > 0) k++;
  color.set(CAR_PAINTS[k][0]).multiplyScalar(0.92 + trafficRng()*0.16);
  return [color.r, color.g, color.b];
}

// ---- the car models (assets/models/Cars.glb, made in Blender): each its own mesh (Ambulance, Bus, Taxi…), built of parts
// in different materials, picked at random for each car (see newCar) once they've loaded. A part named CarCol is repainted
// per car, in a random paint color (see pickCarPaint); Lights, Backlights and TaxiLight glow after dark, like the box car's
// headlights and taillights; everything else keeps its own color, as exported. Flat-shaded, like the people and their hair
// — geometry.computeVertexNormals() below is only for the shadows. The models are built with their length along X; if a
// design's wider that way than along Z it's turned a quarter, to face +Z like everything else that drives or walks.
const CARS_MODEL_URL = 'assets/models/Cars.glb';
const CAR_PAINT_MATERIAL = 'CarCol';
const CAR_GLOW_MATERIALS = {
  Lights: { diffuse: 0xfff4d6, emissive: 0xffe3a3, intensity: 1.6 },
  Backlights: { diffuse: 0x7a1010, emissive: 0xff2a1a, intensity: 1.2 },
  TaxiLight: { diffuse: 0x3a2410, emissive: 0xffb347, intensity: 1.5 },
};
const CAR_SLOT_NAMES = [CAR_PAINT_MATERIAL, 'Lights', 'Backlights', 'TaxiLight']; // vertex slot 0 is everything else
let carMeshes = []; // [{ mesh, paint, wheels, glowUniform, wheelRadius, wheelbase, length, height, name, thumbMesh, thumbCamera, thumbPaint }], one per design, once loaded
let designNumbers = []; // how many of each design have been given out so far (see "the car card")

async function loadGLB(url) {
  const buffer = await fetch(url).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  return new GLTFLoader().parseAsync(buffer, '');
}
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
// One merged, indexed geometry per top-level mesh in the model: carSlot says what a vertex is (see CAR_SLOT_NAMES, 0 for
// anything else) and carColor its color when it isn't being repainted or lit up — the part's own material color, as
// Blender shows it, or (for a glowing part) its unlit color. carWheel is, for a wheel's vertices (anything under a child
// object named Wheel…), the middle of that wheel, and 1 for one that only rolls or 2 for one that steers too — the
// front ones (at +Z), unless the design names its steering wheels WheelSteer… — and all zeros for anything else (see
// injectCarShader, which turns them, and turnWheels).
function buildCarDesigns(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3(), v = new THREE.Vector3(), baseColor = new THREE.Color();
  const designs = [];
  gltf.scene.children.forEach(node => {
    const parts = [];
    node.traverse(o => { if (o.isMesh) parts.push(o); });
    if (!parts.length) return;
    const positions = [], slots = [], colors = [], indices = [], wheelIds = [], wheels = [];
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
      const first = positions.length/3;
      for (let i=0;i<pos.count;i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld);
        positions.push(v.x, v.y, v.z);
        slots.push(slot);
        colors.push(baseColor.r, baseColor.g, baseColor.b);
        wheelIds.push(wheelId);
      }
      const index = geo.index, corners = index ? index.count : pos.count;
      for (let t=0;t<corners;t++) indices.push(first + (index ? index.getX(t) : t));
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    box.copy(geometry.boundingBox);
    box.getSize(size);
    // the model faces along the longer of X and Z; turn it a quarter if that's X, so it faces +Z like everything else
    if (size.x > size.z) { geometry.rotateY(-Math.PI/2); geometry.computeBoundingBox(); box.copy(geometry.boundingBox); box.getSize(size); }
    box.getCenter(center);
    geometry.translate(-center.x, -box.min.y, -center.z); // centered, and sat on the ground
    geometry.setAttribute('carSlot', new THREE.Float32BufferAttribute(slots, 1));
    geometry.setAttribute('carColor', new THREE.Float32BufferAttribute(colors, 3));
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
    designs.push({ name: node.name, geometry, length: size.z/BOX_CAR_LENGTH, width: size.x, height: size.y, radius: geometry.boundingSphere.radius, wheelRadius, wheelbase });
  });
  gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material) o.material.dispose(); } });
  return designs;
}
// Adds a car design's coloring to its material's shader: vCarColor, per vertex, its instance's paint (instanceCarPaint) if
// it's slot 1 (CarCol) or its own baked color otherwise; vCarEmissive, added to what it emits, for the glowing slots — lit
// after dark, like the box car's lights (see carGlowFactor, kept in sync with computeWindowGlowFactor in updateTraffic).
// And its wheels (see carWheel in buildCarDesigns) turned about their middles: rolled by instanceCarWheel.x, and the
// steering ones steered by instanceCarWheel.y (see turnWheels) — normals too, though only the shadows use them.
// `paintUniform`, for the card's thumbnail (see makeCarThumbnail): one car at a time, drawn plainly (not instanced), so its
// paint is a uniform set before each draw rather than an attribute varying per instance (and its wheels sit still).
function injectCarShader(shader, glowUniform, paintUniform) {
  shader.uniforms.carGlowFactor = glowUniform;
  if (paintUniform) shader.uniforms.instanceCarPaint = paintUniform;
  if (paintUniform) shader.uniforms.instanceCarWheel = { value: new THREE.Vector2() };
  const paintDecl = paintUniform ? 'uniform vec3 instanceCarPaint;\nuniform vec2 instanceCarWheel;' : 'attribute vec3 instanceCarPaint;\nattribute vec2 instanceCarWheel;';
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
    .replace('#include <common>', '#include <common>\nattribute float carSlot;\nattribute vec3 carColor;\n' + paintDecl + wheelTurn + '\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = carWheelTurn(objectNormal);')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = carWheelTurn(transformed - carWheel.xyz) + carWheel.xyz;
      vCarColor = carSlot > 0.5 && carSlot < 1.5 ? instanceCarPaint : carColor;
      vCarEmissive = ${CAR_SLOT_NAMES.slice(1).map((name, k) => glowTerm(name, k + 2)).join('\n        ')}vec3(0.0);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\nuniform float carGlowFactor;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vCarColor;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCarEmissive*carGlowFactor;');
}
// The card's thumbnail: the design's own mesh, plainly drawn (not instanced — see injectCarShader), from an isometric
// camera sized and aimed to fit it (see carThumbnailScene, which sets thumbPaint to whichever car's being shown).
function makeCarThumbnail(design) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, envMap: SKY_ENV_MAP, envMapIntensity: 0.8, flatShading: true });
  const glowUniform = { value: 1 }, paintUniform = { value: new THREE.Color(0xffffff) };
  material.onBeforeCompile = shader => injectCarShader(shader, glowUniform, paintUniform);
  material.customProgramCacheKey = () => 'car-thumb';
  const mesh = new THREE.Mesh(design.geometry, material);
  const r = design.radius, elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = r*4;
  const thumbCamera = new THREE.OrthographicCamera(-r*1.15, r*1.15, r*1.15, -r*1.15, 0.1, distance*2);
  thumbCamera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  thumbCamera.up.set(0, 1, 0);
  thumbCamera.lookAt(0, design.height*0.5, 0);
  return { mesh, camera: thumbCamera, paint: paintUniform };
}
function makeCarMesh(design) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, envMap: SKY_ENV_MAP, envMapIntensity: 0.8, flatShading: true });
  const glowUniform = { value: 1 };
  material.onBeforeCompile = shader => injectCarShader(shader, glowUniform, null);
  material.customProgramCacheKey = () => 'car';
  const mesh = new THREE.InstancedMesh(design.geometry, material, TRAFFIC_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const paint = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*3), 3);
  paint.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarPaint', paint);
  const wheels = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*2), 2);
  wheels.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarWheel', wheels);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.name = 'Traffic';
  scene.add(mesh);
  const thumb = makeCarThumbnail(design);
  return { mesh, paint, wheels, glowUniform, length: design.length, width: design.width, height: design.height,
    wheelRadius: design.wheelRadius, wheelbase: design.wheelbase,
    name: design.name,
    thumbMesh: thumb.mesh, thumbCamera: thumb.camera, thumbPaint: thumb.paint };
}

// The lanes: one per sidewalk road line ({ pts, cum, total, lane (offset from the centerline), loop (whether it ends
// where it started, so cars carry on round rather than turning back), vertices with junction links }), plus a grid of
// their points for re-seating cars, and how many cars the roads take.
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
function newCar() {
  return { id: ++carIds, x: 0, z: 0, heading: 0, li: -1, u: 0, dir: 1, seg: 0, speed: 0, ahead: null,
    cruise: 0.8 + trafficRng()*0.4, length: 0.9 + trafficRng()*0.3, width: 0.95 + trafficRng()*0.12, height: 0.9 + trafficRng()*0.35,
    design: null, paint: pickCarPaint(),
    // how far round its wheels have rolled, and how far its steering ones are turned, both in radians (see turnWheels) —
    // and which way it was facing last frame, for how fast it's turning
    wheelSpin: 0, wheelSteer: 0, lastHeading: null,
    // how far the steering's held over, -1 (left) to 1 (right), while it's being driven (see driveByHand)
    steerHeld: 0,
    // someone crossing it's stopped for (see checkYield) — and the last one it rolled its one-in-four chance against, so
    // it doesn't keep re-rolling for the same person every frame while it's still approaching them
    yieldFor: null, yieldChecked: -1, yielded: 0,
    // how long it's stood waiting for another car to get out of its way, how much longer it's given up waiting for any
    // (see waitOrGiveUp), and how long it's waited to turn round at a dead end
    waited: 0, pushing: 0, uTurnWaited: 0,
    // which way it'll go at the next junction, decided on the way up to it (see planTurn), and how long it's waited there
    plan: null, held: 0 };
}
// puts a car in lane `li` at distance u along it, heading `dir`
function carJoinLane(car, li, u, dir) {
  const nav = S.trafficNav.lines[li];
  car.li = li; car.dir = dir; car.u = Math.max(0, Math.min(nav.total, u)); car.turned = null;
  car.seg = 0;
  while (car.seg < nav.pts.length-2 && nav.cum[car.seg+1] <= car.u) car.seg++;
}
// where a car should be: its lane's point at its distance along it, on the side for its direction (smoothed round the
// bends — see laneSmoothed), and which way that lane runs there
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
// the middle of a lane's road about every LANE_SAMPLE along it (its `spacing`), averaged over LANE_SMOOTH lane offsets
// either way along the road, and which way is left there (for a unit lane, square to that): which rounds off the bends,
// so a car turns in a little before one — and, round a sharp one, keeps the inside lane from making a kink (going on
// past the corner, back, then round it), as it would offset from the corners of the road itself
const LANE_SMOOTH = 2.5, LANE_SAMPLE = 0.5;
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
// how far along its lane (the one going `dir`) the point at distance u along the road is — further than u round the
// outside of a bend, and not as far round the inside
function laneLength(nav, dir, u) {
  const sm = laneSmoothed(nav), key = dir > 0 ? 'along' : 'alongBack';
  const at = Math.max(0, Math.min(sm.length-1.001, u/sm.spacing)), k = Math.floor(at);
  return sm[k][key] + (sm[k+1][key] - sm[k][key])*(at - k);
}
// the lane's point at distance u along it, going `dir`
function lanePointAt(li, u, dir) {
  const spot = {};
  carJoinLane(spot, li, u, dir);
  return lanePoint(spot);
}

// ---- a car's route: the path its front axle follows — along its lane, round in a curve where it turns off onto another
// (planned — see planTurn — or just taken) and in a U at a dead end, rather than jumping across as its lane point does
const TURN_CURVE = 2.5;
const ROUTE_SAMPLE = 0.25; // how far along the road to look for how much further its route goes (see updateTraffic) // how far either side of a junction a turn's curve takes, in lane offsets
// the point on a car's route `ahead` further on from its lane point (following its plan through the junction ahead)
function routePoint(car, ahead) {
  const probe = { li: car.li, u: car.u, seg: car.seg, dir: car.dir, plan: car.plan, turned: car.turned, probe: true };
  if (ahead > 0) driveAlong(probe, ahead);
  const nav = S.trafficNav.lines[probe.li];
  // turning round at a dead end: a U, as wide as the lane's offset either side of the middle of the road, and some way
  // back from the end, taken as it comes up to the end and goes back again
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
  // turning off at a junction: coming up to it (with it planned) or just past it
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
// somewhere at random with no other car on it — or, failing a few goes at that, nowhere for now (li -1: out of sight, and
// tried again next frame)
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
// moves a car `dist` along its lane, dealing with each point it passes: at a junction it sometimes turns off (always, at
// the end of its road, if there's another road to take), and at a dead end it turns round into the other lane
function driveAlong(car, dist) {
  let nav = S.trafficNav.lines[car.li], u = car.u + car.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const ahead = car.dir > 0 ? car.seg + 1 : car.seg, at = nav.cum[ahead];
    if (car.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead], isEnd = ahead === 0 || ahead === nav.pts.length-1;
    const plan = planFor(car, ahead) ? car.plan : vertex.links.length && !car.probe ? pickTurn(car.li, ahead, car.dir) : null;
    car.plan = null;
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
// the next junction or dead end ahead of a car, within `lookahead` points: { dist (along its lane), x, z, deadEnd (where
// it'll turn round) } — or null
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
// whether any car — moving or not, since a stopped one can pull away at any moment — is within `radius` of (x, z): the
// "roadsafety radius" a pedestrian checks before crossing (see crossingClear in people.js)
function carsNearby(x, z, radius) {
  return cars.some(car => car.li >= 0 && Math.hypot(car.x - x, car.z - z) < radius);
}
// whether any car is somewhere `test(x, z, car)` says — like carsNearby, for a shape other than a circle (and with the
// car itself, e.g. to leave out one stopped for the pedestrian asking — or neither would ever move again)
function carsWhere(test) {
  return cars.some(car => car.li >= 0 && test(car.x, car.z, car));
}
// notices someone waiting in the middle of the road ahead, ready to cross the rest of the way, and — one time in four —
// decides to stop and let them; once it's committed to stopping for someone it keeps stopping until they're done
// waiting (or gone), rather than re-rolling every frame — or until it's waited long enough, when it drives on, and
// (like anyone a car's stopped for: see updateCrossing in people.js) they can't be hit till they're off the road
const YIELD_GIVE_UP = 8; // (seconds)
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
    }
    if (car === drivenCar) { driveByHand(car, dt); turnWheels(car, dt); placeCar(car, i, designCounts); return; }
    // cruise, but ease off for the car in front and slow down into junctions
    const cruise = CAR_SPEED*car.cruise*S.peopleSpeed;
    let target = cruise;
    if (car.ahead) {
      // (along its lane, not the road, which a car goes round quicker on the inside of a bend — see updateTraffic)
      const nav = S.trafficNav.lines[car.li], along = (laneLength(nav, car.dir, car.ahead.u) - laneLength(nav, car.dir, car.u))*car.dir;
      const gap = (along < 0 ? along + laneLength(nav, car.dir, nav.total) : along) - 2.2*S.peopleSize*(car.length + car.ahead.length); // (round a loop)
      target = Math.min(target, Math.max(0, (gap - 2*S.peopleSize)*1.2*S.peopleSpeed));
    }
    // (and for any other car in its way, whatever lane it's in — see "keeping clear of other cars")
    const block = gapAhead(car);
    if (block.gap < Infinity) target = Math.min(target, Math.max(0, (block.gap - CAR_STOP_GAP*S.peopleSize)*1.2*S.peopleSpeed));
    waitOrGiveUp(car, block.by, dt);
    const ahead = junctionAhead(car, 8);
    // (and, coming up to a dead end, short of it while there's a car where it'd come round into the other lane — for a
    // while, since that car could be queued up behind this one's lane)
    const uTurnWait = ahead && ahead.deadEnd && ahead.dist < 12*S.peopleSize && uTurnBlocked(car);
    car.uTurnWaited = uTurnWait ? car.uTurnWaited + (car.speed < 0.3 ? dt : 0) : 0;
    if (uTurnWait && car.uTurnWaited < GIVE_UP_AFTER*2) {
      target = Math.min(target, Math.max(0, (ahead.dist - carFootprint(car).length*0.5)*1.5*S.peopleSpeed));
    }
    if (ahead && ahead.dist < 10) target = Math.min(target, cruise*(0.45 + 0.055*ahead.dist));
    // stop for a red light — or an amber one there's still room to stop for — with the front bumper at the stop line
    const junction = ahead && S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
    const stopAt = junction ? junction.r + 3.2 + 2.2*car.length*S.peopleSize : carFootprint(car).length*0.5 + S.peopleSize;
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
    car.speed += Math.max(-CAR_BRAKE*S.peopleSpeed*dt, Math.min(5*S.peopleSpeed*dt, target - car.speed));
    // (its lane point moves along the middle of the road, but its route is longer round the outside of a bend, a U or a
    // turn across a junction, and shorter round the inside — so it goes as much further along as keeps it at its speed)
    const back = CAR_REAR_AXLE*carFootprint(car).length;
    let travel = car.speed*dt;
    if (travel > 0) {
      const here = routePoint(car, back), on = routePoint(car, back + ROUTE_SAMPLE);
      const moved = Math.hypot(on.x - here.x, on.z - here.z);
      if (moved > 1e-6) travel *= Math.max(0.25, Math.min(4, ROUTE_SAMPLE/moved));
    }
    driveAlong(car, travel);
    // its front axle keeps to its route (see routePoint), and its back axle — pulled along behind it, as a real car's is —
    // cuts in round the bends
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
    cm.glowUniform.value = glowFactor;
  });
  // the camera onto whoever it's following, at about their roof — and driving it, round behind it
  if (followedCar >= 0) { const car = cars[followedCar]; controls.goalTarget.set(car.x, Y_ROAD + carHeight(car)*(drivenCar ? 1.1 : 0.6), car.z); }
  if (drivenCar) chaseCamera(drivenCar);
}
// Rolls a car's wheels as far as it's gone, and steers its steering ones as sharply as it's turning: for the one being
// driven, the way the steering's held (so they turn standing still, too); for the rest, as sharply as a car with its
// wheelbase would have to steer to turn as fast as it is. Eased toward, so a jolt (being re-seated, say) doesn't flick them.
const WHEEL_STEER_MAX = 0.6; // (radians)
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
// puts car i's model (or box) where it is — counted among its design's in designCounts — and its debug hitbox
const placing = { matrix: new THREE.Matrix4(), rotation: new THREE.Quaternion(), scale: new THREE.Vector3(), position: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
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

// ---- following a car with the camera: exactly as for a person (see "following someone" in people.js) — a click on one in
// World mode keeps the view on it, with a card (car-card.js) naming it, its mood, and what it loves and hates (all from
// assets/cars.txt, by its type — see car-types.js) — until a click elsewhere, a pan, leaving World mode, or it despawning lets it go
let followedCar = -1;
function carHeight(car) { return (car.design != null && carMeshes[car.design] ? carMeshes[car.design].height : car.height)*S.peopleSize; }
// a car's own length and width, in world units — its design's, or (until that's loaded) the box car's own
function carFootprint(car) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  return cm
    ? { length: cm.length*BOX_CAR_LENGTH*S.peopleSize, width: cm.width*S.peopleSize }
    : { length: car.length*BOX_CAR_LENGTH*S.peopleSize, width: car.width*BOX_CAR_WIDTH*S.peopleSize };
}
// Turns a car by `by` radians about its rear axle, as a real one turns, rather than its middle (where car.x/z is) — so
// its back end follows it round instead of sliding out sideways. The axle's taken as this far back along its length.
const CAR_REAR_AXLE = 0.3;
function turnCar(car, by) {
  const back = CAR_REAR_AXLE*carFootprint(car).length, heading = car.heading + by;
  car.x += back*(Math.sin(heading) - Math.sin(car.heading));
  car.z += back*(Math.cos(heading) - Math.cos(car.heading));
  car.heading = heading;
}
// People wander into the road more readily than they dodge traffic (see people.js) — and the cars don't slow for them,
// so anyone out crossing the road who's caught under one when it's moving gets run over: killed exactly as the person
// card's Kill button does (see killPerson in people.js), blood and all, rather than anything of the car's own. Anyone
// else — on a sidewalk, or still at the curb — is never hit, even if a car's hitbox reaches them.
// the hitbox a car runs people over with: its footprint and a little margin, shrunk to CAR_HITBOX_SCALE of that — as half
// its length and width
const CAR_HITBOX_SCALE = 0.6;
function carHitbox(car) {
  const { length, width } = carFootprint(car);
  return { halfLength: (length*0.5 + 0.25)*CAR_HITBOX_SCALE, halfWidth: (width*0.5 + 0.25)*CAR_HITBOX_SCALE };
}
// (the car you're driving hits anyone, wherever they are — sidewalks and parks included — at about the car's height)
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
// the car under a point on the screen (the nearest, if several are), or -1 — exactly like pickPerson in people.js, but
// along the line up the middle of the car's height rather than a walking person's
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
// follows whichever car's under a point on the screen, or stops following if none is
function followCarAt(clientX, clientY) {
  const i = pickCar(clientX, clientY);
  if (i < 0) { stopFollowingCar(); return; }
  followedCar = i;
  const h = carHeight(cars[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9));
  const car = cars[i], cm = car.design != null ? carMeshes[car.design] : null;
  const type = cm ? carTypeOf(cm.name, car.number) : carTypeOf(null);
  const carMakeNumber = cm ? `${type.name} #${car.number}` : type.name;
  let forceRegion;
  switch (type.name?.trim().toLowerCase()) {
    case 'bus':
    case 'ambulance':
    case 'police car':
    case 'taxi':
      forceRegion = 0;
      break;
    default:
      forceRegion = undefined;
  }
  const name = cm ? 
    `${hashLicensePlate(carMakeNumber, forceRegion)} (${carMakeNumber})`
    : carMakeNumber;
  App.showCarCard(i, { ...type, name: name });
}
function stopFollowingCar() {
  if (followedCar < 0) return;
  stopDriving();
  followedCar = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hideCarCard();
}

// ---- not filling up dead ends: a road with a dead end only takes so many cars — or, with its lane back full of cars
// waiting to get out, the ones turning round at the end would have nowhere to go, and the ones behind them would back up
// into the junction, where the ones waiting to get out are headed. So each car decides which way it'll go at a junction
// on the way up to it (going some other way if the road it picked is full), and waits at the stop line while the road
// it's going onto is still full — not in the middle of the junction.
const CAR_SLOT = 7; // how much lane a car stopped in a queue takes up (at size 1)
const stretchCounts = [];
const stretchOf = (li, seg) => S.trafficNav.lines[li].stretchOf[Math.max(0, Math.min(S.trafficNav.lines[li].pts.length-2, seg))];
// how many cars a stretch takes: its two lanes' worth, less the junctions at its ends and one space to turn round in
function stretchRoom(si) {
  const st = S.trafficNav.stretches[si];
  if (st === undefined || st.deadEnd) return Infinity;
  const nav = S.trafficNav.lines[st.li];
  const junctionAt = v => S.roadJunctionByPlace.get(placeKey(nav.pts[v].x, nav.pts[v].z))?.r || 0;
  const usable = st.length - junctionAt(st.from) - junctionAt(st.to);
  return Math.max(1, Math.floor(usable*2/(CAR_SLOT*S.peopleSize)) - 1);
}
const stretchFull = si => stretchCounts[si] >= stretchRoom(si);
// the ways a car on line li heading dir can go at vertex vi: { link (null: straight on), dir, stretch }
function turnOptions(li, vi, dir) {
  const nav = S.trafficNav.lines[li], options = [];
  nav.vertices[vi].links.forEach(link => {
    const other = S.trafficNav.lines[link.li], last = other.pts.length-1;
    (link.vi === 0 ? [1] : link.vi === last ? [-1] : [1, -1]).forEach(d =>
      options.push({ link, dir: d, stretch: stretchOf(link.li, d > 0 ? link.vi : link.vi-1) }));
  });
  const last = nav.pts.length-1, isEnd = vi === 0 || vi === last;
  if (isEnd && !nav.loop) return { options, straight: null };
  // (round a loop, straight on from its end is on from its start, and the other way)
  const seg = dir > 0 ? (vi === last ? 0 : vi) : (vi === 0 ? last-1 : vi-1);
  return { options, straight: { link: null, dir, stretch: stretchOf(li, seg) } };
}
// which way to go, at random: at the end of a road onto another one, otherwise now and then off onto another one
function pickTurn(li, vi, dir) {
  const { options, straight } = turnOptions(li, vi, dir);
  const turn = options.length && (!straight || trafficRng() < 0.35);
  return { li, vi, from: dir, ...(turn ? options[Math.floor(trafficRng()*options.length)] : straight) };
}
// picks which way a car goes at the junction ahead, if it hasn't yet — and whether it has to wait for room there
function waitToTurn(car, ahead, dt) {
  if (!planFor(car, ahead.vi)) { car.plan = planTurn(car, ahead.vi); car.held = 0; }
  if (!stretchFull(car.plan.stretch) || stretchOf(car.li, car.seg) === car.plan.stretch) { car.held = 0; return false; }
  car.held += dt;
  if (car.held > GIVE_UP_AFTER) { car.plan = planTurn(car, ahead.vi); car.held = 0; } // (maybe there's room some other way now)
  return true;
}
// whether the car's plan is for the vertex vi it's coming up to
const planFor = (car, vi) => car.plan && car.plan.li === car.li && car.plan.vi === vi && car.plan.from === car.dir;
function planTurn(car, vi) {
  const { options, straight } = turnOptions(car.li, vi, car.dir);
  const picked = pickTurn(car.li, vi, car.dir);
  if (!stretchFull(picked.stretch)) return picked;
  const free = [...options, ...(straight ? [straight] : [])].filter(o => !stretchFull(o.stretch));
  return free.length ? { li: car.li, vi, from: car.dir, ...free[Math.floor(trafficRng()*free.length)] } : picked;
}

// ---- keeping clear of other cars: each one watches a strip of road ahead of it, as wide as it is and as long as it needs
// to stop in, and eases off for the nearest car with any of its footprint in there — in its lane or not (turning in
// across it at a junction, coming round from a dead end, or the one being driven) — besides the one in front in its own
// lane (its `ahead`, which it keeps sight of round bends where the strip would lose it). Cars coming the other way in
// the other lane are left out — but not one swinging across into its lane to turn off, nor the one being driven, which
// could be anywhere. Two cars each in the other's strip (meeting at an angle in a junction) would both wait
// for ever, so one of them goes first: the one nearer where their paths cross (already across the other's, most likely)
// — or, side by side, the older one.
const CAR_STOP_GAP = 1.5;  // how far short of the car in front one stops (at size 1)
const CAR_BRAKE = 30;      // the hardest a car brakes, per second
const LANE_OVERLAP = 1;    // how much of the two cars' widths has to overlap for one to count as in the other's way
const CAR_GRID_CELL = 12;
const carGrid = new Map();
const cellKey = (cx, cz) => cx + ',' + cz;
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
function forCarsNear(x, z, radius, fn) {
  const reach = Math.ceil(radius/CAR_GRID_CELL), cx = Math.floor(x/CAR_GRID_CELL), cz = Math.floor(z/CAR_GRID_CELL);
  for (let ox=-reach;ox<=reach;ox++) for (let oz=-reach;oz<=reach;oz++) (carGrid.get(cellKey(cx+ox, cz+oz)) || []).forEach(fn);
}
// how far ahead a car looks: its stopping distance, and some
const senseRange = car => carFootprint(car).length*0.5 + 6*S.peopleSize + Math.max(0, car.speed)*1.2;
// how far `car` can go before its front bumper reaches `other` — Infinity if other's not in its way
function gapTo(car, other, range) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading), dx = other.x - car.x, dz = other.z - car.z;
  const forward = dx*sin + dz*cos;
  if (forward <= 0 || forward > range) return Infinity;
  const turn = other.heading - car.heading, left = dx*cos - dz*sin; // (how far off to its left other is)
  if (other !== drivenCar && car !== drivenCar && inOncomingLane(car, other, turn)) return Infinity;
  const a = carFootprint(car), b = carFootprint(other), c = Math.abs(Math.cos(turn)), s = Math.abs(Math.sin(turn));
  // (other's footprint, as seen along and across car's heading)
  const across = c*b.width*0.5 + s*b.length*0.5, along = c*b.length*0.5 + s*b.width*0.5;
  if (Math.abs(left) > (a.width*0.5 + across)*LANE_OVERLAP) return Infinity;
  return forward - a.length*0.5 - along;
}
// whether `other` is coming the other way in the other lane: on the same road, going the other way, with neither of
// them crossing over (see keepingToLane) — or, on another road, going by where their lanes have them, rather than where
// they are (turned by `turn` from car), since halfway round a corner a car's pointing across both lanes of the road it's
// turning into
function inOncomingLane(car, other, turn) {
  if (other.li === car.li) return other.dir !== car.dir && keepingToLane(car) && keepingToLane(other);
  if (Math.cos(turn) >= -0.3) return false;
  const a = lanePoint(car), b = lanePoint(other), sin = Math.sin(a.heading), cos = Math.cos(a.heading);
  const lane = S.trafficNav.lines[car.li].lane;
  return Math.cos(b.heading - a.heading) < -0.7 && (b.x - a.x)*cos - (b.z - a.z)*sin > lane;
}
// whether a car's just keeping to its lane — not about to turn off at the junction ahead (across the other lane,
// maybe), or turning round at a dead end
function keepingToLane(car) {
  const nav = S.trafficNav.lines[car.li], near = TURN_CURVE*nav.lane + carFootprint(car).length, plan = car.plan;
  if (plan && plan.link && plan.li === car.li && plan.from === car.dir && Math.abs(nav.cum[plan.vi] - car.u) < near) return false;
  const deadEnd = vi => !nav.loop && !nav.vertices[vi].links.length;
  return !(deadEnd(0) && car.u < near) && !(deadEnd(nav.pts.length-1) && nav.total - car.u < near);
}
// the nearest car in its way and the gap to it: { gap (Infinity if none), by }
function gapAhead(car) {
  const range = senseRange(car);
  let best = Infinity, by = null;
  forCarsNear(car.x, car.z, range, other => {
    if (other === car || other.ahead === car) return; // (the one behind it in its lane never is, whichever way it's turned)
    if (car.pushing > 0 && other !== drivenCar && other !== car.ahead && Math.abs(other.speed) < 0.3) return;
    const gap = gapTo(car, other, range);
    if (gap >= best) return;
    if (other !== drivenCar && gapTo(other, car, senseRange(other)) < Infinity && goesFirst(car, other)) return;
    best = gap; by = other;
  });
  return { gap: best, by };
}
// Three or more cars can each be waiting on the next (round a junction, say) with none of them ever going, so a car
// that's stood still a while for one that's standing still too — other than the one in front in its lane, or the one
// being driven — gives up waiting and pushes on for a moment, past any car that's standing still. (Each gives up after
// a slightly different wait, so one gets going before the rest.)
const GIVE_UP_AFTER = 2.5, PUSH_FOR = 3; // (seconds)
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
// of two cars each in the other's way, whether `car` is the one to go
function goesFirst(car, other) {
  const sa = Math.sin(car.heading), ca = Math.cos(car.heading), sb = Math.sin(other.heading), cb = Math.cos(other.heading);
  const det = sb*ca - sa*cb, px = other.x - car.x, pz = other.z - car.z;
  if (Math.abs(det) < 0.3) return car.id < other.id;
  // (how far each is from where their paths cross)
  const tCar = (sb*pz - cb*px)/det, tOther = (sa*pz - ca*px)/det;
  return Math.abs(tCar) !== Math.abs(tOther) ? Math.abs(tCar) < Math.abs(tOther) : car.id < other.id;
}
// whether a car coming up to a dead end has somewhere to turn round into: no car at that end of its lane going the other way
function uTurnBlocked(car) {
  const nav = S.trafficNav.lines[car.li], end = car.dir > 0 ? nav.total : 0, length = carFootprint(car).length;
  return cars.some(other => other !== car && other !== drivenCar && other.li === car.li && other.dir === -car.dir
    && Math.abs(other.u - end) < (length + carFootprint(other).length)*0.5 + CAR_STOP_GAP*S.peopleSize);
}
// whether a car put at (x, z) would be on top of another
function spotTaken(car, x, z) {
  const length = carFootprint(car).length;
  return cars.some(other => other !== car && other.li >= 0
    && Math.hypot(other.x - x, other.z - z) < (length + carFootprint(other).length)*0.5 + CAR_STOP_GAP*S.peopleSize);
}
// whether two cars' footprints overlap (turned rectangles: overlapping as seen along each one's length and width)
function carsOverlap(a, b) {
  const fa = carFootprint(a), fb = carFootprint(b), dx = b.x - a.x, dz = b.z - a.z;
  const axes = [a.heading, b.heading].flatMap(h => [[Math.sin(h), Math.cos(h)], [Math.cos(h), -Math.sin(h)]]);
  const extent = (f, h, [ax, az]) => {
    const along = Math.abs(Math.sin(h)*ax + Math.cos(h)*az), across = Math.abs(Math.cos(h)*ax - Math.sin(h)*az);
    return along*f.length*0.5 + across*f.width*0.5;
  };
  return axes.every(axis => Math.abs(dx*axis[0] + dz*axis[1]) < extent(fa, a.heading, axis) + extent(fb, b.heading, axis));
}

// ---- driving a car (see possession.js): the one the camera's following, by hand — out of its lane and anywhere at all,
// with the camera swung round behind it. The other cars hold back for it when it's in front of them, and it runs over
// anyone it hits. Let go, it rejoins the nearest lane, facing whichever way along it it's nearest to.
const DRIVE_TOP_SPEED = 20, DRIVE_BOOST = 1.6, DRIVE_REVERSE_SPEED = 7;
const DRIVE_ACCEL = 10, DRIVE_BRAKE = 28, DRIVE_COAST = 4, DRIVE_TURN = 2.2; // per second (the turn in radians)
// how quickly the steering goes over to full lock and back, per second — and the speed at which the car turns half as
// sharply as it would at a crawl (a third as sharply at twice that, and so on), so it doesn't spin round at top speed
const DRIVE_STEER_RATE = 5, DRIVE_TURN_FADE = 12;
let drivenCar = null;
function driveCar(i) {
  const car = cars[i];
  if (i !== followedCar || !car || car.li < 0 || drivenCar === car || !startDriving()) return;
  drivenCar = car;
  car.yieldFor = null;
  controls.goalRadius = Math.max(controls.minRadius, carFootprint(car).length*2.2);
}
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
// this frame's worth of driving, from the keys held (see controlInput)
function driveByHand(car, dt) {
  const { forward, right, run, brake } = controlInput();
  const top = DRIVE_TOP_SPEED*(run ? DRIVE_BOOST : 1);
  const toward = (v, goal, rate) => v + Math.max(-rate*dt, Math.min(rate*dt, goal - v));
  if (brake) car.speed = toward(car.speed, 0, DRIVE_BRAKE);
  else if (forward > 0) car.speed = toward(car.speed, top, car.speed < 0 ? DRIVE_BRAKE : DRIVE_ACCEL*(run ? DRIVE_BOOST : 1));
  else if (forward < 0) car.speed = toward(car.speed, -DRIVE_REVERSE_SPEED, car.speed > 0 ? DRIVE_BRAKE : DRIVE_ACCEL*0.6);
  else car.speed = toward(car.speed, 0, DRIVE_COAST);
  // steering turns it more the faster it's going, up to a walking pace, and less again from there — and the other way
  // round, reversing — eased on and off rather than all at once
  const was = { x: car.x, z: car.z, heading: car.heading };
  car.steerHeld = toward(car.steerHeld, right, DRIVE_STEER_RATE);
  const pace = Math.max(-1, Math.min(1, car.speed/4))/(1 + Math.abs(car.speed)/DRIVE_TURN_FADE);
  turnCar(car, -car.steerHeld*DRIVE_TURN*dt*pace);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  bumpIntoCars(car, was);
  if (Math.abs(car.speed) > 0.3) runOverPeople(car);
}
// Running into another car stops it dead — bouncing back a little, and shoving the other one aside (which steers back
// into its lane after). Already on top of one (one that's pulled into it, say), it can still move off it. At speed,
// though, it ploughs on through, a little slower for each, and blows up whatever it hits — once updateTraffic's done
// going through the cars (see wreckedCars), since that takes them out of the list.
const BUMP_BOUNCE = 0.3, BUMP_SHOVE = 0.15;
const WRECK_SPEED = 14, WRECK_SLOWDOWN = 0.75; // (how fast it has to be going; how much of its speed it keeps per car)
const wreckedCars = [];
function bumpIntoCars(car, was) {
  const reach = carFootprint(car).length*1.5 + 4*S.peopleSize, before = { ...car, ...was };
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
// the camera eased round behind it, a little above — left wherever the mouse has swung it to for a moment after, and for
// as long as the car's standing still
const CHASE_HOLD = 1500, CHASE_EASE = 0.3, CHASE_PHI = 1.25; // (ms; the share of the way back it's asked for each frame)
function chaseCamera(car) {
  if (performance.now() - driving.lookedAt < CHASE_HOLD || (Math.abs(car.speed) < 1 && driving.lookedAt > -Infinity)) return;
  const behind = car.speed < -0.5 ? car.heading : car.heading + Math.PI; // (reversing, it looks back over the boot)
  controls.goalTheta = controls.theta + CHASE_EASE*Math.atan2(Math.sin(behind - controls.theta), Math.cos(behind - controls.theta));
  controls.goalPhi = controls.phi + CHASE_EASE*(CHASE_PHI - controls.phi);
}

// The car card's Kill button: it blows up on the spot, in its own paint, with a scorch mark and a fireball rather than the
// giblets and blood a person leaves (see explodeCar) — and is simply gone, a replacement spawning in elsewhere as usual.
function killCar(i) {
  const car = cars[i];
  if (!car || car.li < 0) return;
  App.recordMoralityEvent?.('cars destroyed by player');
  if (followedCar === i) stopFollowingCar();
  const paint = new THREE.Color(car.paint[0], car.paint[1], car.paint[2]);
  explodeCar({ x: car.x, y: Y_ROAD, z: car.z }, carHeight(car), { paint });
  cars.splice(i, 1);
  if (followedCar > i) followedCar--; // (a car ahead of it in the array, still being followed, keeps its place)
}
// The card's thumbnail: a followed car's design, painted its own color, and the camera that frames it — or null before the
// models have loaded (or for a car that hasn't been given a design yet).
export function carThumbnailScene(i) {
  const car = cars[i];
  if (!car || car.design == null || !carMeshes[car.design]) return null;
  const cm = carMeshes[car.design];
  cm.thumbPaint.value.setRGB(car.paint[0], car.paint[1], car.paint[2]);
  return { mesh: cm.thumbMesh, camera: cm.thumbCamera };
}

Object.assign(App, { pickCar, followCarAt, stopFollowingCar, driveCar, stopDriving, killCar, carsNearby, carsWhere });
