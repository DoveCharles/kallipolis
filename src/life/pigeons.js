import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { TOON_RAMP } from '../core/toon.js';
import { blasts } from './traffic/state.js';
import { coo, flutter } from '../audio/pigeons.js';
import { camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { buildingNumber as numberFor } from '../buildings/footprints.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';

// ============================================================ pigeons
// Flocks of pigeons on the plazas and in the parks (assets/models/Pigeon.glb, made in Blender). They walk about near
// where their flock landed, peck at the ground, and stand. Walk past one and it takes off, and the ones next to it go
// after it a moment later, the nearest first. Birds a little further off only hurry out of the way on foot. Birds that
// took off circle round and land together somewhere else in the same plaza or park, away from whoever scared them. Now
// and then a flock moves on by itself, too. An explosion scatters everything in reach of it. After dark they stay put,
// hunched up.
//
// A pigeon can be followed by the camera in World mode, with a card saying which it is (name, mood, loves and hates from
// assets/pigeons.txt, as the bees' are from bees.txt) and what it's up to.
//
// The model is rigged, with five clips (Walk, Peck, Peck2, TakeOff, Fly), and three.js can't instance a rigged mesh. So at
// load each clip is played a frame at a time and the posed bird written out as a morph target, one per frame, all
// relative to one standing pose. A pigeon's pose is then the two frames either side of where it is in its clip, weighed
// against each other (and against the pose it's leaving, for a moment after it changes clip). Every pigeon in a park
// has its own influences on the one instanced mesh (InstancedMesh.setMorphAt), as the bees do (see bees.js).
//
// A plaza's or park's pigeons live in its buildingsGroup and are rebuilt with it. updatePigeons drops the flocks of a
// group that has left the scene.
const PIGEON_MODEL_URL = 'assets/models/Pigeon.glb';
const BAKE_FPS = 24;
const PIGEON_LENGTH = 0.48;       // beak to tail, in world units (people are about one tall): cartoonishly big
const CLIPS = { Walk: { loop: true }, Fly: { loop: true }, Peck: { loop: false }, Peck2: { loop: false }, TakeOff: { loop: false } };
// the file's colors raised to this power as they load: Blender's viewport lights the bird much brighter than the city's
// sun does, and this lifts the darks most, so the grey reads as grey and the eyes stay black
const COLOR_LIFT = 0.7;
// and a few of its materials lightened by this much more, as a share of white on screen
const LIGHTEN = { 'Material.002': 0.1 };
const PECKS = ['Peck', 'Peck2']; // one picked at random each time it pecks
const REST = ['Peck', 0];         // the pose every frame is stored against, and the one a bird stands in

const PLAZA_AREA_PER_PIGEON = 80, PARK_AREA_PER_PIGEON = 200; // square units of ground for each bird
const PIGEONS_MAX = 40;           // in one plaza or park
const FLOCK_MIN = 3, FLOCK_MAX = 9;
const FLOCK_SPREAD = 2;         // how far from the middle of its flock a bird will wander
const WALK_SPEED = 0.36, HURRY_SPEED = 0.95;
const WALK_CYCLE = 0.1;          // how far one Walk cycle takes it: quick little steps
const GROUND_TURN = 7;            // how fast it comes round onto where it's walking
const FADE = 0.12;                // seconds to blend from one clip into the next
const SCARE_MOVING = 1.4, SCARE_STILL = 0.75, SCARE_FLEEING = 2.6; // how near someone gets before a bird takes off
const SHY = 2.2;                  // and how near, times that, before it walks off out of their way
const CASCADE_REACH = 3.2;        // flockmates this near a bird that takes off go after it
const TAKEOFF_TIME = 0.42, LAND_TIME = 0.42;
const FLY_SPEED = 6.4, FLY_TURN = 4.8; // (turning twice as fast as well, so it flies the same curves)
const FLAP = 2;                   // how much faster than the model's clip its wings beat
const CRUISE_MIN = 2.2, CRUISE_MAX = 4.5; // how high above the ground it flies
const LAND_FROM = 1.1;            // how near its landing spot it starts to come down onto it
const FLY_GIVE_UP = 14;           // seconds in the air after which it heads straight in
const HOP_MIN = 70, HOP_MAX = 200;           // seconds between a flock moving on of its own accord
const NIGHT = 0;                  // the sun this low (in degrees) and they roost
const COO_EVERY = 22;             // seconds between one bird's coos, on average
// Where its head can be looking, as [turn, cock] in degrees (left positive): baked as poses of their own and flicked
// between, never swept, the way a bird's head moves (it holds still, then snaps to the next place, like our eyes do).
const HEAD_POSES = [[-55, 0], [-30, 0], [30, 0], [55, 0], [-35, 22], [35, -22], [0, 18], [0, -18]];
const HEAD_SNAP = 0.045;          // seconds a flick of the head takes
const HEAD_HOLD_STAND = [0.25, 1.6], HEAD_HOLD_WALK = [0.15, 0.7]; // seconds it holds each look
const HEAD_AHEAD = 0.35;          // how often the next look is straight ahead again

let model = null; // { geometry, clips: { name: { start, frames, duration, loop } }, heads: first head pose, targets } once loaded
const flocks = []; // { group, mesh, birds, flocks, spot, clear, ground }

// ---------------------------------------------------------- the model
// Every primitive of the rigged bird, posed and flattened into one geometry: positions and normals in the model's own
// space, feet on y = 0, facing +z, scaled to PIGEON_LENGTH. Materials become vertex colors.
function bakePose(meshes, index, weld) {
  const positions = [], V = new THREE.Vector3();
  meshes.forEach(mesh => {
    mesh.skeleton.update();
    const pos = mesh.geometry.attributes.position;
    for (let i=0;i<pos.count;i++) {
      mesh.getVertexPosition(i, V).applyMatrix4(mesh.matrixWorld);
      positions.push(V.x, V.y, V.z);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  smoothNormals(geo, weld);
  return geo;
}

// Normals averaged over every vertex at the same place (the export splits them at each face, material and the mirror
// seam), so the bird shades smooth all over. `weld` gives each vertex the number of its place.
function smoothNormals(geo, weld) {
  const pos = geo.attributes.position.array, idx = geo.index.array, sums = new Float32Array((Math.max(...weld) + 1)*3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i=0;i<idx.length;i+=3) {
    a.fromArray(pos, idx[i]*3); b.fromArray(pos, idx[i + 1]*3); c.fromArray(pos, idx[i + 2]*3);
    c.sub(b); b.sub(a); c.cross(b); // (as long as the face is big: area-weighted)
    for (let j=0;j<3;j++) { const w = weld[idx[i + j]]*3; sums[w] -= c.x; sums[w + 1] -= c.y; sums[w + 2] -= c.z; }
  }
  const normals = new Float32Array(pos.length), n = new THREE.Vector3();
  weld.forEach((w, v) => n.fromArray(sums, w*3).normalize().toArray(normals, v*3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

export async function loadPigeonModel() {
  let gltf;
  try {
    const buffer = await fetch(PIGEON_MODEL_URL).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.arrayBuffer(); });
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch (err) {
    console.warn('Splinetopia: the pigeon model failed to load; plazas and parks go without pigeons', err);
    return;
  }
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  if (!meshes.length) return;
  const index = [], colors = [], weld = [], places = new Map(), V = new THREE.Vector3();
  let first = 0;
  gltf.scene.updateMatrixWorld(true);
  meshes.forEach(mesh => {
    const geo = mesh.geometry, count = geo.attributes.position.count, c = mesh.material.color.clone();
    const more = LIGHTEN[mesh.material.name];
    if (more) c.convertLinearToSRGB().addScalar(more).convertSRGBToLinear();
    for (let i=0;i<count;i++) {
      colors.push(c.r**COLOR_LIFT, c.g**COLOR_LIFT, c.b**COLOR_LIFT);
      V.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.round(V.x*1e4)},${Math.round(V.y*1e4)},${Math.round(V.z*1e4)}`;
      if (!places.has(key)) places.set(key, places.size);
      weld.push(places.get(key));
    }
    if (geo.index) for (let i=0;i<geo.index.count;i++) index.push(first + geo.index.getX(i));
    else for (let i=0;i<count;i++) index.push(first + i);
    first += count;
  });
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const head = gltf.scene.getObjectByName('Head');
  const poseAt = (clip, time, look) => {
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.play();
    mixer.setTime(time);
    gltf.scene.updateMatrixWorld(true);
    if (look && head) {
      // turned about the world's up, then cocked about the way it faces (+z), round the head's own pivot
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(look[0]), THREE.MathUtils.degToRad(look[1]), 'YXZ'));
      const own = head.getWorldQuaternion(new THREE.Quaternion());
      head.quaternion.multiply(own.clone().invert().multiply(turn).multiply(own));
      gltf.scene.updateMatrixWorld(true);
    }
    return bakePose(meshes, index, weld);
  };
  const clips = {}, frames = [];
  Object.entries(CLIPS).forEach(([name, { loop }]) => {
    const clip = gltf.animations.find(a => a.name === name);
    if (!clip) { console.warn('Splinetopia: Pigeon.glb has no ' + name + ' clip'); return; }
    const d = clip.duration, n = loop ? Math.max(2, Math.round(d*BAKE_FPS)) : Math.max(2, Math.round(d*BAKE_FPS) + 1);
    clips[name] = { start: frames.length, frames: n, duration: d, loop };
    for (let i=0;i<n;i++) frames.push(poseAt(clip, loop ? i*d/n : i*d/(n - 1)));
  });
  if (!clips[REST[0]] || !clips.Walk || !clips.Fly || !clips.TakeOff) return;
  // the looks, each as the rest pose with its head turned: added on top of whatever the bird's doing
  const heads = frames.length, restClip = gltf.animations.find(a => a.name === REST[0]);
  HEAD_POSES.forEach(look => frames.push(poseAt(restClip, REST[1], look)));
  const rest = frames[clips[REST[0]].start + REST[1]];
  rest.computeBoundingBox();
  const box = rest.boundingBox, scale = PIGEON_LENGTH/(box.max.z - box.min.z);
  const move = new THREE.Matrix4().makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x)/2, -box.min.y, -(box.min.z + box.max.z)/2));
  frames.forEach(f => f.applyMatrix4(move)); // (normals only turn: a uniform scale leaves them be)

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', rest.attributes.position.clone());
  geometry.setAttribute('normal', rest.attributes.normal.clone());
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  const delta = (f, key) => {
    const a = f.attributes[key].array, b = rest.attributes[key].array, out = new Float32Array(a.length);
    for (let i=0;i<a.length;i++) out[i] = a[i] - b[i];
    return new THREE.Float32BufferAttribute(out, 3);
  };
  geometry.morphAttributes.position = frames.map(f => delta(f, 'position'));
  geometry.morphAttributes.normal = frames.map(f => delta(f, 'normal'));
  geometry.morphTargetsRelative = true;
  geometry.computeBoundingBox();
  model = { geometry, clips, heads, targets: frames.length };
  frames.forEach(f => f.dispose());
}

// the birds are toon-shaded, like people and bees (see core/toon.js), and never disposed: every park shares them
const pigeonMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: TOON_RAMP, side: THREE.DoubleSide });

// ---------------------------------------------------------- planting
const between = (lo, hi) => lo + Math.random()*(hi - lo);
const TINTS = [[1, 0.62], [0.62, 0.18], [1.3, 0.08], [0.82, 0.12]]; // [brightness, share]: the usual grey, dark, pale, dusky
function pickTint() {
  let r = Math.random();
  for (const [tint, share] of TINTS) { if ((r -= share) < 0) return tint; }
  return 1;
}

/**
 * Puts a few flocks of pigeons on a plaza or in a park, as it's built.
 * @param {object} zone - its buildingsGroup takes the birds' mesh
 * @param {{ area: number, park?: boolean, ground: number, spot: () => ?{x: number, z: number},
 *   clear: (x: number, z: number) => boolean }} where - how much ground there is, how high, and where a bird can stand
 */
export function plantPigeons(zone, { area, park = false, ground, spot, clear }) {
  if (!model || !zone.buildingsGroup) return;
  const wanted = Math.min(PIGEONS_MAX, Math.floor(area/(park ? PARK_AREA_PER_PIGEON : PLAZA_AREA_PER_PIGEON)));
  if (wanted < FLOCK_MIN) return;
  const birds = [], groups = [];
  let index = 0;
  while (birds.length < wanted) {
    const home = spot();
    if (!home) break;
    const flock = { home: { x: home.x, z: home.z }, hopAt: null, birds: [] };
    const n = Math.min(wanted - birds.length, Math.round(between(FLOCK_MIN, FLOCK_MAX)));
    for (let k=0;k<n;k++) {
      const at = standingSpot(flock.home, clear) || home;
      const bird = { number: numberFor(zone.id + ':pigeon:' + index++), flock, x: at.x, y: ground, z: at.z, yaw: Math.random()*Math.PI*2, pitch: 0, bank: 0,
        state: 'ground', doing: 'stand', until: between(0, 2), tx: at.x, tz: at.z, hurry: false,
        clip: REST[0], time: 0, from: null, fade: 1, spookAt: null, threat: null, land: null, aloft: 0, cruise: 0,
        cooAt: between(3, COO_EVERY*2), tint: pickTint(), turn: 0,
        look: -1, lookFrom: -1, lookK: 1, lookAt: between(0, 1), lookOn: 1 };
      flock.birds.push(bird);
      birds.push(bird);
    }
    groups.push(flock);
  }
  if (!birds.length) return;
  const mesh = new THREE.InstancedMesh(model.geometry, pigeonMaterial, birds.length);
  mesh.name = 'Pigeons';
  mesh.userData.sharedGeometry = true; // the model's, shared by every park (see disposeObject)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.frustumCulled = false; // they fly off from wherever they were when the bounds were worked out
  const color = new THREE.Color();
  birds.forEach((bird, k) => { mesh.setColorAt(k, color.setScalar(bird.tint)); setPose(mesh, k, bird); });
  mesh.instanceColor.needsUpdate = true;
  zone.buildingsGroup.add(mesh);
  flocks.push({ group: zone.buildingsGroup, mesh, birds, flocks: groups, spot, clear, ground });
}

// somewhere near the middle of a flock that a bird can stand
function standingSpot(home, clear) {
  for (let i=0;i<12;i++) {
    const a = Math.random()*Math.PI*2, r = Math.sqrt(Math.random())*FLOCK_SPREAD;
    const x = home.x + Math.cos(a)*r, z = home.z + Math.sin(a)*r;
    if (clear(x, z)) return { x, z };
  }
  return null;
}

// ---------------------------------------------------------- posing
// Where a bird is in its clip, as the two stored frames either side of it and how far it is from the first to the second.
function sample(name, time, out) {
  const c = model.clips[name];
  let x, i, next;
  if (c.loop) {
    x = ((time/c.duration)%1 + 1)%1*c.frames;
    i = Math.floor(x); next = (i + 1)%c.frames;
  } else {
    x = Math.min(1, Math.max(0, time/c.duration))*(c.frames - 1);
    i = Math.min(Math.floor(x), c.frames - 2); next = i + 1;
  }
  out[0] = c.start + i; out[1] = c.start + next; out[2] = x - i;
  return out;
}
const posed = { morphTargetInfluences: [] };
const NOW = [0, 0, 0], THEN = [0, 0, 0];
function setPose(mesh, k, bird) {
  const w = posed.morphTargetInfluences;
  if (w.length !== model.targets) { w.length = model.targets; }
  w.fill(0);
  sample(bird.clip, bird.time, NOW);
  const f = bird.from ? bird.fade : 1;
  w[NOW[0]] += (1 - NOW[2])*f; w[NOW[1]] += NOW[2]*f;
  if (bird.from && f < 1) {
    sample(bird.from.clip, bird.from.time, THEN);
    w[THEN[0]] += (1 - THEN[2])*(1 - f); w[THEN[1]] += THEN[2]*(1 - f);
  }
  // and the head where it's looking (-1: straight ahead), mid-flick for a frame or two
  const on = bird.lookOn;
  if (bird.look >= 0) w[model.heads + bird.look] += bird.lookK*on;
  if (bird.lookFrom >= 0 && bird.lookK < 1) w[model.heads + bird.lookFrom] += (1 - bird.lookK)*on;
  mesh.setMorphAt(k, posed);
}
function play(bird, clip, time = 0) {
  if (bird.clip === clip) { bird.time = time; return; }
  bird.from = { clip: bird.clip, time: bird.time };
  bird.fade = 0;
  bird.clip = clip; bird.time = time;
}

// ---------------------------------------------------------- behaviour
// The head: held still, then flicked somewhere else. Only standing about or walking; pecking and flying it looks ahead.
function stepHead(bird, t, dt) {
  const free = bird.state === 'ground' && (bird.doing === 'stand' || bird.doing === 'walk') && bird.spookAt == null;
  bird.lookK = Math.min(1, bird.lookK + dt/HEAD_SNAP);
  bird.lookOn = free ? Math.min(1, bird.lookOn + dt/HEAD_SNAP) : Math.max(0, bird.lookOn - dt/HEAD_SNAP);
  if (!free || t < bird.lookAt) return;
  const [lo, hi] = bird.doing === 'walk' ? HEAD_HOLD_WALK : HEAD_HOLD_STAND;
  bird.lookAt = t + between(lo, hi);
  let next = -1;
  if (bird.look < 0 || Math.random() > HEAD_AHEAD) {
    do next = Math.floor(Math.random()*HEAD_POSES.length); while (next === bird.look);
  }
  bird.lookFrom = bird.look; bird.look = next; bird.lookK = 0;
}
const angleTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const turnToward = (bird, yaw, rate, dt) => {
  const d = angleTo(bird.yaw, yaw), step = Math.max(-rate*dt, Math.min(rate*dt, d));
  bird.yaw += step;
  return step/Math.max(dt, 1e-6);
};

// Whoever's about who could scare a bird: everyone out walking, standing or running, with how near is too near.
const threats = [];
function gatherThreats() {
  threats.length = 0;
  if (!S.peopleEnabled) return;
  (App.people || []).forEach(p => {
    if (p.mode === 'none' || p.mode === 'dead' || p.mode === 'train' || (p.mode === 'indoors' && p.indoors?.stage === 'inside')) return;
    const size = p.traits?.size || 1;
    const reach = (p.fright || p.attack ? SCARE_FLEEING : p.moving || p.mode === 'possessed' ? SCARE_MOVING : SCARE_STILL)*Math.sqrt(size);
    threats.push({ x: p.x, z: p.z, reach });
  });
}

function takeOff(colony, bird, from, t) {
  bird.state = 'takeoff';
  bird.aloft = 0;
  bird.spookAt = null;
  bird.yaw = from ? Math.atan2(bird.x - from.x, bird.z - from.z) + between(-0.6, 0.6) : bird.yaw;
  play(bird, 'TakeOff');
  bird.cruise = between(CRUISE_MIN, CRUISE_MAX);
  bird.land = landingSpot(colony, bird.flock, from);
  if (Math.random() < 0.6) flutter(bird);
  // the others nearby go too, the nearest first
  bird.flock.birds.forEach(other => {
    if (other === bird || other.state !== 'ground' || other.spookAt != null) return;
    const d = Math.hypot(other.x - bird.x, other.z - bird.z);
    if (d < CASCADE_REACH) { other.spookAt = t + 0.06 + d*0.12 + Math.random()*0.18; other.threat = from; }
  });
}

// Where a flock that's been put up comes down again: the spot of a handful that's furthest from whoever scared it, and
// from anyone else about. Each bird of it lands somewhere near that, on its own.
function landingSpot(colony, flock, from) {
  if (!flock.landing || flock.landingFor !== from) {
    let best = null, bestScore = -Infinity;
    for (let i=0;i<8;i++) {
      const s = colony.spot();
      if (!s) continue;
      let score = from ? Math.hypot(s.x - from.x, s.z - from.z) : Math.hypot(s.x - flock.home.x, s.z - flock.home.z);
      threats.forEach(p => { const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < 3) score -= (3 - d)*4; });
      if (score > bestScore) { bestScore = score; best = s; }
    }
    flock.landing = best || flock.home;
    flock.landingFor = from;
    flock.landingUntil = null;
  }
  return standingSpot(flock.landing, colony.clear) || { x: flock.landing.x, z: flock.landing.z };
}

function stepGround(colony, bird, t, dt, roosting) {
  if (bird.spookAt != null && t >= bird.spookAt) { takeOff(colony, bird, bird.threat, t); return; }
  if (bird.spookAt != null) return;
  // anyone too near?
  let nearest = null, nearestRatio = Infinity;
  for (const p of threats) {
    const ratio = Math.hypot(p.x - bird.x, p.z - bird.z)/p.reach;
    if (ratio < nearestRatio) { nearestRatio = ratio; nearest = p; }
  }
  if (nearestRatio < 1) { takeOff(colony, bird, { x: nearest.x, z: nearest.z }, t); return; }
  if (nearestRatio < SHY && !roosting) {
    // not so near it has to fly: it walks off out of their way instead
    const away = Math.atan2(bird.x - nearest.x, bird.z - nearest.z) + between(-0.5, 0.5);
    const x = bird.x + Math.sin(away)*0.8, z = bird.z + Math.cos(away)*0.8;
    if (colony.clear(x, z) && (bird.doing !== 'walk' || !bird.hurry)) {
      bird.doing = 'walk'; bird.hurry = true; bird.tx = x; bird.tz = z;
    }
  }
  if (bird.doing === 'walk') {
    const dx = bird.tx - bird.x, dz = bird.tz - bird.z, d = Math.hypot(dx, dz);
    if (d < 0.03) { bird.doing = 'stand'; bird.hurry = false; bird.until = t + between(0.2, 1.4); play(bird, REST[0], 0); return; }
    bird.turn = turnToward(bird, Math.atan2(dx, dz), GROUND_TURN, dt);
    const facing = Math.cos(angleTo(bird.yaw, Math.atan2(dx, dz)));
    const step = Math.min(d, (bird.hurry ? HURRY_SPEED : WALK_SPEED)*dt*Math.max(0, facing));
    bird.x += Math.sin(bird.yaw)*step; bird.z += Math.cos(bird.yaw)*step;
    if (bird.clip !== 'Walk') play(bird, 'Walk');
    bird.time += (step/WALK_CYCLE)*model.clips.Walk.duration + (step ? 0 : dt*0.5);
    return;
  }
  if (bird.doing === 'peck') {
    bird.time += dt;
    if (bird.time < model.clips[bird.clip].duration) return;
    bird.doing = 'stand'; bird.until = t + between(0.1, 0.8); play(bird, REST[0], 0);
    return;
  }
  // standing: then off to peck, or wander somewhere else near the flock
  if (t < bird.until) return;
  if (roosting) { bird.until = t + between(4, 12); return; }
  const r = Math.random();
  if (r < 0.45) {
    const pecks = PECKS.filter(name => model.clips[name]);
    bird.doing = 'peck'; play(bird, pecks[Math.floor(Math.random()*pecks.length)], 0);
  }
  else {
    const to = standingSpot(bird.flock.home, colony.clear);
    if (to) { bird.doing = 'walk'; bird.hurry = false; bird.tx = to.x; bird.tz = to.z; }
    else bird.until = t + between(0.5, 2);
  }
}

function stepAir(colony, bird, t, dt) {
  bird.aloft += dt;
  const g = colony.ground;
  if (bird.state === 'takeoff') {
    const k = Math.min(1, bird.aloft/TAKEOFF_TIME);
    bird.time = bird.aloft;
    const speed = FLY_SPEED*0.5*k;
    bird.x += Math.sin(bird.yaw)*speed*dt; bird.z += Math.cos(bird.yaw)*speed*dt;
    bird.y += (0.3 + 1.6*k)*dt;
    bird.pitch = 0.5*k;
    if (k >= 1) { bird.state = 'fly'; play(bird, 'Fly', 0); bird.aloft = 0; }
    return;
  }
  if (bird.state === 'fly') {
    const dx = bird.land.x - bird.x, dz = bird.land.z - bird.z, d = Math.hypot(dx, dz);
    if (d < LAND_FROM || bird.aloft > FLY_GIVE_UP) {
      bird.state = 'land'; bird.aloft = 0;
      bird.landFrom = { x: bird.x, y: bird.y, z: bird.z, yaw: bird.yaw };
      play(bird, 'TakeOff', TAKEOFF_TIME);
      return;
    }
    // slowing as it comes in, and more while it isn't headed there; and turning hard enough that its circle is always
    // well inside the distance left, so it can't go round and round its landing spot
    const facing = Math.cos(angleTo(bird.yaw, Math.atan2(dx, dz)));
    const speed = FLY_SPEED*Math.min(1, 0.3 + d*0.15)*(0.35 + 0.65*Math.max(0, facing));
    const turnRate = Math.min(14, Math.max(FLY_TURN, 2.5*speed/Math.max(d, 0.1)));
    bird.turn = turnToward(bird, Math.atan2(dx, dz), turnRate, dt);
    bird.x += Math.sin(bird.yaw)*speed*dt; bird.z += Math.cos(bird.yaw)*speed*dt;
    // up to its cruising height, then down again on a glide as it comes in
    const want = g + Math.min(bird.cruise, 0.25 + Math.max(0, d - LAND_FROM)*0.5);
    const vy = Math.max(-2.2, Math.min(1.8, (want - bird.y)*2.2));
    bird.y += vy*dt;
    bird.pitch += ((-vy/FLY_SPEED)*0.5 - bird.pitch)*Math.min(1, dt*5);
    bird.bank += (-bird.turn*0.18 - bird.bank)*Math.min(1, dt*6);
    // wings beat hard climbing, and slow in the glide down
    bird.time += dt*FLAP*(vy > 0.2 ? 1.3 : vy < -0.4 ? 0.55 : 1);
    return;
  }
  // landing: the takeoff played backwards, settling onto the spot
  const k = Math.min(1, bird.aloft/LAND_TIME), ease = 1 - (1 - k)*(1 - k), from = bird.landFrom;
  bird.time = TAKEOFF_TIME*(1 - k);
  bird.x = from.x + (bird.land.x - from.x)*ease;
  bird.z = from.z + (bird.land.z - from.z)*ease;
  bird.y = from.y + (g - from.y)*ease;
  bird.pitch *= 1 - Math.min(1, dt*8);
  bird.bank *= 1 - Math.min(1, dt*8);
  if (k >= 1) {
    bird.state = 'ground'; bird.y = g; bird.pitch = 0; bird.bank = 0;
    bird.doing = 'stand'; bird.until = t + between(0.3, 1.5); bird.hurry = false;
    play(bird, REST[0], 0);
    const flock = bird.flock;
    flock.home = { x: flock.landing?.x ?? bird.x, z: flock.landing?.z ?? bird.z };
    if (flock.birds.every(b => b.state === 'ground')) flock.landing = null;
  }
}

// A blast sends up every bird in reach of it (see blasts in traffic/state.js).
function scatterFromBlasts(t) {
  blasts.forEach(b => {
    const reach = 10*(b.scale || 1);
    flocks.forEach(colony => colony.birds.forEach(bird => {
      if (bird.state === 'ground' && bird.spookAt == null && Math.hypot(bird.x - b.x, bird.z - b.z) < reach) {
        bird.spookAt = t + Math.random()*0.15; bird.threat = { x: b.x, z: b.z };
      }
    }));
  });
}

// ---------------------------------------------------------- each frame
const held = new THREE.Object3D();
let lastTime = null;
export function updatePigeons(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  for (let i=flocks.length-1;i>=0;i--) {
    if (flocks[i].group.parent) continue;
    flocks[i].mesh.dispose(); // its instance buffers and shape-key texture, which disposeObject doesn't know about
    flocks.splice(i, 1);
  }
  if (!flocks.length) { stopFollowingPigeon(); return; }
  const roosting = S.sunElevation <= NIGHT;
  gatherThreats();
  if (blasts.length) scatterFromBlasts(t);
  flocks.forEach(colony => {
    colony.flocks.forEach(flock => {
      // now and then a flock moves on by itself, all together
      flock.hopAt ??= t + between(HOP_MIN, HOP_MAX);
      if (t < flock.hopAt) return;
      flock.hopAt = t + between(HOP_MIN, HOP_MAX);
      if (roosting || !flock.birds.every(b => b.state === 'ground')) return;
      flock.landing = null;
      const first = flock.birds[Math.floor(Math.random()*flock.birds.length)];
      flock.birds.forEach(b => { b.spookAt = t + Math.random()*1.2; b.threat = null; });
      first.spookAt = t;
    });
    colony.birds.forEach((bird, k) => {
      if (bird.state === 'ground') {
        stepGround(colony, bird, t, dt, roosting);
        if (!roosting && t >= bird.cooAt) { bird.cooAt = t + between(COO_EVERY*0.4, COO_EVERY*1.6); coo(bird); }
      } else stepAir(colony, bird, t, dt);
      stepHead(bird, t, dt);
      if (bird.from) { bird.fade = Math.min(1, bird.fade + dt/FADE); bird.from.time += dt; if (bird.fade >= 1) bird.from = null; }
      held.position.set(bird.x, bird.y, bird.z);
      held.rotation.set(-bird.pitch, bird.yaw, bird.bank, 'YXZ');
      // hunched up at night: a bit lower and rounder
      held.scale.set(1, roosting && bird.state === 'ground' ? 0.88 : 1, 1);
      held.updateMatrix();
      colony.mesh.setMatrixAt(k, held.matrix);
      setPose(colony.mesh, k, bird);
    });
    colony.mesh.instanceMatrix.needsUpdate = true;
    if (colony.mesh.morphTexture) colony.mesh.morphTexture.needsUpdate = true;
  });
  followPigeons(roosting);
}

// ---------------------------------------------------------- the card, and following one
// As for a bee (see bees.js): a click in World mode on a pigeon puts the camera on it and its card up (see input.js).
const text = loadTypeText('assets/pigeons.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'],
  // this stands in until pigeons.txt has loaded, or if it can't be
  placeholder: { pigeon: { name: ['Pigeon'], mood: ['🐦'], loves: ['Bread'], hates: ['Hawks'] } },
});
const pigeonCard = makeCard({ id: 'pigeon-card', title: 'Pigeon', onClose: () => App.stopFollowingPigeon() });
const drawPigeonThumbnail = makeThumbnailDrawer(pigeonCard.canvas);

let followed = null;    // { colony, bird } the camera's on, or null
let doingShown = null;  // what the card was last told it's up to, so it's only written to on a change
const FOLLOW_MIN_RADIUS = 1.2, FOLLOW_RADIUS = 6; // the closest the camera zooms, and how near it swoops in to start
const PICK_PIXELS = 18;                           // how near a click has to land on one

// standing, from the side and a little above, framed on its rest pose (every morph at zero)
function thumbnailScene() {
  if (!model) return null;
  const mesh = new THREE.Mesh(model.geometry, pigeonMaterial);
  const box = new THREE.Box3().setFromBufferAttribute(model.geometry.attributes.position);
  // (a little inside its bounding sphere, which a long, thin bird fills only the middle of)
  const center = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius*0.75;
  mesh.position.sub(center);
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = radius*4;
  const view = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, distance*2);
  view.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}

// the pigeon under a point on the screen (the nearest, if several are), or null: a flat few pixels round its middle, as
// for a bee. (out, if given, gets its distance from the camera, for comparing across kinds)
const screen = new THREE.Vector3();
function pickPigeon(clientX, clientY, out) {
  const width = window.innerWidth, height = window.innerHeight;
  let best = null, bestDepth = Infinity;
  flocks.forEach(colony => colony.birds.forEach(bird => {
    screen.set(bird.x, bird.y + PIGEON_LENGTH*0.3, bird.z).project(camera);
    if (Math.abs(screen.z) > 1) return; // behind the camera, or beyond what it draws
    const off = Math.hypot((screen.x + 1)/2*width - clientX, (1 - screen.y)/2*height - clientY);
    if (off <= PICK_PIXELS && screen.z < bestDepth) { best = { colony, bird }; bestDepth = screen.z; }
  }));
  if (out && best) out.distance = camera.position.distanceTo(screen.set(best.bird.x, best.bird.y, best.bird.z));
  return best;
}
function followPigeon(colony, bird) {
  followed = { colony, bird };
  doingShown = null;
  controls.minRadius = FOLLOW_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, FOLLOW_RADIUS));
  const number = bird.number;
  pigeonCard.show({ ...text.of('pigeon', number), name: text.of('pigeon', number).name + ' #' + number });
  drawPigeonThumbnail(thumbnailScene());
  pigeonCard.setFavorite({ key: 'pigeon:' + number, kind: 'Pigeon', follow: () => {
    for (const c of flocks) { const b = c.birds.find(b => b.number === number); if (b) { followPigeon(c, b); return true; } }
    return false;
  } });
}
function followPigeonAt(clientX, clientY) {
  const picked = pickPigeon(clientX, clientY);
  if (!picked) { stopFollowingPigeon(); return; }
  followPigeon(picked.colony, picked.bird);
}
function stopFollowingPigeon() {
  if (!followed) return;
  followed = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  pigeonCard.hide();
}
// what its card says it's up to
function pigeonDoing(bird, roosting) {
  if (bird.state === 'takeoff') return 'Taking off';
  if (bird.state === 'fly') return 'Flying';
  if (bird.state === 'land') return 'Landing';
  if (roosting) return 'Roosting';
  if (bird.doing === 'peck') return 'Pecking at crumbs';
  if (bird.doing === 'walk') return bird.hurry ? 'Getting out of the way' : 'Walking about';
  return 'Standing about';
}
// the camera each frame, once the birds have moved
function followPigeons(roosting) {
  if (!followed) return;
  if (S.interactionMode !== 'move' || !flocks.includes(followed.colony)) { stopFollowingPigeon(); return; }
  const { bird } = followed;
  const doing = pigeonDoing(bird, roosting);
  if (doing !== doingShown) { doingShown = doing; pigeonCard.set('status', doing); }
  controls.goalTarget.set(bird.x, bird.y + PIGEON_LENGTH*0.3, bird.z);
}

Object.assign(App, { pigeonFlocks: flocks, pickPigeon, followPigeonAt, stopFollowingPigeon });
