import * as THREE from 'three';
import { scene } from '../core/scene.js';

// ============================================================ lightning
// The Smite button's bolt (see the person and car cards): a jagged streak from high in the sky down to whoever's smitten,
// with a few forks off it, flickering for a moment — redrawn crooked a couple of times as it does — and a hard blue-white
// flash of light where it lands. Each segment is one instance of a thin box stretched between its two ends: a white core,
// and a wider, fainter blue glow round it.
const SEGMENTS_MAX = 400;
const BOLT_HEIGHT = 140, BOLT_STEPS = 22, BOLT_JAG = 0.35; // how high it starts, in how many kinks, and how far each kink strays (against the step)
const BOLT_LIFE = 0.2, BOLT_REDRAWS = [0, 0.08]; // seconds it lasts, and when in that it's drawn afresh
const CORE_WIDTH = 0.5, GLOW_WIDTH = 2.2;

const boltGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); // (from its base up: stretched between two points)
function boltMesh(color, opacity, name) {
  const mesh = new THREE.InstancedMesh(boltGeometry,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), SEGMENTS_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}
const coreMesh = boltMesh(0xffffff, 1, 'LightningCore'), glowMesh = boltMesh(0x8fb4ff, 0.35, 'LightningGlow');
const flash = new THREE.PointLight(0xcfe0ff, 0, 90, 1.5);
scene.add(flash);

const bolts = []; // { at, born, drawn, segments: [[from, to, width]] }

// a crooked line from `from` to `to` in `steps` kinks, each kink strayed sideways by up to `jag` of a step — with forks off it
// (themselves unforked) while `forks` allows
function crooked(from, to, steps, jag, width, out, forks) {
  const step = from.distanceTo(to)/steps;
  let last = from.clone();
  for (let k = 1; k <= steps; k++) {
    const next = from.clone().lerp(to, k/steps);
    if (k < steps) next.add(new THREE.Vector3((Math.random()*2 - 1)*step*jag, (Math.random()*2 - 1)*step*jag*0.5, (Math.random()*2 - 1)*step*jag));
    out.push([last, next, width]);
    if (forks && k < steps - 2 && Math.random() < 0.18) {
      const length = step*(2 + Math.random()*5), angle = Math.random()*Math.PI*2;
      const end = next.clone().add(new THREE.Vector3(Math.cos(angle)*length*0.8, -length*(0.5 + Math.random()*0.5), Math.sin(angle)*length*0.8));
      crooked(next, end, 3 + Math.floor(Math.random()*4), jag, width*0.5, out, false);
    }
    last = next;
  }
  return out;
}
function drawBolt(bolt) {
  const ground = new THREE.Vector3(bolt.at.x, bolt.at.y, bolt.at.z);
  const sky = ground.clone().add(new THREE.Vector3((Math.random() - 0.5)*30, BOLT_HEIGHT, (Math.random() - 0.5)*30));
  bolt.segments = crooked(sky, ground, BOLT_STEPS, BOLT_JAG, 1, [], true);
}

/**
 * Bring a bolt of lightning down on `at` (the ground under whoever's being smitten), and light it up.
 * @param {{x: number, y: number, z: number}} at
 * @returns {void}
 */
export function strikeLightning(at) {
  const bolt = { at: { ...at }, born: performance.now()/1000, drawn: 0 };
  drawBolt(bolt);
  bolts.push(bolt);
}

const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), matrix = new THREE.Matrix4(), turn = new THREE.Quaternion(), size = new THREE.Vector3();
export function updateLightning(t) {
  while (bolts.length && t - bolts[0].born > BOLT_LIFE) bolts.shift();
  let n = 0, brightest = 0, lit = null;
  for (const bolt of bolts) {
    const age = t - bolt.born;
    while (bolt.drawn + 1 < BOLT_REDRAWS.length && age >= BOLT_REDRAWS[bolt.drawn + 1]) { bolt.drawn++; drawBolt(bolt); }
    // it flickers: on hard at each redraw, fading until the next
    const since = age - BOLT_REDRAWS[bolt.drawn], strength = Math.max(0, 1 - since/0.1)*(1 - age/BOLT_LIFE);
    if (strength > brightest) { brightest = strength; lit = bolt; }
    if (strength < 0.05) continue;
    for (const [from, to, width] of bolt.segments) {
      if (n >= SEGMENTS_MAX) break;
      direction.subVectors(to, from);
      const length = direction.length();
      turn.setFromUnitVectors(up, direction.divideScalar(length || 1));
      matrix.compose(from, turn, size.set(CORE_WIDTH*width*strength, length, CORE_WIDTH*width*strength));
      coreMesh.setMatrixAt(n, matrix);
      matrix.compose(from, turn, size.set(GLOW_WIDTH*width*strength, length, GLOW_WIDTH*width*strength));
      glowMesh.setMatrixAt(n, matrix);
      n++;
    }
  }
  coreMesh.count = glowMesh.count = n;
  coreMesh.instanceMatrix.needsUpdate = glowMesh.instanceMatrix.needsUpdate = true;
  flash.intensity = brightest*60;
  if (lit) flash.position.set(lit.at.x, lit.at.y + 6, lit.at.z);
}
