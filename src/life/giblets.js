import * as THREE from 'three';
import { scene, camera, Y_PATH } from '../core/scene.js';
import { S } from '../core/shared.js';

// ============================================================ giblets
// What's left of someone after the person card's Smite button, or a car after the car card's: chunks of them in their own
// colors (skin, top, pants, shoes, hair and a couple of eyes for a person; paint, glass and trim for a car), flecks of
// blood or (a car) soot, and a splat on the ground (blood, or a scorch mark) — thrown out from where they stood, falling,
// bouncing and tumbling to a stop, lying there a while, then sinking away. A car's explosion also gets a fireball and a
// few puffs of smoke (explodeFx below), and a flash of light. The chunks are all one instanced mesh, the splats another,
// and the fire and smoke a third.
const GIBLETS_MAX = 1500, SPLATS_MAX = 48, FX_MAX = 320;
const GIBLET_LIFE = 40, SPLAT_LIFE = 60, SINK_TIME = 3; // seconds before they sink away, and how long that takes
const GRAVITY = 9.8;
const BLOOD_COLORS = [0x7a0a0a, 0x9c1010, 0x5c0606];
const BLOOD_SPLAT_COLOR = new THREE.Color(0x6a0707);
const SCORCH_COLORS = [0x1c1a18, 0x2b2622, 0x14100e];
const SCORCH_SPLAT_COLOR = new THREE.Color(0x161412);
const SOOT_SIZE = 7, SOOT_Y = Y_PATH + 0.02; // (a car's scorch mark: its size against the usual splat's, and its height — over the road, pavement, parks and paths alike)
const EYE_COLOR = 0xf4f1ea;
const CAR_TRIM_COLORS = [0x1a1a1c, 0x8f9298]; // tires and glass/chrome, standing in for whatever a car's actually made of

const giblets = [], splats = [], fx = [];
function instancedMesh(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}
const chunkMesh = instancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.55, flatShading: true }), GIBLETS_MAX, 'Giblets');
chunkMesh.castShadow = true; chunkMesh.receiveShadow = true;
chunkMesh.setColorAt(0, new THREE.Color()); // (gives it its per-chunk colors)
const splatMesh = instancedMesh(new THREE.CircleGeometry(1, 12).rotateX(-Math.PI/2),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), SPLATS_MAX, 'Splats');
splatMesh.receiveShadow = true;
splatMesh.setColorAt(0, new THREE.Color()); // (blood)
// a car's scorch mark is a separate mesh, its edge fading out gradually (an alpha map solid over the middle half, then fading to nothing at the rim)
const sootFade = (() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  [[0, 1], [0.5, 1], [0.65, 0.7], [0.8, 0.3], [0.92, 0.08], [1, 0]].forEach(([at, level]) => gradient.addColorStop(at, `rgb(${level*255|0},${level*255|0},${level*255|0})`));
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
})();
const sootMesh = instancedMesh(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI/2),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, alphaMap: sootFade, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }), SPLATS_MAX, 'Soot');
sootMesh.receiveShadow = true;
sootMesh.renderOrder = 1;
sootMesh.setColorAt(0, new THREE.Color());
const FX_OPACITY = 0.6; // fire, smoke and sparks are all semi-transparent, so what's inside a fireball can be seen
const fxGeometry = new THREE.IcosahedronGeometry(1, 1), fxMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: FX_OPACITY, depthWrite: false });
const fxAlpha = addInstanceAlpha(fxGeometry, fxMaterial, FX_MAX); // (each puff's own share of FX_OPACITY)
const fxMesh = instancedMesh(fxGeometry, fxMaterial, FX_MAX, 'ExplosionFx');
fxMesh.setColorAt(0, new THREE.Color());
// a brief flash of light where the fireball went off, reused explosion to explosion
const flash = new THREE.PointLight(0xffb347, 0, 22, 2);
scene.add(flash);
let flashUntil = -Infinity, flashBorn = 0, flashDuration = 0.5;

// Where the ground is under (x, z), looking straight down from `fromY`: the first solid, upward-facing surface, or `fallback`.
// Moving things (instanced or skinned, such as cars and people), hidden or see-through things, and undersides don't count.
const downRay = new THREE.Raycaster(), downOrigin = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0), surfaceNormal = new THREE.Vector3();
const isShown = o => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
function groundBelow(x, fromY, z, fallback) {
  downRay.set(downOrigin.set(x, fromY, z), DOWN);
  for (const hit of downRay.intersectObject(scene, true)) {
    const o = hit.object;
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !hit.face || !isShown(o)) continue;
    const material = Array.isArray(o.material) ? o.material[hit.face.materialIndex] : o.material;
    if (!material || material.transparent || material.visible === false) continue;
    if (surfaceNormal.copy(hit.face.normal).transformDirection(o.matrixWorld).y < 0.5) continue;
    return hit.point.y;
  }
  return fallback;
}
// whether something is within S.gibRange of the camera: chunks and fireballs further than that are neither made, simulated nor
// drawn (the marks left on the ground always are)
const isNear = o => (o.x - camera.position.x)**2 + (o.y - camera.position.y)**2 + (o.z - camera.position.z)**2 <= S.gibRange*S.gibRange;
// the chunks thrown out from `at` (where feet or wheels were), `height` tall, one call per material of them: [color, how
// many, how big (as a fraction of height)] — `power` throws them further and faster and spreads them wider (a car's
// explosion, much more violent than a person's, uses a bigger one; see explodeCar); `ground` is the height they land on
// (default: where they start from), or a function of (x, z) that finds it, for chunks thrown from the air, which each land
// on whatever is below where they come down
function spawnParts(at, height, parts, power = 1, ground = at.y, momentum = null, amount = S.gibAmount) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000;
  const groundAtStart = typeof ground === 'function' ? ground(at.x, at.z) : ground;
  parts.forEach(([color, count, size]) => {
    const scaled = count*amount, chunks = Math.floor(scaled) + (Math.random() < scaled % 1 ? 1 : 0); // (a fractional amount rounds at random, so small counts still scale)
    for (let k=0;k<chunks;k++) {
      if (giblets.length >= GIBLETS_MAX) giblets.shift(); // (the oldest make way)
      const angle = Math.random()*Math.PI*2, outward = (1 + Math.random()*4.5)*power;
      const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const chunk = {
        x: at.x + (Math.random() - 0.5)*0.25*height*power, y: at.y + height*(0.15 + Math.random()*0.75), z: at.z + (Math.random() - 0.5)*0.25*height*power,
        vx: Math.cos(angle)*outward + (momentum?.x ?? 0), vy: (2 + Math.random()*5.5)*power + (momentum?.y ?? 0), vz: Math.sin(angle)*outward + (momentum?.z ?? 0),
        ground: groundAtStart, size: size*height*(0.6 + Math.random()*0.8),
        shape: new THREE.Vector3(0.6 + Math.random()*0.7, 0.5 + Math.random()*0.6, 0.6 + Math.random()*0.7),
        quaternion: new THREE.Quaternion().setFromAxisAngle(spinAxis, Math.random()*Math.PI*2),
        spinAxis, spin: 4 + Math.random()*14, color, born: now, resting: false,
      };
      if (typeof ground === 'function') {
        // (the ground where it'll come down, going by how long it falls to the ground under where it started)
        const fall = Math.max(0, (chunk.vy + Math.sqrt(chunk.vy*chunk.vy + 2*GRAVITY*(chunk.y - groundAtStart)))/GRAVITY);
        chunk.ground = ground(chunk.x + chunk.vx*fall, chunk.z + chunk.vz*fall) + chunk.size*chunk.shape.y; // (sitting on it, not sunk in it)
      }
      giblets.push(chunk);
    }
  });
}
// the splat left on the ground at `at`, `height` tall, in `color` (blood, or a car's scorch mark) — `sizeMul` for a bigger
// mark than the default (a car's, again — see explodeCar)
function spawnSplat(at, height, color, sizeMul = 1, soot = false) {
  if (splats.length >= SPLATS_MAX) splats.shift();
  splats.push({ x: at.x, y: soot ? SOOT_Y : at.y + 0.015, z: at.z, size: height*(0.45 + Math.random()*0.3)*sizeMul, angle: Math.random()*Math.PI*2, born: performance.now()/1000, color, soot });
}
// a car's fireball — bright chunks bursting up and out, quickly shrinking — and the smoke puffs that follow it, drifting up
// and slowly spreading as they thin out; and the light flash, retriggered (so overlapping explosions just relight it)
const FIRE_COLORS = [0xffdd66, 0xff9a3c, 0xff5a1f, 0xd8280f];
const PLUME_SIZE = 0.45; // how big a car explosion's fireball and smoke are, against the car's height
function explodeFx(at, height) {
  if (!isNear(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<30;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 3 + Math.random()*9;
    fx.push({ kind: 'fire', x: at.x, y: at.y + height*0.2, z: at.z,
      vx: Math.cos(angle)*outward, vy: 5 + Math.random()*9, vz: Math.sin(angle)*outward,
      size: height*PLUME_SIZE*(0.36 + Math.random()*0.36), life: 0.45 + Math.random()*0.4,
      color: new THREE.Color(FIRE_COLORS[Math.floor(Math.random()*FIRE_COLORS.length)]), born: now });
  }
  for (let k=0;k<20;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 0.7 + Math.random()*2.8;
    const grey = 0.12 + Math.random()*0.14;
    fx.push({ kind: 'smoke', x: at.x, y: at.y + height*0.3, z: at.z,
      vx: Math.cos(angle)*outward, vy: 1.7 + Math.random()*2.4, vz: Math.sin(angle)*outward,
      size: height*PLUME_SIZE*(0.55 + Math.random()*0.55), life: 3.2 + Math.random()*2.4,
      color: new THREE.Color(grey, grey, grey), born: now + Math.random()*0.2 });
  }
  flash.position.set(at.x, at.y + height*0.35, at.z);
  flash.distance = 26 + height*5;
  flashDuration = 0.5;
  flashBorn = now; flashUntil = now + flashDuration;
}

// A few small puffs of light smoke round `at` (where feet were), `height` tall, floating up and thinning out in a second or two.
export function puffSmoke(at, height, count = 6) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<count;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 0.2 + Math.random()*0.8, grey = 0.55 + Math.random()*0.2;
    fx.push({ kind: 'smoke', x: at.x + Math.cos(angle)*0.25*height, y: at.y + height*(0.1 + Math.random()*0.5), z: at.z + Math.sin(angle)*0.25*height,
      vx: Math.cos(angle)*outward, vy: 0.6 + Math.random()*0.8, vz: Math.sin(angle)*outward,
      size: height*(0.12 + Math.random()*0.1), life: 1 + Math.random()*0.8, color: new THREE.Color(grey, grey, grey), born: now });
  }
}

// ---- soft particles: glow and smoke drawn as camera-facing discs fading out to their edges, each with its own opacity.
// `glow` adds its light to what's behind it (a car's aura and flames); `smoke` covers it.
const SOFT_MAX = 300;
/** Give an instanced mesh a per-instance opacity (multiplying the material's), as an attribute on `geometry` for `count` instances. */
function addInstanceAlpha(geometry, material, count) {
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('instanceAlpha', alpha);
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vInstanceAlpha;\n#include <opaque_fragment>');
  };
  return alpha;
}
const softParticles = [];
const softTexture = (() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
})();
function softMesh(blending, name) {
  const material = new THREE.MeshBasicMaterial({ map: softTexture, transparent: true, depthWrite: false, toneMapped: false, blending });
  const geometry = new THREE.PlaneGeometry(1, 1), alpha = addInstanceAlpha(geometry, material, SOFT_MAX);
  const mesh = instancedMesh(geometry, material, SOFT_MAX, name);
  mesh.setColorAt(0, new THREE.Color());
  mesh.userData.alpha = alpha;
  return mesh;
}
const glowMesh = softMesh(THREE.AdditiveBlending, 'GlowFx'), smokeMesh = softMesh(THREE.NormalBlending, 'SmokeFx');
glowMesh.renderOrder = smokeMesh.renderOrder = 2;

// What a burning car gives off in the `dt` seconds since it was last called: a soft red glow round it, red, orange and yellow puffs
// rising from it and dark smoke drifting away; `at` where its wheels are, `height` its height.
const BURN_FLAME_COLORS = [0xffdd33, 0xff9a1a, 0xff4a14, 0xd8280f], BURN_AURA_COLOR = new THREE.Color(0xff6a12);
const BURN_FLAMES_PER_SECOND = 30, BURN_SMOKE_PER_SECOND = 10;
const BURN_AURA_SIZE = 2.2, BURN_AURA_OPACITY = 0.12; // (the aura's size is a multiple of the car's height)
export function burnFx(at, height, dt) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000, count = rate => Math.floor(rate*dt + Math.random());
  const add = particle => { if (softParticles.length >= SOFT_MAX*2) softParticles.shift(); softParticles.push({ born: now, ...particle }); };
  add({ kind: 'glow', still: true, x: at.x, y: at.y + height*0.45, z: at.z, vx: 0, vy: 0, vz: 0, size: height*BURN_AURA_SIZE*(0.9 + Math.random()*0.2), growth: 0, life: 0.3, opacity: BURN_AURA_OPACITY, color: BURN_AURA_COLOR });
  solidPuffs(at, height, count(BURN_FLAMES_PER_SECOND), puffColor(BURN_FLAME_COLORS),
    { size: [0.12, 0.22], life: [0.6, 1.1], rise: [1.5, 3], spread: 0.3, outward: [0.1, 0.5], lift: 0.5 });
  for (let k = count(BURN_SMOKE_PER_SECOND); k > 0; k--) {
    const angle = Math.random()*Math.PI*2, out = Math.random()*0.3*height, grey = 0.08 + Math.random()*0.12;
    add({ kind: 'smoke', x: at.x + Math.cos(angle)*out, y: at.y + height*0.8, z: at.z + Math.sin(angle)*out,
      vx: (Math.random() - 0.3)*0.6, vy: 1.6 + Math.random()*1.2, vz: (Math.random() - 0.5)*0.6,
      size: height*(0.15 + Math.random()*0.1), growth: 2.5, life: 2 + Math.random()*1.5, opacity: 0.4, color: new THREE.Color(grey, grey, grey) });
  }
}

// Solid puffs, drawn as puffSmoke's are: `count` circles from around `at` (`height` tall), each `colorAt()`, rising and thinning out.
// `alpha` is the share of the usual opacity they're drawn with. `size` and `life` (seconds) are [least, most] pairs, `rise` (units a second) too; `size` a share of `height`.
function solidPuffs(at, height, count, colorAt, { size, life, rise, spread = 0.25, outward = [0.2, 0.8], lift = 0.3, alpha = 1 }) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000, between = ([least, most]) => least + Math.random()*(most - least);
  for (let k=0;k<count;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, out = between(outward);
    fx.push({ kind: 'smoke', x: at.x + Math.cos(angle)*spread*height, y: at.y + height*lift, z: at.z + Math.sin(angle)*spread*height,
      vx: Math.cos(angle)*out, vy: between(rise), vz: Math.sin(angle)*out, size: height*between(size), life: between(life), color: colorAt(), alpha, born: now });
  }
}
const puffColor = colors => () => new THREE.Color(colors[Math.floor(Math.random()*colors.length)]);
// Small black puffs from a tyre at `at` over the `dt` seconds since it was last called, for a car that's boosting; `height` is the car's.
const TYRE_SMOKE_PER_SECOND = 25, TYRE_RED_SHARE = 0.25, TYRE_RED_ALPHA = 1/3; // (dark brown puffs alongside the black: how many as many, and how opaque as a share of the usual 0.6 — 20% overall)
export function tyreSmoke(at, height, dt) {
  solidPuffs(at, height, Math.floor(TYRE_SMOKE_PER_SECOND*dt + Math.random()), () => { const grey = 0.04 + Math.random()*0.08; return new THREE.Color(grey, grey, grey); },
    { size: [0.08, 0.14], life: [0.7, 1.2], rise: [0.3, 0.8], spread: 0.05, outward: [0.1, 0.4], lift: 0.08 });
  solidPuffs(at, height, Math.floor(TYRE_SMOKE_PER_SECOND*TYRE_RED_SHARE*dt + Math.random()), puffColor([0x110600]),
    { size: [0.1, 0.18], life: [0.7, 1.2], rise: [0.3, 0.8], spread: 0.05, outward: [0.1, 0.4], lift: 0.08, alpha: TYRE_RED_ALPHA });
}
// Smoke from a stalled engine at `at`, `height` tall: plenty of grey puffs, climbing high.
export function engineSmoke(at, height) {
  solidPuffs(at, height, 6, () => { const grey = 0.45 + Math.random()*0.2; return new THREE.Color(grey, grey, grey); },
    { size: [0.15, 0.3], life: [1.5, 2.5], rise: [2.5, 5], spread: 0.15, outward: [0.1, 0.5], lift: 0.3 });
}
// A burst of red, orange and yellow puffs as a car catches fire, from `at` (where its wheels are), `height` tall.
const IGNITE_COLORS = [0xffdd33, 0xff9a1a, 0xff4a14, 0xd8280f];
export function igniteFx(at, height) {
  solidPuffs(at, height, 14, puffColor(IGNITE_COLORS), { size: [0.2, 0.35], life: [0.6, 1.1], rise: [1, 2.5], spread: 0.3, outward: [0.8, 2.2], lift: 0.4 });
}

// A burst of `count` small bright sparks flying out from `at` and quickly dying, for metal hitting metal.
export function sparks(at, count = 8) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<count;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 2 + Math.random()*5;
    fx.push({ kind: 'fire', x: at.x, y: at.y, z: at.z, vx: Math.cos(angle)*outward, vy: 1 + Math.random()*4, vz: Math.sin(angle)*outward,
      size: 0.05 + Math.random()*0.05, life: 0.25 + Math.random()*0.3, color: new THREE.Color(FIRE_COLORS[Math.random() < 0.6 ? 0 : 1]), born: now });
  }
}

// Blows someone up: `at` where their feet were, `height` how tall they were, `colors` what they were made of — { skin, top,
// pants, shoes, hair } as THREE.Colors (hair null for someone bald). `momentum` ({ x, y, z } in units a second) is the velocity
// of whatever struck them, which every chunk keeps on top of its own throw (none for a blast, which has no direction).
export function explode(at, height, colors, momentum = null) {
  const parts = [[colors.skin, 16, 0.075], [colors.top, 10, 0.08], [colors.pants, 9, 0.08], [colors.shoes, 4, 0.06],
    [colors.hair, colors.hair ? 5 : 0, 0.065], [new THREE.Color(EYE_COLOR), 2, 0.035]];
  BLOOD_COLORS.forEach(hex => parts.push([new THREE.Color(hex), 9, 0.028]));
  spawnParts(at, height, parts, 1, at.y, momentum);
  spawnSplat(at, height, BLOOD_SPLAT_COLOR);
}
// A few chunks of blood thrown from `at` (`height` tall), `count` of them whatever the gib amount setting is; `momentum` as for explode.
export function spillBlood(at, height, count, momentum = null) {
  spawnParts(at, height, Array.from({ length: count }, (_, k) => [new THREE.Color(BLOOD_COLORS[k % BLOOD_COLORS.length]), 1, 0.028]), 0.6, at.y, momentum, 1);
}
// Bursts a bee in mid-air: a few flecks of its yellow, black and wing, `size` long — small and soft-thrown, each falling to
// whatever ground is below it (`fallbackGround` where there's nothing), and no mark on it.
export function explodeBee(at, size, fallbackGround) {
  const parts = [[new THREE.Color(0xffeb2b), 6, 0.3], [new THREE.Color(0x1c1c1c), 4, 0.26], [new THREE.Color(0xdfe8f0), 3, 0.22]];
  spawnParts(at, size, parts, 0.25, (x, z) => groundBelow(x, at.y, z, fallbackGround));
}
// Blows a car up: `at` where its wheels were, `height` how tall it was, `colors.paint` its own color — chunks of it, bigger
// and thrown much further than a person's (see spawnParts' `power`), in its paint and (standing in for glass, trim and
// tires) CAR_TRIM_COLORS, sooty flecks, a big scorch mark rather than blood, and a fireball with smoke (see explodeFx).
export function explodeCar(at, height, colors) {
  const parts = [[colors.paint, 32, 0.17], [new THREE.Color(CAR_TRIM_COLORS[0]), 16, 0.13], [new THREE.Color(CAR_TRIM_COLORS[1]), 10, 0.11]];
  SCORCH_COLORS.forEach(hex => parts.push([new THREE.Color(hex), 14, 0.055]));
  spawnParts(at, height, parts, 2.2);
  spawnSplat(at, height, SCORCH_SPLAT_COLOR, SOOT_SIZE, true);
  explodeFx(at, height);
}

const placed = new THREE.Object3D(), spinStep = new THREE.Quaternion(), dimmed = new THREE.Color();
let lastTime = null;
// how far through sinking away something is, 0 until it starts
const sunk = (age, life) => age > life ? Math.min(1, (age - life)/SINK_TIME) : 0;
export function updateGiblets(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  const gibletLife = GIBLET_LIFE*S.gibLifetime;
  while (giblets.length && t - giblets[0].born > gibletLife + SINK_TIME) giblets.shift();
  while (splats.length && t - splats[0].born > SPLAT_LIFE + SINK_TIME) splats.shift();
  while (fx.length && t - fx[0].born > fx[0].life) fx.shift();
  if (!S.showGibs) giblets.length = 0; // (turned off: what's already flying goes too)
  let drawn = 0;
  giblets.forEach(g => {
    if (!isNear(g)) return;
    if (!g.resting) {
      g.vy -= GRAVITY*dt;
      g.x += g.vx*dt; g.y += g.vy*dt; g.z += g.vz*dt;
      g.quaternion.premultiply(spinStep.setFromAxisAngle(g.spinAxis, g.spin*dt));
      const floor = g.ground + g.size*g.shape.y;
      if (g.y < floor) {
        g.y = floor;
        if (g.vy < -1) {
          // a bounce, losing most of its speed
          g.vy *= -0.3; g.vx *= 0.55; g.vz *= 0.55; g.spin *= 0.5;
        } else {
          // sliding to a stop
          g.vy = 0;
          const grip = Math.max(0, 1 - 6*dt);
          g.vx *= grip; g.vz *= grip; g.spin *= grip;
          if (Math.hypot(g.vx, g.vz) < 0.03) g.resting = true;
        }
      }
    }
    const sink = sunk(t - g.born, gibletLife);
    placed.position.set(g.x, g.y - sink*g.size, g.z);
    placed.quaternion.copy(g.quaternion);
    placed.scale.copy(g.shape).multiplyScalar(g.size*(1 - sink));
    placed.updateMatrix();
    chunkMesh.setMatrixAt(drawn, placed.matrix);
    chunkMesh.setColorAt(drawn, g.color);
    drawn++;
  });
  chunkMesh.count = drawn;
  chunkMesh.instanceMatrix.needsUpdate = true;
  if (chunkMesh.instanceColor) chunkMesh.instanceColor.needsUpdate = true;
  const splatsDrawn = { blood: 0, soot: 0 };
  splats.forEach(s => {
    const mesh = s.soot ? sootMesh : splatMesh, i = splatsDrawn[s.soot ? 'soot' : 'blood']++;
    // (spreading out quickly as it lands)
    const age = t - s.born, spread = Math.min(1, age/0.35), size = s.size*(0.3 + 0.7*spread)*(1 - sunk(age, SPLAT_LIFE));
    placed.position.set(s.x, s.y, s.z);
    placed.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.angle);
    placed.scale.set(size, 1, size*0.8);
    placed.updateMatrix();
    mesh.setMatrixAt(i, placed.matrix);
    mesh.setColorAt(i, s.color);
  });
  [[splatMesh, splatsDrawn.blood], [sootMesh, splatsDrawn.soot]].forEach(([mesh, count]) => {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  let fxDrawn = 0;
  fx.forEach(p => {
    if (!isNear(p)) return;
    const age = t - p.born, life = Math.max(0, Math.min(1, age/p.life));
    let scale, dim;
    if (p.kind === 'fire') {
      p.vy -= GRAVITY*0.4*dt;
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      scale = p.size*(1 - life)*(1 - life); // quick burst, quicker fade
      dim = 1 - life*0.6;
    } else {
      p.vx *= 1 - Math.min(1, dt*0.6); p.vz *= 1 - Math.min(1, dt*0.6); p.vy *= 1 - Math.min(1, dt*0.8);
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      // grows for a moment as it billows out, then thins away
      scale = p.size*(0.4 + 0.9*Math.min(1, age/0.6))*(1 - life*life);
      dim = 1 - life*0.7;
    }
    placed.position.set(p.x, p.y, p.z);
    placed.quaternion.identity();
    placed.scale.setScalar(Math.max(0, scale));
    placed.updateMatrix();
    fxMesh.setMatrixAt(fxDrawn, placed.matrix);
    fxMesh.setColorAt(fxDrawn, dimmed.copy(p.color).multiplyScalar(dim));
    fxAlpha.setX(fxDrawn, p.alpha ?? 1);
    fxDrawn++;
  });
  // soft particles: each drifts on, grows by `growth` of its size over its life, and fades in and out
  while (softParticles.length && t - softParticles[0].born > softParticles[0].life) softParticles.shift();
  const drawnSoft = { glow: 0, smoke: 0 }, meshes = { glow: glowMesh, smoke: smokeMesh };
  softParticles.forEach(p => {
    const age = t - p.born, life = age/p.life, mesh = meshes[p.kind];
    if (life > 1 || drawnSoft[p.kind] >= SOFT_MAX || !isNear(p)) return;
    if (!p.still) { p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt; }
    placed.position.set(p.x, p.y, p.z);
    placed.quaternion.copy(camera.quaternion);
    placed.scale.setScalar(p.size*(1 + p.growth*(p.kind === 'glow' && !p.still ? -life : life)));
    placed.updateMatrix();
    const i = drawnSoft[p.kind]++;
    mesh.setMatrixAt(i, placed.matrix);
    mesh.setColorAt(i, p.color);
    mesh.userData.alpha.setX(i, p.opacity*Math.sin(Math.PI*Math.min(1, life))**(p.kind === 'smoke' ? 1 : 0.5));
  });
  Object.entries(meshes).forEach(([kind, mesh]) => {
    mesh.count = drawnSoft[kind];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.alpha.needsUpdate = true;
  });
  fxMesh.count = fxDrawn;
  fxAlpha.needsUpdate = true;
  fxMesh.instanceMatrix.needsUpdate = true;
  if (fxMesh.instanceColor) fxMesh.instanceColor.needsUpdate = true;
  flash.intensity = t < flashUntil ? Math.max(0, 1 - (t - flashBorn)/flashDuration)**2*10 : 0;
}
