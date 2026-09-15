import * as THREE from 'three';
import { scene } from '../core/scene.js';

// ============================================================ giblets
// What's left of someone after the person card's Kill button: chunks of them in their own colors (skin, top, pants, shoes,
// hair, and a couple of eyes), flecks of blood, and a splat on the ground — thrown out from where they stood, falling,
// bouncing and tumbling to a stop, lying there a while, then sinking away. The chunks are all one instanced mesh, and the
// splats another.
const GIBLETS_MAX = 1500, SPLATS_MAX = 48;
const GIBLET_LIFE = 40, SPLAT_LIFE = 60, SINK_TIME = 3; // seconds before they sink away, and how long that takes
const GRAVITY = 9.8;
const BLOOD_COLORS = [0x7a0a0a, 0x9c1010, 0x5c0606];
const EYE_COLOR = 0xf4f1ea;

const giblets = [], splats = [];
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
  new THREE.MeshStandardMaterial({ color: 0x6a0707, roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), SPLATS_MAX, 'BloodSplats');
splatMesh.receiveShadow = true;

// Blows someone up: `at` where their feet were, `height` how tall they were, `colors` what they were made of — { skin, top,
// pants, shoes, hair } as THREE.Colors (hair null for someone bald).
export function explode(at, height, colors) {
  const now = performance.now()/1000;
  const parts = [[colors.skin, 16, 0.075], [colors.top, 10, 0.08], [colors.pants, 9, 0.08], [colors.shoes, 4, 0.06],
    [colors.hair, colors.hair ? 5 : 0, 0.065], [new THREE.Color(EYE_COLOR), 2, 0.035]];
  BLOOD_COLORS.forEach(hex => parts.push([new THREE.Color(hex), 9, 0.028]));
  parts.forEach(([color, count, size]) => {
    for (let k=0;k<count;k++) {
      if (giblets.length >= GIBLETS_MAX) giblets.shift(); // (the oldest make way)
      const angle = Math.random()*Math.PI*2, outward = 1 + Math.random()*4.5;
      const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      giblets.push({
        x: at.x + (Math.random() - 0.5)*0.25*height, y: at.y + height*(0.15 + Math.random()*0.75), z: at.z + (Math.random() - 0.5)*0.25*height,
        vx: Math.cos(angle)*outward, vy: 2 + Math.random()*5.5, vz: Math.sin(angle)*outward,
        ground: at.y, size: size*height*(0.6 + Math.random()*0.8),
        shape: new THREE.Vector3(0.6 + Math.random()*0.7, 0.5 + Math.random()*0.6, 0.6 + Math.random()*0.7),
        quaternion: new THREE.Quaternion().setFromAxisAngle(spinAxis, Math.random()*Math.PI*2),
        spinAxis, spin: 4 + Math.random()*14, color, born: now, resting: false,
      });
    }
  });
  if (splats.length >= SPLATS_MAX) splats.shift();
  splats.push({ x: at.x, y: at.y + 0.015, z: at.z, size: height*(0.45 + Math.random()*0.3), angle: Math.random()*Math.PI*2, born: now });
}

const placed = new THREE.Object3D(), spinStep = new THREE.Quaternion();
let lastTime = null;
// how far through sinking away something is, 0 until it starts
const sunk = (age, life) => age > life ? Math.min(1, (age - life)/SINK_TIME) : 0;
export function updateGiblets(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  while (giblets.length && t - giblets[0].born > GIBLET_LIFE + SINK_TIME) giblets.shift();
  while (splats.length && t - splats[0].born > SPLAT_LIFE + SINK_TIME) splats.shift();
  giblets.forEach((g, i) => {
    if (!g.resting) {
      g.vy -= GRAVITY*dt;
      g.x += g.vx*dt; g.y += g.vy*dt; g.z += g.vz*dt;
      g.quaternion.premultiply(spinStep.setFromAxisAngle(g.spinAxis, g.spin*dt));
      const floor = g.ground + g.size*g.shape.y*0.6;
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
    const sink = sunk(t - g.born, GIBLET_LIFE);
    placed.position.set(g.x, g.y - sink*g.size, g.z);
    placed.quaternion.copy(g.quaternion);
    placed.scale.copy(g.shape).multiplyScalar(g.size*(1 - sink));
    placed.updateMatrix();
    chunkMesh.setMatrixAt(i, placed.matrix);
    chunkMesh.setColorAt(i, g.color);
  });
  chunkMesh.count = giblets.length;
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
  });
  splatMesh.count = splats.length;
  splatMesh.instanceMatrix.needsUpdate = true;
}
