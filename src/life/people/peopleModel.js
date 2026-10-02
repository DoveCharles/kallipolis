import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mulberry32, lerp, seedOf, rendezvousPick } from '../../core/math.js';
import { scene, sun } from '../../core/scene.js';
import { TOON_RAMP } from '../../core/toon.js';
import { onProfilesLoaded, profileOf, sexOf } from '../profiles.js';
import { pinnedLookOf } from './peopleKeep.js';
import { splitBody } from './bodySplit.js';
import { fitSkirt } from './skirtFit.js';
import { fitJeans } from './jeansFit.js';
import { OUTFITS, OUTFIT_ARM, OUTFIT_CHEST, OUTFIT_COLUMNS, OUTFIT_COLUMN_COUNT, OUTFIT_LEG, OUTFIT_TILES, buildOutfitTexture, pickOutfit } from './outfits.js';
import { makeCensorMesh } from './peopleCensor.js';
import { makeSpiritMeshes, makeSpiritWorn, SPECTRAL, BALD_BIT, VANISHED_BIT } from './peopleSpirits.js';
import { presetAt, isPresetHair } from './presets.js';
import { HEADSHOT_LAYER, PEOPLE_MAX, people, peopleMesh, setPersonModel } from './people.js';

// =========================================== PEOPLE MODEL ===========================================
// assets/models/Person.glb replaces the cuboids once it loads — one rigged figure, drawn for everyone
// at once as one instanced mesh, flat- and toon-shaded.
//
// The clips (walk, idle fidgets, wave, sit, lie, punch, fall) are baked, as three.js can't instance a rigged mesh: at
// load each is played a frame at a time and every bone's pose per frame written into a texture (a row per frame, three
// texels per bone), and the vertex shader poses each person from the rows for the moment they are at, blending between
// rows and between the clip they are entering and the one they are leaving.
//
// Hairstyles (Hair.glb) and facial hair (FacialHair.glb) are one instanced mesh per style, parented to the head bone.
// Per-person appearance is in the traits texture (a texel per person); per-frame state is in the instance attributes.
// Their skin is always the model's yellow. 
// Hairstyles (assets/models/Hair.glb, each its own mesh, placed on the model's head) ride on the head bone. A style's name
// says who can wear it: ending in _G, girls; _B, boys; _GB, either (as does no suffix). A style with a Hat part is a hat,
// and only HAT_CHANCE of people wear one.
// Facial hair (assets/models/FacialHair.glb) works the same way, but only boys wear it. So do glasses and sunglasses
// (assets/models/Glasses.glb, built by tools/glasses-model.py), worn by anyone, but only by GLASSES_CHANCE of them.
// Skirts (assets/models/Skirt.glb, built by tools/skirt-models.py) are worn the same way, by SKIRT_CHANCE of women, but
// ride on the pelvis and legs instead, fitted to the body's bones and shape keys as the model loads (see skirtFit.js);
// a woman in one goes bare-legged. Baggy jeans are made from the body's own legs (see jeansFit.js), worn by JEANS_CHANCE of
// everyone not in a skirt, in the color of their trousers.
const PERSON_MODEL_URL = 'assets/models/Person.glb';
const HAIR_MODEL_URL = 'assets/models/Hair.glb';
const FACIAL_HAIR_MODEL_URL = 'assets/models/FacialHair.glb';
const GLASSES_MODEL_URL = 'assets/models/Glasses.glb';
const SKIRT_MODEL_URL = 'assets/models/Skirt.glb';
const GLASSES_CHANCE = 0.2;
const SKIRT_CHANCE = 0.3;
// how far back a skirt's back hangs out at the hem, in the model's units, beyond where it was made: room for the thighs
// swinging back under it (nothing at the waist, all of it at the hem)
const SKIRT_BACK_ROOM = 0.4;
const JEANS_CHANCE = 0.25;
// At the salon (see cutHair): the chance a man comes out with his head shaved, with his facial hair changed, and anyone
// with their hair dyed. And how many more wearers each style's mesh has room for than it started with (see wear).
const BALD_CUT = 0.15, FACIAL_HAIR_CUT = 0.5, HAIR_DYE = 0.3, STYLE_ROOM = 48;
const CUFF_LIGHTEN_TO = new THREE.Color(0xffffff), CUFF_LIGHTEN = 0.3; // how much lighter than the jeans their cuff is
const HAT_CHANCE = 0.1;
/** Frames per second the source clips are baked at, into the bone-pose texture. */
export const PERSON_BAKE_FPS = 24;
/** Distances the model's foot travels per walk-animation cycle. The walk plays slower for the same speed the higher this is. */
const WALK_CYCLE_LENGTH = 4;
/** The model's clips: `loop` plays round and round, otherwise once (or held, if `pose`). `pose` is a single held pose, and
 * `from` names a clip whose last frame this pose is (Fallen is where Fall leaves them), `at` the frame of its own it holds.
 * `play` names a clip this one plays (backwards, if `reverse`), first frame to last; `anchor` a pose it starts or ends in,
 * whose pelvis offset it keeps (see `feet` in people.js). `over` names a clip this one is
 * played over `times` times and reposed each frame by `repose` (Typing is Sit1 with the arms brought up: see typingPose;
 * TypingPaused the same with the hands held still on the keys) —
 * straight after it, so any bone it has no keys for is left as it left it.
 * `base` names the clip one is a version of (WalkHotdog is Walk with a hot dog in hand: see snackClips), played and
 * weighed as that one is.
 * `spread` scales how far the arms are moved out from a heavy or broad body (see PERSON_ARM_SPREAD): 0 for a pose that
 * reaches for something in front of them, where moving the hand out would miss it. `spreadR`, where it's given, is the
 * right arm's alone (a hot dog up at the mouth holds the right arm in, and leaves the left out by their side).
 * `mirror` names a clip this one is the mirror image of, left for right (WaveLeft is Wave with the other hand, for someone
 * whose right hand is full). `hold` names a snack clip whose right arm this one's is swapped for, carried along by the
 * body as it moves (WaveLeftBeer: see snackClips). */
/** What can be held, for the snack clips' names (see SNACK_HOLD). */
const SNACK_ITEMS = ['Hotdog', 'Skewer', 'Coffee', 'Beer', 'Cig', 'Umbrella'];
/** Held up, never raised to the mouth: no Bite clips. */
const NO_BITE = ['Umbrella'];
const PERSON_CLIPS = [
  { name: 'Walk', loop: true }, { name: 'Idle', loop: true }, { name: 'Idle2' }, { name: 'Idle3' }, { name: 'Wave' },
  { name: 'WaveLeft', mirror: 'Wave' }, { name: 'Idle2Left', mirror: 'Idle2' },
  { name: 'Sit1', loop: true, pose: true }, { name: 'Typing', over: 'Sit1', times: 3, loop: true, pose: true, repose: typingPose },
  { name: 'TypingPaused', over: 'Sit1', loop: true, pose: true, repose: (frame, frames, rig) => typingPose(frame, frames, rig, false) },
  { name: 'Eating', over: 'Sit1', times: 3, loop: true, pose: true, spread: 0, repose: eatingPose },
  { name: 'EatingPaused', over: 'Sit1', loop: true, pose: true, spread: 0, repose: (frame, frames, rig) => eatingPose(frame, frames, rig, false) },
  // (each sit/lie clip: its first frame the pose, the rest getting up — played on as <name>Up, backwards as <name>Down)
  ...['SitDown1', 'SitDown2', 'SitDown3', 'LieDown1', 'LieDown2', 'LieDown3'].flatMap(name => [{ name, at: 0, pose: true },
    { name: name + 'Up', play: name, anchor: name }, { name: name + 'Down', play: name, anchor: name, reverse: true }]),
  { name: 'Punch' }, { name: 'Hit' }, { name: 'Fall' }, { name: 'Fallen', from: 'Fall', pose: true }, { name: 'GetUp', anchor: 'Fallen' },
  ...snackClips(),
  ...['WaveLeft', 'Idle2Left'].flatMap(name => SNACK_ITEMS.map(item => ({ name: name + item, mirror: name.slice(0, -4), hold: 'Idle' + item }))),
  ...SNACK_ITEMS.map(item => ({ name: 'Idle3' + item, over: 'Idle3', hold: 'Idle' + item })),
];

// ============== TYPING ==============
// Typing is Sit1 with the arms brought up onto a keyboard in front, reposed a frame at a time as it's baked: each arm's
// shoulder turned and elbow and hand moved so the wrist lands on TYPING_WRIST (a two-bone reach, the elbow bending out
// and down), then each hand dipping and tipping its fingers down at every key it strikes. The keys are struck in bursts
// with pauses between, the same every time round the loop — the times are kept on the clip (clip.taps) so each tap can
// be heard (see audio/typing.js).
//
// In the model's own terms (facing +z, their left towards +x, about 7.6 tall standing; sat, the seat's at y 2 and the
// pelvis at z -2.2): where the wrists go, either side of the middle — which puts the fingertips on keys a hand's length
// further on, at desk height over an office chair pulled up to its desk (see furnishOffice in buildings/interior.js).
const TYPING_WRIST = { x: 0.55, y: 3.5, z: -0.35 };
const TYPING_DIP = 0.07, TYPING_TIP = 0.22, TYPING_TAP_WIDTH = 0.055; // a strike: how far down the hand goes, how far its
                                                                   // fingers tip, and how long it takes (seconds, either side)
const TYPING_SPACE_CHANCE = 0.15; // how many strikes are the space bar, with the right thumb (the hand barely moving)
let typingTaps = null;
/**
 * The keys struck over a loop of the Typing clip: bursts of a second or three, a strike every tenth or fifth of a second
 * from one hand or the other, with pauses between. The same every time (a fixed seed).
 * @param {number} duration - the loop's length, in seconds
 * @returns {{time: number, left: boolean, space: boolean}[]} each strike, in order
 */
function typingSchedule(duration) {
  const rng = mulberry32(0x7e57), taps = [];
  let t = 0.25, left = true;
  while (t < duration - 0.4) {
    const burstEnd = Math.min(duration - 0.4, t + 1 + rng()*2);
    for (; t < burstEnd; t += 0.1 + rng()*0.1) {
      const space = rng() < TYPING_SPACE_CHANCE;
      left = space ? false : rng() < 0.3 ? left : !left;
      taps.push({ time: t, left, space });
    }
    t += 0.5 + rng()*1.2;
  }
  return taps;
}
const typingV = new THREE.Vector3(), typingQ = new THREE.Quaternion(), typingM = new THREE.Matrix4();
/**
 * Set a bone to a place and turn in the model's space, whatever its parent.
 * @param {THREE.Bone} bone
 * @param {?THREE.Vector3} position - where it goes, or null to leave it
 * @param {THREE.Quaternion} turn - the turn to add to it, in the model's space
 * @returns {void}
 */
function reposeBone(bone, position, turn) {
  const parent = bone.parent;
  parent.updateWorldMatrix(true, false);
  const parentTurn = parent.getWorldQuaternion(new THREE.Quaternion());
  const worldTurn = bone.getWorldQuaternion(typingQ).premultiply(turn);
  bone.quaternion.copy(parentTurn.invert().multiply(worldTurn));
  if (position) bone.position.copy(typingV.copy(position).applyMatrix4(typingM.copy(parent.matrixWorld).invert()));
}
/**
 * Repose a frame of Sit1 as a frame of Typing (see PERSON_CLIPS).
 * @param {number} frame - the frame, from 0
 * @param {number} frames - how many the loop is
 * @param {{bone: function(string): ?THREE.Bone, update: function(): void}} rig - the model's bones, by name, and a
 *   refresh of where they all are
 * @param {boolean} [typing] - striking keys, or false for the hands resting on them, still
 * @returns {?{time: number, left: boolean, space: boolean}[]} the loop's key strikes, if typing
 */
function typingPose(frame, frames, rig, typing = true) {
  const duration = frames/PERSON_BAKE_FPS, t = typing ? frame/PERSON_BAKE_FPS : 0;
  if (typing) typingTaps ??= typingSchedule(duration);
  // (playing the clip only sets a bone where it's moved since the frame before, so one that's held still keeps the last
  // frame's reposing — and would be turned again on top of it, round and round: put back as it was before it, instead)
  for (const bone of typingBones(rig)) {
    const was = bone.userData.typing;
    if (was && bone.position.equals(was.set.position) && bone.quaternion.equals(was.set.quaternion)) {
      bone.position.copy(was.from.position); bone.quaternion.copy(was.from.quaternion);
    }
    bone.userData.typing = { from: { position: bone.position.clone(), quaternion: bone.quaternion.clone() } };
  }
  rig.update();
  // how far into a strike each hand is, from 0 to 1 (the loop wrapped round, so a strike near its end carries over)
  const strike = (left, space) => !typing ? 0 : typingTaps.reduce((most, tap) => {
    if (tap.left !== left || tap.space !== space) return most;
    const dt = Math.min(Math.abs(t - tap.time), duration - Math.abs(t - tap.time));
    return Math.max(most, Math.exp(-((dt/TYPING_TAP_WIDTH)**2)));
  }, 0);
  for (const side of ['L', 'R']) {
    const shoulder = rig.bone('Shoulder' + side), elbow = rig.bone('Elbow' + side), hand = rig.bone('Hand' + side);
    if (!shoulder || !elbow || !hand) continue;
    const out = side === 'L' ? 1 : -1, left = side === 'L';
    const S = shoulder.getWorldPosition(new THREE.Vector3()), E = elbow.getWorldPosition(new THREE.Vector3()), W = hand.getWorldPosition(new THREE.Vector3());
    const upper = E.distanceTo(S), lower = W.distanceTo(E);
    // where the wrist goes: over the keys, wandering a little across them, down for a strike (a thumb's barely at all)
    const hit = strike(left, false), thumb = left ? 0 : strike(false, true);
    const target = new THREE.Vector3(out*TYPING_WRIST.x + 0.08*Math.sin(t*1.7 + out), TYPING_WRIST.y - TYPING_DIP*hit - 0.02*thumb,
      TYPING_WRIST.z + 0.05*Math.sin(t*1.3 + 2*out));
    // the elbow, where the two bones meet reaching it: bent out and down
    const toTarget = target.clone().sub(S), reach = Math.min(toTarget.length(), (upper + lower)*0.999);
    const along = toTarget.normalize();
    const bend = new THREE.Vector3(out*0.6, -1, -0.3);
    bend.addScaledVector(along, -bend.dot(along)).normalize();
    const a = (upper*upper - lower*lower + reach*reach)/(2*reach), h = Math.sqrt(Math.max(0, upper*upper - a*a));
    const elbowAt = S.clone().addScaledVector(along, a).addScaledVector(bend, h), wristAt = S.clone().addScaledVector(along, reach);
    const upperTurn = new THREE.Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), elbowAt.clone().sub(S).normalize());
    const lowerTurn = new THREE.Quaternion().setFromUnitVectors(W.clone().sub(E).normalize(), wristAt.clone().sub(elbowAt).normalize());
    reposeBone(shoulder, null, upperTurn);
    reposeBone(elbow, elbowAt, lowerTurn);
    // the hand following the forearm round, laid flat, and its fingers tipped down into a strike
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25 + TYPING_TIP*hit);
    reposeBone(hand, wristAt, flat.multiply(lowerTurn));
  }
  for (const bone of typingBones(rig)) bone.userData.typing.set = { position: bone.position.clone(), quaternion: bone.quaternion.clone() };
  return typing ? typingTaps : null;
}
/** The bones typingPose moves. */
const typingBones = rig => ['L', 'R'].flatMap(side => ['Shoulder', 'Elbow', 'Hand'].map(name => rig.bone(name + side))).filter(Boolean);

// ============== HOLDING SOMETHING ==============
// Where a held thing sits in a fist, from the wrist bone, in the model's rest pose (arms out, palms forward: the fingers
// reach along X, spread along Y, and the thumb points up and out). So a handle lies along the model's Y, through the
// curled fingers — which is the frame peopleHolding.js builds a fork or a cup in.
const HAND_GRIP = { x: 0.5, y: 0.05, z: 0.15 };
/** How far each bone of a fist curls round a handle, and about what: the fingers towards the palm, the thumb onto them. */
const GRIP_CURL = [['Finger1', 1.15, 'fingers'], ['Finger2', 0.95, 'fingers'], ['Middle1', 1.2, 'fingers'], ['Middle2', 1.0, 'fingers'],
  ['Little1', 1.25, 'fingers'], ['Little2', 1.0, 'fingers'], ['Thumb1', 0.55, 'thumb'], ['Thumb2', 0.45, 'thumb']];

// ============== EATING ==============
// Eating is Sit1 with the right arm reposed a frame at a time as it's baked (as Typing is: see typingPose), holding a
// fork. It dips the fork to a plate on the table in front of them, gathers a mouthful, raises it to the mouth, and
// brings it back down over the plate — twice over a loop. What happens when is kept on the clip (clip.taps,
// which people.js plays as it comes round): the fork on the plate, a mouthful gathered, and the mouthful eaten.
//
// Where the hand goes is EAT_POSES, blended from one to the next (eatingAt).
const EAT_FORK = 0.76; // from the fist to the tines, in the model's units (the fork built in peopleHolding.js)
/**
 * Eating's four poses, tuned in View > Held Items (debug): just holding the fork, over the plate, picking up a forkful, at
 * the mouth. Each is a hold as SNACK_HOLD's (the mouth one as a `bite`). One still given as `tip`/`dir` (the fork's tines
 * and which way it points, in the model's units; the mouth's from the mouth) is turned into a hold the first time it's baked.
 */
export const EAT_POSES = [
  { at: [-0.15, -0.13, 0.35], rot: [1.18, 1.24, -1.45], elbowAt: [-0.098, -0.178, -0.026], elbowTurn: [-1.8, 0.991, 2.466] },
  { at: [-0.18, -0.075, 0.365], rot: [1.4, 0.75, -1.42], elbowAt: [-0.232, -0.164, 0.12], elbowTurn: [-2.933, 1.78, 2.82] },
  { at: [-0.055, -0.04, 0.36], rot: [1.51, -0.72, -1.5], elbowAt: [-0.18, -0.06, 0.11], elbowTurn: [-2.82, 2.22, 2.508] },
  { at: [-0.01, -0.13, 0.135], reach: 0, rot: [-1, 3.14, 0.11], elbowAt: [-0.134, -0.148, 0.204], elbowTurn: [-2.14, 0.68, 1.97], mouth: true },
];
/** Which of EAT_POSES EatingPaused holds (0; the debug window shows the others). */
export const EAT_SHOWN = { pose: 0 };
// seconds a mouthful's parts take: hold → over the plate → picking → (picking) → up to the mouth → (in the mouth) → hold
const EAT_TO_PLATE = 0.25, EAT_DIP = 0.4, EAT_GATHER = 0.35, EAT_LIFT = 0.8, EAT_IN_MOUTH = 0.45, EAT_LOWER = 0.7;
const EAT_STEPS = [[0, 1, EAT_TO_PLATE], [1, 2, EAT_DIP], [2, 2, EAT_GATHER], [2, 3, EAT_LIFT], [3, 3, EAT_IN_MOUTH], [3, 0, EAT_LOWER]];
const EAT_MOUTHFUL = EAT_STEPS.reduce((sum, step) => sum + step[2], 0);
const EAT_BITES = 2, EAT_FIRST = 0.5; // mouthfuls a loop, and how long before the first
const EAT_BEND = new THREE.Vector3(-1, -0.4, -0.4); // the way the elbow goes, bending: out and down

const eatEase = x => x*x*(3 - 2*x);
const eatGap = duration => Math.max(0.3, (duration - EAT_FIRST - EAT_BITES*EAT_MOUTHFUL)/EAT_BITES);
/**
 * Which two of EAT_POSES a loop of Eating is between, and how far.
 * @param {number} t - seconds into the loop
 * @param {number} duration - the loop's length in seconds
 * @returns {[number, number, number]} from, to, and how far from one to the other (eased)
 */
function eatingAt(t, duration) {
  const gap = eatGap(duration);
  for (let k=0;k<EAT_BITES;k++) {
    let u = t - (EAT_FIRST + k*(EAT_MOUTHFUL + gap));
    if (u < 0 || u >= EAT_MOUTHFUL) continue;
    for (const [from, to, time] of EAT_STEPS) { if (u < time) return [from, to, eatEase(u/time)]; u -= time; }
  }
  return [0, 0, 0];
}
/**
 * What happens when over a loop of Eating: the fork touching down on the plate, a forkful gathered onto it, and the
 * mouthful taken off it (see eatingAt, and the taps people.js plays).
 * @param {number} duration - the loop's length in seconds
 * @returns {{time: number, cue: string}[]} each cue, in order
 */
function eatingCues(duration) {
  const gap = eatGap(duration);
  const cues = [];
  for (let k=0;k<EAT_BITES;k++) {
    const at = EAT_FIRST + k*(EAT_MOUTHFUL + gap), picked = at + EAT_TO_PLATE + EAT_DIP;
    cues.push({ time: picked, cue: 'clink' });
    cues.push({ time: picked + EAT_GATHER*0.85, cue: 'forkful' });
    // (`up`: the fork up from the plate till it's half back down, for the head to face front: see people.js)
    cues.push({ time: picked + EAT_GATHER + EAT_LIFT + 0.1, cue: 'bite', up: [picked + EAT_GATHER, at + EAT_MOUTHFUL - EAT_LOWER/2] });
  }
  return cues;
}
/**
 * Where a hold (SNACK_HOLD's, or one of EAT_POSES) puts the fist, as the rig stands now.
 * @returns {{grip: THREE.Vector3, turn: THREE.Quaternion, elbowAt: ?THREE.Vector3}}
 */
function holdAt(rig, hold, atMouth) {
  const metre = rig.metre, S = rig.bone('ShoulderR').getWorldPosition(new THREE.Vector3());
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(...hold.rot));
  const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(turn), at = new THREE.Vector3(...hold.at).multiplyScalar(metre);
  const grip = atMouth ? rig.mouth().add(at).addScaledVector(dir, -(hold.reach ?? 0)*metre) : S.clone().add(at);
  return { grip, turn, elbowAt: hold.elbowAt && S.clone().addScaledVector(new THREE.Vector3(...hold.elbowAt), metre) };
}
/** Fill in a hold's elbowAt/elbowTurn from where gripRight bends it (`bend`), then put the arm back as it was. */
function settleElbow(rig, hold, atMouth, bend, moved) {
  if (hold.elbowAt && hold.elbowTurn) return;
  const was = moved.map(b => [b.position.clone(), b.quaternion.clone()]);
  const { grip, turn } = holdAt(rig, hold, atMouth), S = rig.bone('ShoulderR').getWorldPosition(new THREE.Vector3());
  const went = gripRight(rig, grip, turn, hold.elbow ? new THREE.Vector3(...hold.elbow) : bend, { ...hold, elbowAt: null, elbowTurn: null });
  const round = v => Math.round(v*1000)/1000;
  if (went) {
    hold.elbowAt ??= went.at.sub(S).divideScalar(rig.metre).toArray().map(round);
    const e = new THREE.Euler().setFromQuaternion(went.turn.multiply(rig.restTurn('ElbowR').invert()));
    hold.elbowTurn ??= [e.x, e.y, e.z].map(round);
  }
  delete hold.elbow; delete hold.swing; delete hold.elbowRot;
  moved.forEach((b, i) => { b.position.copy(was[i][0]); b.quaternion.copy(was[i][1]); });
  rig.update();
}
/** Turn an EAT_POSES entry still given as tip/dir into a hold (see EAT_POSES). */
function eatPoseHold(rig, pose, moved) {
  if (pose.tip) {
    const dir = new THREE.Vector3(...pose.dir).normalize(), turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const tip = new THREE.Vector3(...pose.tip);
    if (pose.mouth) tip.add(rig.mouth());
    const grip = tip.addScaledVector(dir, -EAT_FORK);
    const from = pose.mouth ? rig.mouth() : rig.bone('ShoulderR').getWorldPosition(new THREE.Vector3());
    const round = v => Math.round(v*1000)/1000, e = new THREE.Euler().setFromQuaternion(turn);
    pose.at = grip.sub(from).divideScalar(rig.metre).toArray().map(round);
    pose.rot = [e.x, e.y, e.z].map(round);
    if (pose.mouth) pose.reach = 0;
    delete pose.tip; delete pose.dir;
  }
  settleElbow(rig, pose, pose.mouth, EAT_BEND, moved);
  return pose;
}
/**
 * Repose a frame of Sit1 as a frame of Eating (see PERSON_CLIPS): the right arm holding a fork, everything else as it sits,
 * blended from one of EAT_POSES to the next.
 * @param {number} frame - the frame, from 0
 * @param {number} frames - how many the loop is
 * @param {object} rig - the model's bones, by name, where they rest, where the mouth is, and a refresh (see buildPersonModel)
 * @param {boolean} [eating] - working through a meal, or false for EAT_SHOWN's pose held still
 * @returns {?{time: number, cue: string}[]} the loop's cues, if eating
 */
function eatingPose(frame, frames, rig, eating = true) {
  const duration = frames/PERSON_BAKE_FPS, t = frame/PERSON_BAKE_FPS;
  const moved = eatingBones(rig);
  unrepose(moved);
  rig.update();
  if (!rig.bone('ShoulderR')) return null;
  const [from, to, x] = eating ? eatingAt(t, duration) : [EAT_SHOWN.pose, EAT_SHOWN.pose, 0];
  const a = eatPoseHold(rig, EAT_POSES[from], moved), b = eatPoseHold(rig, EAT_POSES[to], moved);
  const A = holdAt(rig, a, a.mouth), B = holdAt(rig, b, b.mouth);
  const turnOf = h => new THREE.Quaternion().setFromEuler(new THREE.Euler(...h.elbowTurn));
  const e = new THREE.Euler().setFromQuaternion(turnOf(a).slerp(turnOf(b), x));
  gripRight(rig, A.grip.lerp(B.grip, x), A.turn.slerp(B.turn, x), EAT_BEND, { elbowAt: A.elbowAt.lerp(B.elbowAt, x), elbowTurn: [e.x, e.y, e.z] });
  markRepose(moved);
  return eating ? eatingCues(duration) : null;
}
// (as in typingPose: put back any bone the last frame reposed and the clip hasn't moved since, so a turn isn't added twice)
function unrepose(moved) {
  for (const bone of moved) {
    const was = bone.userData.repose;
    if (was && bone.position.equals(was.set.position) && bone.quaternion.equals(was.set.quaternion)) {
      bone.position.copy(was.from.position); bone.quaternion.copy(was.from.quaternion);
    }
    bone.userData.repose = { from: { position: bone.position.clone(), quaternion: bone.quaternion.clone() } };
  }
}
function markRepose(moved) {
  for (const bone of moved) bone.userData.repose.set = { position: bone.position.clone(), quaternion: bone.quaternion.clone() };
}
/**
 * Reach the right hand to hold something at `grip` (a place in the model's space), turned by `turn` from how the rest pose
 * holds it (a handle along Y: see HAND_GRIP), with the fingers closed round it — the elbow bent out towards `bendTo`, then
 * swung `swing` radians on round the line from shoulder to wrist; or, given `elbowAt`, the elbow put there and the hand
 * right on the grip, the shoulder tracking the elbow (its Y at it, X up, as a Track To). The forearm then points at the
 * wrist, turned by `elbowRot` (x rolls it about itself, y and z swing it about the elbow's two other axes) — or, given
 * `elbowTurn`, is turned just that from its rest pose, no aiming. Angles in radians.
 * @returns {?{at: THREE.Vector3, turn: THREE.Quaternion}} where the elbow went, and its turn
 */
function gripRight(rig, grip, turn, bendTo = EAT_BEND, { swing = 0, elbowRot = null, elbowAt: fixed = null, elbowTurn = null } = {}) {
  const shoulder = rig.bone('ShoulderR'), elbow = rig.bone('ElbowR'), hand = rig.bone('HandR');
  if (!shoulder || !elbow || !hand) return null;
  const wristTarget = grip.clone().sub(rig.grip('R').sub(rig.restAt('HandR')).applyQuaternion(turn));
  // the arm reaching it: the elbow bent out and down, where the two bones meet (as typingPose does it)
  const S = shoulder.getWorldPosition(new THREE.Vector3()), E = elbow.getWorldPosition(new THREE.Vector3()), W = hand.getWorldPosition(new THREE.Vector3());
  const upper = E.distanceTo(S), lower = W.distanceTo(E);
  const toTarget = wristTarget.clone().sub(S), reach = Math.min(toTarget.length(), (upper + lower)*0.999);
  const along = toTarget.normalize();
  const bend = bendTo.clone();
  bend.addScaledVector(along, -bend.dot(along)).normalize().applyAxisAngle(along, swing);
  const a = (upper*upper - lower*lower + reach*reach)/(2*reach), h = Math.sqrt(Math.max(0, upper*upper - a*a));
  const elbowAt = fixed ?? S.clone().addScaledVector(along, a).addScaledVector(bend, h), wristAt = fixed ? wristTarget : S.clone().addScaledVector(along, reach);
  if (fixed) {
    const y = elbowAt.clone().sub(S).normalize(), x = new THREE.Vector3(0, 1, 0).addScaledVector(y, -y.y).normalize();
    const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
    reposeBone(shoulder, null, want.multiply(shoulder.getWorldQuaternion(new THREE.Quaternion()).invert()));
  } else reposeBone(shoulder, null, new THREE.Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), elbowAt.clone().sub(S).normalize()));
  const forearm = wristAt.clone().sub(elbowAt).normalize();
  if (elbowTurn) {
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(...elbowTurn)).multiply(rig.restTurn('ElbowR'));
    reposeBone(elbow, elbowAt, want.multiply(elbow.getWorldQuaternion(new THREE.Quaternion()).invert()));
  } else reposeBone(elbow, elbowAt, new THREE.Quaternion().setFromUnitVectors(W.clone().sub(E).normalize(), forearm));
  if (elbowRot && !elbowTurn) {
    const side = new THREE.Vector3().crossVectors(forearm, bend).normalize(), up = new THREE.Vector3().crossVectors(side, forearm);
    const q = new THREE.Quaternion(), about = (axis, angle) => q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    about(forearm, elbowRot[0]); about(up, elbowRot[1]); about(side, elbowRot[2]);
    reposeBone(elbow, null, q);
  }
  // the hand turned onto the fork, whatever the arm did: the turn from the rest pose, over where the clip left it
  const want = turn.clone().multiply(rig.restTurn('HandR'));
  reposeBone(hand, wristAt, want.multiply(hand.getWorldQuaternion(new THREE.Quaternion()).invert()));
  // and its fingers closed round the handle
  const axes = { fingers: new THREE.Vector3(0, 1, 0).applyQuaternion(turn), thumb: new THREE.Vector3(1, 0, 0).applyQuaternion(turn) };
  for (const [name, angle, about] of GRIP_CURL) {
    const bone = rig.bone(name + 'R');
    if (bone) reposeBone(bone, null, new THREE.Quaternion().setFromAxisAngle(axes[about], angle));
  }
  return { at: elbowAt, turn: elbow.getWorldQuaternion(new THREE.Quaternion()) };
}
/** The bones eatingPose moves. */
const eatingBones = rig => ['Shoulder', 'Elbow', 'Hand', ...GRIP_CURL.map(([name]) => name)].map(name => rig.bone(name + 'R')).filter(Boolean);

// ============== A SNACK IN HAND ==============
// Walking, standing about or sat on a bench with a hot dog or a coffee from a stall (see peopleStalls.js): each of Walk,
// Idle and Sit1 again with the right arm holding it in front of them, and again with it up at the mouth for a bite or a
// sip — people.js blends from one to the other and back for each mouthful (snackClip in peopleHolding.js).
//
// Where the fist goes: carried, a place from the shoulder, in metres (x in towards the middle of them, y up, z forward);
// at the mouth, where the end of the thing goes from the middle of the lips (`at`), and how far that end is from the fist
// (`reach`). `rot` turns the hand from its rest pose (a handle along y), as x/y/z angles in radians.
// `elbowAt` is where the elbow goes, in metres from the shoulder, which tracks it; `elbowTurn` turns it from its rest pose
// (see gripRight). (An old hold — `elbow`, `swing`, `elbowRot` — gets both the first time it's baked.)
export const SNACK_HOLD = {
  Hotdog: {
    carry: { at: [-0.025, -0.26, 0.31], rot: [-0.91, 1.44, 1.64], elbowAt: [-0.06, -0.238, 0.02], elbowTurn: [-0.98, 0.81, 1.76] },
    bite: { at: [-0.015, 0.035, -0.025], reach: 0.145, rot: [0.71, 1.53, -1.86], elbowAt: [-0.108, -0.169, 0.183], elbowTurn: [-2.817, 0.94, 2.54] },
  },
  Skewer: {
    carry: { at: [-0.03, -0.125, 0.31], rot: [-2.43, 3.14, 1.72], elbowAt: [-0.06, -0.238, 0.02], elbowTurn: [-0.98, 1.91, 1.76] },
    bite: { at: [-0.05, 0.025, 0], reach: 0.145, rot: [0.51, 0.05, -1.43], elbowAt: [-0.21, -0.188, 0.03], elbowTurn: [-2.817, 1.83, 2.22] },
  },
  Coffee: {
    carry: { at: [-0.1, -0.265, 0.32], rot: [-3.142, 1.471, -3.142], elbow: [-0.35, -0.96, -0.2] },
    bite: { at: [-0.06, 0.07, 0.13], reach: 0.095, rot: [0.243, 1.434, -1.276], elbow: [-0.12, -0.73, -0.2], swing: 0.27, elbowRot: [0.06, 0, 0] },
  },
  Beer: {
    carry: { at: [-0.1, -0.265, 0.32], rot: [-3.142, 1.471, -3.142], elbow: [-0.35, -0.96, -0.2] },
    bite: { at: [-0.06, 0.07, 0.13], reach: 0.095, rot: [0.243, 1.434, -1.276], elbow: [-0.12, -0.73, -0.2], swing: 0.27, elbowRot: [0.06, 0, 0] },
  },
  // (up over the head in the rain: see UMBRELLA in peopleHolding.js; no bite, so the same twice)
  Umbrella: {
    carry: { at: [-0.1, -0.265, 0.32], rot: [-3.142, 1.471, -3.142], elbow: [-0.35, -0.96, -0.2] },
    bite: { at: [-0.1, -0.265, 0.32], rot: [-3.142, 1.471, -3.142], elbow: [-0.35, -0.96, -0.2] },
  },
  Cig: {
    carry: { at: [-0.14, -0.325, 0.275], rot: [-0.02, 1.191, 0], elbowAt: [-0.086, -0.23, -0.04], elbowTurn: [-1.18, 1.81, 2.14] },
    bite: { at: [-0.03, 0.045, 0.07], reach: 0.09, rot: [0, 1.571, 0], elbowAt: [-0.132, -0.118, 0.19], elbowTurn: [0.81, -0.57, 1.24] },
  },
};
export const SNACK_BEND = new THREE.Vector3(-0.45, -1, -0.2);
/** The snack clips, for PERSON_CLIPS: WalkHotdog, WalkHotdogBite, IdleCoffee, Sit1CoffeeBite… (one for each of SNACK_HOLD, which isn't set yet when PERSON_CLIPS is) */
function snackClips() {
  return ['Walk', 'Idle', 'Sit1'].flatMap(base => SNACK_ITEMS.flatMap(item => (NO_BITE.includes(item) ? [false] : [false, true]).map(biting => ({
    name: base + item + (biting ? 'Bite' : ''), over: base, base, loop: true, pose: base === 'Sit1', spreadR: biting ? 0 : 1,
    repose: (frame, frames, rig) => snackPose(rig, item, biting) }))));
}
/**
 * Repose a frame of Walk, Idle or Sit1 with something held in the right hand (see SNACK_HOLD).
 * @param {object} rig - the model's bones (see buildPersonModel)
 * @param {string} item - 'Hotdog', 'Coffee', 'Beer' or 'Cig'
 * @param {boolean} biting - up at the mouth, or carried
 * @returns {null}
 */
function snackPose(rig, item, biting) {
  const moved = eatingBones(rig);
  unrepose(moved);
  rig.update();
  const shoulder = rig.bone('ShoulderR');
  if (!shoulder) return null;
  const hold = SNACK_HOLD[item][biting ? 'bite' : 'carry'];
  settleElbow(rig, hold, biting, SNACK_BEND, moved);
  const { grip, turn, elbowAt } = holdAt(rig, hold, biting);
  gripRight(rig, grip, turn, SNACK_BEND, { ...hold, elbowAt });
  markRepose(moved);
  return null;
}

export const FIDGETS = ['Idle2', 'Idle3'], GRASS_SITS = ['SitDown1', 'SitDown2', 'SitDown3'], LIE_DOWNS = ['LieDown1', 'LieDown2', 'LieDown3'];
/** Seconds to blend from one clip into the next: FADE_QUICK between walk, idle and wave; FADE_POSE into or out of sitting or
 * lying; FADE_SNACK raising a snack to the mouth and lowering it again (see snackClips). */
export const FADE_QUICK = 0.2, FADE_POSE = 0.6, FADE_SNACK = 0.4;
export const CHAT_GAP = 1.1;        // how far apart two people stand to talk, at people size 1
export const CIRCLE_RADIUS = 1.35;  // how far from the middle of a circle sat on the grass each of them sits, at people size 1
export const CIRCLE_MAX = 4;
/** Every shape key the shader applies, in the order of the shape key texture. PERSON_SHAPE_KEY_BITS holds each one's bit in
 * personVertex.z: body and head/eye keys are set once per person, the rest while that state holds. */
const PERSON_SHAPE_KEYS = ['Breast', 'Waist', 'Hips', 'Weight', 'Butt', 'Shoulders', 'Blink', 'Talk', 'Emotion', 'Key 1', 'Key 2',
  'Shape1', 'Shape2', 'Shape3', 'Shock', 'Happy', 'Angry', 'Sad'];
const PERSON_SHAPE_KEY_BITS = [1, 1, 1, 1, 1, 1, 2, 4, 4, 8, 8, 16, 16, 16, 32, 32, 32, 32];
const PERSON_BODY_KEY_COUNT = 6;

/**
 * A shape key's place in PERSON_SHAPE_KEYS, for the shader to read it by name rather than by a number that moves when a
 * key is added.
 * @param {string} name - the shape key's name in the model
 * @returns {number} its index, or -1
 */
const shapeKey = name => PERSON_SHAPE_KEYS.indexOf(name);
/** Each person's body shape keys by sex, as [lowest, highest]. */
const PERSON_BODY_SHAPES = {
  male:   { Breast: [0.6, 1],  Waist: [0.5, 1],    Hips: [-1, -0.5],  Weight: [0, 1],   Butt: [1, 1],     Shoulders: [0, 1] },
  female: { Breast: [-1, 0.1], Waist: [-0.5, 0.1], Hips: [-0.4, 0.2], Weight: [0, 1],   Butt: [0, 0.6],   Shoulders: [0, 0.3] },
};

/** How far out the arms are moved at Weight 1 and at Shoulders 1, in the model's units. Those two keys widen the body but
 * leave the arms where they are, so without this a heavy or broad person's hands swing through their hips. */
export const PERSON_ARM_SPREAD = { Weight: 0.43, Shoulders: 0.5 };

/** Each person's head and eye shape keys, as [lowest, highest] — or one pair per sex where they differ. */
const PERSON_FACE_SHAPES = { 'Key 1': { male: [0, 1], female: [-0.3, 0] }, 'Key 2': [-0.5, 0.3], Shape1: [-0.2, 1], Shape2: [0, 1], Shape3: [0, 1] };

/** The ages a woman's midriff goes from as bare as anything to all but covered, and the chance at either end (midriffChance). */
const MIDRIFF_BARE_AGE = 22, MIDRIFF_COVERED_BY = 55, MIDRIFF_CHANCE_YOUNG = 2/3, MIDRIFF_CHANCE_OLD = 0.05;

/**
 * The chance a woman's clothes leave any of her midriff bare: lerped from MIDRIFF_CHANCE_YOUNG at MIDRIFF_BARE_AGE to
 * MIDRIFF_CHANCE_OLD at MIDRIFF_COVERED_BY.
 * @param {number} age - her age
 * @returns {number} the chance, from 0 to 1
 */
const midriffChance = age =>
  lerp(MIDRIFF_CHANCE_YOUNG, MIDRIFF_CHANCE_OLD,
       Math.max(0, Math.min(1, (age - MIDRIFF_BARE_AGE)/(MIDRIFF_COVERED_BY - MIDRIFF_BARE_AGE))));
       
// How much skin clothes show: a sleeve, the tummy and a leg are each split into numbered bands (materials Sleeve1,
// Sleeve2…, lowest nearest the body), and a person's clothes stop at one of them — that band and every higher-numbered
// band of the part show skin, the rest the clothes' color.
// `bareChance`, where a part has one, is how often any of it shows at all, the bands that do being evenly spread.
const PERSON_CLOTHING = [
  { band: 'Sleeve', part: 'Top', count: 3 },
  { band: 'Tummy', part: 'Top', count: 2, coveredOnMen: true, bareChance: midriffChance },
  { band: 'Leg', part: 'Pants', count: 2 },
];

/**
 * Work out where one part of someone's clothes stops, from one random number.
 * @param {{band: string, part: string, count: number, coveredOnMen?: boolean, bareChance?: function(number): number}} clothing - the part: its bands, and how likely any of it is to show
 * @param {number} roll - a random number from 0 to 1
 * @param {boolean} man - whether they're a man
 * @param {number} age - how old they are
 * @returns {number} the band it stops at, counting from 1, or one past the last band when it covers the part altogether
 */
const clothingBand = (clothing, roll, man, age) => {
  if (clothing.coveredOnMen && man) return clothing.count + 1;
  const bare = clothing.bareChance ? clothing.bareChance(age) : clothing.count/(clothing.count + 1);
  if (roll >= bare) return clothing.count + 1;
  return 1 + Math.min(clothing.count - 1, Math.floor(roll/bare*clothing.count));
};

// the model's materials, by name: which part of the model each vertex belongs to (its slot, in personVertex.y) — the clothes take each
// person's own colors, the rest keep the model's; and the parts only drawn for women
const PERSON_SLOTS = ['Skin', 'Top', 'Pants', 'Shoes', 'White', 'Black', 'Eyelash1', 'Eyelash2', 'Eyelash3', 'Lips',
  ...PERSON_CLOTHING.flatMap(c => Array.from({ length: c.count }, (_, k) => c.band + (k + 1)))];
PERSON_SLOTS.push('Flesh'); // (not a material: the caps closing a body part's cut, see buildGibMeshes)
const FLESH_COLOR = 0x5a0d0d;
const PERSON_FEMALE_ONLY = ['Eyelash1', 'Eyelash2', 'Eyelash3', 'Lips'];
// the eyelashes come in pieces: each woman wears some of them, at least one (which, a bit each in the clothing row's w);
// the bit after them set for no lipstick
const PERSON_LASHES = ['Eyelash1', 'Eyelash2', 'Eyelash3'];
// the colors each person has their own of, from row 2 of the traits texture on; then a row of where their clothes stop,
// and one of their head's and eyes' shape keys (Key 1, Key 2, Shape1, Shape2 — Shape3 being in row 1)
// ('Skin' starts as the model's own, and is there so a person's can be tinted: see peopleBlood.js)
// ('Blood' is how opaque the splotches drawn over them are — 0 for none — in its fourth number)
// ('Eyes' is what the whites of their eyes are, so they can be tinted: see updatePeople's eye reddening)
// ('Cuff' is a jeans' cuff, a lighter shade of their trousers)
// ('OutfitRed' and 'OutfitGreen' are only for an outfit's texture — see outfits.js — OutfitRed's fourth number being
// which outfit they wear, 0 for none, and OutfitGreen's which column of the outfits' texture)
// ('Cuff''s fourth number is 1 for someone nude: see setNude)
// ('Top''s fourth number is 1 for a villain, 0 for anyone else — only ped view reads it: see ui/ped-view.js)
export const PERSON_TRAIT_COLORS = ['Top', 'Pants', 'Shoes', 'Hair', 'Hat', 'Skin', 'Blood', 'Eyes', 'Glasses', 'Skirt', 'Cuff', 'OutfitRed', 'OutfitGreen'];
// Faces pulled by moving the eye and lip bones' vertices in the rest pose (see personShape): how skeptical someone is in the
// Shoes row's spare .w, how goofy in the Hat row's. FACE_PULLS is how far each bone's vertices go at 1, in eye half-widths:
// [x, y, z] goofy (🥴: one eye drooping, the other wide, the mouth wonky and hanging open), and y skeptical (🤔: the left
// upper lid raised). The eyes' bones come first (FACE_PULL_EYES of them): theirs fade out with a blink, as the eyes' keys do.
// (three.js drops the dot from Blender's names: EyeTL.L is EyeTLL)
export const SKEPTICAL_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Shoes'), GOOFY_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Hat');
// (and how welled up their eyes are, 🥺, in the Pants row's fourth number, for the glint on their pupils: see GLINT_GLSL)
export const WELLING_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Pants');
const FACE_PULLS = {
  EyeTLL: [[0, -0.36, 0], 0.35], EyeTRL: [[0, -0.36, 0], 0.35], EyeTL: [[0, -0.39, 0], 0.35],
  EyeBLL: [[0, 0.1, 0], 0], EyeBRL: [[0, 0.1, 0], 0], EyeBL: [[0, 0.1, 0], 0],
  EyeTLR: [[0, 0.2, 0], 0], EyeTRR: [[0, 0.2, 0], 0], EyeTR: [[0, 0.23, 0], 0],
  EyeBLR: [[0, -0.13, 0], 0], EyeBRR: [[0, -0.13, 0], 0], EyeBR: [[0, -0.16, 0], 0],
  LipUpL: [[0, 0.23, 0], 0], LipBottomL: [[0, 0.2, 0], 0],
  LipUpR: [[0, -0.16, 0], 0], LipBottomR: [[0, -0.2, 0], 0],
  LipTop: [[0.08, 0.03, 0], 0], LipBottom: [[0.07, -0.23, 0], 0],
};
const FACE_PULL_EYES = 12, FACE_PULL_COUNT = Object.keys(FACE_PULLS).length;
export const HAIR_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Hair'); // (its fourth number the headsize trait)
const SKIN_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Skin'), EYES_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Eyes'), BLOOD_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Blood');
const NUDE_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Cuff');
// (its fourth number bits: 1 spirits, 2 ghost, 4 bodiless — see peopleSpirits.js and personBodiless)
export const SPIRITS_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Glasses');
// the bodiless trait's head, on the ground (BODILESS_CLEAR above it), hopping BODILESS_HOP high while they move (TWIN_LOOK_ROW's .z,
// eased: see people.js), × the model's height; BODILESS_HOP_RATE radians a second (see personBodiless, and headShift in peopleTracking.js)
export const BODILESS_CLEAR = 0.02, BODILESS_HOP = 0.12, BODILESS_HOP_RATE = 9;
export const BODILESS_SHOT_RAISE = 0.04; // the headshot aimed that much higher on a bodiless head, × the model's height (see headshotOf)
// The twins trait: the person drawn twice, side by side, in step — each layer half TWIN_GAP (× the model's height) to
// their right, and a copy of it (twinOf) half to their left. One person still: one health, one hitbox (twinReach in people.js).
export const TWIN_GAP = 0.22;
const TWIN_SHOT_SIDE = 0.2, TWIN_SHOT_BACK = 0.15; // the copy in the headshot: to their left and behind the one shown, × the model's height
export const TWIN_SHOT_AIM = 0.07; // and the headshot aimed that far towards it, so the two share the frame (see headshotOf in peopleTracking.js)
// the censor's ends (see peopleCensor.js): down the thigh from the hip, × hip-to-knee; a man's up to the stomach, × hip-to-shoulder;
// a woman's to below the shoulder, down from it × hip-to-shoulder
const CENSOR_THIGH = 0.3, CENSOR_STOMACH = 0.45, CENSOR_SHOULDER = 0.1;
const OUTFIT_RED_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('OutfitRed'), OUTFIT_GREEN_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('OutfitGreen');
const BLOOD_SCALE = 1.2; // how many splotches' worth of noise fit in a unit of the figure: bigger for smaller splotches
export const PERSON_CLOTHING_ROW = 2 + PERSON_TRAIT_COLORS.length, PERSON_FACE_ROW = PERSON_CLOTHING_ROW + 1;
export const TWIN_LOOK_ROW = PERSON_FACE_ROW + 1; // (a twin's copy's own head turn and tilt, as instanceLook.xy: see personLook, people.js; .z how much a bodiless head hops; .w how far a shy ghost's faded: shyGhost)

// A mesh named with a _U suffix is unused: kept in the model file, never drawn.
const isUnused = name => /_U$/i.test(name);

/**
 * Work out who can wear a hairstyle, from the end of its name: 'Hair3_GB' girls and boys, 'Hair6_G' only girls.
 * @param {string} name - the style's name
 * @returns {{girls: boolean, boys: boolean}} who can wear it (everyone, with no suffix)
 */
const hairstyleWearers = name => {
  if (isPresetHair(name)) return { girls: false, boys: false };
  const suffix = /_([GB]+)$/i.exec(name)?.[1].toUpperCase();
  return suffix ? { girls: suffix.includes('G'), boys: suffix.includes('B') } : { girls: true, boys: true };
};

/**
 * Whether a hairstyle part with this material takes a color of its own, rather than the hair's.
 * @param {string} name - the part's material name
 * @returns {boolean} whether it's a hat
 */
const isHatMaterial = name => /^Hat(\.\d+)?$/i.test(name || '');

const PANTS_COLORS = [0x26344f, 0x3e5a82, 0x5a7aa6, 0x232326, 0x4d5057, 0x8f8f93, 0xb09a72, 0x6b5038, 0x46503a];
const SHOE_COLORS = [0x151517, 0x2b2b2f, 0xeeeeea, 0x8f9298, 0x6b4a2f, 0x3b2a1e, 0x22304a, 0xb5a383];
const GLASSES_COLORS = [0x141416, 0x141416, 0x1f1f22, 0x3a2418, 0x5a3520, 0x6d6f74, 0xa4a7ad];
const HAIR_TONES = [0x0f0d0c, 0x2a1d15, 0x4a3223, 0x6f4e33, 0x8a4f2a, 0xa0692f, 0xc49a5a, 0xdcc08a]; // black to platinum
//Removed light tones: 0xb9b5a 0xe3ddd2
export const BLINK_DURATION = 0.25; // seconds for the eyes to close and open again
// how far a person turns their head when they glance around: side to side, and up and down
export const LOOK_MAX_TURN = 50*Math.PI/180, LOOK_MAX_TILT = 15*Math.PI/180;
// how far a pupil wanders from the middle of the eye, in the model's units: side to side (both eyes the same way), and up and down
export const PUPIL_MAX_X = 0.07, PUPIL_MAX_Y = 0.02;
// the middle of a person's face, from where their head meets their neck, in the model's units
export const HEAD_CENTER = new THREE.Vector3(0, 0.3, 0.2);
// the blush on the cheeks of the blushing (the Skin row's fourth number is how much: see tintSkin in people.js)
const PERSON_BLUSH_COLOR = 0xf2506e;

// People too small on screen to see aren't drawn, nor their shadows once they're smaller than PERSON_SHADOW_PIXELS (in
// drawing-buffer pixels, tall): and nobody off screen, or out of the shadow's view, is. All worked out in the vertex
// shader, before any posing, so the ones left out cost next to nothing (see personCulled and aimPersonCulling).
const PERSON_DRAW_PIXELS = 1, PERSON_SHADOW_PIXELS = 6;
// (and anyone under PERSON_ROUGH_PIXELS tall is posed roughly: by each vertex's main bone alone, without the shape keys,
// the head turned or the arms moved out — the full posing is most of what a far-off crowd costs to draw)
const PERSON_ROUGH_PIXELS = 12;
// (what's worn over the body — hair, hats, glasses, skirts, jeans — is left off anyone under PERSON_LAYER_PIXELS: a pixel
// or so of it at most)
const PERSON_LAYER_PIXELS = 5;
// (shared by every person mesh: where the view is from and how many pixels a metre is there, set each frame by
// aimPersonCulling; and the sphere round a person, in the model's units, once the model's built)
const personCulling = {
  personViewPos: { value: new THREE.Vector3() }, personViewScale: { value: new THREE.Vector2() },
  personCullSphere: { value: new THREE.Vector4(0, 1, 0, 1) }, personTall: { value: 1 },
  personTime: { value: 0 }, // seconds, for bobbing (set by updatePeople)
  personFloor: { value: 0 }, // the model's feet, in its units
};
const drawingBuffer = new THREE.Vector2();
// (the same, kept on this side for updatePeople: the last frame's view, see personPixels)
const viewFrustum = new THREE.Frustum(), viewMatrix = new THREE.Matrix4(), viewSphere = new THREE.Sphere();
let viewAimed = false;
const shadowFrustum = new THREE.Frustum();
let shadowAimed = false, copiesAfterAim = null; // (see updateCopies in buildPersonModel)
/**
 * Tell the person meshes where the view is drawn from, so they can leave out whoever's off screen or too small to see
 * (see personCulled). Called just before the frame is drawn.
 * @param {THREE.Camera} camera - the camera the frame's drawn with
 * @param {THREE.WebGLRenderer} renderer
 * @returns {void}
 */
export function aimPersonCulling(camera, renderer) {
  renderer.getDrawingBufferSize(drawingBuffer);
  camera.getWorldPosition(personCulling.personViewPos.value);
  // (pixels per metre: at a metre off for a perspective camera, anywhere for an orthographic one)
  personCulling.personViewScale.value.set(drawingBuffer.y*0.5*camera.projectionMatrix.elements[5], camera.isPerspectiveCamera ? 1 : 0);
  camera.updateMatrixWorld();
  viewFrustum.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  viewAimed = true;
  const shadow = sun.castShadow && renderer.shadowMap.enabled ? sun.shadow.camera : null; // (as it was last drawn)
  shadowAimed = !!shadow;
  if (shadow) shadowFrustum.setFromProjectionMatrix(viewMatrix.multiplyMatrices(shadow.projectionMatrix, shadow.matrixWorldInverse));
  copiesAfterAim?.();
}

// Off screen, or too small on it to make out, the finer things about someone needn't be kept up every frame (see
// updatePeople): their pose and place once they're out of view, their glances, blinks and face under PERSON_ROUGH_PIXELS
// (posed roughly, none of it's drawn), and what they wear under PERSON_LAYER_PIXELS (not drawn at all).
export const PERSON_FACE_PIXELS = PERSON_ROUGH_PIXELS, PERSON_WORN_PIXELS = PERSON_LAYER_PIXELS;
/**
 * How many pixels tall someone standing at a spot looked in the last frame drawn, as personOnScreen works it out in
 * the shader — or -1 if they were out of view (with a margin, as the view may have moved since), or Infinity before
 * anything's been drawn.
 * @param {number} x - where they're standing
 * @param {number} y
 * @param {number} z
 * @param {number} tall - how tall they are, in metres
 * @returns {number}
 */
export function personPixels(x, y, z, tall) {
  if (!viewAimed) return Infinity;
  viewSphere.center.set(x, y + tall*0.5, z);
  viewSphere.radius = tall*1.5;
  if (!viewFrustum.intersectsSphere(viewSphere)) return -1;
  const [scale, perspective] = personCulling.personViewScale.value.toArray();
  return tall*scale/(perspective ? Math.max(viewSphere.center.distanceTo(personCulling.personViewPos.value), 1e-3) : 1);
}

const PERSON_VERTEX_PARS = `
  uniform sampler2D personBones;
  uniform vec2 personBonesSize;
  uniform sampler2D personMorphs;
  uniform float personMorphsWidth;
  uniform float personMorphsRows;
  uniform sampler2D personTraits;
  uniform float personTwin; // -1 a person's own meshes, 1 their twin's (see TWIN_GAP)
  uniform float personHeadBone;
  uniform vec3 personHeadPivot;
  uniform vec2 personHeadMiddle;
  uniform float personPullBones[${FACE_PULL_COUNT}]; // FACE_PULLS' bones
  uniform vec4 personPulls[${FACE_PULL_COUNT}];     // and how far each pulls: xyz goofy, w (up) skeptical, in model units
  uniform float personChestBone;
  uniform vec3 personChestPivot;
  uniform vec2 personArmBonesR; // the right shoulder and elbow bones, for personArms
  uniform vec4 personThighBones; // the left thigh and knee bones, then the right's
  uniform vec3 personHipRest, personKneeRest; // where the left thigh's top ring and knee are at rest (the right's mirrored)
  uniform vec2 personThighRadius; // how thick the thigh is at its top and at the knee
  uniform vec3 personThighGrow, personKneeGrow; // how much thicker each is for all of the Hips, Weight and Butt keys
  uniform int personHidden; // the person whose head is hidden (-1 for nobody)
  uniform int personOnly; // the only person drawn (-1 for everyone): the person card's headshot sees just them
  attribute vec4 personJoints;
  attribute vec4 personWeights;
  // What the shader needs to know about the vertex itself, packed into one attribute (a machine guarantees only 16, and
  // instanceMatrix takes four while gl_InstanceID takes another).
  //
  // x: how much the vertex moves with the head, or negative how much it moves out with the arms. y: which slot (which
  // part of the figure). z: which shape keys move it (PERSON_SHAPE_KEY_BITS). w: where it is in the shape key texture.
  attribute vec4 personVertex;
  attribute vec4 instanceAnim;
  attribute vec4 instanceLook;
  attribute vec4 instanceEyes;
  attribute vec2 instancePupil; // where their pupils have wandered: x left/right, y up/down (the model's units)
  // which person this instance is: the instance itself for the body, and for a hairstyle (holding only some people) the
  // person it was given
  #ifdef PERSON_INDEX_ATTRIBUTE
    attribute float instancePerson;
    int personIndex() { return int(instancePerson + 0.5); }
  #else
    int personIndex() { return gl_InstanceID; }
  #endif
  // a bone's pose (as a matrix from the rest pose) at a row of the bone texture — part-way between rows is part-way between
  // frames, as the texture blends them
  mat4 personBoneAt(float bone, float row) {
    vec2 texel = 1.0/personBonesSize;
    float x = (bone*3.0 + 0.5)*texel.x, y = (row + 0.5)*texel.y;
    vec4 r0 = textureLod(personBones, vec2(x, y), 0.0);
    vec4 r1 = textureLod(personBones, vec2(x + texel.x, y), 0.0);
    vec4 r2 = textureLod(personBones, vec2(x + 2.0*texel.x, y), 0.0);
    return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
  }
  // instanceAnim: x the row they're at in the animation they're going into, y the row of the one they're leaving, z how far
  // they've gone into the first (1 all the way), w how far their eyes are closed
  mat4 personBone(float bone) {
    mat4 pose;
    if (instanceAnim.z > 0.999) pose = personBoneAt(bone, instanceAnim.x);
    else if (instanceAnim.z < 0.001) pose = personBoneAt(bone, instanceAnim.y);
    else pose = personBoneAt(bone, instanceAnim.x)*instanceAnim.z + personBoneAt(bone, instanceAnim.y)*(1.0 - instanceAnim.z);
    return pose;
  }
  // How far the clip being played wants the arms moved out from a wide body (see PERSON_ARM_SPREAD and each clip's spread):
  // the row's last texel (x the left arm, y the right), kept beside the bones and blended between rows and between clips
  // just as a bone is.
  vec2 personClipSpreadAt(float row) {
    vec2 texel = 1.0/personBonesSize;
    return textureLod(personBones, vec2(1.0 - 0.5*texel.x, (row + 0.5)*texel.y), 0.0).xy;
  }
  vec2 personClipSpread() {
    if (instanceAnim.z > 0.999) return personClipSpreadAt(instanceAnim.x);
    if (instanceAnim.z < 0.001) return personClipSpreadAt(instanceAnim.y);
    return personClipSpreadAt(instanceAnim.x)*instanceAnim.z + personClipSpreadAt(instanceAnim.y)*(1.0 - instanceAnim.z);
  }
  mat4 personSkinMatrix() {
    mat4 m = personBone(personJoints.x)*personWeights.x;
    if (personWeights.y > 0.0) m += personBone(personJoints.y)*personWeights.y;
    if (personWeights.z > 0.0) m += personBone(personJoints.z)*personWeights.z;
    if (personWeights.w > 0.0) m += personBone(personJoints.w)*personWeights.w;
    return m;
  }
  // A posed position with the head turned, about where the head meets the neck: instanceLook.x is side to side and .y up
  // and down as the head sees it, so someone lying down rolls their head rather than twisting it round.
  //
  // Only the vertices that move with the head bone or the bones under it (personVertex.x) are affected.
  //
  // And upside down (the Eyes row's fourth number: the 🙃 mood's upsidedown trait, see tintSkin in people.js), the head
  // first rolls half round about the line from the back of its middle (personHeadMiddle: y and z from the pivot) to the front.
  vec3 personLook(vec3 posed) {
    vec3 looked = posed;
    bool flipped = personVertex.x > 0.0 && texelFetch(personTraits, ivec2(personIndex(), ${EYES_ROW}), 0).w > 0.5;
    // (a twin's copy looks about on its own: TWIN_LOOK_ROW)
    vec2 turn = personTwin > 0.0 && personVertex.x > 0.0 ? texelFetch(personTraits, ivec2(personIndex(), ${TWIN_LOOK_ROW}), 0).xy : instanceLook.xy;
    if (personVertex.x > 0.0 && (turn.x != 0.0 || turn.y != 0.0 || flipped)) {
      mat4 head = personBone(personHeadBone);
      mat3 headTurn = mat3(head);
      vec3 pivot = (head*vec4(personHeadPivot, 1.0)).xyz, p = inverse(headTurn)*(posed - pivot);
      if (flipped) p = vec3(-p.x, 2.0*personHeadMiddle.x - p.y, p.z);
      float ct = cos(turn.x), st = sin(turn.x), cn = cos(turn.y), sn = sin(turn.y);
      p = vec3(p.x, p.y*cn - p.z*sn, p.y*sn + p.z*cn);
      p = vec3(p.x*ct + p.z*st, p.y, p.z*ct - p.x*st);
      looked = mix(posed, pivot + headTurn*p, personVertex.x);
    }
    // the headsize trait (the Hair row's fourth number, 0 read as 1: see people.js): scaled about the neck, so it stays on it
    float headSize = personVertex.x > 0.0 ? texelFetch(personTraits, ivec2(personIndex(), ${HAIR_ROW}), 0).w : 0.0;
    if (headSize > 0.0 && headSize != 1.0) {
      vec3 neck = (personBone(personHeadBone)*vec4(personHeadPivot, 1.0)).xyz;
      looked = mix(looked, neck + (looked - neck)*headSize, personVertex.x);
    }
    return looked;
  }
  // This person's row of the traits texture: row 0 is their first four body shape keys, row 1 is x their fifth, w their
  // sixth, y whether they are a man and z their Shape3; after those come the colors they have their own of, where their
  // clothes stop, and their face's shape keys.
  vec4 personTrait(int row) { return texelFetch(personTraits, ivec2(personIndex(), row), 0); }
  // a shape key's offset at this vertex
  vec3 personMorph(int key) {
    int width = int(personMorphsWidth), vertex = int(personVertex.w + 0.5);
    return texelFetch(personMorphs, ivec2(vertex % width, vertex/width + key*int(personMorphsRows)), 0).xyz;
  }
  // every shape key's offset at this vertex, each as far on as this person has it
  vec3 personShape() {
    int mask = int(personVertex.z + 0.5);
    vec3 offset = vec3(0.0);
    if ((mask & 1) != 0) {
      vec4 body = personTrait(0), rest = personTrait(1);
      offset += personMorph(0)*body.x + personMorph(1)*body.y + personMorph(2)*body.z + personMorph(3)*body.w + personMorph(4)*rest.x + personMorph(5)*rest.w;
    }
    if ((mask & 4) != 0) offset += personMorph(${shapeKey('Talk')})*instanceLook.z + personMorph(${shapeKey('Emotion')})*instanceLook.w;
    if ((mask & 8) != 0) { vec4 face = personTrait(${PERSON_FACE_ROW}); offset += personMorph(${shapeKey('Key 1')})*face.x + personMorph(${shapeKey('Key 2')})*face.y; }
    // the eyes' own keys: their shape, and (instanceEyes) how shocked, happy, angry and sad they look
    vec3 eyes = vec3(0.0);
    if ((mask & 16) != 0) { vec4 face = personTrait(${PERSON_FACE_ROW}); eyes += personMorph(${shapeKey('Shape1')})*face.z + personMorph(${shapeKey('Shape2')})*face.w + personMorph(${shapeKey('Shape3')})*personTrait(1).z; }
    if ((mask & 32) != 0) eyes += personMorph(${shapeKey('Shock')})*instanceEyes.x + personMorph(${shapeKey('Happy')})*instanceEyes.y + personMorph(${shapeKey('Angry')})*instanceEyes.z + personMorph(${shapeKey('Sad')})*instanceEyes.w;
    // a face pulled (FACE_PULLS: skeptical, goofy), each bone's pull as much as it carries of the vertex
    float skeptical = personVertex.x > 0.0 ? personTrait(${SKEPTICAL_ROW}).w : 0.0, goofy = personVertex.x > 0.0 ? personTrait(${GOOFY_ROW}).w : 0.0;
    if (skeptical > 0.0 || goofy > 0.0) {
      for (int b = 0; b < ${FACE_PULL_COUNT}; b++) {
        float held = 0.0;
        for (int k = 0; k < 4; k++) if (abs(personJoints[k] - personPullBones[b]) < 0.5) held += personWeights[k];
        if (held == 0.0) continue;
        vec3 pull = held*(personPulls[b].xyz*goofy + vec3(0.0, personPulls[b].w*skeptical, 0.0));
        if (b < ${FACE_PULL_EYES}) eyes += pull; else offset += pull;
      }
    }
    // the Blink key was made on the plain face, so as the eyes close every one of the eyes' keys fades out, on every part
    // of the eyes (not just the lids Blink moves), and back in as they open — laid over a face or an expression it pushes
    // the lids through each other, and leaves whatever it doesn't move in the wrong place
    // (the pupils slide across the face, never into or out of it; up/down closes back to the middle with the lids)
    if ((mask & 64) != 0) { offset.x += instancePupil.x; eyes.y += instancePupil.y; }
    offset += eyes*(1.0 - instanceAnim.w);
    if ((mask & 2) != 0) offset += personMorph(${shapeKey('Blink')})*instanceAnim.w;
    return offset;
  }
  // Moves the arms out from the sides of a heavy or broad person, so their hands don't swing through their hips.
  //
  // Everything from the shoulder down (personVertex.x, negative) moves out along the way the chest faces, by how far the
  // Weight and Shoulders shape keys widen the body. Applied after posing, since the shape keys and bones leave the arms
  // where a slight person's are. A pose that reaches for something in front of them holds the arms in (personClipSpread),
  // so a wide person's hand lands where a slight one's does. The right arm's can differ (a hot dog up at the mouth): its
  // upper arm still moves out as the left does, clear of the chest, and that fades down the forearm to the right's own
  // at the hand, as far as the shoulder and elbow bones hold each vertex.
  float personBoneWeight(float bone) {
    return dot(personWeights, vec4(lessThan(abs(personJoints - bone), vec4(0.5))));
  }
  vec3 personArms(vec3 posed, float restX) {
    vec2 clipSpread = personClipSpread();
    float side = clipSpread.x;
    if (restX < 0.0 && clipSpread.y != clipSpread.x) {
      float towardsHand = clamp(1.0 - personBoneWeight(personArmBonesR.x) - 0.5*personBoneWeight(personArmBonesR.y), 0.0, 1.0);
      side = mix(clipSpread.x, clipSpread.y, towardsHand);
    }
    float spread = max(-personVertex.x, 0.0)*side*(personTrait(0).w*${PERSON_ARM_SPREAD.Weight.toFixed(3)} + personTrait(1).w*${PERSON_ARM_SPREAD.Shoulders.toFixed(3)});
    if (spread <= 0.0) return posed;
    vec3 sideways = normalize(mat3(personBone(personChestBone))*vec3(1.0, 0.0, 0.0));
    return posed + sideways*(restX < 0.0 ? -spread : spread);
  }
  // How far a point is inside a tapered cylinder (negative outside), and which way is out. Above the top it's outside
  // (that's the hips, the skirt's own); below the bottom it's a round end.
  float personCapsuleDepth(vec3 p, vec3 top, vec3 bottom, vec2 radius, out vec3 away) {
    vec3 axis = bottom - top;
    float t = dot(p - top, axis)/dot(axis, axis);
    if (t < 0.0) return -1.0;
    t = min(t, 1.0);
    away = p - (top + axis*t);
    float d = length(away);
    away = d > 1e-5 ? away/d : vec3(0.0, 0.0, -1.0);
    return mix(radius.x, radius.y, t) - d;
  }
  // Keeps a skirt out of the thighs. A skirt's vertex rides a blend of the bones near it (see skirtFit.js), so between the
  // legs it moves half as far as a leg swinging back or up, and the thigh comes through it. Each thigh is a cylinder from
  // its top ring to the knee, posed by the bones those rings ride, grown by the body's shape keys; whatever of the skirt
  // is inside it is pushed out.
  vec3 personClearThighs(vec3 posed) {
    vec4 body = personTrait(0);
    vec3 keys = vec3(body.z, body.w, personTrait(1).x);
    vec2 radius = personThighRadius + vec2(dot(personThighGrow, keys), dot(personKneeGrow, keys));
    vec3 away;
    for (int side = 0; side < 2; side++) {
      vec3 mirror = side == 0 ? vec3(1.0) : vec3(-1.0, 1.0, 1.0), hip = personHipRest*mirror, knee = personKneeRest*mirror;
      float thigh = side == 0 ? personThighBones.x : personThighBones.z, kneeBone = side == 0 ? personThighBones.y : personThighBones.w;
      float depth = personCapsuleDepth(posed, (personBone(thigh)*vec4(hip, 1.0)).xyz, (personBone(kneeBone)*vec4(knee, 1.0)).xyz, radius, away);
      posed += away*max(depth, 0.0);
    }
    return posed;
  }
  uniform vec4 personCullSphere; // (the middle of a person and how far out they reach, in the model's units)
  uniform vec3 personViewPos;
  uniform vec2 personViewScale; // x: pixels per metre (a metre off, if y: a perspective view)
  uniform float personTall; // (in the model's units)
  uniform float personFloor; // (likewise)
  bool personRough = false; // (see PERSON_ROUGH_PIXELS)
  uniform float personTime;
  // (.w: the bits)
  int personSpectral() { return int(texelFetch(personTraits, ivec2(personIndex(), ${SPIRITS_ROW}), 0).w); }
  // 0 to 1 and back, each person out of step
  float personBob(float rate, float phase) { return 0.5 + 0.5*sin(personTime*rate + float(personIndex())*1.7 + phase); }
  // the bodiless trait: all but the head folded away, the head down on the ground (its neck there, whatever the pose) and
  // hopping along as they move (TWIN_LOOK_ROW .z)
  vec3 personBodiless(vec3 posed) {
    if ((personSpectral() & ${SPECTRAL.bodiless}) == 0) return posed;
    if (personVertex.x < 0.5) return vec3(0.0);
    float neck = (personBone(personHeadBone)*vec4(personHeadPivot, 1.0)).y, hop = texelFetch(personTraits, ivec2(personIndex(), ${TWIN_LOOK_ROW}), 0).z;
    return posed - vec3(0.0, neck - personFloor - personTall*(${BODILESS_CLEAR.toFixed(3)} + ${BODILESS_HOP.toFixed(3)}*hop*abs(sin(personTime*${BODILESS_HOP_RATE.toFixed(2)} + float(personIndex())*1.7))), 0.0);
  }
  // the bone that moves this vertex most
  float personMainJoint() {
    float joint = personJoints.x, most = personWeights.x;
    if (personWeights.y > most) { joint = personJoints.y; most = personWeights.y; }
    if (personWeights.z > most) { joint = personJoints.z; most = personWeights.z; }
    return personWeights.w > most ? personJoints.w : joint;
  }
  #ifdef PERSON_CULL
    // how many pixels tall this instance's person is on screen — or -1 if they're out of view (this pass's: the screen's,
    // or the shadow's), and a great many for the headshot's one person, always drawn in full
    float personOnScreen() {
      mat4 placed = modelMatrix*instanceMatrix;
      vec3 middle = (placed*vec4(personCullSphere.xyz, 1.0)).xyz;
      float reach = personCullSphere.w*length(placed[0].xyz);
      vec4 clip = projectionMatrix*viewMatrix*vec4(middle, 1.0);
      // (a generous margin: a sphere's edge in clip space isn't quite its radius across)
      float marginX = 1.5*reach*abs(projectionMatrix[0][0]), marginY = 1.5*reach*abs(projectionMatrix[1][1]);
      if (clip.w < -reach || abs(clip.x) > clip.w + marginX || abs(clip.y) > clip.w + marginY) return -1.0;
      if (personOnly >= 0 || personViewScale.x <= 0.0) return 1e6;
      float away = personViewScale.y > 0.5 ? max(distance(middle, personViewPos), 1e-3) : 1.0;
      return personTall*length(placed[1].xyz)*personViewScale.x/away;
    }
  #endif
`;

// the fragment shader's blood: where the splotches fall, and the layer over the color — personBloodColor at the
// opacity the person's Blood row of the traits texture gives (vPersonBlood.x; .y is the person, so no two have the same splotches)
const BLOOD_GLSL = `
      // blood: smooth round blobs, like the bubbles in a lava lamp, over the figure's own (unposed) surface so they stay put as it
      // moves. Each cell of a grid holds (or doesn't) a blob at a random spot in it; the blobs near a point add their falloffs
      // together, so neighbours run into each other, and the splotch is where the total passes a level
      float bloodHash(vec3 p) { p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
      float bloodBlobs(vec3 at) {
        vec3 base = floor(at - 0.5);
        float field = 0.0;
        for (int k = 0; k < 8; k++) {
          vec3 cell = base + vec3(mod(float(k), 2.0), mod(floor(float(k)/2.0), 2.0), floor(float(k)/4.0));
          vec3 centre = cell + 0.5 + (vec3(bloodHash(cell), bloodHash(cell + 17.1), bloodHash(cell + 31.3)) - 0.5)*0.4;
          float radius = 1.0 + 0.15*bloodHash(cell + 41.7);
          vec3 off = at - centre;
          float fall = max(0.0, 1.0 - dot(off, off)/(radius*radius));
          field += step(0.5, bloodHash(cell + 7.9))*fall*fall*fall;
        }
        return field;
      }`;
const BLOOD_SPLOTCHES = `
  if (vPersonBlood.x > 0.0) {
    vec3 spot = vPersonRest*${BLOOD_SCALE.toFixed(1)} + vec3(vPersonBlood.y*13.7, vPersonBlood.y*7.1, vPersonBlood.y*3.3);
    diffuseColor.rgb = mix(diffuseColor.rgb, personBloodColor, smoothstep(0.23, 0.27, bloodBlobs(spot))*vPersonBlood.x);
  }`;

// the fragment shader's outfit: its column of the outfit texture (see outfits.js), projected straight through the
// rest-pose figure — its front onto the faces turned towards +z, its back onto the rest, which way a face turns found
// from how the rest position changes across the pixel, as the model has no normals of its own to go by once posed.
// (Sampled whatever, so the texture's mipmaps get their derivatives.)
// (vPersonOutfit.w is which outfit, 0 for none, and OUTFIT_PART times where: the torso, a sleeve, a leg or a bare leg
// (no tile, but an outfit with `fishnets` draws them there) — or less, nowhere it's drawn)
const OUTFIT_PART = 16;
// fishnets' holes, across a diagonal in the model's units, and how much of each the net's strands take up
const FISHNET_CELL = 0.1, FISHNET_LINE = 0.28;
const outfitWindow = (point, min, max) => `(${point} - vec2(${min.map(v => v.toFixed(3)).join(', ')}))/vec2(${max.map((v, k) => (v - min[k]).toFixed(3)).join(', ')})`;
const OUTFIT_CHEST_GLSL = `
  {
    float outfitId = mod(vPersonOutfit.w + 0.5, ${OUTFIT_PART.toFixed(1)}) - 0.5, outfitPart = floor((vPersonOutfit.w + 0.5)/${OUTFIT_PART.toFixed(1)});
    vec3 outfitNormal = normalize(cross(dFdx(vPersonRest), dFdy(vPersonRest)));
    vec2 outfitUv = outfitPart > 1.5 ? ${outfitWindow('vPersonRest.zy', [OUTFIT_LEG.minZ, OUTFIT_LEG.minY], [OUTFIT_LEG.maxZ, OUTFIT_LEG.maxY])}
      : outfitPart > 0.5 ? ${outfitWindow('vec2(abs(vPersonRest.x), vPersonRest.z)', [OUTFIT_ARM.minX, OUTFIT_ARM.minZ], [OUTFIT_ARM.maxX, OUTFIT_ARM.maxZ])}
      : ${outfitWindow('vPersonRest.xy', [OUTFIT_CHEST.minX, OUTFIT_CHEST.minY], [OUTFIT_CHEST.maxX, OUTFIT_CHEST.maxY])};
    // (a face of the torso looking sideways, its normal's z all noise, takes the front's tile or the back's by which half it's in)
    bool outfitFront = abs(outfitNormal.z) > 0.3 ? outfitNormal.z > 0.0 : vPersonRest.z > ${OUTFIT_CHEST.midZ.toFixed(3)};
    // which tile (see OUTFIT_TILES), counting up from the texture's foot; and whether this face is one the tile's drawn on:
    // anywhere on the torso, the top of an arm, the outside of a leg — the sleeve's tile being all round the arm, under the arm's
    float outfitRow = ${(OUTFIT_TILES.length - 1).toFixed(1)} - (outfitPart > 1.5 ? ${OUTFIT_TILES.indexOf('leg').toFixed(1)} : outfitPart > 0.5 ? ${OUTFIT_TILES.indexOf('arm').toFixed(1)} : outfitFront ? ${OUTFIT_TILES.indexOf('front').toFixed(1)} : ${OUTFIT_TILES.indexOf('back').toFixed(1)});
    bool outfitFacing = outfitPart > 1.5 ? outfitNormal.x*sign(vPersonRest.x) > 0.5 : outfitPart > 0.5 ? outfitNormal.y > 0.2 : true;
    vec2 outfitAt = vec2((vPersonOutfitRed.w + clamp(outfitUv.x, 0.0, 1.0))/${OUTFIT_COLUMN_COUNT.toFixed(1)}, clamp(outfitUv.y, 0.0, 1.0));
    // (its mip level from where on the tile, not which tile: where the front's gives way to the back's the jump would pick the
    // blurriest, and a seam of the tiles' black borders would show)
    vec2 outfitScale = vec2(${(1/OUTFIT_COLUMN_COUNT).toFixed(6)}, ${(1/OUTFIT_TILES.length).toFixed(6)});
    vec2 outfitDx = dFdx(outfitUv)*outfitScale, outfitDy = dFdy(outfitUv)*outfitScale;
    vec4 outfitMask = outfitFacing ? textureGrad(personOutfitMap, vec2(outfitAt.x, (outfitAt.y + outfitRow)/${OUTFIT_TILES.length.toFixed(1)}), outfitDx, outfitDy) : vec4(0.0);
    if (outfitPart > 0.5 && outfitPart < 1.5) outfitMask = max(outfitMask, textureGrad(personOutfitMap, vec2(outfitAt.x, (outfitAt.y + ${(OUTFIT_TILES.length - 1 - OUTFIT_TILES.indexOf('sleeve')).toFixed(1)})/${OUTFIT_TILES.length.toFixed(1)}), outfitDx, outfitDy));
    if (outfitId > 0.5 && outfitPart > -0.5 && outfitPart < 2.5 && outfitUv.x > 0.0 && outfitUv.x < 1.0 && outfitUv.y > 0.0 && outfitUv.y < 1.0) {
      diffuseColor.rgb = mix(diffuseColor.rgb, vPersonOutfitRed.rgb, outfitMask.r);
      diffuseColor.rgb = mix(diffuseColor.rgb, vPersonOutfit.rgb, outfitMask.g);
      diffuseColor.rgb *= 1.0 - 0.6*outfitMask.b;
    }
    // fishnets: a diamond net wound round the rest-pose leg, fading to its average darkness once too fine to draw
    if (outfitPart > 2.5 && (${OUTFITS.map((o, k) => o.fishnets ? `abs(outfitId - ${k + 1}.0) < 0.5` : '').filter(Boolean).join(' || ') || 'false'})) {
      vec2 net = vec2(vPersonRest.y + vPersonRest.x + vPersonRest.z, vPersonRest.y - vPersonRest.x - vPersonRest.z)/${FISHNET_CELL.toFixed(3)};
      vec2 netWidth = max(fwidth(net), vec2(1e-4));
      vec2 fromLine = 0.5 - abs(fract(net) - 0.5);
      vec2 onLine = 1.0 - smoothstep(${(FISHNET_LINE/2).toFixed(3)} - netWidth, ${(FISHNET_LINE/2).toFixed(3)} + netWidth, fromLine);
      float cover = max(onLine.x, onLine.y);
      float average = 1.0 - (1.0 - ${FISHNET_LINE.toFixed(2)})*(1.0 - ${FISHNET_LINE.toFixed(2)});
      cover = mix(cover, average, smoothstep(0.3, 0.8, max(netWidth.x, netWidth.y)));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), cover*0.92);
    }
    // boots, up the bare leg as high as its outfit's boots say (the model's y), in the black of its shoes
    ${OUTFITS.map((o, k) => o.boots ? `if (outfitPart > 2.5 && abs(outfitId - ${k + 1}.0) < 0.5 && vPersonRest.y < ${o.boots.toFixed(2)}) diffuseColor.rgb = vec3(0.0035);` : '').join('\n    ')}
    // arm warmers, black from that far along a covered sleeve (the model's x) to the wrist, and their cuffs (from cuff) in its green
    ${OUTFITS.map((o, k) => o.armWarmers ? `if (outfitPart > 0.5 && outfitPart < 1.5 && abs(outfitId - ${k + 1}.0) < 0.5 && abs(vPersonRest.x) > ${o.armWarmers.toFixed(2)}) diffuseColor.rgb = vec3(0.0035);` : '').join('\n    ')}
    ${OUTFITS.map((o, k) => o.cuff ? `if (outfitPart > 0.5 && outfitPart < 1.5 && abs(outfitId - ${k + 1}.0) < 0.5 && abs(vPersonRest.x) > ${o.cuff.toFixed(2)}) diffuseColor.rgb = vPersonOutfit.rgb;` : '').join('\n    ')}
    // and a band of its green, trim deep, round the top of the boots
    ${OUTFITS.map((o, k) => o.trim ? `if (outfitPart > 2.5 && abs(outfitId - ${k + 1}.0) < 0.5 && vPersonRest.y < ${o.boots.toFixed(2)} && vPersonRest.y > ${(o.boots - o.trim).toFixed(2)}) diffuseColor.rgb = vPersonOutfit.rgb;` : '').join('\n    ')}
  }`;
// an outfit's sleeves flared from its `cuff` to the wrist, `flare` times wider there (round the rest-pose arm's middle, before
// it's posed); on the sleeves' bands of `look`
const ARM_MIDDLE = [6.705, -0.045], ARM_END = 3.24;
const outfitFlareGlsl = look => OUTFITS.map((o, k) => o.flare ? `if (abs(personTrait(${OUTFIT_RED_ROW}).w - ${k + 1}.0) < 0.5 && abs(transformed.x) > ${o.cuff.toFixed(2)} && (${(look.outfitBands || []).filter(b => b.part === 1).map(b => `int(personVertex.y + 0.5) == ${b.slot} && ${b.number}.0 < personTrait(${PERSON_CLOTHING_ROW})[${b.cut}]`).join(' || ') || 'false'}))
        transformed.yz = vec2(${ARM_MIDDLE.map(v => v.toFixed(3)).join(', ')}) + (transformed.yz - vec2(${ARM_MIDDLE.map(v => v.toFixed(3)).join(', ')}))*(1.0 + ${o.flare.toFixed(2)}*clamp((abs(transformed.x) - ${o.cuff.toFixed(2)})/${(ARM_END - o.cuff).toFixed(2)}, 0.0, 1.0));` : '').filter(Boolean).join('\n      ');
// a skirt's hem stripe, below its outfit's `hem` (the model's y), in the outfit's green color
const SKIRT_HEM_GLSL = `
  ${OUTFITS.map((o, k) => o.hem ? `if (abs(vPersonHem.w - ${k + 1}.0) < 0.5 && vPersonRest.y < ${o.hem.toFixed(2)}) diffuseColor.rgb = vPersonHem.rgb;` : '').join('\n  ')}`;

// A blush: a rectangle of pink on each cheek (personCheeks, from where the eyes are: see buildPersonModel), on the skin at
// the front of the face, as strong as vPersonBlush.
const BLUSH_GLSL = `
  if (vPersonBlush > 0.0 && vPersonRest.z > personCheekBack && abs(abs(vPersonRest.x) - personCheeks.x) < personCheeks.z
    && abs(vPersonRest.y - personCheeks.y) < personCheeks.w) diffuseColor.rgb = mix(diffuseColor.rgb, personBlushColor, vPersonBlush);`;

// A glint: a white square on the top left of each pupil (personPupil: see buildPersonModel), the same side on both, for
// eyes welled up (vPersonGlint).
const GLINT_GLSL = `
  if (vPersonGlint > 0.0) {
    vec4 pupil = personPupil[vPersonRest.x > 0.0 ? 0 : 1];
    vec2 glint = (vPersonRest.xy - pupil.xy)/pupil.zw;
    if (glint.x > -0.9 && glint.x < -0.1 && glint.y > 0.2 && glint.y < 0.67) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), min(1.0, vPersonGlint));
  }`;

/**
 * Add the posing and shape keys to a material's shaders, and how it colors the figure.
 *
 * `look.femaleOnly` gives the slots only drawn for women, and `look.lashes` the eyelash pieces, each only drawn for someone
 * whose bit for it (its place in the list) is set in the clothing row's w; and, unless it's the shadow's depth material, `look.palette`
 * (each slot's own color), `look.traitColors` (the slots taking a color of the person's own instead, as
 * { slot: traits row }), `look.bloodSlots` (the slots blood splotches are drawn over — and, with `look.bloodOnBands`, the bands of clothes where they show skin) and `look.bands` (bands of clothes, which show skin — that person's own — if the person's clothes
 * stop at or before them: { slot, number, cut (which of the clothing row's values says where their clothes stop),
 * colorRow (the traits row of the clothes' color) }), and `look.outfitSlots` (the slots an outfit's texture is
 * drawn over, with `look.outfitMap` the texture: see outfits.js — and `look.outfitBands` and `look.outfitLegSlots`, the
 * bands of the sleeves and legs it's drawn over too, where they're covered, and the rest of the legs; and
 * `look.outfitBareLegSlots`, the legs' bands, where they're bare, for fishnets). `look.blushSlot` is the slot a blush goes on (see BLUSH_GLSL). `look.shadow` says it's the shadow's depth material
 * and `look.layer` that it's worn over the body, for how small a person it leaves out (see personOnScreen).
 * @param {object} shader - three.js's shader object to patch
 * @param {Object<string, {value: *}>} uniforms - the person uniforms to give it
 * @param {object} look - what the material draws and how it colors it
 * @returns {void}
 */
function injectPersonShader(shader, uniforms, look) {
  Object.assign(shader.uniforms, uniforms);
  const colored = !!look.palette;
  if (colored) shader.uniforms.personPalette = { value: look.palette };
  const hide = look.femaleOnly.length
    ? `if ((${look.femaleOnly.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) && personTrait(1).y > 0.5) transformed = vec3(0.0);` : '';
  const lashes = (look.lashes || []).length
    ? `if (${look.lashes.map((slot, k) => `(personSlotIndex == ${slot} && (int(personTrait(${PERSON_CLOTHING_ROW}).w + 0.5) & ${1 << k}) == 0)`).join(' || ')}${look.lips >= 0 ? ` || (personSlotIndex == ${look.lips} && (int(personTrait(${PERSON_CLOTHING_ROW}).w + 0.5) & ${1 << PERSON_LASHES.length}) != 0)` : ''}) transformed = vec3(0.0);` : '';
  // (not from the shadow's depth material, so the body still casts one) whoever personHidden names is drawn headless: their head
  // and hair drawn into a point at the middle of their chest, inside their shirt
  const splotched = colored && (look.bloodSlots || []).length > 0;
  const outfitted = colored && (look.outfitSlots || []).length > 0;
  if (outfitted) shader.uniforms.personOutfitMap = { value: look.outfitMap };
  const blushed = colored && look.blushSlot != null, glinted = colored && look.pupilSlot != null;
  const hemmed = colored && !!look.hemmed;
  const rested = splotched || outfitted || blushed || glinted || hemmed;
  const hideHead = colored ? 'if (personIndex() == personHidden && personTwin < -0.5 && personVertex.x > 0.0) transformed = (personBone(personChestBone)*vec4(personChestPivot, 1.0)).xyz;' : '';
  // (nude: the clothes' slots take their skin)
  const nudeIf = (look.nudeSlots || []).length ? `personTrait(${NUDE_ROW}).w > 0.5 && (${look.nudeSlots.map(slot => `personSlotIndex == ${slot}`).join(' || ')})` : '';
  const nude = nudeIf ? `${nudeIf} ? personTrait(${SKIN_ROW}).rgb : ` : '';
  const bands = (look.bands || []).map(b => `personSlotIndex == ${b.slot} ? (${b.number}.0 >= personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? personTrait(${SKIN_ROW}).rgb : personTrait(${b.colorRow}).rgb) : `).join('');
  // (blood is drawn over the slots it's asked for, and over a band of clothes only where it shows skin)
  const bloodAmount = `personTrait(${BLOOD_ROW}).w`;
  const bloodOver = !splotched ? '' : (nudeIf && look.bloodOnBands ? `${nudeIf} ? ${bloodAmount} : ` : '') + (look.bloodOnBands ? (look.bands || []).map(b => `personSlotIndex == ${b.slot} ? (${b.number}.0 >= personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? ${bloodAmount} : 0.0) : `).join('') : '')
    + `(${look.bloodSlots.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) ? ${bloodAmount} : 0.0`;
  const color = colored
    ? 'vPersonColor = ' + nude + bands + Object.entries(look.traitColors).map(([slot, row]) => `personSlotIndex == ${slot} ? personTrait(${row}).rgb : `).join('') + 'personPalette[personSlotIndex];' : '';
  shader.vertexShader = shader.vertexShader
    .replace('void main() {', `void main() {
      if (personTwin > 0.0 && (personSpectral() & ${SPECTRAL.twins}) == 0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; } // (a twin's copy, for someone without one: before skinning)
      #ifdef PERSON_CULL
        float personPixels = personOnScreen();
        if (personPixels < ${Math.max(look.shadow ? PERSON_SHADOW_PIXELS : PERSON_DRAW_PIXELS, look.layer ? PERSON_LAYER_PIXELS : 0).toFixed(1)}) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; } // (outside the clip volume: nothing drawn)
        personRough = personPixels < ${PERSON_ROUGH_PIXELS.toFixed(1)};
      #endif`)
    .replace('#include <common>', '#include <common>\n' + PERSON_VERTEX_PARS
      + (colored ? `uniform vec3 personPalette[${look.palette.length}];\nvarying vec3 vPersonColor;` : '')
      + (splotched ? '\nvarying vec2 vPersonBlood;' : '') + (rested ? '\nvarying vec3 vPersonRest;' : '')
      + (outfitted ? '\nvarying vec4 vPersonOutfit;\nvarying vec4 vPersonOutfitRed;' : '') + (blushed ? '\nvarying float vPersonBlush;' : '') + (glinted ? '\nvarying float vPersonGlint;' : '') + (hemmed ? '\nvarying vec4 vPersonHem;' : ''))
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      ${rested ? 'vPersonRest = transformed;' : ''}
      ${outfitted ? outfitFlareGlsl(look) : ''}
      if (personRough) transformed = (personBone(personMainJoint())*vec4(transformed, 1.0)).xyz;
      else ${look.clearThighs ? 'transformed = personClearThighs((personSkinMatrix()*vec4(transformed + personShape(), 1.0)).xyz);'
        : 'transformed = personArms(personLook((personSkinMatrix()*vec4(transformed + personShape(), 1.0)).xyz), transformed.x);'}
      int personSlotIndex = int(personVertex.y + 0.5);
      // for a man, the parts only drawn for women are folded away to a point
      ${hide}
      ${lashes}
      ${hideHead}
      ${look.stripBald ? `if ((personSpectral() & ${BALD_BIT}) != 0 && personSlotIndex == 0) transformed = vec3(0.0); // (bald under their hat: its hair parts gone)` : ''}
      transformed = personBodiless(transformed);
      if ((personSpectral() & ${VANISHED_BIT}) != 0) transformed = vec3(0.0); // (a shy ghost, gone: see shyGhost in people.js)
      // (in the card's headshot, personOnly, the copy stands just behind the one it centres on, a little to their left)
      if ((personSpectral() & ${SPECTRAL.twins}) != 0) transformed += personOnly >= 0 && personTwin > 0.0
        ? vec3(${(TWIN_SHOT_SIDE - TWIN_GAP).toFixed(3)}, 0.0, ${(-TWIN_SHOT_BACK).toFixed(3)})*personTall : vec3(personTwin*${TWIN_GAP.toFixed(3)}*personTall, 0.0, 0.0);
      else if (personTwin > 0.0) transformed = vec3(0.0); // (a twin's copy, for someone without one)
      if ((personSpectral() & ${SPECTRAL.ghost}) != 0) transformed = vec3(0.0); // (drawn see-through instead: peopleSpirits.js)
      if (personOnly >= 0 && personIndex() != personOnly) transformed = vec3(0.0);
      ${color}
      ${splotched ? `vPersonBlood = vec2(${bloodOver}, float(personIndex()));` : ''}
      ${blushed ? `vPersonBlush = personSlotIndex == ${look.blushSlot} ? personTrait(${SKIN_ROW}).w : 0.0;` : ''}
      ${glinted ? `vPersonGlint = personSlotIndex == ${look.pupilSlot} && (int(personVertex.z + 0.5) & 64) != 0 ? personTrait(${WELLING_ROW}).w : 0.0;` : ''}
      ${hemmed ? `vPersonHem = vec4(personTrait(${OUTFIT_GREEN_ROW}).rgb, personTrait(${OUTFIT_RED_ROW}).w);` : ''}
      ${outfitted ? `vPersonOutfitRed = vec4(personTrait(${OUTFIT_RED_ROW}).rgb, personTrait(${OUTFIT_GREEN_ROW}).w);
      vPersonOutfit = vec4(personTrait(${OUTFIT_GREEN_ROW}).rgb, personTrait(${OUTFIT_RED_ROW}).w > 0.5 ? personTrait(${OUTFIT_RED_ROW}).w + ${OUTFIT_PART}.0*(
        (${look.outfitSlots.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) ? 0.0
        : ${(look.outfitLegSlots || []).map(slot => `personSlotIndex == ${slot} ? 2.0 : `).join('')}${(look.outfitBands || []).map(b => `personSlotIndex == ${b.slot} && ${b.number}.0 < personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? ${b.part}.0 : `).join('')}${(look.outfitBareLegSlots || []).map(slot => `personSlotIndex == ${slot} ? 3.0 : `).join('')}-1.0) : 0.0);` : ''}`);
  if (!colored) return;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPersonColor;' + (rested ? '\nvarying vec3 vPersonRest;' : '')
      + (splotched ? '\nvarying vec2 vPersonBlood;\nuniform vec3 personBloodColor;' + BLOOD_GLSL : '')
      + (outfitted ? '\nvarying vec4 vPersonOutfit;\nvarying vec4 vPersonOutfitRed;\nuniform sampler2D personOutfitMap;' : '')
      + (blushed ? '\nvarying float vPersonBlush;\nuniform vec4 personCheeks;\nuniform float personCheekBack;\nuniform vec3 personBlushColor;' : '')
      + (glinted ? '\nvarying float vPersonGlint;\nuniform vec4 personPupil[2];' : '') + (hemmed ? '\nvarying vec4 vPersonHem;' : ''))
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vPersonColor;' + (blushed ? BLUSH_GLSL : '') + (glinted ? GLINT_GLSL : '') + (outfitted ? OUTFIT_CHEST_GLSL : '') + (hemmed ? SKIRT_HEM_GLSL : '') + (splotched ? BLOOD_SPLOTCHES : ''));
}

/**
 * Make an instanced mesh of `geometry` drawn with `look` (see injectPersonShader), with shadows that take the pose too.
 * @param {THREE.BufferGeometry} geometry - the posed-figure geometry
 * @param {Object<string, {value: *}>} uniforms - the person uniforms (see buildPersonModel)
 * @param {object} look - what the material draws and how it colors it
 * @param {number} capacity - how many instances to make room for
 * @param {boolean} byAttribute - whether the instances say which person they are (instancePerson) rather than being them in order
 * @param {{name?: string, headshot?: boolean, culled?: boolean, layer?: boolean}} [options] - the mesh's name, whether it's drawn in headshots,
 * whether whoever's out of view or too small is left out (see personCulled — not for anything posed away from the person's
 * own place, like a gib's flying pieces), and whether it's worn over the body (by default, if byAttribute)
 * @returns {THREE.InstancedMesh} the mesh, added to the scene
 */
function makePersonMesh(geometry, uniforms, look, capacity, byAttribute, { name = 'People', headshot = true, culled = true, layer = byAttribute } = {}) {
  const material = new THREE.MeshToonMaterial({ gradientMap: TOON_RAMP, side: THREE.DoubleSide, flatShading: true });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (byAttribute) { material.defines = { PERSON_INDEX_ATTRIBUTE: '' }; depth.defines = { PERSON_INDEX_ATTRIBUTE: '' }; }
  // (lit by a home's lamp, and by the room's glow while the view's inside a building: see buildings/interior.js)
  material.defines = { ...material.defines, ROOM_LAMP: '', ROOM_GLOW: '' };
  if (culled) { material.defines.PERSON_CULL = ''; depth.defines = { ...depth.defines, PERSON_CULL: '' }; }
  // three.js reuses a compiled shader for materials whose onBeforeCompile reads the same, so a look of its own needs a key of its own
  const key = ['person', byAttribute, layer, culled, look.palette.length, JSON.stringify(look.traitColors), (look.bloodSlots || []).join(','), !!look.bloodOnBands, JSON.stringify(look.bands || []), (look.outfitSlots || []).join(','), JSON.stringify(look.outfitBands || []), (look.outfitLegSlots || []).join(','), (look.outfitBareLegSlots || []).join(','), !!look.clearThighs, !!look.hemmed, look.femaleOnly.join(','), (look.lashes || []).join(','), look.blushSlot ?? '', look.pupilSlot ?? '', (look.nudeSlots || []).join(','), !!look.stripBald].join('|');
  material.onBeforeCompile = shader => injectPersonShader(shader, uniforms, { ...look, layer });
  material.customProgramCacheKey = () => key;
  depth.onBeforeCompile = shader => injectPersonShader(shader, uniforms, { femaleOnly: look.femaleOnly, lashes: look.lashes, clearThighs: look.clearThighs, stripBald: look.stripBald, shadow: true, layer });
  depth.customProgramCacheKey = () => key + '|depth';
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.customDepthMaterial = depth;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  if (headshot) mesh.layers.enable(HEADSHOT_LAYER);
  mesh.visible = false;
  mesh.name = name;
  scene.add(mesh);
  return mesh;
}

/**
 * Make a per-instance attribute that changes every frame.
 * @param {number} count - how many instances
 * @param {number} size - how many numbers per instance
 * @returns {THREE.InstancedBufferAttribute} the attribute
 */
function dynamicInstanceAttribute(count, size) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count*size), size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * Load a glTF model from a URL.
 * @param {string} url - where the model is
 * @returns {Promise<object>} the parsed glTF
 */
async function loadGLB(url) {
  const buffer = await fetch(url).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  return new GLTFLoader().parseAsync(buffer, '');
}

/**
 * Load the people, hair, facial-hair, glasses and skirt models, make the jeans, and build the instanced meshes from them. The body failing
 * leaves people as cuboids; any of the others failing only leaves people without them.
 * @returns {Promise<void>}
 */
export async function loadPersonModel() {
  const [body, hair, facialHair, glasses, skirts] = await Promise.allSettled([loadGLB(PERSON_MODEL_URL), loadGLB(HAIR_MODEL_URL), loadGLB(FACIAL_HAIR_MODEL_URL), loadGLB(GLASSES_MODEL_URL), loadGLB(SKIRT_MODEL_URL)]);
  if (body.status === 'rejected') { console.warn('Kallipolis: the people model failed to load; people stay cuboids', body.reason); return; }
  if (hair.status === 'rejected') console.warn('Kallipolis: the hair model failed to load; people go without', hair.reason);
  if (facialHair.status === 'rejected') console.warn('Kallipolis: the facial hair model failed to load; people go without', facialHair.reason);
  if (glasses.status === 'rejected') console.warn('Kallipolis: the glasses model failed to load; people go without', glasses.reason);
  if (skirts.status === 'rejected') console.warn('Kallipolis: the skirt model failed to load; people go without', skirts.reason);
  const loaded = result => result.status === 'fulfilled' ? result.value : null;
  try {
    setPersonModel(buildPersonModel(body.value, loaded(hair), loaded(facialHair), loaded(glasses), loaded(skirts)));
    peopleMesh.visible = false;
  } catch (err) {
    console.warn('Kallipolis: the people model failed to load; people stay cuboids', err);
  }
}

/**
 * Build the instanced meshes, and their textures, from the loaded models.
 *
 * three.js's own rigged meshes can't be instanced, so the animations are baked instead: each one is played through a
 * frame at a time, and every bone's pose at each frame is written into a texture (a row per frame, three texels per
 * bone), the vertex shader posing each person by looking up the rows for the moment they're at. What makes each person
 * themselves is a texel per person in the traits texture — their shape keys, sex, colors and how much skin their
 * clothes show — as there aren't enough vertex attributes to go round.
 * @param {object} gltf - the loaded people model
 * @param {?object} hairGltf - the loaded hairstyles, or null
 * @param {?object} facialHairGltf - the loaded facial hair, or null
 * @param {?object} glassesGltf - the loaded glasses, or null
 * @param {?object} skirtGltf - the loaded skirts, or null
 * @returns {PersonModel} the meshes and everything the shader and the update loop need
 */
function buildPersonModel(gltf, hairGltf, facialHairGltf, glassesGltf, skirtGltf) {
  const root = gltf.scene;
  const rigged = [], attached = [];
  root.traverse(o => { if (isUnused(o.name)) return; if (o.isSkinnedMesh) rigged.push(o); else if (o.isMesh) attached.push(o); });
  if (!rigged.length) throw new Error('the model has no rigged mesh');
  const skeleton = rigged[0].skeleton, bones = skeleton.bones;
  const boneIndex = new Map(bones.map((bone, i) => [bone, i])), boneByName = new Map(bones.map((bone, i) => [bone.name, i]));
  // the same bone on the other side of the body (three.js drops the dot from Blender's names, so Shoulder.L is ShoulderL)
  const mirrorBone = bones.map((bone, i) => {
    const side = bone.name.slice(-1), other = bone.name.slice(0, -1) + (side === 'L' ? 'R' : 'L');
    return (side === 'L' || side === 'R') && boneByName.has(other) ? boneByName.get(other) : i;
  });
  skeleton.pose();
  root.updateMatrixWorld(true);
  // the head bone and every bone under it (the eyes', the lips') — what turns when a person looks around — and where it
  // meets the neck
  const headBone = boneByName.get('Head');
  const inHead = bones.map(bone => { for (let b = bone; b; b = b.parent) if (headBone != null && b === bones[headBone]) return true; return false; });
  const headPivot = headBone != null ? bones[headBone].getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  // The arm bones, by name: the rig does not chain them (a hand is posed by its own bone, not by the arm's), so there is
  // nothing to walk down from the shoulder. The whole arm moves out as one, shoulder included.
  //
  // Sideways once posed is the chest's X, which the shoulders hang from.
  const isArmBone = /^(Shoulder|Elbow|Hand|Wrist|Finger|Thumb|Little|Middle)/;
  const inArm = bones.map(bone => isArmBone.test(bone.name));
  const chestBone = boneIndex.get(bones[boneByName.get('ShoulderL') ?? 0].parent) ?? 0;
  const chestPivot = bones[chestBone].getWorldPosition(new THREE.Vector3());
  // the censor's bones and ends at rest (see peopleCensor.js): the thigh's parent and the chest; along the body's middle
  const censorRest = (() => {
    const at = name => bones[boneByName.get(name)].getWorldPosition(new THREE.Vector3());
    const hip = at('ThighL'), knee = at('KneeL'), shoulder = at('ShoulderL');
    const middle = y => new THREE.Vector3(0, y, lerp(hip.z, chestPivot.z, (y - hip.y)/Math.max(1e-6, chestPivot.y - hip.y)));
    return { pelvis: boneIndex.get(bones[boneByName.get('ThighL')].parent) ?? chestBone, chest: chestBone,
      low: middle(hip.y - CENSOR_THIGH*(hip.y - knee.y)), highMan: middle(hip.y + CENSOR_STOMACH*(shoulder.y - hip.y)),
      highWoman: middle(shoulder.y - CENSOR_SHOULDER*(shoulder.y - hip.y)) };
  })();
  const armBonesR = new THREE.Vector2(boneByName.get('ShoulderR') ?? -1, boneByName.get('ElbowR') ?? -1);

  // ============== BODY POSE ============== 
  // Below defines the body in the rest pose, as one mesh: each part's vertices, the bones moving them, which part they are, and
  // every shape key's offsets.
  //
  // A mesh riding on a bone rather than rigged (the head) moves with that bone alone. A mesh that is only one side of
  // the body (an unapplied Blender Mirror modifier) is mirrored across X onto the other side's bones.
  const positions = [], joints = [], weights = [], headWeights = [], armWeights = [], slots = [], indices = [];
  const offsets = PERSON_SHAPE_KEYS.map(() => []);
  const toModel = new THREE.Matrix4(), toModelLinear = new THREE.Matrix3(), v = new THREE.Vector3();
  const palette = PERSON_SLOTS.map(slot => new THREE.Color(slot === 'Flesh' ? FLESH_COLOR : 0xffffff));
  [...rigged, ...attached].forEach(mesh => {
    let bone = mesh.parent;
    while (bone && !boneIndex.has(bone)) bone = bone.parent;
    if (!mesh.isSkinnedMesh && !bone) return; // not part of the figure
    const geo = mesh.geometry, pos = geo.attributes.position, count = pos.count;
    const slot = Math.max(0, PERSON_SLOTS.indexOf(mesh.material.name));
    // the model's colors, as Blender shows them (the app treats colors as they're shown, not as the linear values glTF stores)
    if (mesh.material.color) palette[slot].copy(mesh.material.color).convertLinearToSRGB();
    toModel.copy(mesh.isSkinnedMesh ? mesh.bindMatrix : mesh.matrixWorld);
    toModelLinear.setFromMatrix4(toModel);
    const ownBones = mesh.isSkinnedMesh ? mesh.skeleton.bones.map(b => boneIndex.get(b)) : null;
    const skinIndex = geo.attributes.skinIndex, skinWeight = geo.attributes.skinWeight;
    const dictionary = mesh.morphTargetDictionary || {}, targets = geo.morphAttributes.position || [];
    const keyTargets = PERSON_SHAPE_KEYS.map(key => {
      const name = Object.keys(dictionary).find(n => n.toLowerCase() === key.toLowerCase());
      return name != null ? targets[dictionary[name]] : null;
    });
    let minX = Infinity, maxX = -Infinity;
    for (let i=0;i<count;i++) { minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i)); }
    const sides = minX > -1e-4 && maxX > 1e-3 ? [1, -1] : [1];
    sides.forEach(side => {
      const first = positions.length/3;
      for (let i=0;i<count;i++) {
        v.set(pos.getX(i)*side, pos.getY(i), pos.getZ(i)).applyMatrix4(toModel);
        positions.push(v.x, v.y, v.z);
        let headWeight = 0, armWeight = 0;
        for (let k=0;k<4;k++) {
          const own = mesh.isSkinnedMesh ? ownBones[skinIndex.getComponent(i, k)] : k === 0 ? boneIndex.get(bone) : 0;
          const joint = side < 0 ? mirrorBone[own] : own, weight = mesh.isSkinnedMesh ? skinWeight.getComponent(i, k) : k === 0 ? 1 : 0;
          joints.push(joint);
          weights.push(weight);
          if (inHead[joint]) headWeight += weight;
          else if (inArm[joint]) armWeight += weight;
        }
        headWeights.push(Math.min(1, headWeight));
        armWeights.push(Math.min(1, armWeight));
        slots.push(slot);
        // a vertex on the mirror plane stays on it through every shape key (as Blender's mirror clipping keeps it), or a key
        // that nudges it sideways pulls the two halves apart there — Key 1 opens a crack down the chin
        const onMirror = sides.length > 1 && Math.abs(pos.getX(i)) < 1e-4;
        keyTargets.forEach((target, key) => {
          if (target) v.set(onMirror ? 0 : target.getX(i)*side, target.getY(i), target.getZ(i)).applyMatrix3(toModelLinear); else v.set(0, 0, 0);
          offsets[key].push(v.x, v.y, v.z);
        });
      }
      const index = geo.index, corners = index ? index.count : count;
      for (let t=0;t+2<corners;t+=3) {
        const a = first + (index ? index.getX(t) : t), b = first + (index ? index.getX(t+1) : t+1), c = first + (index ? index.getX(t+2) : t+2);
        // the flipped side is inside out, so its triangles wind the other way
        if (side > 0) indices.push(a, b, c); else indices.push(a, c, b);
      }
    });
  });
  const vertexCount = positions.length/3;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(joints, 4));
  geometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(weights, 4));
  geometry.computeVertexNormals(); // (flat shading works its normals out per pixel; these are only for the shadows)
  geometry.computeBoundingBox();

  // ---- skirts: each fitted to the body (see skirtFit.js), their vertices' body shape-key offsets going into the shape
  // key texture after the body's own
  const skirtFits = [];
  if (skirtGltf) {
    skirtGltf.scene.updateMatrixWorld(true);
    const bodyOffsets = offsets.slice(0, PERSON_BODY_KEY_COUNT);
    skirtGltf.scene.children.forEach(style => {
      const parts = [];
      style.traverse(o => { if (o.isMesh) parts.push(o); });
      if (!parts.length) return;
      const skirtPositions = [], skirtIndices = [];
      parts.forEach(part => {
        const pos = part.geometry.attributes.position, index = part.geometry.index, first = skirtPositions.length/3;
        for (let i=0;i<pos.count;i++) { v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld); skirtPositions.push(v.x, v.y, v.z); }
        const corners = index ? index.count : pos.count;
        for (let t=0;t<corners;t++) skirtIndices.push(first + (index ? index.getX(t) : t));
      });
      const fit = fitSkirt(skirtPositions, { positions, indices, joints, weights, offsets: bodyOffsets, mirrorBone,
        usable: i => headWeights[i] === 0 && armWeights[i] === 0 });
      // (its back moved back, more the lower down it is, once it's fitted where it was made)
      let top = -Infinity, hem = Infinity;
      for (let i=1;i<skirtPositions.length;i+=3) { top = Math.max(top, skirtPositions[i]); hem = Math.min(hem, skirtPositions[i]); }
      for (let i=0;i<skirtPositions.length;i+=3) if (skirtPositions[i+2] < 0) {
        const down = (top - skirtPositions[i+1])/Math.max(top - hem, 1e-6);
        skirtPositions[i+2] -= SKIRT_BACK_ROOM*down*down*Math.min(1, -skirtPositions[i+2]/0.3);
      }
      const first = offsets[0].length/3;
      offsets.forEach((keyOffsets, k) => { for (let i=0;i<skirtPositions.length;i++) keyOffsets.push(k < PERSON_BODY_KEY_COUNT ? fit.offsets[k][i] : 0); });
      skirtFits.push({ name: style.name, positions: skirtPositions, indices: skirtIndices, fit, first });
    });
    skirtGltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
  // ---- the thighs, as tapered capsules from hip to knee, that a skirt is kept out of (see personClearThighs): how thick
  // the thigh is near either end, of the vertices mostly on the thigh and knee bones, and how much each body shape key thickens it
  const thighBone = boneByName.get('ThighL'), kneeBone = boneByName.get('KneeL');
  const thighs = thighBone != null && kneeBone != null ? (() => {
    const at = b => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[b]).invert());
    const hip = at(thighBone), knee = at(kneeBone), axis = knee.clone().sub(hip), length = axis.length();
    axis.divideScalar(length);
    const onThigh = [];
    for (let i=0;i<positions.length/3;i++) {
      let w = 0;
      for (let j=0;j<4;j++) if (joints[i*4 + j] === thighBone || joints[i*4 + j] === kneeBone) w += weights[i*4 + j];
      if (w > 0.5 && positions[i*3] > 0) onThigh.push(i);
    }
    // (the radius at each end, the thigh's top ring and the knee's: its widest vertex, since the ring's flat sides between
    // vertices sit inside that anyway)
    const radii = key => [[0.05, 0.4], [0.8, 1.05]].map(([from, to]) => {
      const found = [];
      onThigh.forEach(i => {
        const p = new THREE.Vector3(positions[i*3], positions[i*3+1], positions[i*3+2]);
        if (key != null) p.add(new THREE.Vector3(offsets[key][i*3], offsets[key][i*3+1], offsets[key][i*3+2]));
        const t = p.clone().sub(hip).dot(axis)/length;
        if (t >= from && t <= to) found.push(p.sub(hip).addScaledVector(axis, -t*length).length());
      });
      found.sort((a, b) => a - b);
      return found.length ? found[found.length - 1] : 0;
    });
    const rest = radii(null), grow = ['Hips', 'Weight', 'Butt'].map(name => radii(PERSON_SHAPE_KEYS.indexOf(name)).map((r, e) => Math.max(0, r - rest[e])));
    // (the cylinder starts at the top ring rather than the hip joint, so the hips above it, where the skirt sits, are left be)
    const top = onThigh.reduce((y, i) => Math.max(y, hip.y - positions[i*3+1] > 0.05*length ? positions[i*3+1] : -Infinity), -Infinity);
    return { hip: hip.clone().addScaledVector(axis, (hip.y - top)/-axis.y), knee, rest, grow };
  })() : null;

  // ---- baggy jeans: the body's legs pushed out (see jeansFit.js), their shape-key offsets going in after the skirts'
  const legSlots = ['Pants', ...PERSON_SLOTS.filter(slot => /^Leg\d/.test(slot))].map(slot => PERSON_SLOTS.indexOf(slot));
  const jeans = fitJeans({ positions, indices, joints, weights, offsets: offsets.slice(0, PERSON_BODY_KEY_COUNT),
    leg: i => legSlots.includes(slots[i]), usable: i => headWeights[i] === 0 && armWeights[i] === 0 });
  jeans.first = offsets[0].length/3;
  offsets.forEach((keyOffsets, k) => { for (let i=0;i<jeans.positions.length;i++) keyOffsets.push(k < PERSON_BODY_KEY_COUNT ? jeans.offsets[k][i] : 0); });

  // ---- the shape key texture: a block of rows per shape key, a texel per vertex (the body's, then the skirts' and jeans'), holding
  // its offsets
  const morphCount = offsets[0].length/3;
  const morphWidth = Math.min(morphCount, 1024), morphRows = Math.ceil(morphCount/morphWidth);
  const morphData = new Float32Array(morphWidth*morphRows*PERSON_SHAPE_KEYS.length*4);
  const morphMask = new Float32Array(morphCount);
  PERSON_SHAPE_KEYS.forEach((key, k) => {
    const keyOffsets = offsets[k], bit = PERSON_SHAPE_KEY_BITS[k];
    for (let i=0;i<morphCount;i++) {
      const texel = (k*morphRows*morphWidth + i)*4;
      for (let c=0;c<3;c++) morphData[texel + c] = keyOffsets[i*3 + c];
      if (Math.abs(keyOffsets[i*3]) + Math.abs(keyOffsets[i*3+1]) + Math.abs(keyOffsets[i*3+2]) > 1e-6) morphMask[i] = morphMask[i] | bit;
    }
  });
  // (the pupils, which move with their bones, as bit 64)
  const pupilBones = new Set(['PupilL', 'PupilR'].map(name => boneByName.get(name)).filter(b => b !== undefined));
  for (let i=0;i<vertexCount;i++) {
    let pupil = 0;
    for (let k=0;k<4;k++) if (pupilBones.has(joints[i*4 + k])) pupil += weights[i*4 + k];
    if (pupil > 0.5) morphMask[i] = morphMask[i] | 64;
  }
  const vertexData = new Float32Array(vertexCount*4);
  for (let i=0;i<vertexCount;i++) vertexData.set([headWeights[i] || -armWeights[i], slots[i], morphMask[i], i], i*4);
  geometry.setAttribute('personVertex', new THREE.BufferAttribute(vertexData, 4));
  const morphTexture = new THREE.DataTexture(morphData, morphWidth, morphRows*PERSON_SHAPE_KEYS.length, THREE.RGBAFormat, THREE.FloatType);
  morphTexture.needsUpdate = true;

  // ============== MOUTH AND HANDS ==============
  // Where a fork goes, and where it goes when it gets there. The mouth is the middle of the lips, kept in the head bone's
  // own terms so it follows the head round; the grips are the spot in each fist a held thing sits at, in the rest pose's
  // model space (the bone poses in the texture are matrices from that pose, so a grip runs through them like a vertex
  // does — see peopleHolding.js).
  const lipsSlot = PERSON_SLOTS.indexOf('Lips');
  const mouthRest = new THREE.Vector3();
  let lipsCount = 0;
  for (let i=0;i<vertexCount;i++) {
    if (slots[i] !== lipsSlot) continue;
    mouthRest.x += positions[i*3]; mouthRest.y += positions[i*3+1]; mouthRest.z += positions[i*3+2];
    lipsCount++;
  }
  if (lipsCount) mouthRest.multiplyScalar(1/lipsCount); else mouthRest.copy(headPivot).add(HEAD_CENTER);
  const mouthLocal = headBone != null ? bones[headBone].worldToLocal(mouthRest.clone()) : mouthRest.clone();
  // The eyes, at rest: the middle of the whites of the one on +x (the other's its mirror), how wide it is, its bottom and
  // how far forward it comes; and the top of the head. For tears to well up from, blush to go under (see personCheeks) and
  // what comes off the head to come from (see peopleEmotes.js) — all from the head's pivot, as HEAD_CENTER is.
  const whiteSlot = PERSON_SLOTS.indexOf('White'), blackSlot = PERSON_SLOTS.indexOf('Black');
  const pupilBoxes = [new THREE.Box2(), new THREE.Box2()];
  let eyeX = 0, eyeCount = 0, eyeMinX = Infinity, eyeMaxX = -Infinity, eyeLow = Infinity, eyeFront = -Infinity, headTop = -Infinity;
  const noseTip = new THREE.Vector3(0, 0, -Infinity);
  for (let i=0;i<vertexCount;i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    if (headWeights[i] > 0.5 && slots[i] === 0) headTop = Math.max(headTop, y);
    if (headWeights[i] > 0.5 && slots[i] === 0 && Math.abs(x) < 0.05 && y > mouthRest.y && z > noseTip.z) noseTip.set(x, y, z);
    if (slots[i] === blackSlot && morphMask[i] & 64) pupilBoxes[x > 0 ? 0 : 1].expandByPoint(new THREE.Vector2(x, y));
    if (slots[i] !== whiteSlot || x <= 0) continue;
    eyeX += x; eyeCount++;
    eyeMinX = Math.min(eyeMinX, x); eyeMaxX = Math.max(eyeMaxX, x);
    eyeLow = Math.min(eyeLow, y); eyeFront = Math.max(eyeFront, z);
  }
  // (and the mouth, and the tip of the nose — the frontmost skin down the face's middle above the mouth — for breath and steam)
  const mouth = mouthRest.clone().sub(headPivot);
  const nose = noseTip.z > -Infinity ? noseTip.clone().sub(headPivot) : mouth.clone().add(new THREE.Vector3(0, 0.15, 0.05));
  const face = eyeCount ? { eyeX: eyeX/eyeCount, eyeHalf: (eyeMaxX - eyeMinX)/2, eyeLow: eyeLow - headPivot.y, eyeFront: eyeFront - headPivot.z,
    top: new THREE.Vector3(0, (headTop > -Infinity ? headTop : headPivot.y + HEAD_CENTER.y*2) - headPivot.y, HEAD_CENTER.z*0.5), mouth, nose }
    : { eyeX: 0.1, eyeHalf: 0.05, eyeLow: HEAD_CENTER.y, eyeFront: HEAD_CENTER.z, top: new THREE.Vector3(0, HEAD_CENTER.y*2, HEAD_CENTER.z*0.5), mouth, nose };
  // (the blush: a rectangle on each cheek, just under the eye and as wide as it — x from the middle, y and half its width and
  // height, in the model's rest pose — on the skin in front of personCheekBack)
  const cheeks = new THREE.Vector4(face.eyeX*1.15, headPivot.y + face.eyeLow - face.eyeHalf*0.55, face.eyeHalf*0.95, face.eyeHalf*0.3);
  const cheekBack = headPivot.z + face.eyeFront - face.eyeHalf*2.5;
  // (each pupil at rest, +x first: its middle and half its width and height, for the glint)
  const pupilRest = pupilBoxes.map(b => b.isEmpty() ? new THREE.Vector4() : new THREE.Vector4((b.min.x + b.max.x)/2, (b.min.y + b.max.y)/2, (b.max.x - b.min.x)/2, (b.max.y - b.min.y)/2));
  const hands = {};
  ['L', 'R'].forEach(side => {
    const hand = bones[boneByName.get('Hand' + side)], out = side === 'L' ? 1 : -1;
    hands[side] = { bone: boneByName.get('Hand' + side) ?? 0,
      grip: (hand ? hand.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()).add(new THREE.Vector3(out*HAND_GRIP.x, HAND_GRIP.y, HAND_GRIP.z)) };
  });
  const gripRest = { L: hands.L.grip, R: hands.R.grip };
  // the model's units to a metre: someone of height 1 at people size 1 stands 1.7m tall (modelScale in people.js)
  const unitsPerMetre = (geometry.boundingBox.max.y - geometry.boundingBox.min.y)/1.7;

  // ============== BONE TEXTURE ============== 
  // Each clip's frames followed by its first frame again, so blending past the last frame loops
  // smoothly. A missing clip is the rest pose, one frame.
  //
  // Per clip, from its first frame: where it puts the pelvis (someone sitting or lying keeps their pelvis where it was,
  // not their feet), how tall it leaves them, and (for a bench sit) how high their bottom is.
  const mixer = new THREE.AnimationMixer(root);
  const pelvisBone = bones[boneByName.get('Pelvis') ?? 0], restPelvis = pelvisBone.getWorldPosition(new THREE.Vector3());
  const clips = PERSON_CLIPS.map(def => {
    const source = def.from || def.over || def.mirror || def.play || def.name;
    const clip = gltf.animations.find(c => c.name.toLowerCase() === source.toLowerCase());
    if (!clip && !def.from && !def.over && !def.mirror && !def.play) console.warn(`Kallipolis: the people model has no ${def.name} animation`);
    const sourceFrames = clip ? Math.max(1, Math.round(clip.duration*PERSON_BAKE_FPS)) : 1;
    const frames = def.from || def.at != null ? 1 : sourceFrames*(def.times || 1);
    return { name: def.name, clip, missing: !clip || (!!def.play && sourceFrames < 2), loop: !!def.loop && frames > 1, pose: !!def.pose, frames, duration: frames/PERSON_BAKE_FPS,
      sourceFrames, repose: clip ? def.repose : null, taps: null, spread: def.spread ?? 1, spreadR: def.spreadR ?? def.spread ?? 1, base: def.base ?? null,
      holdAt: def.at != null ? def.at/PERSON_BAKE_FPS : def.from ? (sourceFrames - 1)/PERSON_BAKE_FPS : null, mirror: !!def.mirror, hold: def.hold ?? null,
      span: !!def.play, reverse: !!def.reverse, anchor: def.anchor ?? null,
      start: 0, pelvis: new THREE.Vector3(), pelvisX: 0, pelvisZ: 0, top: 0, heightScale: 1, seatY: 0 };
  });
  clips.forEach(c => { if (c.base) c.base = clips.find(o => o.name === c.base) ?? null; });
  clips.forEach(c => { if (c.hold) c.hold = clips.find(o => o.name === c.hold) ?? null; });
  let boneRows = 0;
  clips.forEach(c => { c.start = boneRows; boneRows += c.frames + 1; });
  const restMatrix = name => new THREE.Matrix4().copy(skeleton.boneInverses[boneByName.get(name) ?? 0]).invert();
  const rig = { bone: name => bones[boneByName.get(name)], update: () => root.updateMatrixWorld(true),
    mouth: () => headBone != null ? bones[headBone].localToWorld(mouthLocal.clone()) : mouthRest.clone(),
    grip: side => gripRest[side].clone(), metre: unitsPerMetre,
    restAt: name => new THREE.Vector3().setFromMatrixPosition(restMatrix(name)),
    restTurn: name => new THREE.Quaternion().setFromRotationMatrix(restMatrix(name)) };
  // three texels a bone for its pose, and one on the end of the row for the clip's arm spread, left and right (personClipSpread)
  const boneWidth = bones.length*3 + 1, boneData = new Float32Array(boneWidth*boneRows*4), pose = new THREE.Matrix4();
  // (a mirrored clip gives each bone its partner's pose, reflected across the body's middle: the model is symmetric in x)
  const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
  // (and a `hold` clip's right arm is that snack clip's, moved from where its shoulder's parent is there to where it is here)
  // (every bone of it, the wrist and the fingers' IK bones too, by name as inArm finds them: they're not chained)
  const heldArm = bones.map((bone, b) => isArmBone.test(bone.name) && bone.name.endsWith('R') ? b : -1).filter(b => b >= 0);
  const armBase = bones.indexOf(bones[boneByName.get('ShoulderR')]?.parent);
  const readPose = (row, b, m) => { const o = (row*boneWidth + b*3)*4, d = boneData;
    return m.set(d[o], d[o+1], d[o+2], d[o+3], d[o+4], d[o+5], d[o+6], d[o+7], d[o+8], d[o+9], d[o+10], d[o+11], 0, 0, 0, 1); };
  const writePose = (row, b, m) => { const e = m.elements;
    for (let r=0;r<3;r++) { const o = (row*boneWidth + b*3 + r)*4; boneData[o] = e[r]; boneData[o+1] = e[4+r]; boneData[o+2] = e[8+r]; boneData[o+3] = e[12+r]; } };
  const holdArm = (c, f) => {
    if (armBase < 0) return;
    const row = c.start + f, from = c.hold.start + f % c.hold.frames, move = new THREE.Matrix4(), arm = new THREE.Matrix4();
    move.multiplyMatrices(readPose(row, armBase, move), readPose(from, armBase, arm).invert());
    heldArm.forEach(b => writePose(row, b, arm.multiplyMatrices(move, readPose(from, b, arm))));
  };
  // how far a foot travels over the walk, for how far a cycle of it carries a person
  const footBone = bones[boneByName.get('FootL') ?? boneByName.get('FootR') ?? 0], footPosition = new THREE.Vector3();
  let footMinZ = Infinity, footMaxZ = -Infinity;
  // (a clip's frames into boneData — rebakeClips, further down, runs it again for any whose reposing changes)
  const bakeClip = (c, mixer) => {
    mixer.stopAllAction();
    const action = c.clip ? mixer.clipAction(c.clip).play() : null;
    for (let f=0;f<=c.frames;f++) {
      // (a `play` clip runs exactly first frame to last — or last to first)
      // (short of the very end: a looping action set to its duration wraps round to its first frame)
      const span = c.span ? Math.min(f, c.frames - 1)/Math.max(1, c.frames - 1)*(c.clip.duration - 1e-4) : 0;
      if (action) mixer.setTime(c.holdAt ?? (c.span ? (c.reverse ? c.clip.duration - 1e-4 - span : span) : (f % c.sourceFrames)/PERSON_BAKE_FPS)); else skeleton.pose();
      root.updateMatrixWorld(true);
      if (c.repose) { c.taps = c.repose(f % c.frames, c.frames, rig); root.updateMatrixWorld(true); }
      bones.forEach((bone, b) => {
        const m = c.mirror ? mirrorBone[b] : b;
        pose.multiplyMatrices(bones[m].matrixWorld, skeleton.boneInverses[m]);
        if (c.mirror) pose.premultiply(flip).multiply(flip);
        const e = pose.elements;
        for (let r=0;r<3;r++) {
          const o = ((c.start + f)*boneWidth + b*3 + r)*4;
          boneData[o] = e[r]; boneData[o+1] = e[4+r]; boneData[o+2] = e[8+r]; boneData[o+3] = e[12+r];
        }
      });
      if (c.hold) holdArm(c, f);
      boneData[((c.start + f)*boneWidth + bones.length*3)*4] = c.mirror ? c.spreadR : c.spread;
      boneData[((c.start + f)*boneWidth + bones.length*3)*4 + 1] = c.hold ? c.hold.spreadR : c.mirror ? c.spread : c.spreadR;
      if (c.name === 'Walk' && action) { footBone.getWorldPosition(footPosition); footMinZ = Math.min(footMinZ, footPosition.z); footMaxZ = Math.max(footMaxZ, footPosition.z); }
      if (f === 0) pelvisBone.getWorldPosition(c.pelvis);
    }
  };
  clips.forEach(c => bakeClip(c, mixer));
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  // the body at each animation's first frame, posed as the shader poses it (less the shape keys)
  clips.forEach(c => {
    let top = -Infinity, seat = Infinity;
    for (let i=0;i<vertexCount;i++) {
      const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
      let x = 0, y = 0, z = 0;
      for (let k=0;k<4;k++) {
        const w = weights[i*4 + k];
        if (!w) continue;
        const o = (c.start*boneWidth + joints[i*4 + k]*3)*4;
        x += w*(boneData[o]*px + boneData[o+1]*py + boneData[o+2]*pz + boneData[o+3]);
        y += w*(boneData[o+4]*px + boneData[o+5]*py + boneData[o+6]*pz + boneData[o+7]);
        z += w*(boneData[o+8]*px + boneData[o+9]*py + boneData[o+10]*pz + boneData[o+11]);
      }
      top = Math.max(top, y);
      // their bottom: the lowest of them right around the pelvis
      if (Math.abs(x - c.pelvis.x) < 1.2 && Math.abs(z - c.pelvis.z) < 0.6) seat = Math.min(seat, y);
    }
    c.top = top;
    c.seatY = seat < Infinity ? seat : 0;
    // only sitting or lying down moves the pelvis far enough to follow; standing about, it only sways
    if (c.pose) { c.pelvisX = c.pelvis.x - restPelvis.x; c.pelvisZ = c.pelvis.z - restPelvis.z; }
  });
  clips.forEach(c => { const a = c.anchor && clips.find(o => o.name === c.anchor); if (a) { c.pelvisX = a.pelvisX; c.pelvisZ = a.pelvisZ; } });
  const standingTop = clips.find(c => c.name === 'Idle').top;
  clips.forEach(c => { c.heightScale = standingTop > 0 ? c.top/standingTop : 1; });
  // half floats, which (unlike full floats, everywhere) the texture can blend between rows
  const boneTexture = new THREE.DataTexture(Uint16Array.from(boneData, x => THREE.DataUtils.toHalfFloat(x)), boneWidth, boneRows, THREE.RGBAFormat, THREE.HalfFloatType);
  boneTexture.magFilter = boneTexture.minFilter = THREE.LinearFilter;
  boneTexture.needsUpdate = true;
  // Bake some clips again, into boneData and the texture both (for the held-items debug window: see ui/held-debug.js).
  const rebakeClips = test => {
    const again = new THREE.AnimationMixer(root), halves = boneTexture.image.data;
    clips.filter(test).forEach(c => {
      bakeClip(c, again);
      for (let i = c.start*boneWidth*4, end = (c.start + c.frames + 1)*boneWidth*4; i < end; i++) halves[i] = THREE.DataUtils.toHalfFloat(boneData[i]);
    });
    again.stopAllAction();
    again.uncacheRoot(root);
    boneTexture.needsUpdate = true;
  };

  //============== Hairstyles and facial hair ============== 
  //
  // In model space, riding on head bone.
  // The biggest part of each (a hat aside) is the hair itself, taking the person's hair color; a hat takes their hat
  // color; anything else (a hair band) keeps its own.
  const hairSlots = ['Hair', 'Hat'], hairPalette = [new THREE.Color(0xffffff), new THREE.Color(0xffffff)];
  const headStylesFrom = (styleGltf, wearers) => {
    const styles = [];
    if (!styleGltf || headBone == null) return styles;
    styleGltf.scene.updateMatrixWorld(true);
    styleGltf.scene.children.forEach(style => {
      if (style.name.startsWith('ReferenceHead')) return;    // only there to model against (see tools/reference-head.py)
      if (isUnused(style.name)) return;
      const parts = [];
      style.traverse(o => { if (o.isMesh) parts.push(o); });
      if (!parts.length) return;
      const hairParts = isPresetHair(style.name) ? [] : parts.filter(part => !isHatMaterial(part.material.name)); // (a preset's keeps its own colors)
      const hair = hairParts.length ? hairParts.reduce((a, b) => b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a) : null;
      const stylePositions = [], styleSlots = [], styleIndices = [];
      parts.forEach(part => {
        let slot = 0;
        if (isHatMaterial(part.material.name)) slot = 1;
        else if (part !== hair) {
          const name = part.material.name || 'Accessory';
          slot = hairSlots.indexOf(name);
          if (slot < 0) { hairSlots.push(name); hairPalette.push(new THREE.Color(part.material.color || 0xffffff).convertLinearToSRGB()); slot = hairSlots.length - 1; }
        }
        const pos = part.geometry.attributes.position, index = part.geometry.index, first = stylePositions.length/3;
        for (let i=0;i<pos.count;i++) { v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld); stylePositions.push(v.x, v.y, v.z); styleSlots.push(slot); }
        const corners = index ? index.count : pos.count;
        for (let t=0;t<corners;t++) styleIndices.push(first + (index ? index.getX(t) : t));
      });
      const count = stylePositions.length/3;
      const styleGeometry = new THREE.BufferGeometry();
      styleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stylePositions, 3));
      styleGeometry.setIndex(styleIndices);
      styleGeometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(new Float32Array(count*4).map((_, k) => k % 4 === 0 ? headBone : 0), 4));
      styleGeometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(new Float32Array(count*4).map((_, k) => k % 4 === 0 ? 1 : 0), 4));
      const styleVertices = new Float32Array(count*4);
      for (let i=0;i<count;i++) styleVertices.set([1, styleSlots[i], 0, i], i*4);
      styleGeometry.setAttribute('personVertex', new THREE.BufferAttribute(styleVertices, 4));
      styleGeometry.computeVertexNormals();
      styles.push({ name: style.name, ...wearers(style.name), hat: parts.some(part => isHatMaterial(part.material.name)), geometry: styleGeometry, mesh: null, anim: null, look: null, members: [] });
    });
    styleGltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return styles;
  };
  // Each layer of what's worn: its styles, and for each person which style they wear (-1 for none) and where they are
  // among its wearers. Women always wear a hairstyle, men can be bald; a layer with a `chance` is worn by that many of
  // those who can, whoever they are. `look` is how it's colored: 'hair' as their hair (and hat), 'glasses' and 'skirt' in
  // those colors of theirs, 'jeans' as their trousers. A layer with a `hatChance` gives that many of its wearers one of
  // its hats, and the rest one of its other styles; one `without` another is never worn by that one's wearers.
  const headLayer = (styles, rng, { chance = null, look = 'hair', hatChance = null, without = null } = {}) => {
    const who = (sex, hat) => styles.map((style, k) => style[sex] && (hatChance == null || style.hat === hat) ? k : -1).filter(k => k >= 0);
    return { styles, rng, chance, look, hatChance, without, of: new Int16Array(PEOPLE_MAX).fill(-1), slot: new Int32Array(PEOPLE_MAX),
      girls: who('girls', false), boys: who('boys', false), girlsHats: who('girls', true), boysHats: who('boys', true) };
  };
  const hairLayer = headLayer(headStylesFrom(hairGltf, hairstyleWearers), mulberry32(31337), { hatChance: HAT_CHANCE, look: 'scalp' });
  const facialHairLayer = headLayer(headStylesFrom(facialHairGltf, () => ({ girls: false, boys: true })), mulberry32(4711));
  const glassesLayer = headLayer(headStylesFrom(glassesGltf, () => ({ girls: true, boys: true })), mulberry32(2020), { chance: GLASSES_CHANCE, look: 'glasses' });
  // skirts, ridden by the bones and shape keys each vertex was fitted to above; only women wear them
  const skirtStyles = skirtFits.map(({ name, positions: skirtPositions, indices: skirtIndices, fit, first }) => {
    const count = skirtPositions.length/3, skirtGeometry = new THREE.BufferGeometry();
    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
    skirtGeometry.setIndex(skirtIndices);
    skirtGeometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(fit.joints, 4));
    skirtGeometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(fit.weights, 4));
    const skirtVertices = new Float32Array(count*4);
    for (let i=0;i<count;i++) skirtVertices.set([0, 0, morphMask[first + i], first + i], i*4);
    skirtGeometry.setAttribute('personVertex', new THREE.BufferAttribute(skirtVertices, 4));
    skirtGeometry.computeVertexNormals();
    return { name, girls: true, boys: false, hat: false, geometry: skirtGeometry, mesh: null, anim: null, look: null, members: [] };
  });
  const skirtLayer = headLayer(skirtStyles, mulberry32(1966), { chance: SKIRT_CHANCE, look: 'skirt' });
  // baggy jeans, made above; worn by anyone not in a skirt, the cuff a lighter shade of them
  const jeansStyles = jeans.positions.length ? [(() => {
    const count = jeans.positions.length/3, jeansGeometry = new THREE.BufferGeometry();
    jeansGeometry.setAttribute('position', new THREE.Float32BufferAttribute(jeans.positions, 3));
    jeansGeometry.setIndex(jeans.indices);
    jeansGeometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(jeans.joints, 4));
    jeansGeometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(jeans.weights, 4));
    const jeansVertices = new Float32Array(count*4);
    for (let k=0;k<count;k++) jeansVertices.set([0, jeans.cuff[k], morphMask[jeans.first + k], jeans.first + k], k*4);
    jeansGeometry.setAttribute('personVertex', new THREE.BufferAttribute(jeansVertices, 4));
    jeansGeometry.computeVertexNormals();
    return { name: 'Jeans', girls: true, boys: true, hat: false, geometry: jeansGeometry, mesh: null, anim: null, look: null, members: [] };
  })()] : [];
  const jeansLayer = headLayer(jeansStyles, mulberry32(1492), { chance: JEANS_CHANCE, look: 'jeans', without: skirtLayer });
  const wornLayers = [hairLayer, facialHairLayer, glassesLayer, skirtLayer, jeansLayer];
  // what a preset (see presets.js) wears in a layer: their hair, their skirt, nothing else
  const presetStyle = (layer, preset) => layer.styles.findIndex(style => style.name === (layer === hairLayer ? preset.hair : layer === skirtLayer ? preset.skirt : null));

  // ============== Body Traits ==============
  // Everything about how someone looks — sex, worn styles, body and face shape, colors, where their clothes stop — is
  // seeded from their person id (see assignAppearance below), so they look the same in whichever slot they stand. The
  // per-slot rolls here only size each style's instance buffer (see STYLE_ROOM); assignAppearance moves a slot between
  // styles as anyone's born into it.
  const traitRows = TWIN_LOOK_ROW + 1, traits = new Float32Array(PEOPLE_MAX*traitRows*4);
  const isMan = new Uint8Array(PEOPLE_MAX);
  // (the bald and beard traits on each slot, and the styles it had before they changed them: see groom)
  const UNGROOMED = -2, groomed = { bald: new Int8Array(PEOPLE_MAX), beard: new Int8Array(PEOPLE_MAX), ownHair: new Int16Array(PEOPLE_MAX).fill(UNGROOMED), ownBeard: new Int16Array(PEOPLE_MAX).fill(UNGROOMED) };
  const NATURAL_COLOUR_CHANCE = 0.85;
  const sexRng = mulberry32(777);
  for (let i=0;i<PEOPLE_MAX;i++) {
    const man = sexRng() < 0.5, preset = presetAt(i);
    isMan[i] = (preset ? preset.man : man) ? 1 : 0;
    wornLayers.forEach(layer => {
      const hats = layer.hatChance != null ? (man ? layer.boysHats : layer.girlsHats) : [];
      const styles = hats.length && layer.rng() < layer.hatChance ? hats : man ? layer.boys : layer.girls;
      let k = -1;
      if (styles.length && !(layer.without?.of[i] >= 0)) {
        const pick = layer.chance != null ? (layer.rng() < layer.chance ? Math.floor(layer.rng()*styles.length) : styles.length)
          : Math.floor(layer.rng()*(man ? styles.length + 1 : styles.length));
        if (pick < styles.length) k = styles[pick];
      }
      if (preset) k = presetStyle(layer, preset); // (the rolls made all the same, so no one else's change)
      if (k < 0) return;
      const members = layer.styles[k].members;
      layer.of[i] = k;
      layer.slot[i] = members.length;
      members.push(i);
    });
  }

  /**
   * Where someone's clothes stop (see clothingBand), from their id, and their sex and whether they wear a skirt (which
   * leaves the legs bare), both the slot's: a woman's midriff depends on her age, which comes from people/*.txt, so
   * callers work this out again whenever that loads (see below).
   * @param {number} id - their person id
   * @param {number} i - their slot
   * @returns {number[]} one band per entry in PERSON_CLOTHING, for the clothing texel row
   */
  const clothingRowFor = (id, i) => {
    const man = isMan[i] === 1, clothingRng = mulberry32(wardrobe[i] ? wardrobe[i] + 1 : 1990 + id*7919), { age } = profileOf(id, man), outfit = OUTFITS[outfitOf(id, i) - 1];
    return PERSON_CLOTHING.map(c => {
      const band = clothingBand(c, clothingRng(), man, age);
      if (c.band === 'Leg' && skirtLayer.of[i] >= 0) return 1;
      if (c.band === 'Leg' && jeansLayer.of[i] >= 0) return c.count + 1;
      if (outfit && c.band === 'Sleeve' && outfit.sleeves) return outfit.sleeves;
      return outfit && !outfit.bare.includes(c.band) ? c.count + 1 : band;
    });
  };

  /** Which outfit someone wears (see outfits.js), 0 for none: from their id, by a generator of its own, unless their
   * hat (the slot's) says; and never trousers under a skirt or jeans, a woman's outfit on a man, nor a skirted one on
   * anyone without a skirt (the slot's). */
  const outfitOf = (id, i) => pickOutfit(wardrobe[i] ? seedOf(wardrobe[i], 2) : seedOf(5150, id), hairLayer.of[i] >= 0 ? hairLayer.styles[hairLayer.of[i]].name : null, skirtLayer.of[i] >= 0, jeansLayer.of[i] >= 0, isMan[i] === 1);
  // Clothes bought since (see changeClothes): for each slot, 0 for the clothes they came in (seeded from their id, above
  // and in assignAppearance), or else the seed of what they've changed into since. Like their hairstyle, it's the slot's:
  // whoever takes it next starts again from their own (see assignAppearance).
  const wardrobe = new Float64Array(PEOPLE_MAX);

  const traitTexture = new THREE.DataTexture(traits, PEOPLE_MAX, traitRows, THREE.RGBAFormat, THREE.FloatType);
  const traitRow = part => 2 + PERSON_TRAIT_COLORS.indexOf(part);
  traitTexture.needsUpdate = true;

  // The colours of someone's clothes (and hair), each from an rng of theirs into `color`.
  const clothesColor = {
    Top: (rng, color) => rng() < 0.22 ? color.setHSL(0, 0, [0.1, 0.3, 0.55, 0.88][Math.floor(rng()*4)]) : color.setHSL(rng(), 0.35 + rng()*0.45, 0.35 + rng()*0.3),
    Pants: (rng, color) => rng() < 0.8 ? color.set(PANTS_COLORS[Math.floor(rng()*PANTS_COLORS.length)]) : color.setHSL(rng(), 0.25 + rng()*0.3, 0.25 + rng()*0.25),
    Shoes: (rng, color) => rng() < 0.7 ? color.set(SHOE_COLORS[Math.floor(rng()*SHOE_COLORS.length)]) : color.setHSL(rng(), 0.4 + rng()*0.45, 0.35 + rng()*0.25),
    // half the colors trousers come in, half something brighter
    Skirt: (rng, color) => rng() < 0.5 ? color.set(PANTS_COLORS[Math.floor(rng()*PANTS_COLORS.length)]) : color.setHSL(rng(), 0.35 + rng()*0.45, 0.3 + rng()*0.3),
  };
  // three in four have a natural hair color; the rest have dyed it something bright
  const hairColor = (rng, color) => rng() < NATURAL_COLOUR_CHANCE ? color.set(HAIR_TONES[Math.floor(rng()*HAIR_TONES.length)]).multiplyScalar(0.9 + rng()*0.2) : color.setHSL(rng(), 0.65 + rng()*0.3, 0.45 + rng()*0.15);

  /**
   * Write one person's body shape, face shape, colors and clothing into the traits texture, from their id — not their
   * slot, since two different ids taking the same slot one after another should look nothing alike. The hearted, as
   * saved, wear their kept look over it (see wearLook, people/peopleKeep.js). Called whenever someone is born into a
   * slot (see newPerson and updatePeople in people.js).
   * @param {number} i - their place in the crowd: the slot to write into
   * @param {number} id - their person id: what everything here is seeded from
   * @returns {void}
   */
  function assignAppearance(i, id) {
    const preset = presetAt(i);
    if (!preset) pickWorn(i, id, isMan[i] = sexOf(id) ? 1 : 0);
    const man = isMan[i] === 1, ranges = man ? PERSON_BODY_SHAPES.male : PERSON_BODY_SHAPES.female;
    const texel = row => (row*PEOPLE_MAX + i)*4;
    const traitRng = mulberry32(777 + id*7919), faceRng = mulberry32(2718 + id*7919);
    const colorRng = mulberry32(4242 + id*7919), hatRng = mulberry32(8086 + id*7919), glassesRng = mulberry32(6060 + id*7919), skirtRng = mulberry32(1966 + id*7919), color = new THREE.Color();
    const colorFor = {
      Top: () => clothesColor.Top(colorRng, color),
      Pants: () => clothesColor.Pants(colorRng, color),
      Shoes: () => clothesColor.Shoes(colorRng, color),
      Hair: () => hairColor(colorRng, color),
      Skin: () => color.copy(palette[0]),
      Eyes: () => color.copy(palette[PERSON_SLOTS.indexOf('White')]),
      Blood: () => color.setRGB(0, 0, 0), // (only its fourth number, the opacity, is read: see BLOOD_GLSL)
      // its own generator, so adding it didn't change anyone's other colors
      Hat: () => hatRng() < 0.25 ? color.setHSL(0, 0, [0.08, 0.3, 0.6, 0.9][Math.floor(hatRng()*4)]) : color.setHSL(hatRng(), 0.4 + hatRng()*0.5, 0.3 + hatRng()*0.35),
      // mostly black or tortoiseshell brown, some wire-grey, a few loud
      Glasses: () => { const r = glassesRng(); return r < 0.8 ? color.set(GLASSES_COLORS[Math.floor(glassesRng()*GLASSES_COLORS.length)]) : color.setHSL(glassesRng(), 0.6 + glassesRng()*0.3, 0.4 + glassesRng()*0.15); },
      Skirt: () => clothesColor.Skirt(skirtRng, color),
      Cuff: () => color.setRGB(1, 1, 1), // (worked out from their trousers: see below)
      // (only an outfit has these: see below)
      OutfitRed: () => color.setRGB(1, 1, 1),
      OutfitGreen: () => color.setRGB(1, 1, 1),
    };
    const shape = PERSON_SHAPE_KEYS.slice(0, PERSON_BODY_KEY_COUNT).map(key => { const [lo, hi] = ranges[key]; return lo + traitRng()*(hi - lo); });
    traits.set(shape.slice(0, 4), texel(0));
    // their head's and eyes' shapes
    const face = Object.values(PERSON_FACE_SHAPES).map(range => {
      const [lo, hi] = Array.isArray(range) ? range : range[man ? 'male' : 'female'];
      return lo + faceRng()*(hi - lo);
    });
    traits.set([shape[4], man ? 1 : 0, face[4], shape[5]], texel(1));
    traits.set(face.slice(0, 4), texel(PERSON_FACE_ROW));
    PERSON_TRAIT_COLORS.forEach((part, k) => { colorFor[part](); traits.set([color.r, color.g, color.b], texel(2 + k)); });
    traits[texel(BLOOD_ROW) + 3] = 0; // (no splotches: whoever had this slot before may have died covered in blood)
    wardrobe[i] = 0; // (in the clothes they came in)
    traits[texel(NUDE_ROW) + 3] = 0; // (dressed, till people.js says otherwise: see setNude)
    dressOutfit(i, id, mulberry32(5151 + id*7919), mulberry32(5152 + id*7919));
    const kept = !preset && pinnedLookOf(id);
    if (kept) wearLook(i, kept);
  }
  // Which style of each worn layer person `id` wears, by the same chances as the slots' above but from their id.
  const WORN_SALTS = [6101, 6203, 6301, 6407, 6521]; // (one per wornLayers entry)
  function pickWorn(i, id, man) {
    wornLayers.forEach((layer, n) => {
      const rng = mulberry32(WORN_SALTS[n] + id*7919);
      const hats = layer.hatChance != null ? (man ? layer.boysHats : layer.girlsHats) : [];
      const styles = hats.length && rng() < layer.hatChance ? hats : man ? layer.boys : layer.girls;
      let k = -1;
      // (which style by rendezvous on their names — see core/math.js — so a new style takes only the people it wins; a man
      // may wear none of a layer without a chance, as one more option)
      if (styles.length && !(layer.without?.of[i] >= 0) && (layer.chance == null || rng() < layer.chance)) {
        const options = layer.chance == null && man ? [...styles, -1] : styles;
        k = rendezvousPick(options, seedOf(WORN_SALTS[n], id), o => o < 0 ? '' : layer.styles[o].name);
      }
      if (!wear(layer, i, k) && !wear(layer, i, otherStyle(layer, styles, i, rng, true))) wear(layer, i, -1); // (full: another)
    });
    groomed.bald[i] = groomed.beard[i] = 0; groomed.ownHair[i] = groomed.ownBeard[i] = UNGROOMED;
  }
  // ---- a look kept for a hearted person between sessions (see people/peopleKeep.js): by name and value, not by roll, so
  // new styles, outfits or ranges don't change it. A style or outfit gone since leaves what their id rolls.
  const LAYER_NAMES = ['hair', 'beard', 'glasses', 'skirt', 'jeans']; // (wornLayers' order)
  const KEPT_ROWS = { body: 0, more: 1, face: PERSON_FACE_ROW, clothing: PERSON_CLOTHING_ROW };
  const KEPT_COLORS = PERSON_TRAIT_COLORS.filter(part => part !== 'Blood' && part !== 'OutfitRed' && part !== 'OutfitGreen');
  function lookOf(i) {
    const at = row => (row*PEOPLE_MAX + i)*4, outfit = traits[at(OUTFIT_RED_ROW) + 3];
    return { man: isMan[i] === 1, wardrobe: wardrobe[i],
      worn: Object.fromEntries(wornLayers.map((layer, n) => [LAYER_NAMES[n], layer.of[i] >= 0 ? layer.styles[layer.of[i]].name : null])),
      rows: Object.fromEntries(Object.entries(KEPT_ROWS).map(([name, row]) => [name, Array.from(traits.subarray(at(row), at(row) + 4))])),
      colors: Object.fromEntries(KEPT_COLORS.map(part => [part, Array.from(traits.subarray(at(traitRow(part)), at(traitRow(part)) + 3))])),
      outfit: outfit ? { name: OUTFITS[outfit - 1].name, variant: traits[at(OUTFIT_GREEN_ROW) + 3] - OUTFIT_COLUMNS[outfit - 1] } : null };
  }
  function wearLook(i, look) {
    const at = row => (row*PEOPLE_MAX + i)*4, ok = v => Array.isArray(v) && v.every(Number.isFinite);
    if (typeof look.man === 'boolean') isMan[i] = look.man ? 1 : 0;
    wornLayers.forEach((layer, n) => {
      const name = look.worn?.[LAYER_NAMES[n]];
      if (name === undefined) return;
      const k = name === null ? -1 : layer.styles.findIndex(style => style.name === name);
      if (name === null || k >= 0) wear(layer, i, k);
    });
    Object.entries(KEPT_ROWS).forEach(([name, row]) => { if (ok(look.rows?.[name])) traits.set(look.rows[name].slice(0, 4), at(row)); });
    KEPT_COLORS.forEach(part => { if (ok(look.colors?.[part])) traits.set(look.colors[part].slice(0, 3), at(traitRow(part))); });
    traits[at(1) + 1] = isMan[i]; // (the shader's sex)
    if (look.outfit !== undefined) {
      const o = look.outfit ? OUTFITS.findIndex(outfit => outfit.name === look.outfit.name) : -1;
      traits[at(OUTFIT_RED_ROW) + 3] = o + 1;
      traits[at(OUTFIT_GREEN_ROW) + 3] = o < 0 ? 0 : OUTFIT_COLUMNS[o] + Math.max(0, Math.min((OUTFITS[o].variants || 1) - 1, Math.round(look.outfit.variant) || 0));
    }
    wardrobe[i] = Number.isFinite(look.wardrobe) ? look.wardrobe : 0;
    traitTexture.needsUpdate = true;
  }
  /**
   * The rest of someone's clothes over the colors already written for them: an outfit's colors over their own (`outfitRng`,
   * a generator of its own, so no one else's change) and which of its variants they wear (`variantRng`); under a skirt,
   * the skirt for what's left of their trousers; a jeans' cuff; and where their clothes stop.
   * @param {number} i - their slot
   * @param {number} id - their person id
   * @param {function(): number} outfitRng - for the outfit's colors
   * @param {function(): number} variantRng - for which of its variants
   * @returns {void}
   */
  function dressOutfit(i, id, outfitRng, variantRng) {
    const texel = row => (row*PEOPLE_MAX + i)*4, color = new THREE.Color();
    const outfit = outfitOf(id, i);
    traits[texel(OUTFIT_RED_ROW) + 3] = outfit;
    // and which column of the outfits' texture is theirs: which of its variants they wear (see outfits.js)
    traits[texel(OUTFIT_GREEN_ROW) + 3] = outfit ? OUTFIT_COLUMNS[outfit - 1] + Math.floor(variantRng()*(OUTFITS[outfit - 1].variants || 1)) : 0;
    if (outfit) Object.entries(OUTFITS[outfit - 1].colors).forEach(([part, colors]) => {
      const to = texel(traitRow(part));
      if (typeof colors === 'string') { const from = texel(traitRow(colors)); traits.copyWithin(to, from, from + 3); return; }
      color.set(colors[Math.floor(outfitRng()*colors.length)]);
      traits.set([color.r, color.g, color.b], to);
    });
    // under a skirt, what's left of their trousers (the crotch, which shows as they sit) is the skirt
    if (skirtLayer.of[i] >= 0) traits.copyWithin(texel(traitRow('Pants')), texel(traitRow('Skirt')), texel(traitRow('Skirt')) + 3);
    // a jeans' cuff, a lighter shade of whatever their trousers ended up
    const pants = texel(traitRow('Pants'));
    color.setRGB(traits[pants], traits[pants + 1], traits[pants + 2]).lerp(CUFF_LIGHTEN_TO, CUFF_LIGHTEN);
    traits.set([color.r, color.g, color.b], texel(traitRow('Cuff')));
    traits.set(clothingRowFor(id, i), texel(PERSON_CLOTHING_ROW));
    // which pieces of the eyelashes she wears: any of them, but never none (from a generator of its own)
    traits[texel(PERSON_CLOTHING_ROW) + 3] = 1 + Math.floor(mulberry32(3131 + id*7919)()*((1 << PERSON_LASHES.length) - 1));
    const preset = presetAt(i);
    if (preset) lookLike(i, preset);
    traitTexture.needsUpdate = true;
  }
  // a preset's shape, face, clothes' ends, lashes and lipstick (see presets.js)
  function lookLike(i, preset) {
    const at = (row, k) => (row*PEOPLE_MAX + i)*4 + k;
    const { Breast, Waist, Hips, Weight, Butt, Shoulders } = preset.body, face = preset.face;
    [Breast, Waist, Hips, Weight].forEach((v, k) => { traits[at(0, k)] = v; });
    traits[at(1, 0)] = Butt; traits[at(1, 2)] = face.Shape3; traits[at(1, 3)] = Shoulders;
    [face['Key 1'], face['Key 2'], face.Shape1, face.Shape2].forEach((v, k) => { traits[at(PERSON_FACE_ROW, k)] = v; });
    preset.bands.forEach((v, k) => { traits[at(PERSON_CLOTHING_ROW, k)] = v; });
    traits[at(PERSON_CLOTHING_ROW, 3)] = preset.lashes.reduce((bits, n) => bits | (1 << (n - 1)), preset.lipstick ? 0 : 1 << PERSON_LASHES.length);
  }

  // ============== Changing how someone looks ==============
  // A haircut or new clothes (see "a salon" and "a clothes shop" in peopleActivities.js). A style's instanced from its
  // wearers' slots (see `members`), each mesh with room for STYLE_ROOM more than it started with (see below), so moving
  // a slot from one style to another is: out of the one's list, into the other's (kept in order), and both lists'
  // slots written out again. False if the style has no room left (or no mesh).
  /**
   * Make slot `to` look just like slot `from` (a piper's mini: see peopleMinis.js) — sex, shape, face, colours, clothes
   * and every worn style — without their blood, spectral bits or nudity, which people.js works out for them again.
   * @param {number} from
   * @param {number} to
   * @returns {void}
   */
  function copyLook(from, to) {
    isMan[to] = isMan[from];
    wardrobe[to] = wardrobe[from];
    for (let row = 0; row < traitRows; row++) traits.copyWithin((row*PEOPLE_MAX + to)*4, (row*PEOPLE_MAX + from)*4, (row*PEOPLE_MAX + from + 1)*4);
    traits[(BLOOD_ROW*PEOPLE_MAX + to)*4 + 3] = 0;
    traits[(SPIRITS_ROW*PEOPLE_MAX + to)*4 + 3] = 0;
    wornLayers.forEach(layer => { if (!wear(layer, to, layer.of[from])) wear(layer, to, -1); });
    traitTexture.needsUpdate = true;
  }
  /**
   * The bald and beard traits on whoever's in slot `i` (each -1, 0 or 1: see core/traits.js). bald 1: no hairstyle (a hat
   * stays, its hair parts folded away: stripBald, BALD_BIT); -1: one, if they've none (picked by their id). beard 1:
   * facial hair (anyone, women too), if they've none; -1: none. 0 gives back what the slot had before (groomed.own…).
   * @param {number} i
   * @param {number} id
   * @param {number} bald
   * @param {number} beard
   * @returns {void}
   */
  function groom(i, id, bald, beard) {
    if (presetAt(i)) return;
    const pick = (layer, list, salt) => list.length ? otherStyle(layer, list, i, mulberry32(salt + id*7919), true) : -1;
    const side = (layer, want, own, gives, list, salt) => {
      if (want && own[i] === UNGROOMED) own[i] = layer.of[i];
      const now = layer.of[i], hat = now >= 0 && layer.styles[now].hat;
      if (!want) { if (own[i] !== UNGROOMED) { wear(layer, i, own[i]); own[i] = UNGROOMED; } return; }
      // (`gives`: 1 means having it — facial hair; else 1 means not — bald. A hat stays on the bald)
      const wanted = gives ? want > 0 : want < 0;
      if (wanted && now < 0) wear(layer, i, pick(layer, list, salt));
      else if (!wanted && now >= 0 && !hat) wear(layer, i, -1);
    };
    groomed.bald[i] = bald; groomed.beard[i] = beard;
    side(hairLayer, bald, groomed.ownHair, false, isMan[i] === 1 ? hairLayer.boys : hairLayer.girls, 9091);
    side(facialHairLayer, beard, groomed.ownBeard, true, facialHairLayer.boys, 9092);
  }
  /**
   * What shows on slot `i`'s head, for what people say ({is = bald}, {is = bearded}): bald with no hairstyle, or under a
   * hat with the bald trait; bearded with facial hair.
   * @param {number} i
   * @returns {{bald: boolean, bearded: boolean}}
   */
  const headOf = i => ({ bald: hairLayer.of[i] < 0 || (groomed.bald[i] > 0 && hairLayer.styles[hairLayer.of[i]].hat), bearded: facialHairLayer.of[i] >= 0 });
  function wear(layer, i, k) {
    const was = layer.of[i];
    if (was === k) return true;
    const into = k >= 0 ? layer.styles[k] : null;
    if (into && (!into.mesh || into.members.length >= into.capacity)) return false;
    // (each wearer's copy of where they are and how they're posed moves along with them: far off, it's only brought up to
    // date every few frames — see updatePeople — and meanwhile would be drawn on whoever took its place)
    if (was >= 0) {
      const from = layer.styles[was], at = from.members.indexOf(i), n = from.members.length;
      for (const [array, size] of instanceArrays(from)) array.copyWithin(at*size, (at + 1)*size, n*size);
      from.members.splice(at, 1);
      restack(layer, from);
    }
    layer.of[i] = k;
    if (into) {
      let at = into.members.findIndex(m => m > i);
      if (at < 0) at = into.members.length;
      const n = into.members.length, own = [mesh.instanceMatrix.array, anim.array, look.array, eyes.array, pupil.array]; // (as instanceArrays)
      instanceArrays(into).forEach(([array, size], a) => {
        array.copyWithin((at + 1)*size, at*size, n*size);
        array.set(own[a].subarray(i*size, (i + 1)*size), at*size); // (theirs, from the body's)
      });
      into.members.splice(at, 0, i);
      restack(layer, into);
    }
    return true;
  }
  const instanceArrays = style => [[style.mesh.instanceMatrix.array, 16], [style.anim.array, 4], [style.look.array, 4], [style.eyes.array, 4], [style.pupil.array, 2]];
  // (a style's wearers written out again, each into its instance slot, after one's come or gone)
  function restack(layer, style) {
    if (!style.mesh) return;
    const person = style.geometry.attributes.instancePerson;
    style.members.forEach((m, slot) => { layer.slot[m] = slot; person.array[slot] = m; });
    person.needsUpdate = style.mesh.instanceMatrix.needsUpdate = style.anim.needsUpdate = style.look.needsUpdate = style.eyes.needsUpdate = style.pupil.needsUpdate = true;
  }
  // a style from `list` (indices into the layer's styles) with room for them — other than the one they wear, unless
  // `same` — or -1
  const otherStyle = (layer, list, i, rng, same = false) => {
    const open = list.filter(k => (same || k !== layer.of[i]) && layer.styles[k].mesh && (k === layer.of[i] || layer.styles[k].members.length < layer.styles[k].capacity));
    return open.length ? open[Math.floor(rng()*open.length)] : -1;
  };
  /**
   * A new haircut for whoever's in slot `i`: a hairstyle they've not got (never a hat — it comes off at the salon), now
   * and then a man's head shaved, or his facial hair changed; and now and then their hair dyed. Someone who came in a hat
   * that went with what they wore (see pickOutfit) needs something else to wear with it now: new clothes too.
   * @param {number} i - their slot
   * @param {number} id - their person id
   * @param {function(): number} rng - the choices
   * @returns {void}
   */
  function cutHair(i, id, rng) {
    if (presetAt(i)) return;
    const man = isMan[i] === 1, wasHat = hairLayer.of[i] >= 0 && hairLayer.styles[hairLayer.of[i]].hat;
    // (the bald and beard traits have their way: groom)
    let k = man && hairLayer.of[i] >= 0 && rng() < BALD_CUT ? -1 : otherStyle(hairLayer, man ? hairLayer.boys : hairLayer.girls, i, rng);
    if (groomed.bald[i] > 0) k = -1;
    if (k >= 0 || man || groomed.bald[i] > 0) wear(hairLayer, i, k);
    if (groomed.beard[i] === 0 && man && rng() < FACIAL_HAIR_CUT) wear(facialHairLayer, i, rng() < 0.4 ? -1 : otherStyle(facialHairLayer, facialHairLayer.boys, i, rng));
    if (groomed.bald[i] || groomed.beard[i]) { groomed.ownHair[i] = groomed.ownBeard[i] = UNGROOMED; groom(i, id, groomed.bald[i], groomed.beard[i]); } // (the cut's their own now)
    if (rng() < HAIR_DYE) {
      const color = new THREE.Color();
      hairColor(rng, color);
      traits.set([color.r, color.g, color.b], (traitRow('Hair')*PEOPLE_MAX + i)*4);
      traitTexture.needsUpdate = true;
    }
    if (wasHat) changeClothes(i, id, rng);
  }
  /**
   * New clothes for whoever's in slot `i`: a new top, trousers and shoes, now and then a skirt (a woman) or baggy jeans
   * (anyone not in one) where they'd none, or none where they had — and whatever outfit goes with all that.
   * @param {number} i - their slot
   * @param {number} id - their person id
   * @param {function(): number} rng - the choices
   * @returns {void}
   */
  function changeClothes(i, id, rng) {
    if (traits[(NUDE_ROW*PEOPLE_MAX + i)*4 + 3] > 0.5) return; // (the nude never change)
    const preset = presetAt(i);
    if (preset) { // (dressed again as ever: back from nude, say)
      wear(skirtLayer, i, presetStyle(skirtLayer, preset)); wear(jeansLayer, i, -1);
      dressOutfit(i, id, mulberry32(5151 + id*7919), mulberry32(5152 + id*7919));
      return;
    }
    const man = isMan[i] === 1, seed = wardrobe[i] = 1 + Math.floor(rng()*2**31);
    if (!man) wear(skirtLayer, i, rng() < SKIRT_CHANCE ? otherStyle(skirtLayer, skirtLayer.girls, i, rng, true) : -1);
    if (skirtLayer.of[i] >= 0) wear(jeansLayer, i, -1);
    else wear(jeansLayer, i, rng() < JEANS_CHANCE ? otherStyle(jeansLayer, man ? jeansLayer.boys : jeansLayer.girls, i, rng, true) : -1);
    const texel = row => (row*PEOPLE_MAX + i)*4, colorRng = mulberry32(seed + 3), color = new THREE.Color();
    for (const part of ['Top', 'Pants', 'Shoes', 'Skirt']) {
      clothesColor[part](colorRng, color);
      traits.set([color.r, color.g, color.b], texel(traitRow(part)));
    }
    // (and any outfit that goes with those over them, as in assignAppearance)
    dressOutfit(i, id, mulberry32(seed + 4), mulberry32(seed + 5));
  }
  /**
   * The nude trait: skin for clothes (see nudeSlots), no skirt, jeans or outfit, and the censor over them; or dressed
   * again in new clothes.
   * @param {number} i - their slot
   * @param {number} id - their person id
   * @param {boolean} on - nude or not
   * @returns {void}
   */
  function setNude(i, id, on) {
    const texel = row => (row*PEOPLE_MAX + i)*4;
    traits[texel(NUDE_ROW) + 3] = on ? 1 : 0;
    if (on) {
      wear(skirtLayer, i, -1); wear(jeansLayer, i, -1);
      traits[texel(OUTFIT_RED_ROW) + 3] = traits[texel(OUTFIT_GREEN_ROW) + 3] = 0;
      traits.set(PERSON_CLOTHING.map(() => 1), texel(PERSON_CLOTHING_ROW)); // (every band bare; .w, the lashes, kept)
    } else changeClothes(i, id, mulberry32(9191 + id*7919));
    traitTexture.needsUpdate = true;
  }
  // ---- worn gifts (see life/gifts.js): a style by its name in any layer (the glasses' Sunglasses), whether slot `i` wears
  // it, putting it on them (handing back the name of what it replaced in that layer, null for nothing, or undefined if it
  // couldn't go on), and taking it off again, back into `before` (a name in the same layer, or null for nothing)
  const styleNamed = name => {
    for (const layer of wornLayers) { const k = layer.styles.findIndex(style => style.name === name); if (k >= 0) return { layer, k }; }
    return null;
  };
  const wears = (i, name) => { const found = styleNamed(name); return !!found && found.layer.of[i] === found.k; };
  function putOn(i, name) {
    const found = styleNamed(name);
    if (!found) return undefined;
    const was = found.layer.of[i], before = was >= 0 ? found.layer.styles[was].name : null;
    return wear(found.layer, i, found.k) ? before : undefined;
  }
  function takeOff(i, name, before = null) {
    const found = styleNamed(name);
    if (!found || found.layer.of[i] !== found.k) return;
    const back = before == null ? -1 : found.layer.styles.findIndex(style => style.name === before);
    if (!wear(found.layer, i, back)) wear(found.layer, i, -1);
  }
  // a woman's clothes depend on her age, which comes from people/*.txt: whenever that (re)loads, work out everyone's
  // clothing again, without touching the rest of how they look
  onProfilesLoaded(() => {
    people.forEach((p, i) => { if (!pinnedLookOf(p.id) && traits[(NUDE_ROW*PEOPLE_MAX + i)*4 + 3] < 0.5) traits.set(clothingRowFor(p.id, i), (PERSON_CLOTHING_ROW*PEOPLE_MAX + i)*4); });
    traitTexture.needsUpdate = true;
  });

  // ============== Meshes  ============== 
  const uniforms = {
    personBones: { value: boneTexture }, personBonesSize: { value: new THREE.Vector2(boneWidth, boneRows) },
    personMorphs: { value: morphTexture }, personMorphsWidth: { value: morphWidth }, personMorphsRows: { value: morphRows },
    personTraits: { value: traitTexture }, personHidden: { value: -1 }, personOnly: { value: -1 }, personTwin: { value: -1 }, personBloodColor: { value: new THREE.Color(0.55, 0.05, 0.05) },
    personHeadBone: { value: headBone ?? 0 }, personHeadPivot: { value: headPivot }, personHeadMiddle: { value: new THREE.Vector2(face.top.y*0.5, face.top.z) }, personPullBones: { value: Object.keys(FACE_PULLS).map(name => boneByName.get(name) ?? -9) }, personPulls: { value: Object.values(FACE_PULLS).map(([[x, y, z], up]) => new THREE.Vector4(x, y, z, up).multiplyScalar(face.eyeHalf)) }, personChestBone: { value: chestBone }, personChestPivot: { value: chestPivot }, personArmBonesR: { value: armBonesR },
    personThighBones: { value: thighs ? new THREE.Vector4(thighBone, kneeBone, mirrorBone[thighBone], mirrorBone[kneeBone]) : new THREE.Vector4() },
    personHipRest: { value: thighs ? thighs.hip : new THREE.Vector3() }, personKneeRest: { value: thighs ? thighs.knee : new THREE.Vector3() },
    personThighRadius: { value: new THREE.Vector2(...(thighs ? thighs.rest : [0, 0])) },
    personThighGrow: { value: new THREE.Vector3(...(thighs ? thighs.grow.map(g => g[0]) : [0, 0, 0])) },
    personKneeGrow: { value: new THREE.Vector3(...(thighs ? thighs.grow.map(g => g[1]) : [0, 0, 0])) },
    personCheeks: { value: cheeks }, personCheekBack: { value: cheekBack }, personBlushColor: { value: new THREE.Color(PERSON_BLUSH_COLOR) }, personPupil: { value: pupilRest },
    ...personCulling,
  };
  const bodyLook = {
    palette,
    traitColors: Object.fromEntries([['Skin', 'Skin'], ['Top', 'Top'], ['Pants', 'Pants'], ['Shoes', 'Shoes'], ['White', 'Eyes']].map(([slot, part]) => [PERSON_SLOTS.indexOf(slot), traitRow(part)])),
    femaleOnly: PERSON_FEMALE_ONLY.map(part => PERSON_SLOTS.indexOf(part)), lashes: PERSON_LASHES.map(part => PERSON_SLOTS.indexOf(part)), lips: PERSON_SLOTS.indexOf('Lips'),
    bloodSlots: [PERSON_SLOTS.indexOf('Skin')], bloodOnBands: true,
    bands: PERSON_CLOTHING.flatMap((c, cut) => Array.from({ length: c.count }, (_, k) =>
      ({ slot: PERSON_SLOTS.indexOf(c.band + (k + 1)), number: k + 1, cut, colorRow: traitRow(c.part) }))),
    outfitSlots: ['Top', 'Tummy1', 'Tummy2'].map(slot => PERSON_SLOTS.indexOf(slot)), outfitMap: buildOutfitTexture(),
    blushSlot: PERSON_SLOTS.indexOf('Skin'), pupilSlot: PERSON_SLOTS.indexOf('Black'),
    nudeSlots: ['Top', 'Pants', 'Shoes', ...PERSON_CLOTHING.flatMap(c => Array.from({ length: c.count }, (_, k) => c.band + (k + 1)))].map(slot => PERSON_SLOTS.indexOf(slot)),
  };
  // (a sleeve's bands and a leg's, where they're covered, take the arm's and leg's tiles; and so does the top of the legs, always covered)
  bodyLook.outfitBands = bodyLook.bands.flatMap(b => { const band = PERSON_SLOTS[b.slot]; return band.startsWith('Sleeve') ? [{ ...b, part: 1 }] : band.startsWith('Leg') ? [{ ...b, part: 2 }] : []; });
  bodyLook.outfitLegSlots = [PERSON_SLOTS.indexOf('Pants')];
  // (and a leg's bands where they're bare, for fishnets)
  bodyLook.outfitBareLegSlots = bodyLook.bands.filter(b => PERSON_SLOTS[b.slot].startsWith('Leg')).map(b => b.slot);
  const anim = dynamicInstanceAttribute(PEOPLE_MAX, 4), look = dynamicInstanceAttribute(PEOPLE_MAX, 4), eyes = dynamicInstanceAttribute(PEOPLE_MAX, 4), pupil = dynamicInstanceAttribute(PEOPLE_MAX, 2);
  geometry.setAttribute('instanceAnim', anim);
  geometry.setAttribute('instanceLook', look);
  geometry.setAttribute('instanceEyes', eyes);
  geometry.setAttribute('instancePupil', pupil);
  const spiritTalk = dynamicInstanceAttribute(PEOPLE_MAX, 2); // (the spirits' mouths: see peopleSpirits.js, peopleSpiritChat.js)
  geometry.setAttribute('instanceSpirit', spiritTalk);
  const mesh = makePersonMesh(geometry, uniforms, bodyLook, PEOPLE_MAX, true, { layer: false }); // (as its shown copy: see compactOf)
  // (the nude trait's censor, pelvis to chest: see peopleCensor.js)
  const censor = makeCensorMesh({ vertexPars: PERSON_VERTEX_PARS, uniforms, anim, body: mesh, nudeRow: NUDE_ROW, skinRow: SKIN_ROW, headshotLayer: HEADSHOT_LAYER,
    rest: { ...censorRest, tall: geometry.boundingBox.max.y - geometry.boundingBox.min.y } });
  // (nothing's drawn from the body's and worn styles' own instances, kept one a person (or slot) for updatePeople: each
  // source mesh has compact copies of them, sharing its vertices, holding only those shown — bit 0 — and of those, the
  // ones with a SPECTRAL bit, for twins, spirits and ghosts drawn again; refilled each frame by updateCopies)
  const compacts = [];
  const compactOf = (source, bit) => {
    const found = compacts.find(c => c.source === source && c.bit === bit);
    if (found) return found;
    const capacity = source.instanceMatrix.count, geometry = new THREE.BufferGeometry(), pairs = [];
    geometry.index = source.geometry.index;
    Object.entries(source.geometry.attributes).forEach(([name, attribute]) => {
      const own = attribute.isInstancedBufferAttribute ? dynamicInstanceAttribute(capacity, attribute.itemSize) : attribute;
      if (own !== attribute) pairs.push([attribute, own]);
      geometry.setAttribute(name, own);
    });
    const person = geometry.attributes.instancePerson ? null : dynamicInstanceAttribute(capacity, 1); // (the body's are in order)
    if (person) geometry.setAttribute('instancePerson', person);
    geometry.boundingBox = source.geometry.boundingBox; geometry.boundingSphere = source.geometry.boundingSphere;
    const matrix = dynamicInstanceAttribute(capacity, 16);
    pairs.push([source.instanceMatrix, matrix]);
    const layer = wornLayers.find(l => l.styles.some(style => style.mesh === source)), k = layer?.styles.findIndex(style => style.mesh === source);
    const slotOf = layer ? i => layer.of[i] === k ? layer.slot[i] : -1 : i => i;
    const compact = { source, bit, geometry, matrix, pairs, person, slotOf, meshes: [], owns: [...pairs.map(pair => pair[1]), ...(person ? [person] : [])] };
    compacts.push(compact);
    return compact;
  };
  // (a copy's mesh is shown once with nobody in it, so its shaders are compiled with the rest)
  const drawsCompact = (c, copy) => { c.meshes.push(copy); copy.onBeforeRender = () => { copy.userData.warm = true; }; };
  const spectralBits = Object.values(SPECTRAL), shown = [], having = { 0: shown, ...Object.fromEntries(spectralBits.map(bit => [bit, []])) };
  const sphere = new THREE.Sphere();
  let copyCount = 0, copyAlways = [];
  /**
   * Refill the compact copies (see compactOf): with whoever's shown — in view, or near enough to cast a shadow into it,
   * as personOnScreen has it but with a margin — and `always` (for headshots). Called by updatePeople, and again once the
   * frame's view is aimed (see aimPersonCulling).
   * @param {number} [count] - how many people
   * @param {number[]} [always] - who's shown whatever
   */
  function updateCopies(count = copyCount, always = copyAlways) {
    copyCount = count; copyAlways = always;
    const m = mesh.instanceMatrix.array, [cx, cy, cz, cw] = personCulling.personCullSphere.value.toArray(), tall = personCulling.personTall.value;
    const [perMetre, perspective] = personCulling.personViewScale.value.toArray(), from = personCulling.personViewPos.value;
    shown.length = 0;
    for (let i = 0; i < count; i++) {
      const o = i*16, s = Math.hypot(m[o+4], m[o+5], m[o+6]);
      if (!viewAimed || i === uniforms.personOnly.value || always.includes(i)) { shown.push(i); continue; }
      if (!s) continue;
      sphere.center.set(m[o]*cx + m[o+4]*cy + m[o+8]*cz + m[o+12], m[o+1]*cx + m[o+5]*cy + m[o+9]*cz + m[o+13], m[o+2]*cx + m[o+6]*cy + m[o+10]*cz + m[o+14]);
      sphere.radius = 2*cw*Math.hypot(m[o], m[o+1], m[o+2]);
      const pixels = tall*s*perMetre/(perspective ? Math.max(sphere.center.distanceTo(from), 1e-3) : 1);
      if ((pixels >= PERSON_DRAW_PIXELS && viewFrustum.intersectsSphere(sphere)) || (pixels >= PERSON_SHADOW_PIXELS && shadowAimed && shadowFrustum.intersectsSphere(sphere))) shown.push(i);
    }
    spectralBits.forEach(bit => { having[bit].length = 0; });
    shown.forEach(i => {
      const bits = traits[(SPIRITS_ROW*PEOPLE_MAX + i)*4 + 3];
      if (bits) spectralBits.forEach(bit => { if (bits & bit) having[bit].push(i); });
    });
    compacts.forEach(c => {
      let n = 0;
      for (const i of having[c.bit]) {
        const at = c.slotOf(i);
        if (at < 0) continue;
        for (const [from, to] of c.pairs) { const size = from.itemSize, a = from.array, b = to.array; for (let k = 0; k < size; k++) b[n*size + k] = a[at*size + k]; }
        if (c.person) c.person.array[n] = i;
        n++;
      }
      if (n) c.owns.forEach(a => { a.clearUpdateRanges(); a.addUpdateRange(0, n*a.itemSize); a.needsUpdate = true; });
      c.meshes.forEach(copy => { copy.count = n; copy.visible = n > 0 || !copy.userData.warm; });
    });
  }
  copiesAfterAim = () => { if (mesh.visible) updateCopies(); };
  // (the spirits trait's shoulder ghosts: see peopleSpirits.js)
  const spiritParts = { vertexPars: PERSON_VERTEX_PARS, uniforms, geometry, body: mesh, compact: (source, bit, ...copies) => { const c = compactOf(source, bit); copies.forEach(copy => drawsCompact(c, copy)); return c; }, headshotLayer: HEADSHOT_LAYER, fadeRow: TWIN_LOOK_ROW,
    shoulder: bones[boneByName.get('ShoulderL')].getWorldPosition(new THREE.Vector3()), idle: clips.find(c => c.name === 'Idle'), fps: PERSON_BAKE_FPS,
    slots: { white: PERSON_SLOTS.indexOf('White'), dark: ['Black', 'Eyelash1', 'Eyelash2', 'Eyelash3', 'Lips'].map(slot => PERSON_SLOTS.indexOf(slot)),
      lashes: PERSON_LASHES.map(part => PERSON_SLOTS.indexOf(part)), femaleOnly: PERSON_FEMALE_ONLY.map(part => PERSON_SLOTS.indexOf(part)), lashRow: PERSON_CLOTHING_ROW } };
  const spirits = makeSpiritMeshes(spiritParts);
  const hairLook = { palette: hairPalette, traitColors: { 0: traitRow('Hair'), 1: traitRow('Hat') }, femaleOnly: [] };
  const scalpLook = { ...hairLook, stripBald: true }; // (the hairstyles and hats themselves: facial hair is hairLook)
  const glassesLook = { palette: hairPalette, traitColors: { 0: traitRow('Glasses') }, femaleOnly: [] };
  const looks = { hair: hairLook, scalp: scalpLook, glasses: glassesLook, skirt: { palette: [new THREE.Color(0xffffff)], traitColors: { 0: traitRow('Skirt') }, femaleOnly: [], clearThighs: !!thighs, hemmed: true },
    jeans: { palette: [new THREE.Color(0xffffff), new THREE.Color(0xffffff)], traitColors: { 0: traitRow('Pants'), 1: traitRow('Cuff') }, femaleOnly: [] } };
  // (each with room for STYLE_ROOM more wearers than it started with, for haircuts and changes of clothes: see wear)
  wornLayers.flatMap(layer => layer.styles.map(style => [style, looks[layer.look]])).forEach(([style, look]) => {
    if (!style.members.length && !style.girls && !style.boys) { style.geometry.dispose(); return; }
    style.capacity = style.members.length + STYLE_ROOM;
    const person = new Float32Array(style.capacity);
    person.set(style.members);
    style.geometry.setAttribute('instancePerson', new THREE.InstancedBufferAttribute(person, 1));
    style.anim = dynamicInstanceAttribute(style.capacity, 4);
    style.look = dynamicInstanceAttribute(style.capacity, 4);
    style.eyes = dynamicInstanceAttribute(style.capacity, 4);
    style.pupil = dynamicInstanceAttribute(style.capacity, 2);
    style.geometry.setAttribute('instanceAnim', style.anim);
    style.geometry.setAttribute('instanceLook', style.look);
    style.geometry.setAttribute('instanceEyes', style.eyes);
    style.geometry.setAttribute('instancePupil', style.pupil);
    style.mesh = makePersonMesh(style.geometry, uniforms, look, style.capacity, true);
    style.mesh.count = style.members.length;
  });
  // (and the spirits' hair and accessories: not clothes)
  const spiritWorn = makeSpiritWorn(spiritParts, wornLayers.filter(layer => layer.look !== 'skirt' && layer.look !== 'jeans').flatMap(layer => layer.styles).filter(style => style.mesh));
  // (twins: each mesh again, shown and hidden with it, drawing its twin — see TWIN_GAP — over only the twins: compactOf)
  const twinOf = (source, look, layer) => {
    const c = compactOf(source, SPECTRAL.twins);
    const copy = makePersonMesh(c.geometry, { ...uniforms, personTwin: { value: 1 } }, look, c.matrix.count, true, { name: source.name + 'twins', layer });
    copy.instanceMatrix = c.matrix;
    source.add(copy);
    drawsCompact(c, copy);
  };
  // (and each drawn from its compact copy of those shown, itself never: its layers off, so not its children's)
  const shownOf = (source, look, layer) => {
    const c = compactOf(source, 0);
    const copy = makePersonMesh(c.geometry, uniforms, look, c.matrix.count, true, { name: source.name, layer });
    copy.instanceMatrix = c.matrix;
    source.add(copy);
    source.layers.disableAll();
    drawsCompact(c, copy);
  };
  shownOf(mesh, bodyLook, false);
  wornLayers.forEach(layer => layer.styles.forEach(style => { if (style.mesh) shownOf(style.mesh, looks[layer.look], true); }));
  twinOf(mesh, bodyLook, false);
  wornLayers.forEach(layer => layer.styles.forEach(style => { if (style.mesh) twinOf(style.mesh, looks[layer.look], true); }));
  const gibs = buildGibMeshes({ geometry, joints, weights, slots, bones, inHead, inArm, wornLayers, uniforms, bodyLook, looks, traits, traitRows });
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });

  const box = geometry.boundingBox;
  // (half as far again round, for the arms thrown out and the poses that lean or lie a person down)
  const middle = box.getCenter(new THREE.Vector3());
  personCulling.personCullSphere.value.set(middle.x, middle.y, middle.z, box.getSize(new THREE.Vector3()).length()*0.75);
  personCulling.personTall.value = box.max.y - box.min.y;
  personCulling.personFloor.value = box.min.y;
  // whoever's already in the crowd when the model finishes loading has been walking round as a cuboid till now: fill
  // in their looks (once the styles' meshes are made, so they can be worn). Everyone born after this just gets them as
  // they arrive (see updatePeople in people.js).
  people.forEach((p, i) => assignAppearance(i, p.id));
  const footTravel = footMaxZ > footMinZ ? footMaxZ - footMinZ : (box.max.y - box.min.y)*0.3;
  // the model faces along +Z, as people do
  return { mesh, rebakeClip: name => rebakeClips(c => c.name === name || c.hold?.name === name), hidden: uniforms.personHidden, only: uniforms.personOnly, anim, look, eyes, pupil, hair: wornLayers.flatMap(layer => layer.styles).filter(style => style.mesh), wornLayers, isMan, lookOf, boneData, boneWidth, traitData: traits, traitTexture, palette, assignAppearance, cutHair, changeClothes, setNude, censor, spirits, spiritWorn, spiritTalk, updateCopies, copyLook, groom, headOf, time: personCulling.personTime, wears, putOn, takeOff,
    headBone: headBone ?? 0, headPivot, face, chestBone, hands, unitsPerMetre, floorY: geometry.boundingBox.min.y, tall: box.max.y - box.min.y, gibs,
    height: box.max.y - box.min.y, minY: box.min.y, clips: Object.fromEntries(clips.map(c => [c.name, c])), stride: footTravel*WALK_CYCLE_LENGTH };
}


// ============== BODY-PART GIBS ==============
// What someone comes apart into when they die (see peopleGibs.js): their body split into parts by the bones each
// triangle moves with, plus whatever they wore on their head, whole. Each part is an instanced mesh over a subset of
// the body's own triangles (sharing its vertex data), drawn by the same shader as the living, in the pose they died in.
// A dead person's looks are copied into a traits texture of the gibs' own, a column per body, so their slot can go to
// someone new while their parts are still lying about.
export const GIB_BODIES_MAX = 32;
const GIB_SAMPLES = 24; // vertices per part used to find, on the CPU, where that part is in the pose they died in
const GIB_SAMPLE_STRIDE = 11; // rest position (3), joints (4), weights (4)
const GIB_DARKEN = new THREE.Color(0x550000), GIB_DARKEN_AMOUNT = 0.25; // how far a gib's colors are pulled towards dried blood
const SHARED_VERTEX_ATTRIBUTES = ['position', 'normal', 'personJoints', 'personWeights', 'personVertex'];

/**
 * A few of a part's vertices, evenly spread, with their bones, for placing the part on the CPU (see gibPartCentre).
 * @param {ArrayLike<number>} index - the part's triangle indices
 * @param {BufferAttribute} position - the rest positions
 * @param {ArrayLike<number>} joints - four bone indices per vertex
 * @param {ArrayLike<number>} weights - four bone weights per vertex
 * @returns {Float32Array} GIB_SAMPLE_STRIDE numbers per sample
 */
function gibSamples(index, position, joints, weights) {
  const vertices = [...new Set(index)], step = Math.max(1, vertices.length/GIB_SAMPLES), count = Math.min(GIB_SAMPLES, vertices.length);
  const samples = new Float32Array(count*GIB_SAMPLE_STRIDE);
  for (let k=0;k<count;k++) {
    const v = vertices[Math.floor(k*step)], o = k*GIB_SAMPLE_STRIDE;
    samples.set([position.getX(v), position.getY(v), position.getZ(v)], o);
    for (let j=0;j<4;j++) { samples[o + 3 + j] = joints[v*4 + j]; samples[o + 7 + j] = weights[v*4 + j]; }
  }
  return samples;
}

/**
 * Where a part is, in model space, in a pose from the bone texture (rows blended as the shader blends them), and how
 * far its vertices reach from there.
 * @param {Float32Array} samples - from gibSamples
 * @param {Float32Array} boneData - the bone texture's data
 * @param {number} boneWidth - texels per row of it
 * @param {ArrayLike<number>} anim - the instanceAnim values: row A, row B, how far blended towards A
 * @param {THREE.Vector3} centre - set to the part's middle
 * @param {THREE.Vector3} [size] - set to the size of the box around it
 * @returns {number} its radius
 */
export function gibPartCentre(samples, boneData, boneWidth, anim, centre, size = null) {
  const count = samples.length/GIB_SAMPLE_STRIDE, points = new Float32Array(count*3);
  const rows = [[Math.floor(anim[0]), anim[2]], [Math.floor(anim[1]), 1 - anim[2]]];
  centre.set(0, 0, 0);
  for (let k=0;k<count;k++) {
    const o = k*GIB_SAMPLE_STRIDE, px = samples[o], py = samples[o+1], pz = samples[o+2];
    let x = 0, y = 0, z = 0;
    for (const [row, share] of rows) {
      if (share <= 0) continue;
      for (let j=0;j<4;j++) {
        const w = samples[o + 7 + j]*share;
        if (!w) continue;
        const b = (row*boneWidth + samples[o + 3 + j]*3)*4;
        x += w*(boneData[b]*px + boneData[b+1]*py + boneData[b+2]*pz + boneData[b+3]);
        y += w*(boneData[b+4]*px + boneData[b+5]*py + boneData[b+6]*pz + boneData[b+7]);
        z += w*(boneData[b+8]*px + boneData[b+9]*py + boneData[b+10]*pz + boneData[b+11]);
      }
    }
    points.set([x, y, z], k*3);
    centre.x += x; centre.y += y; centre.z += z;
  }
  if (count) centre.multiplyScalar(1/count);
  let radius = 0;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let k=0;k<count;k++) {
    radius = Math.max(radius, Math.hypot(points[k*3] - centre.x, points[k*3+1] - centre.y, points[k*3+2] - centre.z));
    for (let c=0;c<3;c++) { low[c] = Math.min(low[c], points[k*3 + c]); high[c] = Math.max(high[c], points[k*3 + c]); }
  }
  if (size) size.set(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  return radius;
}

/**
 * The body as its gibs use it: its own vertices plus the copies capping each part's cut (see bodySplit.js), in the
 * Flesh slot but otherwise the vertex they copy (same bones, same shape keys), and each part's triangles.
 * @returns {THREE.BufferGeometry} with userData.parts: {name, index}[]
 */
function gibBodyGeometry({ geometry, joints, weights, slots, bones, inHead, inArm }) {
  const position = geometry.attributes.position.array;
  const shoulder = bones.find(bone => bone.name === 'ShoulderL');
  const leftSign = shoulder ? Math.sign(shoulder.getWorldPosition(new THREE.Vector3()).x) || 1 : 1;
  const { parts, capSources } = splitBody({ position, index: geometry.index.array, joints, weights, slotOf: slots.map(slot => PERSON_SLOTS[slot]),
    boneNames: bones.map(bone => bone.name), inHead, inArm, leftSign });
  const flesh = PERSON_SLOTS.indexOf('Flesh'), vertexCount = position.length/3, total = vertexCount + capSources.length;
  const out = new THREE.BufferGeometry();
  ['position', 'normal', 'personJoints', 'personWeights', 'personVertex'].forEach(name => {
    const from = geometry.attributes[name], size = from.itemSize, array = new Float32Array(total*size);
    array.set(from.array.subarray(0, vertexCount*size));
    capSources.forEach((v, k) => array.set(from.array.subarray(v*size, v*size + size), (vertexCount + k)*size));
    if (name === 'personVertex') for (let k=0;k<capSources.length;k++) array[(vertexCount + k)*4 + 1] = flesh;
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  });
  out.userData.parts = parts;
  return out;
}

/**
 * Build the gib meshes: one per body part, and one per worn hairstyle, facial hair, pair of glasses, skirt and pair of jeans.
 * @returns {{parts: object[], snapshot: function(number, number): void, capacity: number}} the parts (each {name, mesh,
 *   anim, look, eyes, pupil, person, samples}), each worn style given a `gib` of the same shape, and a snapshot(i, column)
 *   copying person i's looks into gib column `column`
 */
function buildGibMeshes({ geometry, joints, weights, slots, bones, inHead, inArm, wornLayers, uniforms, bodyLook, looks, traits, traitRows }) {
  const gibTraits = new Float32Array(GIB_BODIES_MAX*traitRows*4);
  const gibTraitTexture = new THREE.DataTexture(gibTraits, GIB_BODIES_MAX, traitRows, THREE.RGBAFormat, THREE.FloatType);
  gibTraitTexture.needsUpdate = true;
  const gibUniforms = { ...uniforms, personTraits: { value: gibTraitTexture }, personHidden: { value: -1 }, personOnly: { value: -1 } };
  const gibOf = (source, index, look, name, samples) => {
    const geo = new THREE.BufferGeometry();
    SHARED_VERTEX_ATTRIBUTES.forEach(n => { if (source.attributes[n]) geo.setAttribute(n, source.attributes[n]); });
    geo.setIndex(index);
    const gib = { name, samples, anim: dynamicInstanceAttribute(GIB_BODIES_MAX, 4), look: dynamicInstanceAttribute(GIB_BODIES_MAX, 4),
      eyes: dynamicInstanceAttribute(GIB_BODIES_MAX, 4), pupil: dynamicInstanceAttribute(GIB_BODIES_MAX, 2), person: dynamicInstanceAttribute(GIB_BODIES_MAX, 1) };
    geo.setAttribute('instanceAnim', gib.anim);
    geo.setAttribute('instanceLook', gib.look);
    geo.setAttribute('instanceEyes', gib.eyes);
    geo.setAttribute('instancePupil', gib.pupil);
    geo.setAttribute('instancePerson', gib.person);
    // (a gib's pieces fly apart, the thighs from the skirt, so it isn't kept out of them)
    gib.mesh = makePersonMesh(geo, gibUniforms, { ...look, clearThighs: false }, GIB_BODIES_MAX, true, { name: 'BodyGibs', headshot: false, culled: false });
    return gib;
  };
  const body = gibBodyGeometry({ geometry, joints, weights, slots, bones, inHead, inArm });
  const bodyJoints = body.attributes.personJoints.array, bodyWeights = body.attributes.personWeights.array;
  const parts = body.userData.parts.map(({ name, index }) =>
    gibOf(body, index, bodyLook, name, gibSamples(index, body.attributes.position, bodyJoints, bodyWeights)));
  wornLayers.forEach(layer => layer.styles.forEach(style => {
    if (!style.mesh) return;
    const g = style.geometry, index = g.index.array;
    style.gib = gibOf(g, g.index, looks[layer.look], style.name, gibSamples(index, g.attributes.position, g.attributes.personJoints.array, g.attributes.personWeights.array));
  }));
  const colorRows = PERSON_TRAIT_COLORS.filter(part => part !== 'Blood').map(part => 2 + PERSON_TRAIT_COLORS.indexOf(part));
  const color = new THREE.Color();
  function snapshot(i, column) {
    for (let row=0;row<traitRows;row++) {
      const from = (row*PEOPLE_MAX + i)*4, to = (row*GIB_BODIES_MAX + column)*4;
      gibTraits.set(traits.subarray(from, from + 4), to);
      if (!colorRows.includes(row)) continue;
      color.setRGB(gibTraits[to], gibTraits[to+1], gibTraits[to+2]).lerp(GIB_DARKEN, GIB_DARKEN_AMOUNT);
      gibTraits[to] = color.r; gibTraits[to+1] = color.g; gibTraits[to+2] = color.b;
    }
    gibTraitTexture.needsUpdate = true;
  }
  return { parts, snapshot, capacity: GIB_BODIES_MAX };
}
