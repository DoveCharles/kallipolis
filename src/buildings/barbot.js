import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// ============================================================ the bar bot
// Every pub has a bar bot (assets/models/Barbot.glb) behind its bar, between the back bar and the counter, and it never
// leaves: it only slides along the bar (the room's x), its body bone (Body) turning on its yaw to face the way it's going
// and back round to face the bar when it stops. Now and then it polishes a glass (PolishGlass) or wipes the bar
// (CleanBar: done from the middle of the counter, facing it, where it was animated), looking down (the LookDown shape)
// while it does; otherwise its eyes (Look Left/Right) flick about and its eyebrow (Raised Eyebrow) goes up now and then.
// With nobody in the pub it sleeps: the Sleep pose, its face (Face) swapped for the Zzz, and its screen (the Face and
// FaceBacklight materials) dimmed. There's only ever one room up, so there's one bot, moved to whichever pub that is
// (placeBarbot, from furnishPub in interior.js). How far behind the counter it stands and how tall it is are tuned in
// View > Bar Bot (debug) (ui/barbot-debug.js) and remembered in the browser.
const BARBOT_MODEL_URL = 'assets/models/Barbot.glb';
const STORAGE_KEY = 'kallipolis.barbot';
/** How far behind the counter's back edge it stands (m), and how tall it is (m): see ui/barbot-debug.js. */
export const BARBOT_TUNING = { behind: 0.45, height: 1.6 };
try { Object.assign(BARBOT_TUNING, JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}); } catch (err) { /* storage blocked or garbled: the defaults */ }
export function rememberBarbotTuning() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(BARBOT_TUNING)); } catch (err) { /* storage blocked: not remembered */ }
}

const SPEED = 0.5;          // m/s along the bar
const TURN = 5;             // rad/s, the body's yaw
const FACING = 0.15;        // rad: near enough facing the way it means to
const FADE = 0.4;           // s, between poses
const SHAPE_EASE = 8;       // the face's shapes, eased per second (the eyes jump: see `look`)
const ASLEEP_GLOW = 0.12;   // its screen's glow asleep, of awake
const END_GAP = 0.35;       // kept from either end of the counter
const SHAPES = ['Look Left/Right', 'Raised Eyebrow', 'LookDown'];

let bot = null;             // { root, rig, body, mixer, actions, shaped, screens, face, zzz, height }
let place = null;           // where it is in this pub: { x0, x1, mid, barZ }
const state = {
  x: 0, goal: 0, yaw: 0, doing: 'idle', next: 0, then: null, asleep: false, snap: true,
  look: 0, lookNext: 0, brow: 0, browUntil: 0, browNext: 0, shape: [0, 0, 0], glow: 1,
};
let lastTime = 0;
const yawTurn = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);

/**
 * Load the model, lit with the room's `lit` (see roomLit in interior.js) but for its screen and glass.
 * @param {function(THREE.Material): THREE.Material} lit
 */
export async function loadBarbot(lit) {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(BARBOT_MODEL_URL);
  } catch (err) {
    console.warn('Kallipolis: the bar bot model failed to load; pubs have no bar bot', err);
    return;
  }
  const rig = gltf.scene;
  let body = null, face = null, zzz = null;
  const shaped = [], screens = [], meshes = [];
  rig.traverse(o => {
    if (o.isBone && /^body/i.test(o.name) && !body) body = o;
    if (o.name === 'Face' && !o.isBone) face = o;
    if (o.name === 'Zzz' && !o.isBone) zzz = o;
    if (!o.isMesh) return;
    meshes.push(o);
    o.frustumCulled = false; // (skinned: its bounds are the rest pose's)
    o.castShadow = o.receiveShadow = !o.material.transparent;
    const m = o.material;
    if (m.name === 'Face' || m.name === 'FaceBacklight') screens.push(o);
    else if (!m.transparent && !m.userData.lit) { lit(m); m.userData.lit = true; }
    if (o.morphTargetDictionary && SHAPES.some(s => s in o.morphTargetDictionary)) shaped.push(o);
  });
  for (const o of screens) o.userData.glow = o.material.emissiveIntensity;
  if (zzz) zzz.visible = false;
  const size = new THREE.Box3().setFromObject(rig).getSize(new THREE.Vector3());
  const root = new THREE.Group();
  root.name = 'BarBot';
  root.add(rig);
  const mixer = new THREE.AnimationMixer(rig), actions = {};
  for (const clip of gltf.animations) {
    // (a pose is a single frame: given a length, so looping it doesn't divide by nothing)
    if (clip.duration < 0.1) clip.duration = 1;
    const action = mixer.clipAction(clip);
    if (clip.name === 'PolishGlass' || clip.name === 'CleanBar') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[clip.name] = action;
  }
  mixer.addEventListener('finished', e => { if (e.action === actions[state.doing]) settle(); });
  bot = { root, rig, body, mixer, actions, shaped, screens, face, zzz, height: size.y };
  sizeBarbot();
}

/** What's to be compiled under the loading screen (see warmUp in interior.js), or null. */
export const barbotWarmUp = () => bot ? cloneSkinned(bot.root) : null;

/** Scale it to BARBOT_TUNING.height, and stand it BARBOT_TUNING.behind the counter. */
export function sizeBarbot() {
  if (!bot) return;
  bot.root.scale.setScalar(BARBOT_TUNING.height/bot.height);
  if (place) bot.root.position.z = place.barZ - BARBOT_TUNING.behind;
}

/**
 * Put the bot behind this pub's counter, in `group` (the pub's furniture, in the room's terms).
 * @param {THREE.Group} group
 * @param {{x0: number, x1: number, barZ: number}} bar - the counter's ends along x, and its back edge's z (the bot's on
 *   the -z side of it, facing +z)
 * @param {function(): number} rng
 */
export function placeBarbot(group, bar, rng) {
  if (!bot) return;
  const x0 = bar.x0 + END_GAP, x1 = Math.max(x0, bar.x1 - END_GAP);
  place = { x0, x1, mid: (bar.x0 + bar.x1)/2, barZ: bar.barZ };
  Object.assign(state, { x: x0 + rng()*(x1 - x0), yaw: 0, doing: 'idle', next: 1 + rng()*3, then: null, snap: true });
  state.goal = state.x;
  bot.root.position.set(state.x, 0, 0);
  sizeBarbot();
  group.add(bot.root);
}

// what it's doing: 'idle', 'walk' (then `state.then` once it's there and facing the bar), 'PolishGlass', 'CleanBar'
function pose(name, fade = FADE) {
  const to = bot.actions[name];
  if (!to) return;
  // (isScheduled, not isRunning: a finished PolishGlass or CleanBar is held on its last frame, and fades out too)
  for (const action of Object.values(bot.actions)) if (action !== to && action.isScheduled()) action.fadeOut(fade);
  to.reset().setEffectiveWeight(1).fadeIn(fade).play();
}
function settle() {
  state.doing = 'idle';
  state.next = 2 + Math.random()*6;
  pose('DefaultPose');
}
function decide() {
  const r = Math.random();
  if (r < 0.4) walkTo(place.x0 + Math.random()*(place.x1 - place.x0), null);
  else if (r < 0.65) walkTo(state.x, 'PolishGlass');
  else if (r < 0.85) walkTo(Math.min(place.x1, Math.max(place.x0, place.mid)), 'CleanBar');
  else state.next = 1 + Math.random()*3;
}
function walkTo(x, then) {
  state.goal = x;
  state.then = then;
  state.doing = 'walk';
}

/**
 * Each frame, while the room's up.
 * @param {boolean} inPub - the room up is a pub
 * @param {boolean} occupied - anyone's in it
 */
export function updateBarbot(inPub, occupied) {
  const now = performance.now()/1000, dt = Math.min(0.1, now - lastTime);
  lastTime = now;
  if (!bot || !place || !inPub || bot.root.parent == null) return;

  const snap = state.snap;
  state.snap = false;
  if (!occupied !== state.asleep || snap) {
    state.asleep = !occupied;
    if (state.asleep) { state.doing = 'sleep'; pose('Sleep', snap ? 0 : FADE*2); }
    else { settle(); if (snap) pose('DefaultPose', 0); }
    if (bot.face) bot.face.visible = !state.asleep;
    if (bot.zzz) bot.zzz.visible = state.asleep;
  }

  // along the bar, turning to face the way it's going, and back to the bar once it's there
  let yawGoal = 0;
  if (state.doing === 'walk') {
    const dx = state.goal - state.x;
    if (Math.abs(dx) > 0.01) {
      yawGoal = Math.sign(dx)*Math.PI/2;
      if (Math.abs(yawGoal - state.yaw) < FACING) state.x += Math.sign(dx)*Math.min(Math.abs(dx), SPEED*dt);
    } else if (Math.abs(state.yaw) < 0.02) {
      if (state.then) { state.doing = state.then; state.then = null; pose(state.doing); }
      else settle();
    }
  } else if (state.doing === 'idle' && (state.next -= dt) <= 0) decide();
  const turn = yawGoal - state.yaw;
  state.yaw += Math.sign(turn)*Math.min(Math.abs(turn), TURN*dt);
  bot.root.position.x = state.x;

  bot.mixer.update(dt);
  if (bot.body) bot.body.quaternion.premultiply(yawTurn.setFromAxisAngle(UP, state.yaw));

  // the face: looking down at the work, or the eyes flicking about and the eyebrow going up now and then
  const working = state.doing === 'PolishGlass' || state.doing === 'CleanBar';
  if (now > state.lookNext) { state.look = Math.random()*2 - 1; state.lookNext = now + 0.4 + Math.random()*2.5; }
  if (now > state.browNext) { state.browUntil = now + 0.6 + Math.random()*1.2; state.browNext = state.browUntil + 3 + Math.random()*8; }
  const goals = working || state.asleep ? [0, 0, working ? 1 : 0] : [state.look, now < state.browUntil ? 1 : 0, 0];
  const ease = Math.min(1, SHAPE_EASE*dt);
  goals.forEach((g, i) => { state.shape[i] = i === 0 && !working ? g : state.shape[i] + (g - state.shape[i])*ease; });
  for (const mesh of bot.shaped) SHAPES.forEach((name, i) => {
    const k = mesh.morphTargetDictionary[name];
    if (k != null) mesh.morphTargetInfluences[k] = state.shape[i];
  });

  // its screen dimmed while it sleeps (set on whatever material the mesh has now: see fadeWhatsInTheWay in interior.js)
  const glow = state.asleep ? ASLEEP_GLOW : 1;
  state.glow = snap ? glow : state.glow + (glow - state.glow)*Math.min(1, 3*dt);
  for (const o of bot.screens) o.material.emissiveIntensity = o.userData.glow*state.glow;
}
