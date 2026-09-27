import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// ============================================================ the bar bot
// Every pub has a bar bot (assets/models/Barbot.glb) behind its bar, between the back bar and the counter, and it never
// leaves: it only slides along the bar (the room's x), its body bone (Body) turning on its yaw to face the way it's going
// and back round to face the bar when it stops. Now and then it polishes a glass (PolishGlass) or wipes the bar
// (CleanBar: done from the middle of the counter, facing it, where it was animated), looking down (the LookDown shape)
// while it does; otherwise its eyes (Look Left/Right) flick about and its eyebrow (Raised Eyebrow) goes up now and then.
// Standing about or going along the bar, it swivels its head (Head) to look round the room now and then.
// With nobody in the pub it sleeps: the Sleep pose, its face (Face) swapped for the Zzz (glowing just short of the lit
// screen: the Face material's dark ink turned to the backlight's glow), and the screen behind them (FaceBacklight)
// dimmed. There's only ever one room up, so there's one bot, moved to whichever pub that is (placeBarbot, from
// furnishPub in interior.js).
const BARBOT_MODEL_URL = 'assets/models/Barbot.glb';
const BEHIND = 0.38;        // m, stood behind the counter's back edge
const HEIGHT = 1.85;        // m tall

const SPEED = 0.5;          // m/s along the bar
const TURN = 5;             // rad/s, the body's yaw
const FACING = 0.15;        // rad: near enough facing the way it means to
const FADE = 0.4;           // s, between poses
const SHAPE_EASE = 8;       // the face's shapes, eased per second (the eyes jump: see `look`)
const ASLEEP_GLOW = 0.12;   // its screen's backlight's glow asleep, of awake
const ASLEEP_FACE = 0.85;   // and the Zzz's (the Face material's), of the backlight's awake
const HEAD_REACH = 0.7;     // rad, the most its head swivels either way looking round
const HEAD_EASE = 3;        // the head's swivel, eased per second
const END_GAP = 0.35;       // kept from either end of the counter
const SHAPES = ['Look Left/Right', 'Raised Eyebrow', 'LookDown'];

let bot = null;             // { root, rig, body, mixer, actions, shaped, screens, face, zzz, height }
let place = null;           // where it is in this pub: { x0, x1, mid, barZ }
const state = {
  x: 0, goal: 0, yaw: 0, doing: 'idle', next: 0, then: null, asleep: false, snap: true,
  look: 0, lookNext: 0, brow: 0, browUntil: 0, browNext: 0, shape: [0, 0, 0], sleepy: 0,
  head: 0, headGoal: 0, headNext: 0,
};
let lastTime = 0;
const yawTurn = new THREE.Quaternion(), yawUndo = new THREE.Quaternion(), headTurn = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);

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
  let body = null, head = null, face = null, zzz = null;
  const shaped = [], screens = [], meshes = [];
  rig.traverse(o => {
    if (o.isBone && /^body/i.test(o.name) && !body) body = o;
    if (o.isBone && o.name === 'Head') head = o;
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
  // (each screen's awake glow, and its asleep one: the backlight's dimmed, the Face material's ink lit up to the
  // backlight's colour)
  const backlight = screens.find(o => o.material.name === 'FaceBacklight')?.material;
  for (const o of screens) {
    const m = o.material, ink = m.name === 'Face';
    o.userData.awake = m.emissive.clone().multiplyScalar(m.emissiveIntensity);
    o.userData.asleep = ink && backlight ? backlight.emissive.clone().multiplyScalar(backlight.emissiveIntensity*ASLEEP_FACE)
      : o.userData.awake.clone().multiplyScalar(ink ? ASLEEP_FACE : ASLEEP_GLOW);
  }
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
  bot = { root, rig, body, head, mixer, actions, shaped, screens, face, zzz, height: size.y };
  sizeBarbot();
}

/** What's to be compiled under the loading screen (see warmUp in interior.js), or null. */
export const barbotWarmUp = () => bot ? cloneSkinned(bot.root) : null;

/** Scale it to HEIGHT, and stand it BEHIND the counter. */
function sizeBarbot() {
  if (!bot) return;
  bot.root.scale.setScalar(HEIGHT/bot.height);
  if (place) bot.root.position.z = place.barZ - BEHIND;
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
  for (const action of Object.values(bot.actions)) if (action !== to && action.isScheduled()) fade ? action.fadeOut(fade) : action.stop();
  // (a held pose is left held: restarted, it'd fade in from nothing, and the mixer fills what's missing with the rest
  // pose, a T-pose)
  if (to.loop === THREE.LoopRepeat && to.isRunning() && to.getEffectiveWeight() > 0) {
    to.stopFading().setEffectiveWeight(1);
    return;
  }
  to.reset().setEffectiveWeight(1).play();
  if (fade) to.fadeIn(fade);
}
function settle(fade = FADE) {
  state.doing = 'idle';
  state.next = 1 + Math.random()*3;
  state.headNext = performance.now()/1000 + 0.3 + Math.random()*0.7;
  pose('DefaultPose', fade);
}
function decide() {
  const r = Math.random();
  if (r < 0.6) walkTo(place.x0 + Math.random()*(place.x1 - place.x0), null);
  else if (r < 0.75) walkTo(place.x0 + Math.random()*(place.x1 - place.x0), 'PolishGlass');
  else if (r < 0.9) walkTo(Math.min(place.x1, Math.max(place.x0, place.mid)), 'CleanBar');
  else state.next = 0.5 + Math.random()*1.5;
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
    else settle(snap ? 0 : FADE);
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

  // its head swivelling to look round the room while it stands about or goes along the bar, and straight again while it
  // works or sleeps
  if ((state.doing !== 'idle' && state.doing !== 'walk') || state.asleep) state.headGoal = 0;
  else if (now > state.headNext) {
    state.headGoal = Math.random() < 0.3 ? 0 : (Math.random()*2 - 1)*HEAD_REACH;
    state.headNext = now + 1 + Math.random()*2.5;
  }
  state.head += (state.headGoal - state.head)*Math.min(1, HEAD_EASE*dt);

  // (last frame's turns taken off first: the mixer only writes a bone when its value changes, and the poses hold Body
  // and Head still, so otherwise the turns pile up)
  if (bot.body) bot.body.quaternion.premultiply(yawUndo.copy(yawTurn).invert());
  if (bot.head) bot.head.quaternion.premultiply(yawUndo.copy(headTurn).invert());
  bot.mixer.update(dt);
  if (bot.body) bot.body.quaternion.premultiply(yawTurn.setFromAxisAngle(UP, state.yaw));
  if (bot.head) bot.head.quaternion.premultiply(headTurn.setFromAxisAngle(UP, state.head));

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

  // its screen dimmed while it sleeps, the Zzz nearly as bright as the face (set on whatever material the mesh has now:
  // see fadeWhatsInTheWay in interior.js)
  const sleepy = state.asleep ? 1 : 0;
  state.sleepy = snap ? sleepy : state.sleepy + (sleepy - state.sleepy)*Math.min(1, 3*dt);
  for (const o of bot.screens) {
    o.material.emissive.lerpColors(o.userData.awake, o.userData.asleep, state.sleepy);
    o.material.emissiveIntensity = 1;
  }
}
