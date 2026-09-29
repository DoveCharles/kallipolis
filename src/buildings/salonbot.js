import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { TOON_RAMP } from '../core/toon.js';
import { S } from '../core/shared.js';
import { playSound } from '../audio/sfx.js';

// ============================================================ the salon bots
// Behind every styling chair in a salon there's a salon bot (assets/models/SalonBot.glb, a rigged model made in Blender,
// toon-shaded like the bar bot but for its screens), under the floor beneath a round hatch (Door, its iris opened by
// the Open shape). Whoever sits down in the chair for a haircut calls it up (summonSalonBot, from "a salon" in
// life/people/peopleActivities.js): the hatch opens, then it plays Cut — up out of the floor, a haircut, and back down —
// and once that's done the hatch shuts again, and the haircut's theirs. Between cuts it's held on Cut's first frame (the
// same as its last: down under the floor), hidden.
// The model's in no particular size: it's scaled so that, cutting, its scissors and comb meet at a seated person's head
// (CUT_AT, measured from the clip on load), and stood behind the chair so they meet over it.
const SALONBOT_MODEL_URL = 'assets/models/SalonBot.glb';
const OPEN_TIME = 0.6;      // s, the hatch opening or shutting
const HOLE_MATERIAL = 'Material.006'; // the black disc under the hatch's iris
// where a seated person's head is (the middle of it), from where the chair seats them, in metres at their full size: up
// above the seat, and forward
const HEAD_UP = 0.6, HEAD_FORWARD = 0.06;
/** Tweaks on that fit, from View > Salon Bot (debug) (ui/salonbot-debug.js): its size, times, and metres further back. */
export const SALONBOT_TUNE = { scale: 1.07, back: 0.235 };

let model = null;           // { scene, clip, cutAt, doorRadius } once loaded
const pool = [];            // one bot a chair, reused room to room: { root, rig, door, mixer, action, phase, t, by, served, seat }
let placed = 0;             // how many of the pool are in the room now
let lastTime = 0;

/** Load the model, toon-shaded (and lit indoors like the people: the room's lamps and glow) but for its screens. */
export async function loadSalonBot() {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(SALONBOT_MODEL_URL);
  } catch (err) {
    console.warn('Kallipolis: the salon bot model failed to load; salons have no salon bots', err);
    return;
  }
  const scene = gltf.scene, toon = new Map();
  scene.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // (skinned: its bounds are the rest pose's)
    o.castShadow = o.receiveShadow = !o.material.transparent;
    const m = o.material;
    // (the disc under the hatch's iris, the hole it opens onto: flat black, whatever the export says — it comes out white)
    if (m.name === HOLE_MATERIAL) { o.material = toon.get(m) ?? toon.set(m, new THREE.MeshBasicMaterial({ name: m.name, color: 0x000000 })).get(m); o.castShadow = false; return; }
    if (m.name.startsWith('Screen') || m.transparent) return;
    if (!toon.has(m)) toon.set(m, Object.assign(new THREE.MeshToonMaterial({ name: m.name, color: m.color, map: m.map, gradientMap: TOON_RAMP, side: THREE.DoubleSide, flatShading: true }),
      { defines: { ROOM_LAMP: '', ROOM_GLOW: '' } }));
    o.material = toon.get(m);
  });
  const clip = gltf.animations.find(c => c.name === 'Cut');
  if (!clip) { console.warn('Kallipolis: the salon bot model has no Cut animation; salons have no salon bots'); return; }
  // (the hatch's radius, as the model rests: Door's one of its root's children, unskinned)
  const door = scene.getObjectByName('Door'), box = door ? new THREE.Box3().setFromObject(door) : null;
  model = { scene, clip, cutAt: measureCut(scene, clip), doorRadius: box ? (box.max.x - box.min.x)/2 : 0.5 };
}

// Where the scissors and comb meet, cutting, in the model's terms: the middle of them over the frames the scissors are
// furthest out in front (+z), reaching over the head.
function measureCut(scene, clip) {
  const bones = {};
  scene.traverse(o => { if (o.isBone) bones[o.name.replace(/_\d+$/, '')] = o; });
  const hands = ['Scissors1', 'Scissors2', 'Comb'].map(n => bones[n]).filter(Boolean);
  const mixer = new THREE.AnimationMixer(scene), action = mixer.clipAction(clip).play();
  const frames = [], at = new THREE.Vector3();
  for (let t = 0; t <= clip.duration; t += 1/24) {
    mixer.setTime(t);
    scene.updateMatrixWorld(true);
    const mid = new THREE.Vector3();
    for (const b of hands) mid.add(b.getWorldPosition(at));
    frames.push(mid.multiplyScalar(1/Math.max(1, hands.length)));
  }
  action.stop();
  mixer.uncacheRoot(scene);
  const reach = Math.max(...frames.map(f => f.z));
  const cutting = frames.filter(f => f.z > 0.7*reach);
  // (and when it's cutting, from the first of those frames to the last: see salonBotSnipping)
  const first = frames.indexOf(cutting[0]), last = frames.indexOf(cutting[cutting.length - 1]);
  cutTimes = [first/24, last/24];
  return cutting.reduce((sum, f) => sum.add(f), new THREE.Vector3()).multiplyScalar(1/cutting.length);
}
let cutTimes = [0, 0]; // when in Cut the scissors are at the head (s), measured with CUT_AT

/**
 * Whether a seat's bot is at the head cutting now (for the snips, and the cloud and clippings: see haircutFx in
 * life/giblets.js) — not coming up or going back down.
 * @param {object} seat
 * @returns {boolean}
 */
export function salonBotSnipping(seat) {
  const bot = seat.salonBot;
  if (!bot || (bot.phase !== 'cutting' && bot.phase !== 'looping')) return false;
  const t = bot.action.time;
  return t >= cutTimes[0] && t <= cutTimes[1];
}
// The racket a bot makes while it cuts (salonBotNoise): it works so fast that it's all going at once — each sound on its
// own clock, seconds between them [shortest, longest], and how loud [quietest, loudest].
const NOISES = {
  snip: { every: [0.07, 0.2], loud: [0.7, 1] },
  brush: { every: [0.2, 0.6], loud: [0.6, 1] },
  spray: { every: [0.5, 1.4], loud: [0.6, 1] },
  hairdryer: { every: [0.7, 1.6], loud: [0.7, 1] },
  clippers: { every: [0.5, 1.5], loud: [0.5, 0.9] },
};
const between = ([a, b]) => a + Math.random()*(b - a);
/**
 * The sounds of a bot cutting someone's hair, for a frame of it: call each frame it's snipping (salonBotSnipping).
 * @param {object} clocks - somewhere to keep when each sound's next due, one per chair being cut at
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function salonBotNoise(clocks, at, dt) {
  for (const name in NOISES) {
    const { every, loud } = NOISES[name];
    if ((clocks[name] = (clocks[name] ?? Math.random()*every[1]) - dt) > 0) continue;
    clocks[name] = between(every);
    // (off round the head a little, as the arms move about it)
    playSound(name, { x: at.x + (Math.random() - 0.5)*0.4, y: at.y, z: at.z + (Math.random() - 0.5)*0.4 }, between(loud));
  }
}
/**
 * Where the middle of the head is of someone sat on a seat (in the seat's terms: the world's for the room's seats).
 * @param {{x: number, y: number, z: number, nx: number, nz: number}} seat
 * @param {number} size - how big they are (1 for someone of middling height at full size)
 * @returns {{x: number, y: number, z: number}}
 */
export const seatedHead = (seat, size) => ({ x: seat.x + seat.nx*HEAD_FORWARD*size, y: seat.y + HEAD_UP*size, z: seat.z + seat.nz*HEAD_FORWARD*size });

/** What's to be compiled under the loading screen (see warmUp in interior.js), or null. */
export const salonBotWarmUp = () => model ? cloneSkinned(model.scene) : null;

/** Take the salon bots out of the room (before it's fitted out again: see furnishSalon in interior.js). */
export function clearSalonBots() {
  for (let i = 0; i < placed; i++) pool[i].root.removeFromParent();
  placed = 0;
}

/**
 * Put a salon bot behind a styling chair, in `group` (the salon's furniture, in the room's terms), and give the chair's
 * seat it to call up (seat.salonBot).
 * @param {THREE.Group} group
 * @param {{x: number, y: number, z: number, nx: number, nz: number}} seat - the chair's seat: where it seats someone, and the way it faces
 * @returns {?{x: number, z: number, radius: number}} where its hatch is, in the room, or null without the model
 */
export function placeSalonBot(group, seat) {
  if (!model) return;
  let bot = pool[placed];
  if (!bot) {
    const root = cloneSkinned(model.scene), mixer = new THREE.AnimationMixer(root);
    let rig = null, door = null;
    const colors = {};
    root.traverse(o => {
      if (o.name === 'SalonBotRig') rig = o;
      // (its own two body colours, picked when it's placed: see paint)
      if (o.isMesh && (o.material.name === 'Col1' || o.material.name === 'Col2')) o.material = colors[o.material.name] ??= Object.assign(o.material.clone(), { defines: { ...o.material.defines } });
      if (o.isMesh && o.morphTargetDictionary && 'Open' in o.morphTargetDictionary) (door ??= []).push(o);
    });
    const action = mixer.clipAction(model.clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    bot = pool[placed] = { root, rig, door: door ?? [], colors, mixer, action, phase: 'down', t: 0, by: null, served: null };
    mixer.addEventListener('finished', () => { if (bot.phase === 'cutting') { bot.phase = 'closing'; bot.t = 0; bot.served = bot.by; } });
  }
  placed++;
  Object.assign(bot, { phase: 'down', t: 0, by: null, served: null, seat });
  const scale = standBehind(bot);
  paint(bot);
  rest(bot);
  seat.salonBot = bot;
  group.add(bot.root);
  return { x: bot.root.position.x, z: bot.root.position.z, radius: model.doorRadius*scale };
}
// Col1 and Col2 a random colour each time it's placed, the second always opposite the first on the colour wheel (pink and
// yellow-green, say)
function paint(bot) {
  const hue = Math.random(), saturation = 0.6 + Math.random()*0.3, lightness = 0.5 + Math.random()*0.15;
  bot.colors.Col1?.color.setHSL(hue, saturation, lightness);
  bot.colors.Col2?.color.setHSL((hue + 0.5) % 1, saturation, lightness);
}
// sized and stood behind its seat (the room's: bot.seat), by fit; returns its scale
function standBehind(bot) {
  const seat = bot.seat, { scale, back } = fit(seat);
  bot.root.scale.setScalar(scale);
  bot.root.rotation.y = Math.atan2(seat.nx, seat.nz);
  bot.root.position.set(seat.x - seat.nx*back, 0, seat.z - seat.nz*back);
  return scale;
}
/** Size and stand every bot in the room again, after SALONBOT_TUNE's changed (the hatches' floor space stays as it was). */
export function refitSalonBots() {
  for (let i = 0; i < placed; i++) standBehind(pool[i]);
}
// How big a bot's made for a seat this high (see placeSalonBot), and how far behind the seat its hatch is: sized so the
// cut's at the head, of a person of middling height at the people's size.
function fit(seat) {
  const size = S.peopleSize, cut = model.cutAt, scale = (seat.y + HEAD_UP*size)/cut.y*SALONBOT_TUNE.scale;
  return { scale, back: cut.z*scale - HEAD_FORWARD*size + SALONBOT_TUNE.back };
}
/** The scale a bot's made for this seat (see SALONBOT_TUNE), or 0 without the model. */
export const salonBotScale = seat => model ? fit(seat).scale : 0;

/**
 * Cut played over and over, the hatch open, for looking at (ui/salonbot-debug.js) — or, `on` false, back down to rest.
 * @param {object} bot - a seat's salonBot
 * @param {boolean} on
 */
export function loopSalonBot(bot, on) {
  Object.assign(bot, { phase: on ? 'looping' : 'down', t: 0, by: null, served: null });
  if (!on) { rest(bot); return; }
  bot.action.setLoop(THREE.LoopRepeat, Infinity);
  bot.action.reset().play();
  if (bot.rig) bot.rig.visible = true;
  setDoor(bot, 1);
}
/**
 * How far behind a seat this high the floor's taken up by its bot's hatch, to its far edge, in metres — or 0 without the
 * model.
 * @param {{y: number}} seat
 * @returns {number}
 */
export function salonBotReach(seat) {
  if (!model) return 0;
  const { scale, back } = fit(seat);
  return back + model.doorRadius*scale;
}

// down under the floor, the hatch shut: Cut held on its first frame, and the bot hidden
function rest(bot) {
  bot.action.setLoop(THREE.LoopOnce, 1);
  bot.action.reset().play();
  bot.action.paused = true;
  bot.mixer.setTime(0);
  if (bot.rig) bot.rig.visible = false;
  setDoor(bot, 0);
}
function setDoor(bot, open) {
  const k = open*open*(3 - 2*open);
  for (const mesh of bot.door) mesh.morphTargetInfluences[mesh.morphTargetDictionary.Open] = k;
}

/**
 * Someone sat in a styling chair calls its bot up (each frame they're there waiting): the hatch opens and it cuts their
 * hair, if it's not busy with someone else's.
 * @param {object} seat - the chair's seat (see placeSalonBot)
 * @param {object} who - whoever's calling it
 * @returns {?string} null if the chair's got no bot (no haircut from it: time it some other way), else 'coming' (the hatch
 *   opening, or it still finishing someone else's), 'cutting', or 'done' (their haircut's finished)
 */
export function summonSalonBot(seat, who) {
  const bot = seat.salonBot;
  if (!bot || !bot.root.parent) return null;
  if (bot.served === who) return 'done';
  if (bot.phase === 'down') { Object.assign(bot, { phase: 'opening', t: 0, by: who, served: null }); if (bot.rig) bot.rig.visible = true; }
  if (bot.by !== who) return 'coming';
  return bot.phase === 'cutting' ? 'cutting' : bot.phase === 'opening' ? 'coming' : 'done';
}

/**
 * Each frame, while the room's up.
 * @param {boolean} inSalon - the room up is a salon
 */
export function updateSalonBots(inSalon) {
  const now = performance.now()/1000, dt = Math.min(0.1, now - lastTime);
  lastTime = now;
  if (!inSalon) return;
  for (let i = 0; i < placed; i++) {
    const bot = pool[i];
    if (bot.phase === 'down') continue;
    bot.t += dt;
    if (bot.phase === 'opening') {
      setDoor(bot, Math.min(1, bot.t/OPEN_TIME));
      if (bot.t >= OPEN_TIME) { bot.phase = 'cutting'; bot.action.paused = false; }
    } else if (bot.phase === 'closing') {
      setDoor(bot, Math.max(0, 1 - bot.t/OPEN_TIME));
      if (bot.t >= OPEN_TIME) { rest(bot); bot.phase = 'down'; } // (still `served`, for whoever it cut to see it's done)
    }
    bot.mixer.update(dt);
  }
}
