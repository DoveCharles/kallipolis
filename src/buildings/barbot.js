import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { babble, nextSyllable } from '../audio/voices.js';
import { botWhir } from '../audio/whir.js';
import { TOON_RAMP } from '../core/toon.js';

// ============================================================ the bar bot
// (The same model, dressed as a waiter — Pint hidden, Moustache shown, Tux shape on — is every restaurant's waiter: waiterBody,
// dressBot, botFace; see waiterbot.js.)
// Every pub has a bar bot (assets/models/Barbot.glb) behind its bar, between the back bar and the counter, and it never
// leaves: it only slides along the bar (the room's x), its body (Body) turning on its yaw to face the way it's going
// and back round to face the bar when it stops. (Body's the root bone, at the model's origin and never moved by its
// poses, so it's the whole model that's turned: the same to look at, and the pose mixer never sees it — see `yaw`.) Now and then it polishes a glass (PolishGlass) or wipes the bar
// (CleanBar: done from the middle of the counter, facing it, where it was animated), looking down (the LookDown shape)
// while it does; otherwise its eyes (Look Left/Right) flick about and its eyebrow (Raised Eyebrow) goes up now and then.
// Awake, it blinks (Blink: shut outright and open again, no easing) every few seconds.
// Standing about or going along the bar, it swivels its head (Head) to look round the room now and then.
// With nobody in the pub it sleeps: the Sleep pose, its face (Face) swapped for the Zzz (glowing just short of the lit
// screen: the Face material's dark ink turned to the backlight's glow), and the screen behind them (FaceBacklight)
// dimmed. There's only ever one room up, so there's one bot, moved to whichever pub that is (placeBarbot, from
// furnishPub in interior.js).
// Someone sat at the bar now and then talks to it (a 'bar' chat: see "talking to the bar bot" in
// life/people/peopleActivities.js), `BARBOT` standing in for it among them: it drops what it's doing and stands still,
// turned to them, its eyes left alone but for blinking; on its turns it babbles in a robot's voice (ROBOT_VOICE: see
// audio/voices.js), its mouth (Talk) snapping open and shut.
const BARBOT_MODEL_URL = 'assets/models/Barbot.glb';
const BEHIND = 0.38;        // m, stood behind the counter's back edge
export const HEIGHT = 1.85;      // m tall

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
const STAND_FROM = 5, STAND_MORE = 7; // s stood about between one thing and the next (5 to 12)
const SHAPES = ['Look Left/Right', 'Raised Eyebrow', 'LookDown', 'Blink', 'Talk'];
const BLINK = 0.12;         // s, the eyes shut
const CHAT_STALE = 2;       // s without word from its chat (see BARBOT.chat) before it's taken to be over
const MOUTH_SNAP = [0.05, 0.14]; // s, how long its mouth stays open or shut, talking
export const HEAD_UP = 0.2;      // m above its Head bone: its face, where its voice comes from and it's looked at
// its voice: the peds' babble (a pitch, where its formants sit, how sharp they ring: see audio/voices.js), made a robot's —
// flat notes on a square wave, buzzing at `robot` Hz
const ROBOT_VOICE = { pitch: 240, formant: 1.1, sharpness: 7, melody: 0, robot: 90 };

/**
 * The bar bot as the people talking to it see it (see "talking to the bar bot" in life/people/peopleActivities.js): where
 * its head is, in the world; how talkative it is, for taking turns; and the chat it's in (a group, kept fresh by its
 * `seenAt`, performance.now() in seconds), set and cleared by whoever it's talking to.
 */
export const BARBOT = { x: 0, y: 0, z: 0, traits: { talkative: 1 }, chat: null, lookAt: null, phrase: null, isBarbot: true };

let bot = null;             // { root, rig, head, mixer, actions, shaped, screens, face, zzz, height }
let place = null;           // where it is in this pub: { x0, x1, mid, barZ }
const state = {
  x: 0, goal: 0, yaw: 0, doing: 'idle', next: 0, then: null, asleep: false, snap: true,
  look: 0, lookNext: 0, brow: 0, browUntil: 0, browNext: 0, blinkUntil: 0, blinkNext: 0, shape: [0, 0, 0, 0, 0], sleepy: 0,
  inPub: false, chatting: false, talkIn: 0, syllable: false, mouth: 0, mouthNext: 0,
  head: 0, headGoal: 0, headNext: 0,
};
let lastTime = 0;
const headAt = new THREE.Vector3(), towards = new THREE.Vector3();
const yawUndo = new THREE.Quaternion(), headTurn = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);

/**
 * Load the model, toon-shaded like the people (and lit like them indoors: the room's lamps and glow, see interior.js)
 * but for its screen and glass.
 */
export async function loadBarbot() {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(BARBOT_MODEL_URL);
  } catch (err) {
    console.warn('Kallipolis: the bar bot model failed to load; pubs have no bar bot', err);
    return;
  }
  const spare = cloneSkinned(gltf.scene); // (before any materials are swapped: the waiter's own, see waiterbot.js)
  bot = makeBot(gltf.scene, gltf.animations);
  dressBot(bot, false);
  bot.mixer.addEventListener('finished', e => { if (e.action === bot.actions[state.doing]) settle(); });
  waiter = makeBot(spare, gltf.animations);
  dressBot(waiter, true);
  sizeBarbot();
}
let waiter = null;
/** The second body, dressed as a waiter (see waiterbot.js), or null. */
export const waiterBody = () => waiter;

// A body from the model: toon-shaded like the people (and lit like them indoors: the room's lamps and glow, see
// interior.js) but for its screen and glass, which are its own.
function makeBot(rig, animations) {
  let head = null, face = null, zzz = null, pint = null, moustache = null, robe = null, headband = null, knife = null, bowtie = null;
  const shaped = [], screens = [], tux = [], aprons = [], black = [], toon = new Map();
  rig.traverse(o => {
    if (o.isBone && o.name === 'Head') head = o;
    if (o.name === 'Face' && !o.isBone) face = o;
    if (o.name === 'Zzz' && !o.isBone) zzz = o;
    if (o.name === 'Pint' && !o.isBone) pint = o;
    if (o.name === 'Moustache' && !o.isBone) moustache = o;
    if (o.name === 'Robe' && !o.isBone) robe = o;
    if (o.name.startsWith('Headband') && !o.isBone) headband = o;
    if (o.name === 'Yanagiba' && !o.isBone) knife = o;
    if (o.name === 'Bowtie' && !o.isBone) bowtie = o;
    if (!o.isMesh) return;
    o.frustumCulled = false; // (skinned: its bounds are the rest pose's)
    o.castShadow = o.receiveShadow = !o.material.transparent;
    const m = o.material;
    if (m.name === 'Apron') aprons.push(o);
    if (m.name === 'Face' || m.name === 'FaceBacklight') { o.material = m.clone(); screens.push(o); }
    else if (!m.transparent) {
      if (!toon.has(m)) toon.set(m, Object.assign(new THREE.MeshToonMaterial({ name: m.name, color: m.color, map: m.map, gradientMap: TOON_RAMP, side: THREE.DoubleSide, flatShading: true }),
        { defines: { ROOM_LAMP: '', ROOM_GLOW: '' } }));
      o.material = toon.get(m);
    }
    if (o.morphTargetDictionary && SHAPES.some(s => s in o.morphTargetDictionary)) shaped.push(o);
    if (o.morphTargetDictionary && 'Tux' in o.morphTargetDictionary) tux.push(o);
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
  // (the body's Black part: the one beside its Apron; the Body node's name clashes with the Body bone's, so not by name)
  rig.traverse(o => { if (o.isMesh && o.material.name === 'Black' && o.parent?.children.some(c => c.material?.name === 'Apron')) black.push(o); });
  const size = new THREE.Box3().setFromObject(rig).getSize(new THREE.Vector3());
  const root = new THREE.Group();
  root.name = 'BarBot';
  root.add(rig);
  const mixer = new THREE.AnimationMixer(rig), actions = {};
  for (const clip of animations) {
    // (a pose is a single frame: given a length, so looping it doesn't divide by nothing)
    if (clip.duration < 0.1) clip.duration = 1;
    const action = mixer.clipAction(clip);
    if (clip.name === 'PolishGlass' || clip.name === 'CleanBar') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[clip.name] = action;
  }
  return { root, rig, head, mixer, actions, shaped, screens, face, zzz, pint, moustache, robe, headband, knife, bowtie, tux, aprons,
    black, chrome: [...toon.values()].find(m => m.name === 'Chrome2'), height: size.y };
}
// the bar bot (a pint in hand), the waiter (a tux and a moustache, and no pint) or the sushi chef (a robe and headband,
// no apron: see waiterbot.js)
export function dressBot(b, waiter, chef = false) {
  if (b.pint) b.pint.visible = !waiter && !chef;
  if (b.moustache) b.moustache.visible = waiter && !chef;
  if (b.robe) b.robe.visible = chef;
  if (b.headband) b.headband.visible = chef;
  if (b.knife) b.knife.visible = false;
  if (b.bowtie) b.bowtie.visible = !chef;
  if (chef) b.aprons.forEach(o => { o.visible = false; });
  for (const o of b.black) { o.userData.black ??= o.material; o.material = chef && b.chrome ? b.chrome : o.userData.black; } // (Black → Chrome2 on the chef)
  for (const o of b.tux) o.morphTargetInfluences[o.morphTargetDictionary.Tux] = waiter || chef ? 1 : 0; // (the robe's fitted to the Tux body)
}

/** BARBOT if the bot's up in the pub the view's in, awake and not talking to anyone already, else null. */
export const barbotFree = () => bot && place && state.inPub && bot.root.parent && !state.asleep && !chatOf() ? BARBOT : null;
// the chat it's in, if whoever it's with is still keeping it going
function chatOf() {
  const chat = BARBOT.chat;
  if (chat && performance.now()/1000 - (chat.seenAt ?? 0) > CHAT_STALE) BARBOT.chat = null;
  return BARBOT.chat;
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
  state.next = STAND_FROM + Math.random()*STAND_MORE;
  state.headNext = performance.now()/1000 + 0.3 + Math.random()*0.7;
  pose('DefaultPose', fade);
}
// (mostly it stands where it is looking round the room: it's only now and then that it goes along the bar)
function decide() {
  const r = Math.random();
  if (r < 0.5) state.next = STAND_FROM + Math.random()*STAND_MORE;
  else if (r < 0.62) walkTo(place.x0 + Math.random()*(place.x1 - place.x0), null);
  else if (r < 0.82) walkTo(state.x, 'PolishGlass');
  else walkTo(Math.min(place.x1, Math.max(place.x0, place.mid)), 'CleanBar');
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
  state.inPub = inPub;
  if (!bot || !place || !inPub || bot.root.parent == null) { botWhir('bar', null, 0); return; }

  // Last frame's head swivel taken off first, before anything else touches the pose: the mixer only writes a bone when
  // its value changes, and the poses mostly hold Head still, so otherwise the swivels pile up. And first, before any
  // pose starts or stops (below, and in the mixer's 'finished'): starting one saves the bones as they are, and stopping
  // the last restores them, so a swivel still on then would be saved as where the head rests, and taken off again on top.
  if (bot.head) bot.head.quaternion.premultiply(yawUndo.copy(headTurn).invert());

  const snap = state.snap;
  state.snap = false;
  if (!occupied !== state.asleep || snap) {
    state.asleep = !occupied;
    if (state.asleep) { state.doing = 'sleep'; pose('Sleep', snap ? 0 : FADE*2); }
    else settle(snap ? 0 : FADE);
    if (bot.face) bot.face.visible = !state.asleep;
    if (bot.zzz) bot.zzz.visible = state.asleep;
  }

  // talking to someone: whatever it was doing dropped, and stood where it is turned to them
  const chat = state.asleep ? null : chatOf(), them = chat?.members[0];
  if (chat && !state.chatting && state.doing !== 'idle') settle();
  state.chatting = !!chat;

  // along the bar, turning to face the way it's going, and back to the bar once it's there
  const x0 = state.x, yaw0 = state.yaw;
  let yawGoal = 0;
  if (them) {
    bot.root.parent.worldToLocal(towards.set(them.x, 0, them.z));
    yawGoal = Math.max(-Math.PI/2, Math.min(Math.PI/2, Math.atan2(towards.x - state.x, towards.z - bot.root.position.z)));
    state.next = Math.max(state.next, 2);
  } else if (state.doing === 'walk') {
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
  const moved = dt ? Math.max(Math.abs(state.x - x0)/(SPEED*dt), 0.6*Math.abs(state.yaw - yaw0)/(TURN*dt)) : 0;
  botWhir('bar', bot.root.getWorldPosition(towards), moved);

  // its head swivelling to look round the room while it stands about or goes along the bar, and straight again while it
  // works or sleeps
  if ((state.doing !== 'idle' && state.doing !== 'walk') || state.asleep || them) state.headGoal = 0;
  else if (now > state.headNext) {
    state.headGoal = Math.random() < 0.3 ? 0 : (Math.random()*2 - 1)*HEAD_REACH;
    state.headNext = now + 1 + Math.random()*2.5;
  }
  state.head += (state.headGoal - state.head)*Math.min(1, HEAD_EASE*dt);

  bot.mixer.update(dt);
  bot.rig.rotation.y = state.yaw;
  if (bot.head) bot.head.quaternion.premultiply(headTurn.setFromAxisAngle(UP, state.head));
  // (where its head is, for whoever's talking to it to look at, and for its voice to come from)
  if (bot.head) {
    bot.head.getWorldPosition(headAt);
    BARBOT.x = headAt.x; BARBOT.y = headAt.y + HEAD_UP; BARBOT.z = headAt.z;
  }

  const working = state.doing === 'PolishGlass' || state.doing === 'CleanBar';
  botFace(bot, state, BARBOT, dt, now, { asleep: state.asleep, working, still: !!chat, talking: chat?.speaker === BARBOT, snap });
}

/**
 * A bot's face and voice for a frame: the bar bot's, or the waiter's (see waiterbot.js).
 * @param {object} b - its body (see makeBot)
 * @param {object} state - its face's state (see newFace)
 * @param {object} talker - who it is to those it talks to (BARBOT, or WAITER)
 * @param {number} dt
 * @param {number} now - seconds
 * @param {{asleep: boolean, working: boolean, still: boolean, talking: boolean, snap: boolean}} how - looking down at its
 *   work, its eyes kept still (talking to someone), its turn to talk
 */
export function botFace(b, state, talker, dt, now, { asleep, working, still, talking, snap }) {
  // its turn to talk: babble in its robot's voice a syllable at a time (as people do: see "talking" in
  // life/people/people.js), its mouth snapping open and shut through each one
  if (talking) {
    if ((state.talkIn -= dt) <= 0) {
      const { open, length, intonation } = nextSyllable(talker, Math.random);
      state.talkIn = length;
      state.syllable = open > 0;
      if (open > 0) babble(talker, ROBOT_VOICE, length, open, 0, intonation);
    }
  } else { talker.phrase = null; state.talkIn = 0; state.syllable = false; }
  if (!state.syllable) state.mouth = 0;
  else if (now > state.mouthNext) {
    state.mouth = state.mouth ? 0 : 1;
    state.mouthNext = now + MOUTH_SNAP[0] + Math.random()*(MOUTH_SNAP[1] - MOUTH_SNAP[0]);
  }

  // the face: looking down at the work, or the eyes flicking about and the eyebrow going up now and then
  if (now > state.lookNext) { state.look = Math.random()*2 - 1; state.lookNext = now + 0.4 + Math.random()*2.5; }
  if (now > state.browNext) { state.browUntil = now + 0.6 + Math.random()*1.2; state.browNext = state.browUntil + 3 + Math.random()*8; }
  if (now > state.blinkNext) { state.blinkUntil = now + BLINK; state.blinkNext = state.blinkUntil + 2 + Math.random()*5; }
  // (talking to someone, its eyes left still on them, but for blinking)
  const goals = working || asleep || still ? [0, 0, working ? 1 : 0] : [state.look, now < state.browUntil ? 1 : 0, 0];
  const ease = Math.min(1, SHAPE_EASE*dt);
  goals.forEach((g, i) => { state.shape[i] = i === 0 && !working && !still ? g : state.shape[i] + (g - state.shape[i])*ease; });
  state.shape[3] = !asleep && now < state.blinkUntil ? 1 : 0; // (a blink's all or nothing)
  state.shape[4] = asleep ? 0 : state.mouth;                   // (and so's its mouth)
  for (const mesh of b.shaped) SHAPES.forEach((name, i) => {
    const k = mesh.morphTargetDictionary[name];
    if (k != null) mesh.morphTargetInfluences[k] = state.shape[i];
  });

  // its screen dimmed while it sleeps, the Zzz nearly as bright as the face (set on whatever material the mesh has now:
  // see fadeWhatsInTheWay in interior.js)
  const sleepy = asleep ? 1 : 0;
  state.sleepy = snap ? sleepy : state.sleepy + (sleepy - state.sleepy)*Math.min(1, 3*dt);
  for (const o of b.screens) {
    o.material.emissive.lerpColors(o.userData.awake, o.userData.asleep, state.sleepy);
    o.material.emissiveIntensity = 1;
  }
}
/** A bot's face's state, as botFace keeps it. */
export const newFace = () => ({ look: 0, lookNext: 0, browUntil: 0, browNext: 0, blinkUntil: 0, blinkNext: 0, shape: [0, 0, 0, 0, 0],
  sleepy: 0, talkIn: 0, syllable: false, mouth: 0, mouthNext: 0 });
