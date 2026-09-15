import * as THREE from 'three';
import { S } from '../core/shared.js';
import { scene, computeWindowGlowFactor, SKY_ENV_MAP, Y_ROAD } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder } from '../roads/roads.js';
import { isPathLine, isRiverLine } from '../roads/paths.js';
import { placeKey, signalState } from '../roads/markings.js';
import { isTrainLine } from '../trains/trains.js';
import { PEOPLE_NAV_SPACING, pickWeighted } from './people.js';

// ============================================================ traffic
// Cars, switched on and off with the people (World → People, with speed and size shared too). They drive the sidewalk
// roads — one lane each way, either side of the centerline — turning off at junctions now and then, U-turning at dead
// ends, slowing as they near a junction and keeping their distance from the car in front. The roads only take so many
// (one car per TRAFFIC_LANE_PER_CAR of lane), however many the slider asks for, so they don't gridlock. Like people
// they're instanced meshes sharing one set of instance matrices: body (in a random paint color), windows, wheels, and
// head- and taillights that come on after dark; each car is stretched a little differently, so they aren't all the same.
const TRAFFIC_MAX = 1000;
const CAR_SPEED = 9;               // world units per second at speed 1
const TRAFFIC_LANE_PER_CAR = 16;   // the most cars a road takes: one per this length of lane
const CAR_PAINTS = [[0xe9e9e6, 5], [0x1c1d20, 5], [0xa8adb3, 4], [0x5f646b, 3], [0x233a66, 2], [0x8f1f22, 2], [0x2f5d3a, 1],
  [0xd8b12c, 1], [0xd26a1f, 1], [0x2a8a9a, 1], [0x6b3d7a, 0.5], [0xb8c9d8, 1]]; // [color, how common]
S.trafficAmount = 150, S.trafficNav = null, S.trafficNavBuiltAt = -Infinity, S.lastTrafficTime = null;
const cars = [];
const trafficRng = mulberry32(31337);
// the car, built around its own origin on the ground, facing +Z: about 4.4 long, 1.8 wide and 1.5 tall
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

// The lanes: one per sidewalk road line ({ pts, cum, total, lane (offset from the centerline), vertices with junction
// links }), plus a grid of their points for re-seating cars, and how many cars the roads take.
function buildTrafficNav() {
  const lines = [];
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isPathLine(line) || isRiverLine(line)) return;
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
    cruise: 0.8 + trafficRng()*0.4, length: 0.9 + trafficRng()*0.3, width: 0.95 + trafficRng()*0.12, height: 0.9 + trafficRng()*0.35 };
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
export function updateTraffic(t) {
  const dt = S.lastTrafficTime == null ? 0 : Math.min(0.1, Math.max(0, t - S.lastTrafficTime));
  S.lastTrafficTime = t;
  carParts.all.forEach(mesh => { mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) return;
  if (!S.trafficNav || (S.trafficNavDirty && t - S.trafficNavBuiltAt > 0.25)) {
    S.trafficNavDirty = false;
    S.trafficNavBuiltAt = t;
    S.trafficNav = buildTrafficNav();
    cars.forEach(reseatCar);
  }
  const wanted = Math.min(TRAFFIC_MAX, Math.round(S.trafficAmount), S.trafficNav.capacity);
  while (cars.length < wanted) { const car = newCar(); spawnCar(car); cars.push(car); }
  if (cars.length > wanted) cars.length = wanted;
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
  cars.forEach((car, i) => {
    if (car.li < 0) { matrix.makeScale(0, 0, 0); carParts.body.setMatrixAt(i, matrix); return; }
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
    car.speed += Math.max(-18*S.peopleSpeed*dt, Math.min(5*S.peopleSpeed*dt, target - car.speed));
    driveAlong(car, car.speed*dt);
    // steer towards the lane — quicker when off it, as when swinging round a corner or into the other lane
    const at = lanePoint(car);
    const dx = at.x - car.x, dz = at.z - car.z, d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      const step = Math.max(car.speed, 3*S.peopleSpeed)*dt*(1 + Math.min(3, d*0.3)), k = Math.min(1, step/d), mx = dx*k, mz = dz*k;
      car.x += mx; car.z += mz;
      if (Math.hypot(mx, mz) > 1e-3) {
        const facing = Math.atan2(mx, mz);
        car.heading += Math.atan2(Math.sin(facing - car.heading), Math.cos(facing - car.heading))*Math.min(1, dt*6);
      }
    }
    rotation.setFromAxisAngle(up, car.heading);
    matrix.compose(position.set(car.x, Y_ROAD, car.z), rotation, scale.set(car.width*S.peopleSize, car.height*S.peopleSize, car.length*S.peopleSize));
    carParts.body.setMatrixAt(i, matrix);
  });
  carParts.matrix.needsUpdate = true;
}
