import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, computeWindowGlowFactor, SKY_ENV_MAP, Y_ROAD } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { mulberry32 } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder, navRebuildOnHold } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { placeKey, signalState } from '../roads/markings.js';
import { isTrainLine } from '../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted, isPedInDanger } from './people.js';
import { explodeCar } from './giblets.js';

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
// what a vehicle's proud of being, for its card (see "the car card" below) — a design not listed here gets DEFAULT_CAR_EMOJI
const DESIGN_EMOJI = {
  Ambulance: '🚑', Bus: '🚌', Canyonero: '🚙', Taxi: '🚕', PoliceCar: '🚓',
  PickupTruck: '🛻', SportsCar: '🏎️', Truck: '🚚', Van: '🚐',
};
const DEFAULT_CAR_EMOJI = '🚗';
let carMeshes = []; // [{ mesh, paint, glowUniform, length, height, name, mood, thumbMesh, thumbCamera, thumbPaint }], one per design, once loaded
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
// Blender shows it, or (for a glowing part) its unlit color.
function buildCarDesigns(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3(), v = new THREE.Vector3(), baseColor = new THREE.Color();
  const designs = [];
  gltf.scene.children.forEach(node => {
    const parts = [];
    node.traverse(o => { if (o.isMesh) parts.push(o); });
    if (!parts.length) return;
    const positions = [], slots = [], colors = [], indices = [];
    parts.forEach(part => {
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
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    designs.push({ name: node.name, geometry, length: size.z/BOX_CAR_LENGTH, width: size.x, height: size.y, radius: geometry.boundingSphere.radius });
  });
  gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material) o.material.dispose(); } });
  return designs;
}
// Adds a car design's coloring to its material's shader: vCarColor, per vertex, its instance's paint (instanceCarPaint) if
// it's slot 1 (CarCol) or its own baked color otherwise; vCarEmissive, added to what it emits, for the glowing slots — lit
// after dark, like the box car's lights (see carGlowFactor, kept in sync with computeWindowGlowFactor in updateTraffic).
// `paintUniform`, for the card's thumbnail (see makeCarThumbnail): one car at a time, drawn plainly (not instanced), so its
// paint is a uniform set before each draw rather than an attribute varying per instance.
function injectCarShader(shader, glowUniform, paintUniform) {
  shader.uniforms.carGlowFactor = glowUniform;
  if (paintUniform) shader.uniforms.instanceCarPaint = paintUniform;
  const paintDecl = paintUniform ? 'uniform vec3 instanceCarPaint;' : 'attribute vec3 instanceCarPaint;';
  const glowTerm = (name, slot) => { const g = CAR_GLOW_MATERIALS[name], c = new THREE.Color(g.emissive).multiplyScalar(g.intensity);
    return `carSlot > ${slot - 0.5} && carSlot < ${slot + 0.5} ? vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)}) : `; };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float carSlot;\nattribute vec3 carColor;\n' + paintDecl + '\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
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
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.name = 'Traffic';
  scene.add(mesh);
  const thumb = makeCarThumbnail(design);
  return { mesh, paint, glowUniform, length: design.length, width: design.width, height: design.height,
    name: design.name, mood: DESIGN_EMOJI[design.name] || DEFAULT_CAR_EMOJI,
    thumbMesh: thumb.mesh, thumbCamera: thumb.camera, thumbPaint: thumb.paint };
}

// The lanes: one per sidewalk road line ({ pts, cum, total, lane (offset from the centerline), vertices with junction
// links }), plus a grid of their points for re-seating cars, and how many cars the roads take.
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
    lines.push({ pts, cum, total: cum[cum.length-1], lane: Math.max(0.8, roadLineWidths(line).hw*0.5), vertices: pts.map(() => ({ links: [] })) });
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
  const capacity = Math.floor(lines.reduce((sum, nav) => sum + nav.total*2, 0)/TRAFFIC_LANE_PER_CAR);
  return { lines, grid, CELL, capacity };
}
function newCar() {
  return { x: 0, z: 0, heading: 0, li: -1, u: 0, dir: 1, seg: 0, speed: 0, ahead: null,
    cruise: 0.8 + trafficRng()*0.4, length: 0.9 + trafficRng()*0.3, width: 0.95 + trafficRng()*0.12, height: 0.9 + trafficRng()*0.35,
    design: null, paint: pickCarPaint(),
    // someone crossing it's stopped for (see checkYield) — and the last one it rolled its one-in-four chance against, so
    // it doesn't keep re-rolling for the same person every frame while it's still approaching them
    yieldFor: null, yieldChecked: -1 };
}
// puts a car in lane `li` at distance u along it, heading `dir`
function carJoinLane(car, li, u, dir) {
  const nav = S.trafficNav.lines[li];
  car.li = li; car.dir = dir; car.u = Math.max(0, Math.min(nav.total, u));
  car.seg = 0;
  while (car.seg < nav.pts.length-2 && nav.cum[car.seg+1] <= car.u) car.seg++;
}
// where a car should be: its lane's point at its distance along it, on the side for its direction, and which way that
// lane runs there
function lanePoint(car) {
  const nav = S.trafficNav.lines[car.li];
  const i = Math.max(0, Math.min(nav.pts.length-2, car.seg));
  const a = nav.pts[i], b = nav.pts[i+1], segLen = (nav.cum[i+1] - nav.cum[i]) || 1;
  const t = Math.max(0, Math.min(1, (car.u - nav.cum[i])/segLen));
  const dx = (b.x-a.x)/segLen, dz = (b.z-a.z)/segLen, side = car.dir*nav.lane;
  return { x: a.x + (b.x-a.x)*t - dz*side, z: a.z + (b.z-a.z)*t + dx*side, heading: Math.atan2(dx*car.dir, dz*car.dir) };
}
function spawnCar(car) {
  const { lines } = S.trafficNav;
  if (!lines.length) { car.li = -1; return; }
  const li = pickWeighted(lines, nav => nav.total);
  carJoinLane(car, li, trafficRng()*lines[li].total, trafficRng() < 0.5 ? -1 : 1);
  const at = lanePoint(car);
  car.x = at.x; car.z = at.z; car.heading = at.heading; car.speed = 0;
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
    if (vertex.links.length && trafficRng() < (isEnd ? 1 : 0.35)) {
      const link = vertex.links[Math.floor(trafficRng()*vertex.links.length)], other = S.trafficNav.lines[link.li], remaining = Math.abs(u - at);
      const dir = link.vi === 0 ? 1 : link.vi === other.pts.length-1 ? -1 : (trafficRng() < 0.5 ? 1 : -1);
      carJoinLane(car, link.li, other.cum[link.vi], dir);
      car.seg = dir > 0 ? Math.min(link.vi, other.pts.length-2) : Math.max(link.vi-1, 0);
      nav = other;
      u = car.u + dir*remaining;
      continue;
    }
    if (isEnd) { car.dir = -car.dir; u = 2*at - u; continue; }
    car.seg += car.dir;
  }
  car.u = Math.max(0, Math.min(nav.total, u));
}
// the next junction or dead end ahead of a car, within `lookahead` points: { dist (along its lane), x, z } — or null
function junctionAhead(car, lookahead) {
  const nav = S.trafficNav.lines[car.li];
  let v = car.dir > 0 ? car.seg + 1 : car.seg;
  for (let k=0; k<lookahead && v >= 0 && v < nav.pts.length; k++, v += car.dir) {
    if (nav.vertices[v].links.length || v === 0 || v === nav.pts.length-1) return { dist: Math.abs(nav.cum[v] - car.u), x: nav.pts[v].x, z: nav.pts[v].z };
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
// waiting (or gone), rather than re-rolling every frame
function checkYield(car) {
  if (car.yieldFor != null) {
    const p = App.people[car.yieldFor];
    if (!p || (p.crossStage !== 'mid' && !isPedInDanger(p))) car.yieldFor = null;
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
    cars.forEach(reseatCar);
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
    if (car.li < 0) return;
    const key = car.li*2 + (car.dir > 0 ? 1 : 0);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(car);
  });
  lanes.forEach(list => {
    list.sort((a, b) => (a.u - b.u)*a.dir);
    for (let k=0;k<list.length-1;k++) list[k].ahead = list[k+1];
  });
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const designCounts = carMeshes.map(() => 0);
  cars.forEach((car, i) => {
    if (car.li < 0) { matrix.makeScale(0, 0, 0); carParts.body.setMatrixAt(i, matrix); if (S.showRoadsafetyDebug) carHitboxDebugMesh.setMatrixAt(i, matrix); return; }
    if (car.design == null && carMeshes.length) {
      car.design = Math.floor(trafficRng()*carMeshes.length);
      car.length = carMeshes[car.design].length;
      car.number = ++designNumbers[car.design];
    }
    // cruise, but ease off for the car in front and slow down into junctions
    const cruise = CAR_SPEED*car.cruise*S.peopleSpeed;
    let target = cruise;
    if (car.ahead) {
      const gap = Math.abs(car.ahead.u - car.u) - 2.2*S.peopleSize*(car.length + car.ahead.length);
      target = Math.min(target, Math.max(0, (gap - 2*S.peopleSize)*1.2*S.peopleSpeed));
    }
    const ahead = junctionAhead(car, 8);
    if (ahead && ahead.dist < 10) target = Math.min(target, cruise*(0.45 + 0.055*ahead.dist));
    // stop for a red light — or an amber one there's still room to stop for — with the front bumper at the stop line
    const junction = ahead && S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
    if (junction) {
      const lane = lanePoint(car), tx = Math.sin(lane.heading), tz = Math.cos(lane.heading);
      const arm = junction.arms.reduce((best, a) => -(a.x*tx + a.z*tz) > -(best.x*tx + best.z*tz) ? a : best, junction.arms[0]); // the arm it's coming in on
      const state = signalState(junction, arm.phase, t), stopAt = junction.r + 3.2 + 2.2*car.length*S.peopleSize;
      if (state !== 2 && ahead.dist > stopAt - 0.5 && (state === 0 || ahead.dist > stopAt + 3)) {
        target = Math.min(target, Math.max(0, (ahead.dist - stopAt)*1.5*S.peopleSpeed));
      }
    }
    if (checkYield(car)) target = 0;
    car.speed += Math.max(-18*S.peopleSpeed*dt, Math.min(5*S.peopleSpeed*dt, target - car.speed));
    driveAlong(car, car.speed*dt);
    // steer towards the lane — quicker when off it, as when swinging round a corner or into the other lane
    const at = lanePoint(car);
    const dx = at.x - car.x, dz = at.z - car.z, d = Math.hypot(dx, dz);
    let angleDiff = 0;
    if (d > 1e-4) {
      const step = Math.max(car.speed, 3*S.peopleSpeed)*dt*(1 + Math.min(3, d*0.3)), k = Math.min(1, step/d), mx = dx*k, mz = dz*k;
      car.x += mx; car.z += mz;
      if (Math.hypot(mx, mz) > 1e-3) {
        // (once it's overshot the start of a tight turn's new lane, the lane point is behind it and off to the wrong
        // side — turning to face that would swing it the long way round, so it lines up with the lane instead)
        const toward = Math.atan2(mx, mz), facing = Math.cos(toward - at.heading) < 0 ? at.heading : toward;
        angleDiff = Math.atan2(Math.sin(facing - car.heading), Math.cos(facing - car.heading));
        car.heading += angleDiff*Math.min(1, dt*6);
      }
    }
    if (car.speed > 0.3 && Math.abs(angleDiff) < TURN_SAFE_ANGLE) runOverPeople(car);
    rotation.setFromAxisAngle(up, car.heading);
    position.set(car.x, Y_ROAD, car.z);
    if (car.design != null && carMeshes[car.design]) {
      const cm = carMeshes[car.design], idx = designCounts[car.design]++;
      scale.setScalar(S.peopleSize);
      matrix.compose(position, rotation, scale);
      cm.mesh.setMatrixAt(idx, matrix);
      cm.paint.setXYZ(idx, car.paint[0], car.paint[1], car.paint[2]);
      matrix.makeScale(0, 0, 0);
      carParts.body.setMatrixAt(i, matrix);
    } else {
      scale.set(car.width*S.peopleSize, car.height*S.peopleSize, car.length*S.peopleSize);
      matrix.compose(position, rotation, scale);
      carParts.body.setMatrixAt(i, matrix);
    }
    if (S.showRoadsafetyDebug) {
      const { length: fl, width: fw } = carFootprint(car), h = carHeight(car);
      scale.set(fw + 0.5, h, fl + 0.5);
      matrix.compose(position.setY(Y_ROAD + h*0.5), rotation, scale);
      carHitboxDebugMesh.setMatrixAt(i, matrix);
    }
  });
  carHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) { carHitboxDebugMesh.count = cars.length; carHitboxDebugMesh.instanceMatrix.needsUpdate = true; }
  carParts.matrix.needsUpdate = true;
  const glowFactor = computeWindowGlowFactor(S.sunElevation);
  carMeshes.forEach((cm, d) => {
    cm.mesh.count = designCounts[d];
    cm.mesh.instanceMatrix.needsUpdate = true;
    cm.paint.needsUpdate = true;
    cm.glowUniform.value = glowFactor;
  });
  // the camera onto whoever it's following, at about their roof
  if (followedCar >= 0) { const car = cars[followedCar]; controls.goalTarget.set(car.x, Y_ROAD + carHeight(car)*0.6, car.z); }
}

// ---- following a car with the camera: exactly as for a person (see "following someone" in people.js) — a click on one in
// World mode keeps the view on it, with a card (car-card.js) naming it, its mood (what kind of vehicle it is) and what it
// enjoys and hates — the same for every car — until a click elsewhere, a pan, leaving World mode, or it despawning lets it go
let followedCar = -1;
function carHeight(car) { return (car.design != null && carMeshes[car.design] ? carMeshes[car.design].height : car.height)*S.peopleSize; }
// a car's own length and width, in world units — its design's, or (until that's loaded) the box car's own
function carFootprint(car) {
  const cm = car.design != null ? carMeshes[car.design] : null;
  return cm
    ? { length: cm.length*BOX_CAR_LENGTH*S.peopleSize, width: cm.width*S.peopleSize }
    : { length: car.length*BOX_CAR_LENGTH*S.peopleSize, width: car.width*BOX_CAR_WIDTH*S.peopleSize };
}
// People wander into the road more readily than they dodge traffic (see people.js) — and the cars don't slow for them,
// so anyone caught under one when it's moving gets run over: killed exactly as the person card's Kill button does (see
// killPerson in people.js), blood and all, rather than anything of the car's own.
function runOverPeople(car) {
  const { length, width } = carFootprint(car), reach = length*0.5 + 0.4, cos = Math.cos(car.heading), sin = Math.sin(car.heading);
  App.people.forEach((p, i) => {
    if (p.mode === 'none' || p.mode === 'dead' || p.mode === 'train') return; // (up in a station, or on a train, out of reach)
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return; // (cheaply rules out most people before the exact check)
    const right = dx*cos - dz*sin, forward = dx*sin + dz*cos;
    if (Math.abs(right) < width*0.5 + 0.25 && Math.abs(forward) < length*0.5 + 0.25) App.killPerson(i, 'car');
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
  App.showCarCard(i, cm ? { name: `${cm.name} #${car.number}`, mood: cm.mood } : { name: 'Car', mood: DEFAULT_CAR_EMOJI });
}
function stopFollowingCar() {
  if (followedCar < 0) return;
  followedCar = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hideCarCard();
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

Object.assign(App, { pickCar, followCarAt, stopFollowingCar, killCar, carsNearby, carsWhere });
