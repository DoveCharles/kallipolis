import * as THREE from 'three';
import { scene, camera, Y_PATH } from '../core/scene.js';
import { S } from '../core/shared.js';
import { playSound } from '../audio/sfx.js';
import { WATER_LEVEL } from '../water/water.js';
import { groundBelow } from '../core/ground-probe.js';

// ============================================================ giblets
// Two separate things share this file, each with its own setting group in S (see core/shared.js): gibs — what's left of
// someone after the person card's Smite button, or a car after the car card's — and particles — every other fire, smoke,
// spark or spray effect, none of which counts as a gib even though they used to share the gib settings.
//
// A gib is: chunks of them in their own colors (skin, top, pants, shoes, hair and a couple of eyes for a person; paint,
// glass and trim for a car), flecks of blood or (a car) soot, and a splat on the ground (blood, or a scorch mark) — thrown
// out from where they stood, falling, bouncing and tumbling to a stop, lying there a while, then sinking away. Gated by
// S.showGibs and S.gibAmount (0 for either and nothing is thrown), drawn out to S.gibRange and lasting S.gibLifetime of
// the base lifetime. The chunks are one instanced mesh, the splats (blood) and scorch marks two more.
//
// A particle is everything else: a car's explosion fireball and smoke (explodeFx), a car's splash going into water
// (splashFx), tyre and engine smoke, a burning car's flames, sparks off metal, a legendary car's sparkle shimmer, and so
// on. Gated by S.maxParticles (0 switches them off) and drawn out to S.particleRange. The bursty ones (fire, smoke,
// sparks, spray, foam) are one instanced mesh; the soft camera-facing ones (glow, drifting smoke, sparkle) three more.
const GIBLETS_MAX = 1500, BLOOD_CHUNKS_MAX = 1000, SPLATS_MAX = 48;
const BLOOD_LIFE_SHARE = 0.25; // how long a blood chunk lasts, against the other gibs
const FX_MESH_CAP = 1500; // the fx instanced mesh's own capacity — a ceiling maxParticles is clamped under, not a target
const fxCap = () => Math.max(0, Math.min(FX_MESH_CAP, Math.round(S.maxParticles)));
const GIBLET_LIFE = 40, SPLAT_LIFE = 60, SINK_TIME = 3; // seconds before they sink away, and how long that takes
const GRAVITY = 9.8;
// where a falling chunk lands if groundBelow finds no solid ground at all under it (see explode, spillBlood and
// explodeCar, below) — well under WATER_LEVEL, so a gib thrown out over open water with no lakebed geometry to hit
// still falls far enough to cross WATER_LEVEL and be caught there (updateGiblets) rather than snapping back up to a
// fallback at ground level, which would put it right back to bouncing where it died instead of going under.
export const NO_GROUND_FALLBACK = WATER_LEVEL - 5;
const BLOOD_COLORS = [0x7a0a0a, 0x9c1010, 0x5c0606];
const PERSON_BLOOD_CHUNKS = 20; // blood chunks a person bursts into, besides their own body parts
const BLOOD_SPLAT_COLOR = new THREE.Color(0x6a0707);
const SCORCH_COLORS = [0x1c1a18, 0x2b2622, 0x14100e];
const SCORCH_SPLAT_COLOR = new THREE.Color(0x161412);
const SOOT_SIZE = 7, SOOT_Y = Y_PATH + 0.02; // (a car's scorch mark: its size against the usual splat's, and its height — over the road, pavement, parks and paths alike)
const EYE_COLOR = 0xf4f1ea;
const CAR_TRIM_COLORS = [0x1a1a1c, 0x8f9298];
const CAR_GLASS_COLOR = 0x9fb8c8, WRECK_GLASS_CHUNKS = 6, WRECK_SCORCH_CHUNKS = 3; // (per scorch color) // tires and glass/chrome, standing in for whatever a car's actually made of

const splats = [], fx = [];
function instancedMesh(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}
// (drawn with a stronger polygon offset than the flat surfaces they land on — grass -2, pavement and roads -4 — which
// are pulled towards the camera so they don't flicker against each other, and would otherwise hide a small chunk lying on them)
const chunkMesh = instancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.55, flatShading: true, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }), GIBLETS_MAX, 'Giblets');
chunkMesh.castShadow = true; chunkMesh.receiveShadow = true;
chunkMesh.setColorAt(0, new THREE.Color()); // (gives it its per-chunk colors)
// blood chunks: their own mesh so they can go without shadows (too small to see one) and go sooner
const bloodChunkMesh = instancedMesh(chunkMesh.geometry, chunkMesh.material, BLOOD_CHUNKS_MAX, 'BloodChunks');
bloodChunkMesh.receiveShadow = true;
bloodChunkMesh.setColorAt(0, new THREE.Color());
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
const fxAlpha = addInstanceAlpha(fxGeometry, fxMaterial, FX_MESH_CAP); // (each puff's own share of FX_OPACITY)
const fxMesh = instancedMesh(fxGeometry, fxMaterial, FX_MESH_CAP, 'ExplosionFx');
fxMesh.setColorAt(0, new THREE.Color());
// a brief flash of light where the fireball went off, reused explosion to explosion
const flash = new THREE.PointLight(0xffb347, 0, 22, 2);
scene.add(flash);
let flashUntil = -Infinity, flashBorn = 0, flashDuration = 0.5;

// whether something is within S.gibRange (isNear, for gib chunks), S.particleRange (isNearFx, for most particle
// effects) or CAR_SMOKE_RANGE_SHARE of that (isNearCarSmoke, for a car's own tyre, engine and terrible-trait smoke —
// see below) of the camera: further than that, neither made, simulated nor drawn (the marks a gib leaves always are)
const distSq = o => (o.x - camera.position.x)**2 + (o.y - camera.position.y)**2 + (o.z - camera.position.z)**2;
export const isNear = o => distSq(o) <= S.gibRange*S.gibRange;
const isNearFx = o => distSq(o) <= S.particleRange*S.particleRange;
const CAR_SMOKE_RANGE_SHARE = 0.5; // ordinary car smoke is drawn out to only half S.particleRange — it's the most frequent particle by far, so it's the first to go as the camera pulls back
const isNearCarSmoke = o => distSq(o) <= (S.particleRange*CAR_SMOKE_RANGE_SHARE)**2;
// A particle's priority (see pushFx) when nothing else says otherwise: 0. A car's own tyre, engine and terrible-trait
// smoke — the most frequent particle in the game, since any car on the road can be spouting it at any time — is marked
// down to CAR_SMOKE_PRIORITY instead, so it can only ever crowd out more of its own kind, never a splash, an
// explosion, or anything else worth seeing.
const CAR_SMOKE_PRIORITY = -1;
// Add `particle` to fx, staying within fxCap(): once full, evicts the oldest particle no higher a priority than this
// one (particle.priority, default 0 — see CAR_SMOKE_PRIORITY above and the splash's priority 1), so a flood of
// ordinary smoke from nearby traffic can't crowd out something more important before it's had its moment. If every
// existing particle already outranks this one, the new one is simply dropped rather than displacing something better.
function pushFx(particle) {
  if (fx.length >= fxCap()) {
    const priority = particle.priority ?? 0;
    const evict = fx.findIndex(p => (p.priority ?? 0) <= priority);
    if (evict === -1) return; // (everything already alive outranks this one — drop it rather than displace something better)
    fx.splice(evict, 1);
  }
  fx.push(particle);
}
// the chunks thrown out from `at` (where feet or wheels were), `height` tall, one call per material of them: [color, how
// many, how big (as a fraction of height)] — `power` throws them further and faster and spreads them wider (a car's
// explosion, much more violent than a person's, uses a bigger one; see explodeCar); `ground` is the height they land on
// (default: where they start from), or a function of (x, z) that finds it, for chunks thrown from the air, which each land
// on whatever is below where they come down
// The ground a thrown piece at (x, y, z) moving at (vx, vy, vz) comes down on: found under where it lands if it fell to
// `fromGround`, the ground under where it started. `groundAt(x, z)` finds the ground there.
export function landingGround(piece, fromGround, groundAt) {
  const fall = Math.max(0, (piece.vy + Math.sqrt(piece.vy*piece.vy + 2*GRAVITY*Math.max(0, piece.y - fromGround)))/GRAVITY);
  return groundAt(piece.x + piece.vx*fall, piece.z + piece.vz*fall);
}
function spawnParts(at, height, parts, power = 1, ground = at.y, momentum = null, amount = S.gibAmount, pool = fleshPool) {
  if (!S.showGibs || amount <= 0 || !isNear(at)) return;
  const now = performance.now()/1000;
  const groundAtStart = typeof ground === 'function' ? ground(at.x, at.z) : ground;
  parts.forEach(([color, count, size]) => {
    const scaled = count*amount, chunks = Math.floor(scaled) + (Math.random() < scaled % 1 ? 1 : 0); // (a fractional amount rounds at random, so small counts still scale)
    for (let k=0;k<chunks;k++) {
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
        // (the ground where it'll come down, going by how long it falls to the ground under where it started — a
        // surface height, same as the fixed-number `ground` case above, since updateGiblets adds its own half-size
        // on top of this to find where it actually comes to rest; adding that here too used to double it up, floating
        // every chunk that fell this way — a bee's flecks, now also anyone's or a car's — twice its own size too high)
        chunk.ground = landingGround(chunk, groundAtStart, ground);
      }
      pool.add(chunk);
    }
  });
}
// the splat left on the ground at `at`, `height` tall, in `color` (blood, or a car's scorch mark) — `sizeMul` for a bigger
// mark than the default (a car's, again — see explodeCar)
function spawnSplat(at, height, color, sizeMul = 1, soot = false) {
  if (!S.showGibs || S.gibAmount <= 0) return; // (a gib mark, not a particle — the same settings as the chunks it's left with)
  if (splats.length >= SPLATS_MAX) splats.shift();
  splats.push({ x: at.x, y: soot ? SOOT_Y : at.y + 0.015, z: at.z, size: height*(0.45 + Math.random()*0.3)*sizeMul, angle: Math.random()*Math.PI*2, born: performance.now()/1000, color, soot });
}
// a car's fireball — bright chunks bursting up and out, quickly shrinking — and the smoke puffs that follow it, drifting up
// and slowly spreading as they thin out; and the light flash, retriggered (so overlapping explosions just relight it)
const FIRE_COLORS = [0xffdd66, 0xff9a3c, 0xff5a1f, 0xd8280f];
const PLUME_SIZE = 0.45; // how big a car explosion's fireball and smoke are, against the car's height
function explodeFx(at, height, scale = 1) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  height *= scale;
  const spread = Math.sqrt(scale); // (a bigger blast throws its fire and smoke further out, not just bigger)
  const now = performance.now()/1000;
  for (let k=0;k<30;k++) {
    const angle = Math.random()*Math.PI*2, outward = (3 + Math.random()*9)*spread;
    pushFx({ kind: 'fire', x: at.x, y: at.y + height*0.2, z: at.z,
      vx: Math.cos(angle)*outward, vy: (5 + Math.random()*9)*spread, vz: Math.sin(angle)*outward,
      size: height*PLUME_SIZE*(0.36 + Math.random()*0.36), life: 0.45 + Math.random()*0.4,
      color: new THREE.Color(FIRE_COLORS[Math.floor(Math.random()*FIRE_COLORS.length)]), born: now });
  }
  for (let k=0;k<20;k++) {
    const angle = Math.random()*Math.PI*2, outward = (0.7 + Math.random()*2.8)*spread;
    const grey = 0.12 + Math.random()*0.14;
    pushFx({ kind: 'smoke', x: at.x, y: at.y + height*0.3, z: at.z,
      vx: Math.cos(angle)*outward, vy: 1.7 + Math.random()*2.4, vz: Math.sin(angle)*outward,
      size: height*PLUME_SIZE*(0.55 + Math.random()*0.55), life: 3.2 + Math.random()*2.4,
      color: new THREE.Color(grey, grey, grey), born: now + Math.random()*0.2 });
  }
  flash.position.set(at.x, at.y + height*0.35, at.z);
  flash.distance = 26 + height*5;
  flashDuration = 0.5;
  flashBorn = now; flashUntil = now + flashDuration;
}
// a car going under water — no fireball, no flash: fine spray (its own 'spray' fx kind, a vivid-blue reworking of
// explodeFx's fireball burst, but under extra-strong gravity so it snaps into a tight, obvious arc) thrown up and out
// of where it went down; bigger chunks of foam (the 'foam' fx kind, below) rising and falling with it just as heavily,
// dark blue through to near-white; and a puff of pale spray mist (the 'smoke' fx kind) following it up — all fading
// away rather than drifting off like real smoke would
const SPRAY_COLORS = [0x00e5ff, 0x00aaff, 0x2979ff, 0x40e0ff]; // vivid cyan through to a saturated blue
const SPLASH_PLUME_SIZE = 0.55;
const FOAM_DARK = new THREE.Color(0x1c4a63), FOAM_LIGHT = new THREE.Color(0xf4fcff); // (each foam chunk's own colour is a random point between these)
const FOAM_SIZE = 1.1; // bigger than the fine droplets — clumps of foam, not spray
const SPLASH_GRAVITY = GRAVITY*2.5; // much heavier than real gravity — droplets and foam snap back down hard and fast, rather than floating like embers
// upward launch speed [least, most] for spray and foam — this is what controls how high the splash goes (peak height = vy0²/(2*SPLASH_GRAVITY))
const SPRAY_LAUNCH_SPEED = [9.5, 16.5], FOAM_LAUNCH_SPEED = [6.5, 13.5];
// how long a droplet launched at vy0 (under SPLASH_GRAVITY) takes to arc back down to the height it went up from — its
// life is pinned to this (plus a short tail) so it visibly falls before fading, rather than fading mid-rise looking
// like it flew off in a straight line
const flightTime = vy0 => 2*vy0/SPLASH_GRAVITY;
// an aqua car's continuous wake while it sits on water (see aquaWake, below): a gentler, steady trickle of the same
// spray and foam as the one-off death splash, at WAKE_LAUNCH_SHARE of its launch speed so it barely leaves the
// surface rather than erupting every frame. Thrown from WAKE_SPOTS points round the car (its middle and both sides),
// each an equal share of the totals below, so the water visibly disturbs all along its length, not just at its centre.
const WAKE_LAUNCH_SHARE = 0.35, WAKE_SPRAY_PER_SECOND = 30, WAKE_FOAM_PER_SECOND = 14, WAKE_SPOTS = 3;
function splashFx(at, height, mist = true) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<36;k++) { // (fine spray — a short, contained pop up and out, then snapping back down under the heavy gravity)
    const angle = Math.random()*Math.PI*2, outward = 1 + Math.random()*3, vy0 = SPRAY_LAUNCH_SPEED[0] + Math.random()*(SPRAY_LAUNCH_SPEED[1] - SPRAY_LAUNCH_SPEED[0]);
    pushFx({ kind: 'spray', priority: 1, x: at.x, y: at.y, z: at.z, // (priority 1: a nearby car's ambient smoke can't crowd this out)
      vx: Math.cos(angle)*outward, vy: vy0, vz: Math.sin(angle)*outward,
      size: height*SPLASH_PLUME_SIZE*(0.16 + Math.random()*0.22), life: flightTime(vy0) + 0.15 + Math.random()*0.15,
      color: new THREE.Color(SPRAY_COLORS[Math.floor(Math.random()*SPRAY_COLORS.length)]), born: now });
  }
  for (let k=0;k<18;k++) { // (fat clumps of foam, thrown up with it and falling back just as hard)
    const angle = Math.random()*Math.PI*2, outward = 0.6 + Math.random()*2, vy0 = FOAM_LAUNCH_SPEED[0] + Math.random()*(FOAM_LAUNCH_SPEED[1] - FOAM_LAUNCH_SPEED[0]);
    pushFx({ kind: 'foam', priority: 1, x: at.x, y: at.y, z: at.z, // (priority 1, same as the spray)
      vx: Math.cos(angle)*outward, vy: vy0, vz: Math.sin(angle)*outward,
      size: height*FOAM_SIZE*(0.15 + Math.random()*0.24), life: flightTime(vy0) + 0.2 + Math.random()*0.2,
      color: new THREE.Color().lerpColors(FOAM_DARK, FOAM_LIGHT, Math.random()), born: now });
  }
  if (!mist) return;
  for (let k=0;k<16;k++) { // (a low ring of white spray mist round the splash — ordinary priority, same as any other smoke)
    const angle = Math.random()*Math.PI*2, outward = 0.6 + Math.random()*2.6;
    pushFx({ kind: 'smoke', x: at.x, y: at.y + height*0.05, z: at.z,
      vx: Math.cos(angle)*outward, vy: 1.4 + Math.random()*2, vz: Math.sin(angle)*outward,
      size: height*SPLASH_PLUME_SIZE*(0.4 + Math.random()*0.4), life: 0.6 + Math.random()*0.4,
      color: new THREE.Color(0xf3fbfd), born: now + Math.random()*0.08 });
  }
}

// A few small puffs of light smoke round `at` (where feet were), `height` tall, floating up and thinning out in a second or two.
export function puffSmoke(at, height, count = 6) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<count;k++) {
    const angle = Math.random()*Math.PI*2, outward = 0.2 + Math.random()*0.8, grey = 0.55 + Math.random()*0.2;
    pushFx({ kind: 'smoke', x: at.x + Math.cos(angle)*0.25*height, y: at.y + height*(0.1 + Math.random()*0.5), z: at.z + Math.sin(angle)*0.25*height,
      vx: Math.cos(angle)*outward, vy: 0.6 + Math.random()*0.8, vz: Math.sin(angle)*outward,
      size: height*(0.12 + Math.random()*0.1), life: 1 + Math.random()*0.8, color: new THREE.Color(grey, grey, grey), born: now });
  }
}

// ---- soft particles: glow and smoke drawn as camera-facing discs fading out to their edges, each with its own opacity.
// `glow` adds its light to what's behind it (a car's aura and flames); `smoke` covers it.
const SOFT_MESH_CAP = 750; // each soft mesh's own capacity — a ceiling maxParticles is clamped under, not a target
const softCap = () => Math.max(0, Math.min(SOFT_MESH_CAP, Math.round(S.maxParticles)));
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
function softMesh(blending, name, texture = softTexture) {
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, blending });
  const geometry = new THREE.PlaneGeometry(1, 1), alpha = addInstanceAlpha(geometry, material, SOFT_MESH_CAP);
  const mesh = instancedMesh(geometry, material, SOFT_MESH_CAP, name);
  mesh.setColorAt(0, new THREE.Color());
  mesh.userData.alpha = alpha;
  return mesh;
}
const glowMesh = softMesh(THREE.AdditiveBlending, 'GlowFx'), smokeMesh = softMesh(THREE.NormalBlending, 'SmokeFx');
// a four-pointed sparkle glint (two crossed elongated diamonds, blurred, over a soft core glow), for a legendary car's shimmer
const sparkleTexture = (() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.translate(32, 32);
  ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 9;
  const spike = (long, short) => { ctx.beginPath(); ctx.moveTo(0, -long); ctx.lineTo(short, 0); ctx.lineTo(0, long); ctx.lineTo(-short, 0); ctx.closePath(); ctx.fill(); };
  spike(30, 2.5);
  ctx.rotate(Math.PI/2); spike(30, 2.5); ctx.rotate(-Math.PI/2);
  ctx.shadowBlur = 0;
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 9);
  core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI*2); ctx.fill();
  return new THREE.CanvasTexture(canvas);
})();
const sparkleMesh = softMesh(THREE.AdditiveBlending, 'SparkleFx', sparkleTexture);
glowMesh.renderOrder = smokeMesh.renderOrder = sparkleMesh.renderOrder = 2;
// A single sparkle glint at `at`, tinted `color`, for a legendary car's shimmer — a soft pop in and out, spinning slowly.
export function sparkleFx(at, color, size = 0.35) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  if (softParticles.length >= softCap()*2) softParticles.shift();
  softParticles.push({ kind: 'sparkle', born: performance.now()/1000, still: true, x: at.x, y: at.y, z: at.z,
    size, life: 0.5 + Math.random()*0.3, opacity: 1, color: new THREE.Color(color),
    roll: Math.random()*Math.PI*2, spin: (Math.random() < 0.5 ? -1 : 1)*1.5, growth: 0 });
}

// What a burning car gives off in the `dt` seconds since it was last called: a soft red glow round it, red, orange and yellow puffs
// rising from it and dark smoke drifting away; `at` where its wheels are, `height` its height.
const BURN_FLAME_COLORS = [0xffdd33, 0xff9a1a, 0xff4a14, 0xd8280f], BURN_AURA_COLOR = new THREE.Color(0xff6a12);
const BURN_FLAMES_PER_SECOND = 30, BURN_SMOKE_PER_SECOND = 10;
const BURN_AURA_SIZE = 2.2, BURN_AURA_OPACITY = 0.12; // (the aura's size is a multiple of the car's height)
export function burnFx(at, height, dt) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000, count = rate => Math.floor(rate*dt + Math.random());
  const add = particle => { if (softParticles.length >= softCap()*2) softParticles.shift(); softParticles.push({ born: now, ...particle }); };
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
// `priority` and `near` (see pushFx and isNearFx/isNearCarSmoke) default to ordinary particle rules; a car's own tyre
// and engine smoke (below) instead pass CAR_SMOKE_PRIORITY and isNearCarSmoke, being the most frequent particle around.
function solidPuffs(at, height, count, colorAt, { size, life, rise, spread = 0.25, outward = [0.2, 0.8], lift = 0.3, alpha = 1, priority = 0, near = isNearFx }) {
  if (S.maxParticles <= 0 || !near(at)) return;
  const now = performance.now()/1000, between = ([least, most]) => least + Math.random()*(most - least);
  for (let k=0;k<count;k++) {
    const angle = Math.random()*Math.PI*2, out = between(outward);
    pushFx({ kind: 'smoke', priority, x: at.x + Math.cos(angle)*spread*height, y: at.y + height*lift, z: at.z + Math.sin(angle)*spread*height,
      vx: Math.cos(angle)*out, vy: between(rise), vz: Math.sin(angle)*out, size: height*between(size), life: between(life), color: colorAt(), alpha, born: now });
  }
}
const puffColor = colors => () => new THREE.Color(colors[Math.floor(Math.random()*colors.length)]);
// Small black puffs from a tyre at `at` over the `dt` seconds since it was last called, for a car that's boosting; `height` is the car's.
// The most frequent particle in the game — any car on the road can be boosting at any time — so it's drawn out to only
// half the usual particle range (isNearCarSmoke) and marked down to CAR_SMOKE_PRIORITY, so it never crowds out anything else.
const TYRE_SMOKE_PER_SECOND = 25, TYRE_RED_SHARE = 0.25, TYRE_RED_ALPHA = 1/3; // (dark brown puffs alongside the black: how many as many, and how opaque as a share of the usual 0.6 — 20% overall)
export function tyreSmoke(at, height, dt) {
  solidPuffs(at, height, Math.floor(TYRE_SMOKE_PER_SECOND*dt + Math.random()), () => { const grey = 0.04 + Math.random()*0.08; return new THREE.Color(grey, grey, grey); },
    { size: [0.08, 0.14], life: [0.7, 1.2], rise: [0.3, 0.8], spread: 0.05, outward: [0.1, 0.4], lift: 0.08, priority: CAR_SMOKE_PRIORITY, near: isNearCarSmoke });
  solidPuffs(at, height, Math.floor(TYRE_SMOKE_PER_SECOND*TYRE_RED_SHARE*dt + Math.random()), puffColor([0x110600]),
    { size: [0.1, 0.18], life: [0.7, 1.2], rise: [0.3, 0.8], spread: 0.05, outward: [0.1, 0.4], lift: 0.08, alpha: TYRE_RED_ALPHA, priority: CAR_SMOKE_PRIORITY, near: isNearCarSmoke });
}
// A drifting car's tyre at `at` over the `dt` seconds since it was last called (`height` the car's): thick pale smoke
// billowing out and a spray of orange sparks skittering off the road — meant to read at a glance, so it keeps normal
// particle range and priority, unlike tyreSmoke.
const DRIFT_SMOKE_PER_SECOND = 45, DRIFT_SPARKS_PER_SECOND = 30;
export function driftSmoke(at, height, dt) {
  solidPuffs(at, height, Math.floor(DRIFT_SMOKE_PER_SECOND*dt + Math.random()), () => { const grey = 0.7 + Math.random()*0.2; return new THREE.Color(grey, grey, grey); },
    { size: [0.18, 0.34], life: [0.9, 1.6], rise: [0.4, 1.1], spread: 0.08, outward: [0.4, 1.2], lift: 0.08 });
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000;
  for (let k = Math.floor(DRIFT_SPARKS_PER_SECOND*dt + Math.random()); k > 0; k--) {
    const angle = Math.random()*Math.PI*2, outward = 1 + Math.random()*3;
    pushFx({ kind: 'fire', x: at.x, y: at.y + 0.02, z: at.z, vx: Math.cos(angle)*outward, vy: 0.5 + Math.random()*2, vz: Math.sin(angle)*outward,
      size: 0.04 + Math.random()*0.05, life: 0.15 + Math.random()*0.25, color: new THREE.Color(FIRE_COLORS[Math.random() < 0.5 ? 0 : 1]), born: now });
  }
}
// Smoke from a stalled engine at `at`, `height` tall: plenty of grey puffs, climbing high. Same reduced range and low
// priority as tyreSmoke, for the same reason.
export function engineSmoke(at, height) {
  solidPuffs(at, height, 6, () => { const grey = 0.45 + Math.random()*0.2; return new THREE.Color(grey, grey, grey); },
    { size: [0.15, 0.3], life: [1.5, 2.5], rise: [2.5, 5], spread: 0.15, outward: [0.1, 0.5], lift: 0.3, priority: CAR_SMOKE_PRIORITY, near: isNearCarSmoke });
}
// Heavy black smoke from underneath a terrible car over the `dt` seconds since it was last called, at `at` (`height`
// tall, `width` wide, `heading` which way it's facing, `speed` how fast along it — so the puffs can start out moving
// with it rather than being left behind at once) — small and plentiful, the more of it the more terrible it is
// (`level`), pushed out to both sides as far as the car is wide before curving upward (see terribleSmoke's `accel`,
// read by updateGiblets). Every puff is spawned as a mirrored pair, one to each side — spawning a single puff with a
// side picked at random (or alternated by index) reliably favours one side, since most calls only spawn zero or one.
// Any car with the terrible trait puts this out constantly, so — like tyreSmoke and engineSmoke — it's drawn out to
// only half the usual particle range and marked down to CAR_SMOKE_PRIORITY.
const TERRIBLE_SMOKE_PER_SECOND = 24, TERRIBLE_SMOKE_LIFT = 1.5; // per level of `terrible`; how hard the curve up kicks in
export function terribleSmoke(at, height, width, dt, level, heading, speed) {
  if (S.maxParticles <= 0 || !isNearCarSmoke(at)) return;
  const now = performance.now()/1000, sideX = Math.cos(heading), sideZ = -Math.sin(heading);
  const alongX = Math.sin(heading)*speed, alongZ = Math.cos(heading)*speed; // (keeps pace with the car for a moment, so it reads as spreading to the sides rather than trailing behind)
  const count = Math.floor(TERRIBLE_SMOKE_PER_SECOND*level*dt + Math.random());
  for (let k=0;k<count;k++) {
    const out = width*(0.55 + Math.random()*0.35), grey = 0.03 + Math.random()*0.05;
    [1, -1].forEach(side => {
      const jitter = (Math.random() - 0.5)*0.3;
      pushFx({ kind: 'smoke', priority: CAR_SMOKE_PRIORITY, x: at.x, y: at.y + height*0.08, z: at.z,
        vx: alongX + sideX*out*side + jitter, vz: alongZ + sideZ*out*side + jitter, vy: 0.15 + Math.random()*0.2, accel: TERRIBLE_SMOKE_LIFT,
        size: height*(0.1 + Math.random()*0.14), life: 1.8 + Math.random()*1.2, color: new THREE.Color(grey, grey, grey), born: now });
    });
  }
}
// A burst of red, orange and yellow puffs as a car catches fire, from `at` (where its wheels are), `height` tall.
const IGNITE_COLORS = [0xffdd33, 0xff9a1a, 0xff4a14, 0xd8280f];
export function igniteFx(at, height) {
  solidPuffs(at, height, 14, puffColor(IGNITE_COLORS), { size: [0.2, 0.35], life: [0.6, 1.1], rise: [1, 2.5], spread: 0.3, outward: [0.8, 2.2], lift: 0.4 });
}

// A burst of `count` small bright sparks flying out from `at` and quickly dying, for metal hitting metal.
export function sparks(at, count = 8) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<count;k++) {
    const angle = Math.random()*Math.PI*2, outward = 2 + Math.random()*5;
    pushFx({ kind: 'fire', x: at.x, y: at.y, z: at.z, vx: Math.cos(angle)*outward, vy: 1 + Math.random()*4, vz: Math.sin(angle)*outward,
      size: 0.05 + Math.random()*0.05, life: 0.25 + Math.random()*0.3, color: new THREE.Color(FIRE_COLORS[Math.random() < 0.6 ? 0 : 1]), born: now });
  }
}

// Blows someone up: `at` where their feet were, `height` how tall they were, `colors` what they were made of — { skin, top,
// pants, shoes, hair } as THREE.Colors (hair null for someone bald). `momentum` ({ x, y, z } in units a second) is the velocity
// of whatever struck them, which every chunk keeps on top of its own throw (none for a blast, which has no direction).
export function explode(at, height, colors, momentum = null) {
  // (only blood when their own body parts are thrown instead: see peopleGibs.js)
  const parts = [];
  if (colors.skin) parts.push([colors.skin, 16, 0.075]);
  if (colors.top) parts.push([colors.top, 10, 0.08]);
  if (colors.pants) parts.push([colors.pants, 9, 0.08]);
  if (colors.shoes) parts.push([colors.shoes, 4, 0.06]);
  if (colors.hair) parts.push([colors.hair, 5, 0.065]);
  if (colors.eyes) parts.push([new THREE.Color(EYE_COLOR), 2, 0.035]);
  const blood = BLOOD_COLORS.map((hex, k) => [new THREE.Color(hex), Math.floor(PERSON_BLOOD_CHUNKS/BLOOD_COLORS.length) + (k < PERSON_BLOOD_CHUNKS % BLOOD_COLORS.length ? 1 : 0), 0.028]);
  // (a function, not the fixed height they died at: a chunk thrown out over a bank or into water needs its own ground —
  // or none at all, if it's water, which updateGiblets catches on the way down — rather than landing back at their feet's height)
  const groundAt = (x, z) => groundBelow(x, at.y, z, NO_GROUND_FALLBACK);
  spawnParts(at, height, parts, 1, groundAt, momentum);
  spawnParts(at, height, blood, 1, groundAt, momentum, S.gibAmount, bloodPool);
  spawnSplat(at, height, BLOOD_SPLAT_COLOR);
  playSound('gib', at);
}
// A few chunks of blood thrown from `at` (`height` tall), `count` of them whatever the gib amount setting is; `momentum` as for explode.
export function spillBlood(at, height, count, momentum = null) {
  spawnParts(at, height, Array.from({ length: count }, (_, k) => [new THREE.Color(BLOOD_COLORS[k % BLOOD_COLORS.length]), 1, 0.028]), 0.6, (x, z) => groundBelow(x, at.y, z, NO_GROUND_FALLBACK), momentum, 1, bloodPool);
}
// Bursts a bee in mid-air: a few flecks of its yellow, black and wing, `size` long — small and soft-thrown, each falling to
// whatever ground is below it (`fallbackGround` where there's nothing), and no mark on it.
export function explodeBee(at, size, fallbackGround) {
  const parts = [[new THREE.Color(0xffeb2b), 6, 0.3], [new THREE.Color(0x1c1c1c), 4, 0.26], [new THREE.Color(0xdfe8f0), 3, 0.22]];
  spawnParts(at, size, parts, 0.25, (x, z) => groundBelow(x, at.y, z, fallbackGround));
  playSound('pop', at);
}
// A fireball, smoke and scorch mark with nothing thrown: an explosive person going up (see killPerson in people/people.js).
export function blastFx(at, height, scale = 1) {
  spawnSplat(at, height*scale, SCORCH_SPLAT_COLOR, SOOT_SIZE, true);
  explodeFx(at, height, scale);
  playSound('explosion', at);
}
// Blows a car up: `at` where its wheels were, `height` how tall it was, `colors.paint` its own color — chunks of it, bigger
// and thrown much further than a person's (see spawnParts' `power`), in its paint and (standing in for glass, trim and
// tires) CAR_TRIM_COLORS, sooty flecks, a big scorch mark rather than blood, and a fireball with smoke (see explodeFx) — `scale`
// times as big for an explosive car.
export function explodeCar(at, height, colors, scale = 1) {
  // (a wreck — a car or an aircraft, whose own body comes apart in blocks: see car-wrecks.js — needs only its glass and
  // a few scorched flecks)
  const parts = colors.wrecked ? [[new THREE.Color(CAR_GLASS_COLOR), WRECK_GLASS_CHUNKS, 0.06]]
    : [[colors.paint, 32, 0.17], [new THREE.Color(CAR_TRIM_COLORS[0]), 16, 0.13], [new THREE.Color(CAR_TRIM_COLORS[1]), 10, 0.11]];
  SCORCH_COLORS.forEach(hex => parts.push([new THREE.Color(hex), colors.wrecked ? WRECK_SCORCH_CHUNKS : 14, 0.055]));
  spawnParts(at, height, parts, 2.2, (x, z) => groundBelow(x, at.y, z, NO_GROUND_FALLBACK)); // (its own ground per chunk, same reasoning as explode, above — wreckage can fly a lot further than a person's gibs, easily far enough to clear a bank into water)
  spawnSplat(at, height*scale, SCORCH_SPLAT_COLOR, SOOT_SIZE, true);
  explodeFx(at, height, scale);
  playSound('explosion', at);
}
// Takes a car under at the water's surface: `at` where it went down, `height` how tall it was — no wreckage and no
// fireball, just its own splash (splashFx) thrown up and out of the water in its place. Call it once per point that
// should splash (see waterAxleSpots in life/traffic/driving.js, called once per set of wheels for a long vehicle like a bus)
// rather than passing a size multiplier — that way a bus's splash reads as disturbed water spread along it, not one
// oversized splash in the middle.
export function splashCar(at, height, volume = 1) {
  splashFx(at, height);
  playSound('splash', at, volume);
}
// Water thrown up by something coming up out of it (see surfacing and climbOut in life/people/peopleWater.js): the spray
// and foam of splashCar, without its mist or its sound.
export function splashUp(at, height) {
  splashFx(at, height, false);
}
// An aqua car's wake while it's actually settled on water (see updateFloating in life/traffic/driving.js), called every frame
// it's there: a steady trickle of spray and foam over the `dt` seconds since last called, round `at` (its position,
// `height` tall, `width` wide, `heading` which way it's facing) — the same particles as splashCar's one-off death
// splash, just far lighter and slower (WAKE_LAUNCH_SHARE), so the water reads as disturbed the whole time it's
// floating rather than just at the moment it went in or came out. Split evenly across WAKE_SPOTS points along its
// width (its middle, and both sides out to half its width), so the disturbance reads as coming from all round the
// car sitting in the water rather than a single point under its centre. As with splashCar, call it once per point
// along a long vehicle's length that should have its own wake (waterAxleSpots, life/traffic/driving.js) rather than scaling
// it up in place. `share` scales how much it throws (aqua people: see peopleWater.js).
export function aquaWake(at, height, width, heading, dt, share = 1) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000, sideX = Math.cos(heading), sideZ = -Math.sin(heading);
  const spots = [{ x: at.x, z: at.z }, { x: at.x + sideX*width*0.5, z: at.z + sideZ*width*0.5 }, { x: at.x - sideX*width*0.5, z: at.z - sideZ*width*0.5 }];
  spots.forEach(spot => {
    for (let k=0;k<Math.floor(WAKE_SPRAY_PER_SECOND/WAKE_SPOTS*dt*share + Math.random());k++) {
      const angle = Math.random()*Math.PI*2, outward = 0.5 + Math.random()*1.5,
        vy0 = (SPRAY_LAUNCH_SPEED[0] + Math.random()*(SPRAY_LAUNCH_SPEED[1] - SPRAY_LAUNCH_SPEED[0]))*WAKE_LAUNCH_SHARE;
      pushFx({ kind: 'spray', priority: 1, x: spot.x, y: at.y, z: spot.z,
        vx: Math.cos(angle)*outward, vy: vy0, vz: Math.sin(angle)*outward,
        size: height*SPLASH_PLUME_SIZE*(0.1 + Math.random()*0.14), life: flightTime(vy0) + 0.1 + Math.random()*0.1,
        color: new THREE.Color(SPRAY_COLORS[Math.floor(Math.random()*SPRAY_COLORS.length)]), born: now });
    }
    for (let k=0;k<Math.floor(WAKE_FOAM_PER_SECOND/WAKE_SPOTS*dt*share + Math.random());k++) {
      const angle = Math.random()*Math.PI*2, outward = 0.3 + Math.random()*1,
        vy0 = (FOAM_LAUNCH_SPEED[0] + Math.random()*(FOAM_LAUNCH_SPEED[1] - FOAM_LAUNCH_SPEED[0]))*WAKE_LAUNCH_SHARE;
      pushFx({ kind: 'foam', priority: 1, x: spot.x, y: at.y, z: spot.z,
        vx: Math.cos(angle)*outward, vy: vy0, vz: Math.sin(angle)*outward,
        size: height*FOAM_SIZE*(0.1 + Math.random()*0.15), life: flightTime(vy0) + 0.15 + Math.random()*0.15,
        color: new THREE.Color().lerpColors(FOAM_DARK, FOAM_LIGHT, Math.random()), born: now });
    }
  });
}
// A boosting aqua car's rooster-tail wake off its back while it's on water, in place of its (disabled) tyre smoke —
// see boostSmoke in life/traffic/driving.js. `at` is a single point at its very rear (even for a long vehicle like a bus,
// which keeps this to the one trail off the back, unlike its splash and idling wake — see waterAxleSpots, life/traffic/driving.js),
// `height` how tall it is, `heading` which way it's facing (thrown out backward from that, in a BOOST_WAKE_ARC-wide
// fan, rather than aquaWake's calmer, all-round trickle) over the `dt` seconds since last called. Bigger and faster
// than the ordinary wake (BOOST_WAKE_SIZE_SHARE, and its own share of the launch speed) — a boat gunning it throws up
// a lot more water than one just sitting there.
const BOOST_WAKE_ARC = Math.PI*0.7, BOOST_WAKE_SPRAY_PER_SECOND = 40, BOOST_WAKE_FOAM_PER_SECOND = 22, BOOST_WAKE_SIZE_SHARE = 1.8, BOOST_WAKE_LAUNCH_SHARE = WAKE_LAUNCH_SHARE*1.5;
export function boostWake(at, height, heading, dt) {
  if (S.maxParticles <= 0 || !isNearFx(at)) return;
  const now = performance.now()/1000, back = heading + Math.PI;
  for (let k=0;k<Math.floor(BOOST_WAKE_SPRAY_PER_SECOND*dt + Math.random());k++) {
    const angle = back + (Math.random() - 0.5)*BOOST_WAKE_ARC, outward = 2 + Math.random()*4,
      vy0 = (SPRAY_LAUNCH_SPEED[0] + Math.random()*(SPRAY_LAUNCH_SPEED[1] - SPRAY_LAUNCH_SPEED[0]))*BOOST_WAKE_LAUNCH_SHARE;
    pushFx({ kind: 'spray', priority: 1, x: at.x, y: at.y, z: at.z,
      vx: Math.sin(angle)*outward, vy: vy0, vz: Math.cos(angle)*outward,
      size: height*SPLASH_PLUME_SIZE*BOOST_WAKE_SIZE_SHARE*(0.16 + Math.random()*0.22), life: flightTime(vy0) + 0.15 + Math.random()*0.15,
      color: new THREE.Color(SPRAY_COLORS[Math.floor(Math.random()*SPRAY_COLORS.length)]), born: now });
  }
  for (let k=0;k<Math.floor(BOOST_WAKE_FOAM_PER_SECOND*dt + Math.random());k++) {
    const angle = back + (Math.random() - 0.5)*BOOST_WAKE_ARC, outward = 1.5 + Math.random()*3,
      vy0 = (FOAM_LAUNCH_SPEED[0] + Math.random()*(FOAM_LAUNCH_SPEED[1] - FOAM_LAUNCH_SPEED[0]))*BOOST_WAKE_LAUNCH_SHARE;
    pushFx({ kind: 'foam', priority: 1, x: at.x, y: at.y, z: at.z,
      vx: Math.sin(angle)*outward, vy: vy0, vz: Math.cos(angle)*outward,
      size: height*FOAM_SIZE*BOOST_WAKE_SIZE_SHARE*(0.15 + Math.random()*0.24), life: flightTime(vy0) + 0.2 + Math.random()*0.2,
      color: new THREE.Color().lerpColors(FOAM_DARK, FOAM_LIGHT, Math.random()), born: now });
  }
}

const placed = new THREE.Object3D(), spinStep = new THREE.Quaternion(), dimmed = new THREE.Color();
const sparkleAxis = new THREE.Vector3(0, 0, 1), sparkleRoll = new THREE.Quaternion(); // (a sparkle spins about the camera's view axis)
const GIB_SPLASH_SPEED = 3.5; // launch speed of the single droplet flicked up where a falling gib goes under open water (updateGiblets, below) — under the same SPLASH_GRAVITY as any other spray, so it snaps back down just as heavily
let lastTime = null;
// how far through sinking away something is, 0 until it starts
const sunk = (age, life) => age > life ? Math.min(1, (age - life)/SINK_TIME) : 0;
// One step of a thrown piece falling, bouncing and sliding to rest on `piece.ground`, its middle held `lift` above it.
// `splashSize` is how big the droplet is. Returns false once it's gone under open water (with a droplet flicked up where it went in), for the caller to drop it.
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
// A fixed ring of chunks drawn by one instanced mesh. Each chunk keeps its instance for life, so its color is written
// once and, lying still, so is its place; only what changed is uploaded. A new chunk takes the oldest one's instance.
class ChunkPool {
  constructor(mesh, capacity, lifeShare = 1) {
    Object.assign(this, { mesh, capacity, lifeShare, slots: new Array(capacity).fill(null), cursor: 0, used: 0 });
    for (let i=0;i<capacity;i++) mesh.setMatrixAt(i, HIDDEN);
    this.matrixRange = [Infinity, -1]; this.colorRange = [Infinity, -1];
  }
  life() { return GIBLET_LIFE*S.gibLifetime*this.lifeShare; }
  add(chunk) {
    const slot = this.cursor;
    this.cursor = (slot + 1) % this.capacity;
    this.used = Math.max(this.used, slot + 1);
    if (this.slots[slot]) this.hide(slot);
    chunk.shown = false;
    this.slots[slot] = chunk;
    this.mesh.setColorAt(slot, chunk.color);
    this.touch(this.colorRange, slot);
  }
  touch(range, slot) { range[0] = Math.min(range[0], slot); range[1] = Math.max(range[1], slot); }
  hide(slot) { this.mesh.setMatrixAt(slot, HIDDEN); this.touch(this.matrixRange, slot); }
  remove(slot) { this.slots[slot] = null; this.hide(slot); }
  clear() { for (let i=0;i<this.used;i++) if (this.slots[i]) this.remove(i); }
  update(t, dt) {
    const life = this.life();
    for (let i=0;i<this.used;i++) {
      const g = this.slots[i];
      if (!g) continue;
      const age = t - g.born;
      if (age > life + SINK_TIME) { this.remove(i); continue; }
      if (!isNear(g)) { if (g.shown) { this.hide(i); g.shown = false; } continue; }
      if (!fallStep(g, dt, t, g.size*g.shape.y, g.size*0.6)) { this.remove(i); continue; }
      const sink = sunk(age, life);
      if (g.resting && !sink && g.shown) continue; // (lying still: already where it's drawn)
      placed.position.set(g.x, g.y - sink*g.size, g.z);
      placed.quaternion.copy(g.quaternion);
      placed.scale.copy(g.shape).multiplyScalar(g.size*(1 - sink));
      placed.updateMatrix();
      this.mesh.setMatrixAt(i, placed.matrix);
      this.touch(this.matrixRange, i);
      g.shown = true;
    }
    this.mesh.count = this.used;
    this.flush(this.mesh.instanceMatrix, this.matrixRange, 16);
    if (this.mesh.instanceColor) this.flush(this.mesh.instanceColor, this.colorRange, 3);
  }
  flush(attribute, range, size) {
    if (range[1] < 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(range[0]*size, (range[1] - range[0] + 1)*size);
    attribute.needsUpdate = true;
    range[0] = Infinity; range[1] = -1;
  }
}
const fleshPool = new ChunkPool(chunkMesh, GIBLETS_MAX), bloodPool = new ChunkPool(bloodChunkMesh, BLOOD_CHUNKS_MAX, BLOOD_LIFE_SHARE);
export function fallStep(piece, dt, t, lift, splashSize = lift) {
  if (piece.resting) return true;
  piece.vy -= GRAVITY*dt;
  piece.x += piece.vx*dt; piece.y += piece.vy*dt; piece.z += piece.vz*dt;
  if (piece.y <= WATER_LEVEL) { // open water, not solid ground below it: no floor to land on, so it goes straight through rather than coming to rest on the lakebed
    pushFx({ kind: 'spray', priority: 1, x: piece.x, y: WATER_LEVEL, z: piece.z,
      vx: (Math.random() - 0.5)*1.5, vy: GIB_SPLASH_SPEED, vz: (Math.random() - 0.5)*1.5,
      size: splashSize, life: flightTime(GIB_SPLASH_SPEED) + 0.15, color: new THREE.Color(SPRAY_COLORS[Math.floor(Math.random()*SPRAY_COLORS.length)]), born: t });
    return false;
  }
  piece.quaternion.premultiply(spinStep.setFromAxisAngle(piece.spinAxis, piece.spin*dt));
  const floor = piece.ground + lift;
  if (piece.y < floor) {
    piece.y = floor;
    if (piece.vy < -1) {
      // a bounce, losing most of its speed
      piece.vy *= -0.3; piece.vx *= 0.55; piece.vz *= 0.55; piece.spin *= 0.5;
    } else {
      // sliding to a stop
      piece.vy = 0;
      const grip = Math.max(0, 1 - 6*dt);
      piece.vx *= grip; piece.vz *= grip; piece.spin *= grip;
      if (Math.hypot(piece.vx, piece.vz) < 0.03) piece.resting = true;
    }
  }
  return true;
}
// how far through sinking away a piece born at `born` is at `t`: 0 until its life is up, 1 once it's gone
export const gibSink = (t, born) => sunk(t - born, GIBLET_LIFE*S.gibLifetime);
export const gibGone = (t, born) => t - born > GIBLET_LIFE*S.gibLifetime + SINK_TIME;
export function updateGiblets(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  while (splats.length && t - splats[0].born > SPLAT_LIFE + SINK_TIME) splats.shift();
  while (fx.length && t - fx[0].born > fx[0].life) fx.shift();
  if (!S.showGibs || S.gibAmount <= 0) { fleshPool.clear(); bloodPool.clear(); splats.length = 0; } // (turned off: what's already flying, or lying there, goes too)
  if (S.maxParticles <= 0) { fx.length = 0; softParticles.length = 0; } // (same, for particles)
  fleshPool.update(t, dt);
  bloodPool.update(t, dt);
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
    if (!isNearFx(p)) return;
    const age = t - p.born, life = Math.max(0, Math.min(1, age/p.life));
    let scale, dim;
    if (p.kind === 'fire') {
      p.vy -= GRAVITY*0.4*dt;
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      scale = p.size*(1 - life)*(1 - life); // quick burst, quicker fade
      dim = 1 - life*0.6;
    } else if (p.kind === 'spray') {
      p.vy -= SPLASH_GRAVITY*dt; // much heavier than real gravity: snaps into a tight, obvious arc rather than hanging like a fireball's embers
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      scale = p.size*(1 - life*life); // holds its size through the arc, fading only near the end
      dim = 1 - life*0.3;
    } else if (p.kind === 'foam') {
      p.vy -= SPLASH_GRAVITY*dt; // (falls hard, like a heavy droplet of water — not a fireball's puffed-up ember)
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      scale = p.size*(1 - life*life*life); // holds its size through the rise and fall, only shrinking away right at the end
      dim = 1 - life*0.3;
    } else {
      if (p.accel) p.vy += p.accel*dt; // (a steady lift kicking in over time, so it curves upward rather than rising from the start — see terribleSmoke)
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
  const drawnSoft = { glow: 0, smoke: 0, sparkle: 0 }, meshes = { glow: glowMesh, smoke: smokeMesh, sparkle: sparkleMesh };
  softParticles.forEach(p => {
    const age = t - p.born, life = age/p.life, mesh = meshes[p.kind];
    if (life > 1 || drawnSoft[p.kind] >= softCap() || !isNearFx(p)) return;
    if (!p.still) { p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt; }
    placed.position.set(p.x, p.y, p.z);
    placed.quaternion.copy(camera.quaternion);
    // a sparkle spins slowly about the view axis as it pops in and out, rather than drifting or billowing like glow/smoke
    const scale = p.kind === 'sparkle' ? p.size*Math.sin(Math.PI*Math.min(1, life))**0.5 : p.size*(1 + p.growth*(p.kind === 'glow' && !p.still ? -life : life));
    if (p.kind === 'sparkle') placed.quaternion.multiply(sparkleRoll.setFromAxisAngle(sparkleAxis, p.roll + age*p.spin));
    placed.scale.setScalar(scale);
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
