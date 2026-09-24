import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { computeWindowGlowFactor } from '../core/scene.js';
import { createMeshBuilder } from '../roads/roads.js';

// ============================================================ what there is to put down
// The catalogue the Objects tab places from: benches, lamp posts, a market stall and the rest. Each kind says what it
// looks like (`build`), how much ground it stands on (`radius` — what the ring under a selected one is drawn from), and
// how it wants to land:
//   facing:'street'  it turns to look at whatever's nearest — a road, else a walkway, else a zone's edge (see
//                    streetFacingAt in objects.js). Anything meant to be walked up to: a bench, a postbox, a notice board.
//   facing:'free'    no front to speak of, so it lands at whatever angle comes up. A bin, a bollard, a water tower.
// `turnJitter` (in degrees) and `sizeJitter` (a fraction of full size) are how far off that one of them may land, so a
// row of them doesn't look stamped out.
//
// A prop is built facing +z, standing on y=0 and centered on the origin; the placing code lifts, turns and scales the
// group it gets back. Each kind is merged down to one mesh per material by the kit below, the way a plaza's furniture
// is — so a street's worth of benches is a handful of draw calls rather than hundreds.
const standard = (color, opts) => new THREE.MeshStandardMaterial({ color, roughness:0.75, metalness:0.15, flatShading:true, ...opts });
// One material per look, shared by every prop that uses it — so they all draw together, and none of them owns it (see
// disposeObject: a mesh marked sharedMaterial leaves its material alone when the prop goes).
const MAT = {
  metal: standard(0x4a4d52, { roughness:0.7, metalness:0.2 }), // the dark grey a plaza's benches and lamps already are
  steel: standard(0x8a8f96, { roughness:0.6, metalness:0.35 }),
  stone: standard(0x9c978c, { roughness:1, metalness:0 }),
  pale:  standard(0xb9b3a6, { roughness:1, metalness:0 }),
  wood:  standard(0x8a6640, { roughness:0.9, metalness:0 }),
  cork:  standard(0x6b533f, { roughness:1, metalness:0 }),
  red:   standard(0xa8342c),
  blue:  standard(0x2f5b8b),
  cream: standard(0xe6e0d0),
  paper: standard(0xf0ece2, { roughness:1, metalness:0 }),
  dark:  standard(0x2a2c30, { roughness:0.5 }),
  glass: standard(0xbcd6e0, { roughness:0.15, metalness:0.1, transparent:true, opacity:0.35 }),
  // a lamp's globe, which comes on after dark along with the windows — that's all baseEmissiveIntensity takes (see
  // refreshSceneIndex in scene.js)
  lamplight: standard(0xfff1d6, { roughness:0.4, emissive:0xffd08a, emissiveIntensity: 1.6*computeWindowGlowFactor(S.sunElevation) }),
};
MAT.lamplight.userData.baseEmissiveIntensity = 1.6;

// The statue is a custom model (assets/models/Statue.glb, made in Blender): one stone figure, centered on its own
// origin, standing however tall it was sculpted. It's loaded once at startup, scaled to STATUE_HEIGHT and rested on
// y=0, then every statue prop placed is a clone of it, sharing its geometry and material; until it's ready (or if it
// fails to load), statues fall back to the built-in blocky stone one below.
const STATUE_MODEL_URL = 'assets/models/Statue.glb';
const STATUE_HEIGHT = 3.1; // about what the built-in stone statue stands, plinth to head
const STATUE_COLOR = 0xb9b3a6; // MAT.pale's color, so it matches the built-in one and the palette swatch
let statueModel = null; // { root, middle, floor }
export async function loadStatueModel() {
  let gltf;
  try {
    const buffer = await fetch(STATUE_MODEL_URL).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.arrayBuffer(); });
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch (err) {
    console.warn('Splinetopia: the statue model failed to load; statues use the built-in stone one', err);
    return;
  }
  gltf.scene.updateMatrixWorld(true);
  const rawSize = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  if (!(rawSize.y > 0)) { console.warn('Splinetopia: the statue model is empty; statues use the built-in stone one'); return; }
  gltf.scene.scale.setScalar(STATUE_HEIGHT/rawSize.y);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene), middle = box.getCenter(new THREE.Vector3());
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    o.userData.sharedGeometry = true; // every statue draws the template's geometry, so a rebuild mustn't free it
    o.userData.sharedMaterial = true;
    if (o.material) { o.material.color.setHex(STATUE_COLOR); o.material.roughness = 1; o.material.metalness = 0; }
  });
  statueModel = { root: gltf.scene, middle, floor: box.min.y };
  App.rebuildObjectsOfType('statue'); // any already standing were built with the fallback; swap them for the real thing
}

// The round shapes props are built out of, made once and merged wherever they're wanted (addGeometry copies them in, so
// one of each is enough however many props use it). Cylinders and cones stand up on their own, which is the way they're
// always wanted here.
const shapes = new Map();
const shapeOf = (key, make) => { let geo = shapes.get(key); if (!geo) shapes.set(key, geo = make()); return geo; };
const cylinderShape = (r, h, sides) => shapeOf(`cyl:${r}:${h}:${sides}`, () => new THREE.CylinderGeometry(r, r, h, sides));
const coneShape = (r, h, sides) => shapeOf(`cone:${r}:${h}:${sides}`, () => new THREE.ConeGeometry(r, h, sides));
const ballShape = (r) => shapeOf(`ball:${r}`, () => new THREE.IcosahedronGeometry(r, 1));

// The kit a kind is described with. Everything is in the prop's own space: x across it, z out through its front, y up
// from the ground — and a box or a post is given the height of its underside, since that's where it sits.
function propKit() {
  const parts = new Map();
  const partFor = mat => { let builder = parts.get(mat); if (!builder) parts.set(mat, builder = createMeshBuilder()); return builder; };
  const kit = {
    box: (mat, x, y, z, w, h, d) => kit.turned(mat, x, y, z, w, h, d, 0),
    // a box set at an angle within the prop: a crate shoved under a counter, a brace between a tower's legs
    turned(mat, x, y, z, w, h, d, yaw) { partFor(mat).addBox(x, z, Math.cos(yaw), Math.sin(yaw), w/2, d/2, y, y+h); },
    post(mat, x, y, z, r, h, sides = 10) { partFor(mat).addGeometry(cylinderShape(r, h, sides), x, y + h/2, z); },
    cap(mat, x, y, z, r, h, sides = 10) { partFor(mat).addGeometry(coneShape(r, h, sides), x, y + h/2, z); },
    ball(mat, x, y, z, r) { partFor(mat).addGeometry(ballShape(r), x, y, z); }, // y is its middle, not its underside
    build() {
      const group = new THREE.Group();
      parts.forEach((builder, material) => {
        const geo = builder.build();
        if (!geo) return;
        const mesh = new THREE.Mesh(geo, material);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData.sharedMaterial = true;
        group.add(mesh);
      });
      return group;
    },
  };
  return kit;
}

// The kinds themselves. `build(rng)` may use its random numbers for whatever varies between two of the same kind (which
// arm a statue has up, how much is stacked under a stall) — it's called with the prop's own seed, so one always builds
// back the same way.
export const OBJECT_TYPES = [
  {
    id:'bench', label:'Bench', color:'#8a6640', facing:'street', radius:1.15, turnJitter:4, sizeJitter:0.05,
    build() {
      const kit = propKit(), seat = 0.42;
      kit.box(MAT.wood, 0, seat-0.1, 0, 1.9, 0.1, 0.5);                 // the seat
      kit.box(MAT.wood, 0, seat, -0.22, 1.9, 0.45, 0.06);               // and its back, so you sit looking forward
      [-0.8, 0.8].forEach(x => kit.box(MAT.metal, x, 0, 0, 0.07, seat-0.1, 0.44));
      return kit.build();
    },
  },
  {
    id:'lamp', label:'Lamp post', color:'#ffd08a', facing:'free', radius:0.6, turnJitter:0, sizeJitter:0.04,
    build() {
      const kit = propKit(), h = 4.3;
      kit.box(MAT.metal, 0, 0, 0, 0.36, 0.3, 0.36);      // the block it's bolted down to
      kit.post(MAT.metal, 0, 0.25, 0, 0.07, h);
      kit.box(MAT.metal, 0, h+0.05, 0, 0.22, 0.12, 0.22);
      kit.ball(MAT.lamplight, 0, h+0.4, 0, 0.3);
      return kit.build();
    },
  },
  {
    id:'statue', label:'Statue', color:'#b9b3a6', facing:'street', radius:1.1, turnJitter:3, sizeJitter:0.08,
    build(rng) {
      if (statueModel) {
        const model = statueModel.root.clone(true);
        model.position.set(-statueModel.middle.x, -statueModel.floor, -statueModel.middle.z);
        const group = new THREE.Group();
        group.add(model);
        return group;
      }
      const kit = propKit(), top = 0.95;
      kit.box(MAT.stone, 0, 0, 0, 1.5, 0.2, 1.5);            // a step up to it
      kit.box(MAT.stone, 0, 0.2, 0, 1.2, top-0.2, 1.2);      // the plinth
      kit.box(MAT.dark, 0, 0.5, 0.61, 0.6, 0.3, 0.03);       // the plaque nobody reads
      kit.box(MAT.pale, 0, top, 0, 0.42, 0.95, 0.34);        // legs
      kit.box(MAT.pale, 0, top+0.95, 0, 0.6, 0.72, 0.4);     // body
      kit.ball(MAT.pale, 0, top+1.88, 0, 0.22);              // head
      const side = rng() < 0.5 ? -1 : 1;                     // whichever arm this one happens to have up
      kit.box(MAT.pale, side*0.42, top+1.35, 0, 0.36, 0.16, 0.16);  // out to the side
      kit.box(MAT.pale, side*0.55, top+1.5, 0, 0.16, 0.7, 0.16);    // and then up
      return kit.build();
    },
  },
  {
    id:'postbox', label:'Postbox', color:'#a8342c', facing:'street', radius:0.5, turnJitter:5, sizeJitter:0.04,
    build() {
      const kit = propKit(), h = 1.25;
      kit.post(MAT.dark, 0, 0, 0, 0.38, 0.1);
      kit.post(MAT.red, 0, 0.1, 0, 0.34, h);
      kit.ball(MAT.red, 0, h+0.1, 0, 0.34);                     // a domed top, half of it sunk into the body
      kit.box(MAT.dark, 0, h-0.18, 0.31, 0.4, 0.07, 0.08);      // the slot, facing whoever's posting
      return kit.build();
    },
  },
  {
    id:'phonebox', label:'Phone box', color:'#2f5b8b', facing:'street', radius:0.85, turnJitter:4, sizeJitter:0.03,
    build() {
      const kit = propKit(), h = 2.5, half = 0.48;
      kit.box(MAT.dark, 0, 0, 0, 1.06, 0.1, 1.06);
      [-1, 1].forEach(sx => [-1, 1].forEach(sz => kit.box(MAT.blue, sx*half, 0.1, sz*half, 0.12, h, 0.12)));
      kit.box(MAT.glass, 0, 0.5, -half, 0.84, 1.7, 0.05);                          // the back
      [-1, 1].forEach(sx => kit.box(MAT.glass, sx*half, 0.5, 0, 0.05, 1.7, 0.84)); // the sides
      kit.box(MAT.glass, 0, 1.2, half, 0.84, 1.0, 0.05);                           // and the top half of the door
      kit.box(MAT.blue, 0, h+0.1, 0, 1.2, 0.2, 1.2);                               // the roof
      kit.box(MAT.cream, 0, h-0.12, half+0.02, 0.8, 0.22, 0.04);                   // with its lit sign under it
      return kit.build();
    },
  },
  {
    id:'noticeboard', label:'Notice board', color:'#6b533f', facing:'street', radius:0.9, turnJitter:6, sizeJitter:0.05,
    build(rng) {
      const kit = propKit(), low = 0.95;
      [-0.55, 0.55].forEach(x => kit.box(MAT.metal, x, 0, 0, 0.08, low+0.95, 0.08));
      kit.box(MAT.wood, 0, low, 0, 1.36, 0.95, 0.1);
      kit.box(MAT.cork, 0, low+0.08, 0.06, 1.18, 0.78, 0.02);
      const notices = 2 + Math.floor(rng()*3); // whatever's pinned up this week
      for (let i=0; i<notices; i++) kit.box(MAT.paper, -0.42 + i*0.23, low + 0.2 + rng()*0.28, 0.08, 0.17, 0.22, 0.01);
      return kit.build();
    },
  },
  {
    id:'stall', label:'Market stall', color:'#a8342c', facing:'street', radius:1.5, turnJitter:5, sizeJitter:0.04,
    build(rng) {
      const kit = propKit(), counter = 0.85, roof = 2.25;
      kit.box(MAT.wood, 0, counter-0.08, 0, 2.1, 0.08, 0.95);
      [-0.95, 0.95].forEach(x => [-0.4, 0.4].forEach(z => kit.box(MAT.wood, x, 0, z, 0.09, counter-0.08, 0.09)));
      [-1.05, 1.05].forEach(x => [-0.5, 0.5].forEach(z => kit.box(MAT.metal, x, 0, z, 0.07, roof, 0.07)));
      kit.box(MAT.cream, 0, roof, 0, 2.4, 0.12, 1.25);                  // the canopy
      kit.box(MAT.red, 0, roof-0.28, 0.62, 2.4, 0.3, 0.06);             // and the valance hanging over its front
      const crates = 1 + Math.floor(rng()*3);                           // with the stock shoved under the counter
      for (let i=0; i<crates; i++) kit.turned(MAT.wood, -0.6 + i*0.6, 0, -0.1, 0.5, 0.35, 0.4, (rng()-0.5)*0.6);
      return kit.build();
    },
  },
  {
    id:'watertower', label:'Water tower', color:'#8a8f96', facing:'free', radius:2.4, turnJitter:0, sizeJitter:0.1,
    build() {
      const kit = propKit(), legs = 5.2, tank = 2.6, spread = 1.25;
      [-1, 1].forEach(sx => [-1, 1].forEach(sz => kit.box(MAT.steel, sx*spread, 0, sz*spread, 0.16, legs, 0.16)));
      [2.2, 4.4].forEach(y => {                                          // the rings bracing them
        [-1, 1].forEach(sz => kit.box(MAT.steel, 0, y, sz*spread, spread*2, 0.1, 0.1));
        [-1, 1].forEach(sx => kit.turned(MAT.steel, sx*spread, y, 0, spread*2, 0.1, 0.1, Math.PI/2));
      });
      kit.box(MAT.steel, 0, legs, 0, spread*2+0.3, 0.16, spread*2+0.3);  // the platform the tank sits on
      kit.post(MAT.steel, 0, legs+0.16, 0, 1.55, tank, 12);
      kit.cap(MAT.metal, 0, legs+0.16+tank, 0, 1.7, 0.9, 12);
      [-0.2, 0.2].forEach(x => kit.box(MAT.metal, x, 0, spread+0.25, 0.06, legs+0.2, 0.06)); // a ladder up one side
      return kit.build();
    },
  },
  {
    id:'bin', label:'Litter bin', color:'#4a4d52', facing:'free', radius:0.45, turnJitter:0, sizeJitter:0.05,
    build() {
      const kit = propKit(), h = 0.8;
      kit.post(MAT.metal, 0, 0, 0, 0.28, h, 8);
      kit.post(MAT.dark, 0, h, 0, 0.33, 0.12, 8); // the rim, standing a little proud of it
      return kit.build();
    },
  },
  {
    id:'bollard', label:'Bollard', color:'#2a2c30', facing:'free', radius:0.3, turnJitter:0, sizeJitter:0.06,
    build() {
      const kit = propKit(), h = 0.85;
      kit.post(MAT.dark, 0, 0, 0, 0.11, h, 8);
      kit.post(MAT.cream, 0, h*0.62, 0, 0.115, 0.12, 8); // the band that catches headlights
      kit.ball(MAT.dark, 0, h, 0, 0.12);
      return kit.build();
    },
  },
];
export const objectTypeOf = id => OBJECT_TYPES.find(type => type.id === id) || OBJECT_TYPES[0];
