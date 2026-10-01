import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { scene } from '../../core/scene.js';
import { PEOPLE_MAX, inRoom, isDrawn, lastPeopleTime, people, peopleRng, personModel } from './people.js';
import { PERSON_ARM_SPREAD } from './peopleModel.js';
import { eatingSound } from '../../audio/eating.js';
import { STATUS_SOURCES, addStatus } from '../statuseffects.js';
import { S } from '../../core/shared.js';
import { restaurantStyleOf } from '../../buildings/footprints.js';
import { headPointOf } from './peopleTracking.js';
import { cigSmokeFx } from '../giblets.js';

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
  // (a sushi diner's: see sushiDiner in peopleActivities.js)
  chopsticks: { parts: [
    { shape: 'box', size: [0.008, 0.21, 0.008], at: [-0.006, 0.055, 0], color: 0x3a2418 },
    { shape: 'box', size: [0.008, 0.21, 0.008], at: [0.006, 0.055, 0.004], color: 0x3a2418 },
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
    { shape: 'beer', size: [0.2, 0.2, 0.2], at: [0.059, 0.047, 0.036], turn: [-0.072, 2.588, 0.028] },
  ] },
  // (filter out of the top of the fist, to the lips; its Fire glows as it's drawn on: see CIG_FIRE)
  cig: { parts: [
    { shape: 'cig', size: [0.117, 0.117, 0.117], at: [-0.036, 0.017, 0.039], turn: [1.5, -3.14, 1.61] },
  ] },
  plate: { parts: [
    { shape: 'cylinder', size: [0.23, 0.010, 0.23], at: [0, 0.005, 0], color: 0xf4f2ee },
  ] },
  // (a restaurant's: spaghetti and meatballs, `sits` on its bottom and eaten down to the plate; a pizza on a tray, its
  // slices drawn round it — see PIZZA_SLICES — each taken into the hand as a snack)
  spaghetti: { parts: [
    { shape: 'spaghetti', size: [0.26, 0.26, 0.26], at: [0, 0, 0], sits: true, eaten: true },
  ] },
  pizza: { parts: [
    { shape: 'cylinder', size: [0.36, 0.008, 0.36], at: [0, 0.004, 0], color: 0xb0b4b8 },
  ] },
  // (a Greek one's: moussaka, as the spaghetti; souvlaki on a platter, as the pizza, a skewer at a time)
  moussaka: { parts: [
    { shape: 'moussaka', size: [0.26, 0.26, 0.26], at: [0, 0, 0], sits: true, eaten: true },
  ] },
  souvlaki: { parts: [
    { shape: 'cylinder', size: [0.36, 0.008, 0.36], at: [0, 0.004, 0], color: 0xf4f2ee },
  ] },
  skewer: { parts: [
    { shape: 'skewer', size: [0.17, 0.17, 0.17], at: [0.046, 0.028, 0.013], turn: [-0.022, 0.968, 0], eaten: true },
  ] },
  slice: { parts: [
    { shape: 'slice', size: [0.173, 0.178, 0.17], at: [0.064, 0.011, 0.099], turn: [0, -1.2, -1.48], eaten: true },
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
const SPAGHETTI_COLORS = [0xe8c870, 0xe8c870, 0xa81e10, 0x6a3a22]; // (what's on the fork)
const MOUSSAKA_COLORS = [0xe8c878, 0x7a3a22, 0x3a1a34, 0xc8281e];
const SPAGHETTI_LEFT = 0.3;      // how much of its height is left when the pasta's gone (the plate)
const PIZZA_SLICES = 8, PIZZA_EATEN = [3, 5]; // slices it's cut into, and how many one person eats

const SHAPES = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(0.5, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
};
// The shapes that are models: a node of Holdables.glb each, turned so that it's held the way the items above are (the hot
// dog lies along Z in Blender, its bun open to +Y: stood on end here, open away from the palm), centred, and scaled so
// its longest side is 1. Their materials' colours are baked into the vertices; the see-through ones (a pint's glass and the
// beer in it) go in a second mesh of their own, drawn see-through, with their opacity baked in alongside.
// (a model from another file says which: the pint is the one the pubs put on their tables, from Pub.glb — see
// tools/pub-models.py)
const HOLDABLES_MODEL_URL = 'assets/models/Holdables.glb';
const MODELS = {
  hotdog: { node: 'Hotdog', turn: [Math.PI/2, 0, 0] },
  coffee: { node: 'CoffeeCup' },
  beer: { node: 'Pint', url: 'assets/models/Pub.glb' },
  cig: { node: 'Cig', turn: [Math.PI/2, 0, 0] },
  stout: { node: 'Stout', url: 'assets/models/Pub.glb' },
  // (the restaurants', from Restaurant.glb — see tools/restaurant-models.py: the slice's tip up, cheese out of the palm)
  spaghetti: { node: 'Spaghetti', url: 'assets/models/Restaurant.glb' },
  slice: { node: 'PizzaSlice', url: 'assets/models/Restaurant.glb', turn: [Math.PI/2, Math.PI, 0] },
  moussaka: { node: 'Moussaka', url: 'assets/models/RestaurantGreek.glb' },
  skewer: { node: 'Souvlaki', url: 'assets/models/RestaurantGreek.glb', turn: [Math.PI/2, Math.PI, 0] },
};
// a restaurant's dishes: what's on a tray, and what's taken off it into the hand
export const TRAYS = { pizza: 'slice', souvlaki: 'skewer' };
/** A restaurant's two dishes, the tray one first: Greek (see footprints.js restaurantStyleOf) or Italian. */
export const menuOf = building => restaurantStyleOf(building?.key) === 'greek' ? ['souvlaki', 'moussaka'] : ['pizza', 'spaghetti'];
// A pint is of stout, drawn in place of the beer, for the share of people who'd rather (as the pubs' tables have it)
const STOUT_SHARE = 0.25;
const HELD_MAX = 512;
// A cig's Fire material (its tip): dim red held, bright orange-yellow drawn on (`glow` 0–1 per held one), linear RGB
export const CIG_FIRE = { dim: new THREE.Color(0.24, 0.17, 0.02), lit: new THREE.Color(3.58, 1.4, 0.15) };
// Held things are lit like the room around them when they are in one (see roomLit in buildings/interior.js: a room under
// its own ceiling is in shadow, and its things glow a little to make up for it), and plainly out in the daylight. The glow
// is in each thing's own colour, as roomLit's is (a white one washes a pint of beer out to pale).
const HELD_GLOW = 0.25;
const glowOwnColor = shader => {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= diffuseColor.rgb;');
};
const meshes = Object.fromEntries(Object.entries(SHAPES).flatMap(([shape, geometry]) => ['lit', 'plain'].map(light => {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  if (light === 'lit') { material.emissive.setScalar(1); material.emissiveIntensity = HELD_GLOW; material.onBeforeCompile = glowOwnColor; }
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
 * Load the models in Holdables.glb (and any from elsewhere) and add an instanced mesh for each (lit and plain), as SHAPES has for its own. Each
 * carries a `cut` per instance, a height on the model above which nothing is drawn (what's been bitten off).
 * @returns {Promise<void>}
 */
async function loadHoldables() {
  const files = {};
  const load = url => files[url] ??= fetch(url).then(response => { if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`); return response.arrayBuffer(); })
    .then(buffer => new GLTFLoader().parseAsync(buffer, '')).then(gltf => { gltf.scene.updateMatrixWorld(true); return gltf; });
  for (const [shape, { node, url = HOLDABLES_MODEL_URL, turn = [0, 0, 0] }] of Object.entries(MODELS)) {
    const object = (await load(url)).scene.getObjectByName(node);
    if (!object) { console.warn(`Kallipolis: ${url} has no ${node}`); continue; }
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
      geometry.setAttribute('fire', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(child.material.name === 'Fire' ? 1 : 0), 1));
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
      const fire = geometry.attributes.fire.array.some(v => v > 0);
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: clear ? 0.1 : 0.5, vertexColors: true, side: THREE.DoubleSide, transparent: clear, depthWrite: !clear });
      if (fire) material.defines = { FIRE: '' };
      if (light === 'lit') { material.emissive.setScalar(1); material.emissiveIntensity = HELD_GLOW; }
      material.onBeforeCompile = shader => {
        shader.uniforms.fireDim = { value: CIG_FIRE.dim };
        shader.uniforms.fireLit = { value: CIG_FIRE.lit };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float cut;\nvarying float vUncut;\n#ifdef FIRE\nattribute float fire;\nattribute float glow;\nuniform vec3 fireDim, fireLit;\nvarying vec3 vFire;\n#endif')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUncut = cut - position.y;\n#ifdef FIRE\nvFire = fire*mix(fireDim, fireLit, glow);\n#endif');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vUncut;\n#ifdef FIRE\nvarying vec3 vFire;\n#endif')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vUncut < 0.0) discard;')
          .replace('#include <lights_fragment_begin>', '#ifdef FIRE\ntotalEmissiveRadiance += vFire;\n#endif\n#include <lights_fragment_begin>');
        glowOwnColor(shader);     // (for plain too: it has no glow to tint, and the two share a program)
      };
      const cut = new THREE.InstancedBufferAttribute(new Float32Array(HELD_MAX).fill(1), 1);
      cut.setUsage(THREE.DynamicDrawUsage);
      const instanced = geometry.clone().setAttribute('cut', cut);
      if (fire) instanced.setAttribute('glow', new THREE.InstancedBufferAttribute(new Float32Array(HELD_MAX), 1).setUsage(THREE.DynamicDrawUsage));
      const mesh = new THREE.InstancedMesh(instanced, material, HELD_MAX);
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
export function serveMeal(p, tableTop = null, dish = 'plate') {
  dropSnack(p); // (the right hand is wanted for the fork)
  const plate = hold(p, dish, { at: PLATE_AT, onY: tableTop });
  if (!plate) return;
  if (TRAYS[dish]) { // (no fork: see feedPizza)
    plate.slices = PIZZA_SLICES;
    plate.slice = TRAYS[dish];
    plate.toEat = PIZZA_EATEN[0] + Math.floor(peopleRng()*(PIZZA_EATEN[1] + 1 - PIZZA_EATEN[0]));
    return;
  }
  const count = MEAL_FOOD[0] + Math.floor(peopleRng()*(MEAL_FOOD[1] + 1 - MEAL_FOOD[0]));
  const colors = dish === 'spaghetti' ? SPAGHETTI_COLORS : dish === 'moussaka' ? MOUSSAKA_COLORS : FOOD_COLORS;
  plate.food = Array.from({ length: count }, () => {
    const angle = peopleRng()*Math.PI*2, out = Math.sqrt(peopleRng())*FOOD_SPREAD;
    return { x: Math.cos(angle)*out, z: Math.sin(angle)*out, color: colors[Math.floor(peopleRng()*colors.length)] };
  });
  plate.served = count;
  hold(p, 'fork', { hand: 'R' });
}

/**
 * Someone with a pizza in front of them: a slice into their hand whenever they've none, till they've had their share.
 * Called each frame they're sat.
 * @param {object} p - the person
 * @returns {boolean} whether they're still eating it
 */
export function feedPizza(p) {
  const pizza = holding(p, 'pizza') ?? holding(p, 'souvlaki');
  if (!pizza) return false;
  if (p.snack?.item === pizza.slice) return true;
  if (pizza.toEat <= 0 || pizza.slices <= 0) return false;
  pizza.toEat--;
  pizza.slices--;
  giveSnack(p, pizza.slice);
  return true;
}

/**
 * Clear away someone's dinner, whether they finished it or got up.
 * @param {object} p - the person
 * @returns {void}
 */
/** Where someone sat at a table has their plate put (see serveMeal), in the world (its x and z). */
export function plateSpot(p) {
  personModel.mesh.getMatrixAt(people.indexOf(p), instance);
  return new THREE.Vector3().copy(PLATE_AT).applyMatrix4(instance);
}
export function clearMeal(p) {
  for (const item of ['plate', 'spaghetti', 'pizza', 'moussaka', 'souvlaki', 'fork', 'chopsticks']) letGo(p, item);
  if (p.snack?.item === 'slice' || p.snack?.item === 'skewer') dropSnack(p);
}

/**
 * Whether someone has a plate in front of them with nothing left on it.
 * @param {object} p - the person
 * @returns {boolean}
 */
export function mealFinished(p) {
  if (holding(p, 'pizza') ?? holding(p, 'souvlaki')) return !feedPizza(p);
  const plate = holding(p, 'plate') ?? holding(p, 'spaghetti') ?? holding(p, 'moussaka');
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
  const fork = holding(p, 'fork'), plate = holding(p, 'plate') ?? holding(p, 'spaghetti') ?? holding(p, 'moussaka');
  const at = { x: p.x, y: p.y + 1.05*p.height, z: p.z };
  if (cue === 'forkful') {
    if (!plate || !fork || !plate.food.length) return;
    fork.loaded = plate.food.pop().color;
    if (plate.served) plate.left = SPAGHETTI_LEFT + (1 - SPAGHETTI_LEFT)*plate.food.length/plate.served;
    return;
  }
  if (cue === 'bite' && fork) fork.loaded = null;
  if (cue === 'clink' && holding(p, 'chopsticks')) return; // (sushi: no fork on china)
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
  cig: { clip: 'Cig', mouthfuls: 8, up: 1.6, gap: [4, 9] }, // (a drag each: see SMOKING)
  slice: { clip: 'Hotdog', mouthfuls: 3, up: 1.1, gap: [2, 4], sound: 'bite' }, // (a pizza's: see feedPizza)
  skewer: { clip: 'Hotdog', mouthfuls: 3, up: 1.1, gap: [2, 4], sound: 'bite' }, // (souvlaki's)
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
  if (p.snack?.mouthfuls > 0 && p.holding?.includes(p.snack.held)) dropToFloor(p, p.snack.held); // (one not finished falls)
  dropSnack(p);
  const held = hold(p, item, { hand: 'R' });
  if (item === 'beer') held.stout = p.likesStout ??= peopleRng() < STOUT_SHARE;
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
  if (!snack) { lightUp(p, clip, dt); return clip; }
  // knocked down, dead or gone indoors (but for into the room you're in, as a pint in a pub is: see aboutTheRoom): it's gone
  if (p.punched || p.mode === 'dead' || (p.mode === 'indoors' && !p.inRoom) || !p.holding?.includes(snack.held)) {
    if ((p.punched || p.mode === 'dead') && snack.mouthfuls > 0 && p.holding?.includes(snack.held)) dropToFloor(p, snack.held); // (knocked from their hand)
    dropSnack(p);
    return clip;
  }
  const kind = SNACKS[snack.item], clips = personModel.clips;
  const carried = clips[clip.name + kind.clip], raised = clips[clip.name + kind.clip + 'Bite'];
  if (!carried || carried.missing || !raised) return clip; // (lying down or on the grass, it waits)
  if (snack.up > 0) {
    const was = snack.up;
    snack.up -= dt;
    if (was > kind.up - SNACK_TAKEN && snack.up <= kind.up - SNACK_TAKEN) {
      snack.mouthfuls--;
      if (ITEMS[snack.item].parts[0].eaten) snack.held.left = snack.mouthfuls/kind.mouthfuls;
      if (snack.item === 'beer') p.pints = (p.pints ?? 0) + 1/kind.mouthfuls; // (going to their head: see peopleDrunk.js)
      // and what it leaves on them, every mouthful stacking (STATUS_SOURCES, addStatus in life/statuseffects.js)
      const leaves = STATUS_SOURCES[snack.item];
      leaves?.forEach(leave => addStatus(p, leave.status, leave.seconds, lastPeopleTime ?? 0, leave.level));
      if (kind.sound) eatingSound({ x: p.x, y: p.y + (clip.pose ? 1.05 : 1.5)*p.height*S.peopleSize, z: p.z }, kind.sound);
    }
    if (snack.item === 'cig' && was > EXHALE_AT && snack.up <= EXHALE_AT) snack.exhale = EXHALE_TIME;
    if (snack.up <= 0) {
      if (snack.mouthfuls <= 0) { if (snack.item === 'cig') dropToFloor(p, snack.held); dropSnack(p); return clip; } // (the butt's flicked away)
      snack.next = snackGap(kind);
    }
  } else if ((snack.next -= dt) <= 0) snack.up = kind.up;
  if (snack.item === 'cig') smoke(p, snack, kind, dt);
  return snack.up > 0 ? raised : carried;
}

// ============== SMOKING ==============
// A share of people smoke (p.smoker): now and then, out of doors with their hands free, they light up a cig, a snack
// like any other but for its drags: the tip glows bright while it's at the lips (CIG_FIRE, held.glow) and a cloud's
// blown out of the mouth as it comes down (EXHALE_*).
const SMOKER_SHARE = 0.15, SMOKE_EVERY = [40, 200]; // (seconds between cigs)
const DRAW_ON = [0.45, 0.4];   // the drag: from this long after the hand goes up, to this long before it's down (seconds)
const GLOW_UP = 4, GLOW_DOWN = 1.2; // how fast the tip brightens and dims, per second
const EXHALE_AT = 0.35, EXHALE_TIME = 1.1, EXHALE_PUFFS = 14; // (when, how long, puffs a second)
const smokeGap = () => SMOKE_EVERY[0] + peopleRng()*(SMOKE_EVERY[1] - SMOKE_EVERY[0]);
function lightUp(p, clip, dt) {
  if (!(p.smoker ??= peopleRng() < SMOKER_SHARE)) return;
  if ((p.nextCig ??= smokeGap()) > 0) { p.nextCig -= dt; return; }
  if (p.holding?.length || p.punched || p.act || p.mode === 'dead' || p.mode === 'indoors' || inRoom(p) || !personModel?.clips[clip.name + 'Cig']) return;
  p.nextCig = smokeGap();
  giveSnack(p, 'cig');
}
function smoke(p, snack, kind, dt) {
  const drawing = snack.up > 0 && snack.up < kind.up - DRAW_ON[0] && snack.up > DRAW_ON[1];
  const held = snack.held;
  held.glow = Math.max(0, Math.min(1, (held.glow ?? 0) + (drawing ? GLOW_UP : -GLOW_DOWN)*dt));
  if (!(snack.exhale > 0)) return;
  snack.exhale -= dt;
  for (let k = Math.floor(EXHALE_PUFFS*dt + peopleRng()); k > 0; k--) exhale(p);
}
const mouth = new THREE.Vector3(), ahead = new THREE.Vector3(), mouthAt = new THREE.Vector3(), aheadAt = new THREE.Vector3();
/**
 * A puff of smoke out of someone's mouth.
 * @param {object} p - the person
 * @returns {void}
 */
export function exhale(p) {
  const i = people.indexOf(p), face = personModel?.face;
  if (i < 0 || !face?.mouth) return;
  headPointOf(i, mouth.copy(face.mouth), mouthAt);
  headPointOf(i, ahead.copy(face.mouth).setZ(face.mouth.z + 1), aheadAt);
  cigSmokeFx(mouthAt, aheadAt.sub(mouthAt).normalize(), p.height*S.peopleSize, p);
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
// ============== DROPPED ==============
// A snack not finished when another's handed over, or they're punched or killed, falls from their hand (dropToFloor) and
// tumbles as a box on the flat ground at their feet — gravity, bouncing off its corners, friction — so a cup or a pint can
// land upright or fall over; it lies there DROPPED_TIME seconds.
// BODIES: each one's box, half its size in metres (as ITEMS' are) once turned by `turn` from how it's held to how it stands.
const DROPPED_TIME = 30, DROPPED_MAX = 64, DROP_FROM = [0, 1, -0.25]; // (where it leaves them: metres, their frame)
const BODIES = {
  hotdog: { half: [0.03, 0.025, 0.0875], turn: [Math.PI/2, 0, 0] },
  coffee: { half: [0.055, 0.083, 0.055] },
  beer: { half: [0.045, 0.1, 0.045] },
  cig: { half: [0.005, 0.005, 0.04], turn: [Math.PI/2, 0, 0] },
  slice: { half: [0.06, 0.008, 0.085], turn: [-Math.PI/2, 0, 0] },
  skewer: { half: [0.016, 0.014, 0.085], turn: [-Math.PI/2, 0, 0] },
};
const DROP_GRAVITY = 9.8, BOUNCE = 0.25, GRIP = 0.4, SETTLE = 0.05, DROP_STEPS = 4;
const dropped = []; // {shape, left, light, until, scale, ground, half, pos, vel, spin, turn, rest: Quaternion}, oldest first
let droppedAt = null;
const yAxis = new THREE.Vector3(0, 1, 0), corner = new THREE.Vector3(), arm = new THREE.Vector3(), pointVel = new THREE.Vector3(), push = new THREE.Vector3();
const spinTurn = new THREE.Quaternion();
const layFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI/2, 0, 0)), PIZZA_SLICE_Y = 0.016; // (a slice on the tray: cheese up)
function dropToFloor(p, held) {
  const i = people.indexOf(p), body = BODIES[held.item], item = ITEMS[held.item];
  if (!personModel || i < 0 || !body || !item) return;
  personModel.mesh.getMatrixAt(i, instance);
  const u = personModel.unitsPerMetre; // (from their feet: the model's lowest point)
  world.multiplyMatrices(instance, anchor.makeTranslation(0, personModel.floorY ?? 0, 0).scale(size.setScalar(u)));
  const scale = place.setFromMatrixColumn(world, 0).length(), ground = place.setFromMatrixPosition(world).y;
  const facing = new THREE.Quaternion().setFromRotationMatrix(part.extractRotation(world));
  const left = item.parts[0].eaten ? held.left : 1, r = () => peopleRng() - 0.5;
  dropped.push({
    shape: item.parts[0].shape === 'beer' && held.stout ? 'stout' : item.parts[0].shape, left, light: inRoom(p) ? 'lit' : 'plain',
    until: (lastPeopleTime ?? 0) + DROPPED_TIME, scale, ground, size: item.parts[0].size,
    half: new THREE.Vector3(...body.half).multiplyScalar(scale).multiply(new THREE.Vector3(1, 1, body.turn ? Math.max(0.2, left) : 1)),
    pos: new THREE.Vector3(...DROP_FROM).applyMatrix4(world),
    vel: new THREE.Vector3(r(), 0.5 + r(), -0.6 + r()).applyQuaternion(facing).multiplyScalar(scale),
    spin: new THREE.Vector3(r()*10, r()*6, r()*10),
    turn: facing.clone().multiply(spinTurn.setFromAxisAngle(yAxis, peopleRng()*Math.PI*2)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(r()*0.8, 0, r()*0.8))),
    rest: new THREE.Quaternion().setFromEuler(new THREE.Euler(...(body.turn ?? [0, 0, 0]))),
  });
  if (dropped.length > DROPPED_MAX) dropped.shift();
}
// One step of a dropped thing: falling and turning, then pushed back up out of the ground at each corner under it (an
// impulse at that corner, which is what tips it over), sliding to a stop.
function stepDropped(d, dt) {
  d.vel.y -= DROP_GRAVITY*d.scale*dt;
  d.pos.addScaledVector(d.vel, dt);
  const angle = d.spin.length()*dt;
  if (angle > 1e-6) d.turn.premultiply(spinTurn.setFromAxisAngle(arm.copy(d.spin).normalize(), angle)).normalize();
  const inertia = d.half.lengthSq()/3; // (a box's, near enough, for a mass of 1)
  let deepest = 0;
  for (let c = 0; c < 8; c++) {
    corner.set(c & 1 ? d.half.x : -d.half.x, c & 2 ? d.half.y : -d.half.y, c & 4 ? d.half.z : -d.half.z).applyQuaternion(d.turn);
    const depth = d.ground - (d.pos.y + corner.y);
    if (depth <= 0) continue;
    deepest = Math.max(deepest, depth);
    arm.copy(corner);
    pointVel.crossVectors(d.spin, arm).add(d.vel);
    if (pointVel.y >= 0) continue;
    const across = push.set(arm.z, 0, -arm.x).lengthSq(); // (|arm × up|²)
    const j = -(1 + BOUNCE)*pointVel.y/(1 + across/inertia);
    d.vel.y += j;
    d.spin.add(push.set(-arm.z, 0, arm.x).multiplyScalar(j/inertia)); // (arm × up, times the impulse)
    d.vel.x -= pointVel.x*GRIP/4; d.vel.z -= pointVel.z*GRIP/4;
    d.spin.multiplyScalar(1 - GRIP/8);
  }
  if (deepest > 0) d.pos.y += deepest;
  if (deepest > 0 && d.vel.lengthSq() < (SETTLE*d.scale)**2 && d.spin.lengthSq() < SETTLE) { d.vel.set(0, 0, 0); d.spin.set(0, 0, 0); d.still = true; }
}
function updateDropped() {
  const now = lastPeopleTime ?? 0, dt = Math.min(0.05, Math.max(0, now - (droppedAt ?? now)));
  droppedAt = now;
  while (dropped.length && dropped[0].until <= now) dropped.shift();
  for (const d of dropped) {
    if (!d.still && dt > 0) for (let n = 0; n < DROP_STEPS; n++) stepDropped(d, dt/DROP_STEPS);
    part.compose(d.pos, turn.copy(d.turn).multiply(d.rest), size.set(...d.size).multiplyScalar(d.scale));
    draw(d.shape, d.light, part, color.setHex(0xffffff), d.left);
  }
}

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
        if (piece.sits) place.y -= (meshes[`${piece.shape}:${light}`]?.userData.cut.bottom ?? -0.5)*size.y; // (its bottom on the table)
        if (size.y <= 0 || left <= 0) continue;
        part.compose(place, turn.setFromEuler(euler), size);
        draw(piece.shape === 'beer' && held.stout ? 'stout' : piece.shape, light, part.premultiply(world), piece.tint ? color.setHex(held.loaded ?? held.color.getHex()) : color.setHex(piece.color ?? 0xffffff), left, held.glow ?? 0);
      }
      // and the slices left of a pizza, flat round the middle of its tray, tips in
      if (held.slices) for (let k = 0; k < held.slices; k++) {
        const s = ITEMS[held.slice].parts[0].size[1];
        turn.setFromAxisAngle(yAxis, k*Math.PI*2/PIZZA_SLICES);
        place.set(0, PIZZA_SLICE_Y, s/2).applyQuaternion(turn);
        part.compose(place, turn.multiply(layFlat), size.setScalar(s));
        draw(held.slice, light, part.premultiply(world), color.setHex(0xffffff));
      }
      // and what's left on the plate
      if (held.food && !held.served) for (const food of held.food) {
        part.compose(place.set(food.x, FOOD_SIZE*0.45, food.z), turn.identity(), size.setScalar(FOOD_SIZE));
        draw('sphere', light, part.premultiply(world), color.setHex(food.color));
      }
    }
  });
  if (only < 0) updateDropped();
  for (const [key, mesh] of Object.entries(meshes)) {
    mesh.count = counts[key];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (mesh.geometry.attributes.cut) mesh.geometry.attributes.cut.needsUpdate = true;
    if (mesh.geometry.attributes.glow) mesh.geometry.attributes.glow.needsUpdate = true;
  }
}
function draw(shape, light, matrix, tint, left = 1, glow = 0) {
  for (const key of [`${shape}:${light}`, `${shape}~clear:${light}`]) { // (a model's see-through half, if it has one, along with it)
    const mesh = meshes[key], at = counts[key] ?? 0;
    if (!mesh || at >= HELD_MAX) continue;
    mesh.setMatrixAt(at, matrix);
    mesh.setColorAt(at, tint);
    if (mesh.userData.cut) mesh.geometry.attributes.cut.setX(at, left < 1 ? mesh.userData.cut.bottom + mesh.userData.cut.height*left : 1e6);
    mesh.geometry.attributes.glow?.setX(at, glow);
    counts[key] = at + 1;
  }
}
