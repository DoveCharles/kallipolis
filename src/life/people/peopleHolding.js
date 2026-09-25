import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { scene } from '../../core/scene.js';
import { PEOPLE_MAX, inRoom, isDrawn, people, peopleRng, personModel } from './people.js';
import { PERSON_ARM_SPREAD } from './peopleModel.js';
import { eatingSound } from '../../audio/eating.js';
import { S } from '../../core/shared.js';

// ============================================================ holding things
// Anything a person carries: a fork and a plate of dinner for now, a mug or a hotdog when something wants one. A thing
// held is hung off a hand's bone, so it goes wherever that hand goes through every frame of every clip; a thing set down
// in front of them (their plate) is hung off the model itself, so it sits where the pose using it expects it, whatever
// height they are. Either way their own instance matrix puts it in the world, so it turns with them, is as big as they
// are, and goes when they go (nothing is drawn for someone whose building isn't being shown, whose matrix is empty).
//
// Every item is built out of boxes, spheres and cylinders — one instanced mesh a shape, so a room of diners costs three
// draw calls — or is a model from assets/models/Holdables.glb (see MODELS), drawn the same way once it loads. Sizes are
// in metres, for someone of height 1 at people size 1.
//
// A thing in a hand is placed in the model's rest pose, where the arms are out and the palms face forward: the handle of
// whatever is held lies along Y, out of the top of the fist past the thumb, and Z comes out of the palm (see HAND_GRIP
// in peopleModel.js). X is the way the right hand's fingers point, so an item that isn't symmetric reads mirrored in the
// left hand.
export const ITEMS = {
  fork: { parts: [
    { shape: 'box', size: [0.014, 0.17, 0.007], at: [0, 0.035, 0], color: 0xc8ccd3 },
    { shape: 'box', size: [0.034, 0.038, 0.005], at: [0, 0.135, 0], color: 0xc8ccd3 },
    { shape: 'sphere', size: [0.028, 0.028, 0.028], at: [0, 0.155, 0], tint: true, loaded: true },
  ] },
  mug: { parts: [
    { shape: 'cylinder', size: [0.075, 0.09, 0.075], at: [0, 0.035, 0], color: 0xf2f0ea },
    { shape: 'box', size: [0.012, 0.045, 0.012], at: [0.048, 0.035, 0], color: 0xf2f0ea },
    { shape: 'cylinder', size: [0.06, 0.004, 0.06], at: [0, 0.07, 0], tint: true },
  ] },
  // (the parts that are `eaten` get shorter from the top as it goes: see A SNACK; a model's is cut away rather than squashed)
  hotdog: { parts: [
    { shape: 'hotdog', size: [0.175, 0.175, 0.175], at: [0.046, 0.028, 0.013], turn: [-0.022, 0.968, 0], eaten: true },
  ] },
  coffee: { parts: [
    { shape: 'coffee', size: [0.167, 0.167, 0.167], at: [0.059, 0.047, 0.036], turn: [-0.072, 2.588, 0.028] },
  ] },
  beer: { parts: [
    { shape: 'beer', size: [0.167, 0.167, 0.167], at: [0.059, 0.047, 0.036], turn: [-0.072, 2.588, 0.028] },
  ] },
  plate: { parts: [
    { shape: 'cylinder', size: [0.23, 0.010, 0.23], at: [0, 0.005, 0], color: 0xf4f2ee },
  ] },
};

// A dinner: where the plate goes on the table in front of someone sitting down to eat, in the model's own units (the
// Eating clip dips its fork to the same spot — see EAT_TIP_PLATE in peopleModel.js), and what is on it. Its height there
// only suits someone of about average size: the plate is set down on the table top itself (serveMeal), since a table
// doesn't grow with whoever sits at it and a short diner's plate would otherwise sink into it.
const PLATE_AT = new THREE.Vector3(-0.05, 3.44, -0.56);
const MEAL_FOOD = [3, 6];        // how many things are on a plate
const FOOD_SIZE = 0.028, FOOD_SPREAD = 0.075; // a ball of food, and how far about the middle of the plate they lie, in metres
const FOOD_COLORS = [0x6f9a3e, 0xd8762a, 0xe8dcb0, 0x8a4b2a, 0xb83a2a, 0xdcc98a, 0x4f7a3a];

const SHAPES = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(0.5, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
};
// The shapes that are models: a node of Holdables.glb each, turned so that it's held the way the items above are (the hot
// dog lies along Z in Blender, its bun open to +Y: stood on end here, open away from the palm), centred, and scaled so
// its longest side is 1. Their materials' colours are baked into the vertices; the see-through ones (a pint's glass and the
// beer in it) go in a second mesh of their own, drawn see-through, with their opacity baked in alongside.
const HOLDABLES_MODEL_URL = 'assets/models/Holdables.glb';
const MODELS = {
  hotdog: { node: 'Hotdog', turn: [Math.PI/2, 0, 0] },
  coffee: { node: 'CoffeeCup' },
  beer: { node: 'BeerPint' },
};
const HELD_MAX = 512;
// Held things are lit like the room around them when they are in one (see roomLit in buildings/interior.js: a room under
// its own ceiling is in shadow, and its things glow a little to make up for it), and plainly out in the daylight.
const HELD_GLOW = 0.25;
const meshes = Object.fromEntries(Object.entries(SHAPES).flatMap(([shape, geometry]) => ['lit', 'plain'].map(light => {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  if (light === 'lit') { material.emissive.setScalar(1); material.emissiveIntensity = HELD_GLOW; }
  const mesh = new THREE.InstancedMesh(geometry, material, HELD_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = `Held ${shape}`;
  mesh.setColorAt(0, new THREE.Color());
  scene.add(mesh);
  return [`${shape}:${light}`, mesh];
})));

loadHoldables().catch(error => console.warn('Kallipolis: no held models (' + HOLDABLES_MODEL_URL + '):', error));

/**
 * Load the models in Holdables.glb and add an instanced mesh for each (lit and plain), as SHAPES has for its own. Each
 * carries a `cut` per instance, a height on the model above which nothing is drawn (what's been bitten off).
 * @returns {Promise<void>}
 */
async function loadHoldables() {
  const buffer = await fetch(HOLDABLES_MODEL_URL).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);
  for (const [shape, { node, turn = [0, 0, 0] }] of Object.entries(MODELS)) {
    const object = gltf.scene.getObjectByName(node);
    if (!object) { console.warn('Kallipolis: Holdables.glb has no ' + node); continue; }
    const pieces = { solid: [], clear: [] };
    object.traverse(child => {
      if (!child.isMesh) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', child.geometry.attributes.position.clone());
      geometry.setAttribute('normal', child.geometry.attributes.normal.clone());
      geometry.setIndex(child.geometry.index.clone());
      geometry.applyMatrix4(child.matrixWorld);
      const { r, g, b } = child.material.color, a = child.material.transparent ? child.material.opacity : 1;
      const colors = new Float32Array(geometry.attributes.position.count*4);
      for (let i = 0; i < colors.length; i += 4) colors.set([r, g, b, a], i);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      pieces[a < 1 ? 'clear' : 'solid'].push(geometry);
    });
    // (sized and centred as a whole, so the two halves still fit together)
    const whole = mergeGeometries([...pieces.solid, ...pieces.clear]);
    const place = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...turn));
    whole.applyMatrix4(place);
    whole.computeBoundingBox();
    const box = whole.boundingBox, middle = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3());
    place.premultiply(new THREE.Matrix4().makeScale(...Array(3).fill(1/Math.max(extent.x, extent.y, extent.z))).multiply(new THREE.Matrix4().makeTranslation(-middle.x, -middle.y, -middle.z)));
    const bottom = (box.min.y - middle.y)/Math.max(extent.x, extent.y, extent.z), height = extent.y/Math.max(extent.x, extent.y, extent.z);
    for (const [half, list] of Object.entries(pieces)) for (const light of ['lit', 'plain']) {
      if (!list.length) continue;
      const geometry = mergeGeometries(list).applyMatrix4(place), clear = half === 'clear';
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: clear ? 0.1 : 0.5, vertexColors: true, side: THREE.DoubleSide, transparent: clear, depthWrite: !clear });
      if (light === 'lit') { material.emissive.setScalar(1); material.emissiveIntensity = HELD_GLOW; }
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float cut;\nvarying float vUncut;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUncut = cut - position.y;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vUncut;')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vUncut < 0.0) discard;');
      };
      const cut = new THREE.InstancedBufferAttribute(new Float32Array(HELD_MAX).fill(1), 1);
      cut.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.InstancedMesh(geometry.clone().setAttribute('cut', cut), material, HELD_MAX);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = !clear;
      mesh.receiveShadow = true;
      mesh.name = `Held ${shape}`;
      mesh.setColorAt(0, new THREE.Color());
      mesh.userData.cut = { bottom, height };
      scene.add(mesh);
      meshes[`${shape}${clear ? '~clear' : ''}:${light}`] = mesh;
    }
  }
}

/**
 * Give someone something to hold, or to set down in front of them.
 * @param {object} p - the person
 * @param {string} item - which item (a key of ITEMS)
 * @param {object} [options] - `hand` ('R' or 'L') for something held, or `at` (a place in the model's units) for
 *   something set down in front of them, and `onY` (a height in the world) for it to sit at instead of at's own; `color`
 *   for the parts that take one
 * @returns {?object} what they are holding, to keep hold of and change (a fork's `loaded`, a plate's `food`)
 */
export function hold(p, item, options = {}) {
  if (!ITEMS[item]) return null;
  const { hand = options.at ? null : 'R', at = null, onY = null, color = 0xffffff } = options;
  letGo(p, item);
  const held = { item, hand, at: at ? at.clone() : null, onY, color: new THREE.Color(color), loaded: null, food: null, left: 1 };
  (p.holding ??= []).push(held);
  return held;
}

/**
 * Take something back off someone.
 * @param {object} p - the person
 * @param {string} [item] - which item, or nothing for everything they hold
 * @returns {void}
 */
export function letGo(p, item) {
  if (!p.holding) return;
  p.holding = item ? p.holding.filter(held => held.item !== item) : [];
}

/**
 * What someone is holding of a kind, if anything.
 * @param {object} p - the person
 * @param {string} item - which item
 * @returns {?object} it, or null
 */
export function holding(p, item) {
  return p.holding?.find(held => held.item === item) ?? null;
}

// ============== A MEAL ==============
/**
 * Sit someone down to dinner: a plate of food on the table in front of them and a fork in their hand (what the Eating
 * clip in peopleModel.js is posed around).
 * @param {object} p - the person
 * @param {?number} [tableTop] - how high the table top is, in the world (else the plate goes where PLATE_AT has it)
 * @returns {void}
 */
export function serveMeal(p, tableTop = null) {
  dropSnack(p); // (the right hand is wanted for the fork)
  const plate = hold(p, 'plate', { at: PLATE_AT, onY: tableTop });
  if (!plate) return;
  const count = MEAL_FOOD[0] + Math.floor(peopleRng()*(MEAL_FOOD[1] + 1 - MEAL_FOOD[0]));
  plate.food = Array.from({ length: count }, () => {
    const angle = peopleRng()*Math.PI*2, out = Math.sqrt(peopleRng())*FOOD_SPREAD;
    return { x: Math.cos(angle)*out, z: Math.sin(angle)*out, color: FOOD_COLORS[Math.floor(peopleRng()*FOOD_COLORS.length)] };
  });
  hold(p, 'fork', { hand: 'R' });
}

/**
 * Clear away someone's dinner, whether they finished it or got up.
 * @param {object} p - the person
 * @returns {void}
 */
export function clearMeal(p) {
  letGo(p, 'plate');
  letGo(p, 'fork');
}

/**
 * Whether someone has a plate in front of them with nothing left on it.
 * @param {object} p - the person
 * @returns {boolean}
 */
export function mealFinished(p) {
  const plate = holding(p, 'plate');
  return !!plate && !plate.food.length;
}

/**
 * Something happening at a point in the Eating clip (see eatingCues in peopleModel.js): the fork touching down on the
 * plate, a forkful gathered onto it, or the mouthful taken off it.
 * @param {object} p - the person
 * @param {string} cue - 'clink', 'forkful' or 'bite'
 * @returns {void}
 */
export function mealCue(p, cue) {
  const fork = holding(p, 'fork'), plate = holding(p, 'plate');
  const at = { x: p.x, y: p.y + 1.05*p.height, z: p.z };
  if (cue === 'forkful') {
    if (!plate || !fork || !plate.food.length) return;
    fork.loaded = plate.food.pop().color;
    return;
  }
  if (cue === 'bite' && fork) fork.loaded = null;
  eatingSound(at, cue);
}

// ============== A SNACK ==============
// A hot dog, a coffee or a pint bought from a stall (see peopleStalls.js), in the right hand wherever they go, and eaten or drunk
// a mouthful at a time: every few seconds up it goes to the mouth and down again (the snack versions of Walk, Idle and
// Sit1 — see snackClips in peopleModel.js), a bite off the hot dog each time, until there's none left. Doing anything
// else (lying down, sitting on the grass) it waits in their hand.
const SNACKS = {
  hotdog: { clip: 'Hotdog', mouthfuls: 5, up: 1.1, gap: [2.5, 6], sound: 'bite' },
  coffee: { clip: 'Coffee', mouthfuls: 7, up: 1.5, gap: [3, 8], sound: 'sip' },
  beer: { clip: 'Beer', mouthfuls: 9, up: 1.7, gap: [4, 10], sound: 'sip' },
};
/** What someone's snack adds to a clip's name, for the version of it with that in hand ('Beer': WalkBeer, WaveLeftBeer…), or ''. */
export const snackClipName = p => SNACKS[p.snack?.item]?.clip ?? '';
const SNACK_TAKEN = 0.5; // seconds after it starts up to the mouth that the mouthful's taken
const snackGap = kind => kind.gap[0] + peopleRng()*(kind.gap[1] - kind.gap[0]);

/**
 * Put a hot dog, a coffee or a pint in someone's right hand, to eat or drink as they go.
 * @param {object} p - the person
 * @param {string} item - 'hotdog', 'coffee' or 'beer'
 * @returns {void}
 */
export function giveSnack(p, item) {
  const kind = SNACKS[item];
  if (!kind) return;
  dropSnack(p);
  const held = hold(p, item, { hand: 'R' });
  p.snack = { item, held, mouthfuls: kind.mouthfuls, next: snackGap(kind)*0.5, up: 0 };
}
/**
 * Take someone's snack off them, finished or not.
 * @param {object} p - the person
 * @returns {void}
 */
export function dropSnack(p) {
  if (!p.snack) return;
  letGo(p, p.snack.item);
  p.snack = null;
}
/**
 * The clip someone with a snack plays for `clip` (a version of it with the snack in hand, or up at the mouth), counting down
 * to their next mouthful and taking it. Called each frame by updatePeople.
 * @param {object} p - the person
 * @param {object} clip - the clip they'd play without it
 * @param {number} dt - seconds since the last frame
 * @returns {object} the clip to play
 */
export function snackClip(p, clip, dt) {
  const snack = p.snack;
  if (!snack) return clip;
  // knocked down, dead or gone indoors (but for into the room you're in, as a pint in a pub is: see aboutTheRoom): it's gone
  if (p.punched || p.mode === 'dead' || (p.mode === 'indoors' && !p.inRoom) || !p.holding?.includes(snack.held)) { dropSnack(p); return clip; }
  const kind = SNACKS[snack.item], clips = personModel.clips;
  const carried = clips[clip.name + kind.clip], raised = clips[clip.name + kind.clip + 'Bite'];
  if (!carried || carried.missing || !raised) return clip; // (lying down or on the grass, it waits)
  if (snack.up > 0) {
    const was = snack.up;
    snack.up -= dt;
    if (was > kind.up - SNACK_TAKEN && snack.up <= kind.up - SNACK_TAKEN) {
      snack.mouthfuls--;
      if (snack.item === 'hotdog') snack.held.left = snack.mouthfuls/kind.mouthfuls;
      if (snack.item === 'beer') p.pints = (p.pints ?? 0) + 1/kind.mouthfuls; // (going to their head: see peopleDrunk.js)
      eatingSound({ x: p.x, y: p.y + (clip.pose ? 1.05 : 1.5)*p.height*S.peopleSize, z: p.z }, kind.sound);
    }
    if (snack.up <= 0) {
      if (snack.mouthfuls <= 0) { dropSnack(p); return clip; }
      snack.next = snackGap(kind);
    }
  } else if ((snack.next -= dt) <= 0) snack.up = kind.up;
  return snack.up > 0 ? raised : carried;
}

// ============== DRAWING ==============
// A bone's pose this frame is read as the shader reads it (and as headshotOf in peopleTracking.js does): the row of the
// bone texture each of the two clips is at, blended by how far between them they are.
const poseA = new Float32Array(12), poseB = new Float32Array(12);
const boneMatrix = new THREE.Matrix4(), chestMatrix = new THREE.Matrix4();
const instance = new THREE.Matrix4(), anchor = new THREE.Matrix4(), world = new THREE.Matrix4(), part = new THREE.Matrix4();
const shift = new THREE.Vector3(), place = new THREE.Vector3(), size = new THREE.Vector3(), turn = new THREE.Quaternion();
const euler = new THREE.Euler(), color = new THREE.Color();
const counts = {};

function poseAt(out, bone, row) {
  const { boneData, boneWidth } = personModel, r = Math.floor(row), t = row - r;
  const a = (r*boneWidth + bone*3)*4, b = ((r + 1)*boneWidth + bone*3)*4;
  for (let k=0;k<12;k++) out[k] = boneData[a + k] + (boneData[b + k] - boneData[a + k])*t;
}
function boneAt(out, bone, i) {
  const anim = personModel.anim.array, o = i*4, fade = anim[o+2];
  poseAt(poseA, bone, anim[o]);
  if (fade > 0.999) poseB.set(poseA); else poseAt(poseB, bone, anim[o+1]);
  const e = poseA.map((value, k) => value*fade + poseB[k]*(1 - fade));
  return out.set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
}
/**
 * How far the shader moves this person's arms out from their body this frame (see personArms in peopleModel.js): a held
 * thing has to go the same way, or a broad person's fork misses their plate.
 */
function armShift(out, p, i, hand) {
  const side = hand === 'L' ? 'spread' : 'spreadR';
  const spread = (p.clipA[side]*p.fade + p.clipB[side]*(1 - p.fade))
    *(personModel.traitData[i*4 + 3]*PERSON_ARM_SPREAD.Weight + personModel.traitData[(PEOPLE_MAX + i)*4 + 3]*PERSON_ARM_SPREAD.Shoulders);
  if (spread <= 0) return out.set(0, 0, 0);
  boneAt(chestMatrix, personModel.chestBone, i);
  // out along the way the chest faces, and the hands rest to the left and right of the middle, as the shader has it
  return out.setFromMatrixColumn(chestMatrix, 0).normalize().multiplyScalar(hand === 'L' ? spread : -spread);
}

/**
 * Draw everything everyone is holding, from where their bones ended up this frame. Called once the people themselves
 * have been placed.
 * @returns {void}
 */
export function updateHeld(only = -1) {
  for (const key of Object.keys(meshes)) counts[key] = 0;
  if (personModel) people.forEach((p, i) => {
    if (!p.holding?.length || !isDrawn(p) || (only >= 0 && i !== only)) return;
    personModel.mesh.getMatrixAt(i, instance);
    const light = inRoom(p) ? 'lit' : 'plain';
    for (const held of p.holding) {
      const item = ITEMS[held.item];
      if (!item) continue;
      // where the item sits on the model: in a fist, or out in front of them on the table
      if (held.hand) {
        boneAt(boneMatrix, personModel.hands[held.hand].bone, i);
        armShift(shift, p, i, held.hand);
        anchor.makeTranslation(shift.x, shift.y, shift.z).multiply(boneMatrix);
        anchor.multiply(part.makeTranslation(...personModel.hands[held.hand].grip.toArray()));
      } else {
        // (on a table top, however high up it is on them: their matrix's own height and scale undone)
        const y = held.onY == null ? held.at.y : (held.onY - instance.elements[13])/place.setFromMatrixColumn(instance, 1).length();
        anchor.makeTranslation(held.at.x, y, held.at.z);
      }
      anchor.scale(size.setScalar(personModel.unitsPerMetre));
      world.multiplyMatrices(instance, anchor);
      for (const piece of item.parts) {
        if (piece.loaded && held.loaded == null) continue;
        euler.set(...(piece.turn ?? [0, 0, 0]));
        place.set(...piece.at);
        size.set(...piece.size);
        const left = piece.eaten ? held.left : 1, model = !SHAPES[piece.shape];
        if (left < 1 && !model) { place.y -= size.y*(1 - left)/2; size.y *= left; } // (bitten down from the top)
        if (size.y <= 0 || left <= 0) continue;
        part.compose(place, turn.setFromEuler(euler), size);
        draw(piece.shape, light, part.premultiply(world), piece.tint ? color.setHex(held.loaded ?? held.color.getHex()) : color.setHex(piece.color ?? 0xffffff), left);
      }
      // and what's left on the plate
      if (held.food) for (const food of held.food) {
        part.compose(place.set(food.x, FOOD_SIZE*0.45, food.z), turn.identity(), size.setScalar(FOOD_SIZE));
        draw('sphere', light, part.premultiply(world), color.setHex(food.color));
      }
    }
  });
  for (const [key, mesh] of Object.entries(meshes)) {
    mesh.count = counts[key];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (mesh.geometry.attributes.cut) mesh.geometry.attributes.cut.needsUpdate = true;
  }
}
function draw(shape, light, matrix, tint, left = 1) {
  for (const key of [`${shape}:${light}`, `${shape}~clear:${light}`]) { // (a model's see-through half, if it has one, along with it)
    const mesh = meshes[key], at = counts[key] ?? 0;
    if (!mesh || at >= HELD_MAX) continue;
    mesh.setMatrixAt(at, matrix);
    mesh.setColorAt(at, tint);
    if (mesh.userData.cut) mesh.geometry.attributes.cut.setX(at, left < 1 ? mesh.userData.cut.bottom + mesh.userData.cut.height*left : 1e6);
    counts[key] = at + 1;
  }
}
