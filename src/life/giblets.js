import * as THREE from 'three';
import { scene, camera } from '../core/scene.js';
import { S } from '../core/shared.js';

// ============================================================ giblets
// What's left of someone after the person card's Kill button, or a car after the car card's: chunks of them in their own
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
splatMesh.setColorAt(0, new THREE.Color()); // (blood, or a car's scorch mark — see spawnSplat)
const fxMesh = instancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), FX_MAX, 'ExplosionFx');
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
function spawnParts(at, height, parts, power = 1, ground = at.y, momentum = null) {
  if (!S.showGibs || !isNear(at)) return;
  const now = performance.now()/1000;
  const groundAtStart = typeof ground === 'function' ? ground(at.x, at.z) : ground;
  parts.forEach(([color, count, size]) => {
    const scaled = count*S.gibAmount, chunks = Math.floor(scaled) + (Math.random() < scaled % 1 ? 1 : 0); // (a fractional amount rounds at random, so small counts still scale)
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
function spawnSplat(at, height, color, sizeMul = 1) {
  if (splats.length >= SPLATS_MAX) splats.shift();
  splats.push({ x: at.x, y: at.y + 0.015, z: at.z, size: height*(0.45 + Math.random()*0.3)*sizeMul, angle: Math.random()*Math.PI*2, born: performance.now()/1000, color });
}
// a car's fireball — bright chunks bursting up and out, quickly shrinking — and the smoke puffs that follow it, drifting up
// and slowly spreading as they thin out; and the light flash, retriggered (so overlapping explosions just relight it)
const FIRE_COLORS = [0xffdd66, 0xff9a3c, 0xff5a1f, 0xd8280f];
function explodeFx(at, height) {
  if (!isNear(at)) return;
  const now = performance.now()/1000;
  for (let k=0;k<30;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 3 + Math.random()*9;
    fx.push({ kind: 'fire', x: at.x, y: at.y + height*0.2, z: at.z,
      vx: Math.cos(angle)*outward, vy: 5 + Math.random()*9, vz: Math.sin(angle)*outward,
      size: height*(0.36 + Math.random()*0.36), life: 0.45 + Math.random()*0.4,
      color: new THREE.Color(FIRE_COLORS[Math.floor(Math.random()*FIRE_COLORS.length)]), born: now });
  }
  for (let k=0;k<20;k++) {
    if (fx.length >= FX_MAX) fx.shift();
    const angle = Math.random()*Math.PI*2, outward = 0.7 + Math.random()*2.8;
    const grey = 0.12 + Math.random()*0.14;
    fx.push({ kind: 'smoke', x: at.x, y: at.y + height*0.3, z: at.z,
      vx: Math.cos(angle)*outward, vy: 1.7 + Math.random()*2.4, vz: Math.sin(angle)*outward,
      size: height*(0.55 + Math.random()*0.55), life: 3.2 + Math.random()*2.4,
      color: new THREE.Color(grey, grey, grey), born: now + Math.random()*0.2 });
  }
  flash.position.set(at.x, at.y + height*0.35, at.z);
  flash.distance = 26 + height*5;
  flashDuration = 0.5;
  flashBorn = now; flashUntil = now + flashDuration;
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
  spawnSplat(at, height, SCORCH_SPLAT_COLOR, 1.8);
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
  splats.forEach((s, i) => {
    // (spreading out quickly as it lands)
    const age = t - s.born, spread = Math.min(1, age/0.35), size = s.size*(0.3 + 0.7*spread)*(1 - sunk(age, SPLAT_LIFE));
    placed.position.set(s.x, s.y, s.z);
    placed.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.angle);
    placed.scale.set(size, 1, size*0.8);
    placed.updateMatrix();
    splatMesh.setMatrixAt(i, placed.matrix);
    splatMesh.setColorAt(i, s.color);
  });
  splatMesh.count = splats.length;
  splatMesh.instanceMatrix.needsUpdate = true;
  if (splatMesh.instanceColor) splatMesh.instanceColor.needsUpdate = true;
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
    fxDrawn++;
  });
  fxMesh.count = fxDrawn;
  fxMesh.instanceMatrix.needsUpdate = true;
  if (fxMesh.instanceColor) fxMesh.instanceColor.needsUpdate = true;
  flash.intensity = t < flashUntil ? Math.max(0, 1 - (t - flashBorn)/flashDuration)**2*10 : 0;
}
