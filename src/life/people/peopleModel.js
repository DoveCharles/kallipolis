import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mulberry32, lerp } from '../../core/math.js';
import { scene } from '../../core/scene.js';
import { onProfilesLoaded, profileOf } from '../profiles.js';
import { HEADSHOT_LAYER, PEOPLE_MAX, people, peopleMesh, setPersonModel } from './people.js';

// =========================================== PEOPLE MODEL ===========================================
// assets/models/Person.glb replaces the cuboids once it loads — one rigged figure, drawn for everyone
// at once as one instanced mesh, flat-shaded.
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
// says who can wear it: ending in _G, girls; _B, boys; _GB, either (as does no suffix).
// Facial hair (assets/models/FacialHair.glb) works the same way, but only boys wear it. So do glasses and sunglasses
// (assets/models/Glasses.glb, built by tools/glasses-model.py), worn by anyone, but only by GLASSES_CHANCE of them.
const PERSON_MODEL_URL = 'assets/models/Person.glb';
const HAIR_MODEL_URL = 'assets/models/Hair.glb';
const FACIAL_HAIR_MODEL_URL = 'assets/models/FacialHair.glb';
const GLASSES_MODEL_URL = 'assets/models/Glasses.glb';
const GLASSES_CHANCE = 0.2;
/** Frames per second the source clips are baked at, into the bone-pose texture. */
export const PERSON_BAKE_FPS = 24;
/** Distances the model's foot travels per walk-animation cycle. The walk plays slower for the same speed the higher this is. */
const WALK_CYCLE_LENGTH = 4;
/** The model's clips: `loop` plays round and round, otherwise once (or held, if `pose`). `pose` is a single held pose, and
 * `from` names a clip whose last frame this pose is (Fallen is where Fall leaves them). `over` names a clip this one is
 * played over `times` times and reposed each frame by `repose` (Typing is Sit1 with the arms brought up: see typingPose;
 * TypingPaused the same with the hands held still on the keys) —
 * straight after it, so any bone it has no keys for is left as it left it.
 * `spread` scales how far the arms are moved out from a heavy or broad body (see PERSON_ARM_SPREAD): 0 for a pose that
 * reaches for something in front of them, where moving the hand out would miss it. */
const PERSON_CLIPS = [
  { name: 'Walk', loop: true }, { name: 'Idle', loop: true }, { name: 'Idle2' }, { name: 'Idle3' }, { name: 'Wave' },
  { name: 'Sit1', loop: true, pose: true }, { name: 'Typing', over: 'Sit1', times: 3, loop: true, pose: true, repose: typingPose },
  { name: 'TypingPaused', over: 'Sit1', loop: true, pose: true, repose: (frame, frames, rig) => typingPose(frame, frames, rig, false) },
  { name: 'Eating', over: 'Sit1', times: 3, loop: true, pose: true, spread: 0, repose: eatingPose },
  { name: 'EatingPaused', over: 'Sit1', loop: true, pose: true, spread: 0, repose: (frame, frames, rig) => eatingPose(frame, frames, rig, false) },
  { name: 'SitDown1', pose: true }, { name: 'SitDown2', pose: true }, { name: 'SitDown3', pose: true },
  { name: 'LieDown1', pose: true }, { name: 'LieDown2', pose: true }, { name: 'LieDown3', pose: true },
  { name: 'Punch' }, { name: 'Fall' }, { name: 'Fallen', from: 'Fall', pose: true },
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
// brings it back down over the plate to chew — twice over a loop. What happens when is kept on the clip (clip.taps,
// which people.js plays as it comes round): the fork on the plate, a mouthful gathered, and the mouthful eaten.
//
// The places are in the model's own space, sat on a dining chair with the table's edge in front of them (see the dining
// tables in buildings/interior.js): EAT_TIP_PLATE is the middle of the plate, and the mouth is wherever the head has got to.
const EAT_FORK = 0.76; // from the fist to the tines, in the model's units (the fork built in peopleHolding.js)
const EAT_TIP_REST = new THREE.Vector3(-0.65, 3.60, -0.23), EAT_DIR_REST = new THREE.Vector3(0.4, -0.28, 0.88);
const EAT_TIP_PLATE = new THREE.Vector3(-0.05, 3.56, -0.56), EAT_DIR_PLATE = new THREE.Vector3(0.2, -0.93, 0.3);
const EAT_TIP_MOUTH = new THREE.Vector3(0.02, -0.05, 0.14), EAT_DIR_MOUTH = new THREE.Vector3(0.34, 0.75, -0.57);
// seconds a mouthful's parts take: down to the plate, gathering, up to the mouth, in the mouth, and back down again
const EAT_DIP = 0.6, EAT_GATHER = 0.4, EAT_LIFT = 0.8, EAT_IN_MOUTH = 0.45, EAT_LOWER = 0.7;
const EAT_MOUTHFUL = EAT_DIP + EAT_GATHER + EAT_LIFT + EAT_IN_MOUTH + EAT_LOWER;
const EAT_BITES = 2, EAT_FIRST = 0.5; // mouthfuls a loop, and how long before the first

const eatEase = x => x*x*(3 - 2*x);
/**
 * Where the fork is part-way through a loop of Eating.
 * @param {number} t - seconds into the loop
 * @param {number} duration - the loop's length in seconds
 * @param {THREE.Vector3} mouth - where their mouth is, in the model's space
 * @returns {{tip: THREE.Vector3, dir: THREE.Vector3, cue: ?string}} where the tines are, which way the fork points
 *   (from the fist to the tines), and anything to sound or show at this frame
 */
function eatingAt(t, duration, mouth) {
  const gap = Math.max(0.3, (duration - EAT_FIRST - EAT_BITES*EAT_MOUTHFUL)/EAT_BITES);
  const fork = (tip, dir) => ({ tip: tip.clone(), dir: dir.clone().normalize() });
  const between = (a, da, b, db, x) => ({ tip: a.clone().lerp(b, eatEase(x)),
    dir: da.clone().normalize().lerp(db.clone().normalize(), eatEase(x)).normalize() });
  const tipMouth = mouth.clone().add(EAT_TIP_MOUTH);
  for (let k=0;k<EAT_BITES;k++) {
    const u = t - (EAT_FIRST + k*(EAT_MOUTHFUL + gap));
    if (u < 0 || u >= EAT_MOUTHFUL) continue;
    if (u < EAT_DIP) return between(EAT_TIP_REST, EAT_DIR_REST, EAT_TIP_PLATE, EAT_DIR_PLATE, u/EAT_DIP);
    if (u < EAT_DIP + EAT_GATHER) { // rummaging about the plate for a forkful
      const g = u - EAT_DIP;
      return fork(EAT_TIP_PLATE.clone().add(new THREE.Vector3(0.09*Math.sin(g*15), -0.03*Math.sin(g*9), 0.07*Math.cos(g*13))), EAT_DIR_PLATE);
    }
    if (u < EAT_DIP + EAT_GATHER + EAT_LIFT) return between(EAT_TIP_PLATE, EAT_DIR_PLATE, tipMouth, EAT_DIR_MOUTH, (u - EAT_DIP - EAT_GATHER)/EAT_LIFT);
    if (u < EAT_MOUTHFUL - EAT_LOWER) return fork(tipMouth, EAT_DIR_MOUTH);
    return between(tipMouth, EAT_DIR_MOUTH, EAT_TIP_REST, EAT_DIR_REST, (u - (EAT_MOUTHFUL - EAT_LOWER))/EAT_LOWER);
  }
  return fork(EAT_TIP_REST, EAT_DIR_REST); // between mouthfuls, the fork held over the plate
}
/**
 * What happens when over a loop of Eating: the fork touching down on the plate, a forkful gathered onto it, and the
 * mouthful taken off it (see eatingAt, and the taps people.js plays).
 * @param {number} duration - the loop's length in seconds
 * @returns {{time: number, cue: string}[]} each cue, in order
 */
function eatingCues(duration) {
  const gap = Math.max(0.3, (duration - EAT_FIRST - EAT_BITES*EAT_MOUTHFUL)/EAT_BITES);
  const cues = [];
  for (let k=0;k<EAT_BITES;k++) {
    const at = EAT_FIRST + k*(EAT_MOUTHFUL + gap);
    cues.push({ time: at + EAT_DIP, cue: 'clink' });
    cues.push({ time: at + EAT_DIP + EAT_GATHER*0.85, cue: 'forkful' });
    const bite = at + EAT_DIP + EAT_GATHER + EAT_LIFT + 0.1;
    cues.push({ time: bite, cue: 'bite' });
    cues.push({ time: bite + 0.5, cue: 'chew' });
    cues.push({ time: bite + 1.0, cue: 'chew' });
  }
  return cues;
}
/**
 * Repose a frame of Sit1 as a frame of Eating (see PERSON_CLIPS): the right arm holding a fork, everything else as it sits.
 * @param {number} frame - the frame, from 0
 * @param {number} frames - how many the loop is
 * @param {object} rig - the model's bones, by name, where they rest, where the mouth is, and a refresh (see buildPersonModel)
 * @param {boolean} [eating] - working through a meal, or false for the fork held still over the plate
 * @returns {?{time: number, cue: string}[]} the loop's cues, if eating
 */
function eatingPose(frame, frames, rig, eating = true) {
  const duration = frames/PERSON_BAKE_FPS, t = frame/PERSON_BAKE_FPS;
  const moved = eatingBones(rig);
  // (as in typingPose: put back any bone the last frame reposed and the clip hasn't moved since, so a turn isn't added twice)
  for (const bone of moved) {
    const was = bone.userData.repose;
    if (was && bone.position.equals(was.set.position) && bone.quaternion.equals(was.set.quaternion)) {
      bone.position.copy(was.from.position); bone.quaternion.copy(was.from.quaternion);
    }
    bone.userData.repose = { from: { position: bone.position.clone(), quaternion: bone.quaternion.clone() } };
  }
  rig.update();
  const fork = eating ? eatingAt(t, duration, rig.mouth()) : eatingAt(-1, duration, rig.mouth());
  const shoulder = rig.bone('ShoulderR'), elbow = rig.bone('ElbowR'), hand = rig.bone('HandR');
  if (!shoulder || !elbow || !hand) return null;
  // the fist on the fork's handle, which lies along the model's Y in the rest pose (HAND_GRIP)
  const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), fork.dir);
  const grip = fork.tip.clone().addScaledVector(fork.dir, -EAT_FORK);
  const wristTarget = grip.clone().sub(rig.grip('R').sub(rig.restAt('HandR')).applyQuaternion(turn));
  // the arm reaching it: the elbow bent out and down, where the two bones meet (as typingPose does it)
  const S = shoulder.getWorldPosition(new THREE.Vector3()), E = elbow.getWorldPosition(new THREE.Vector3()), W = hand.getWorldPosition(new THREE.Vector3());
  const upper = E.distanceTo(S), lower = W.distanceTo(E);
  const toTarget = wristTarget.clone().sub(S), reach = Math.min(toTarget.length(), (upper + lower)*0.999);
  const along = toTarget.normalize();
  const bend = new THREE.Vector3(-1, -0.4, -0.4);
  bend.addScaledVector(along, -bend.dot(along)).normalize();
  const a = (upper*upper - lower*lower + reach*reach)/(2*reach), h = Math.sqrt(Math.max(0, upper*upper - a*a));
  const elbowAt = S.clone().addScaledVector(along, a).addScaledVector(bend, h), wristAt = S.clone().addScaledVector(along, reach);
  reposeBone(shoulder, null, new THREE.Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), elbowAt.clone().sub(S).normalize()));
  reposeBone(elbow, elbowAt, new THREE.Quaternion().setFromUnitVectors(W.clone().sub(E).normalize(), wristAt.clone().sub(elbowAt).normalize()));
  // the hand turned onto the fork, whatever the arm did: the turn from the rest pose, over where the clip left it
  const want = turn.clone().multiply(rig.restTurn('HandR'));
  reposeBone(hand, wristAt, want.multiply(hand.getWorldQuaternion(new THREE.Quaternion()).invert()));
  // and its fingers closed round the handle
  const axes = { fingers: new THREE.Vector3(0, 1, 0).applyQuaternion(turn), thumb: new THREE.Vector3(1, 0, 0).applyQuaternion(turn) };
  for (const [name, angle, about] of GRIP_CURL) {
    const bone = rig.bone(name + 'R');
    if (bone) reposeBone(bone, null, new THREE.Quaternion().setFromAxisAngle(axes[about], angle));
  }
  for (const bone of moved) bone.userData.repose.set = { position: bone.position.clone(), quaternion: bone.quaternion.clone() };
  return eating ? eatingCues(duration) : null;
}
/** The bones eatingPose moves. */
const eatingBones = rig => ['Shoulder', 'Elbow', 'Hand', ...GRIP_CURL.map(([name]) => name)].map(name => rig.bone(name + 'R')).filter(Boolean);

export const FIDGETS = ['Idle2', 'Idle3'], GRASS_SITS = ['SitDown1', 'SitDown2', 'SitDown3'], LIE_DOWNS = ['LieDown1', 'LieDown2', 'LieDown3'];
/** Seconds to blend from one clip into the next: FADE_QUICK between walk, idle and wave; FADE_POSE into or out of sitting or lying. */
export const FADE_QUICK = 0.2, FADE_POSE = 0.6;
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
const PERSON_SLOTS = ['Skin', 'Top', 'Pants', 'Shoes', 'White', 'Black', 'Eyelashes', 'Lips',
  ...PERSON_CLOTHING.flatMap(c => Array.from({ length: c.count }, (_, k) => c.band + (k + 1)))];
const PERSON_FEMALE_ONLY = ['Eyelashes', 'Lips'];
// the colors each person has their own of, from row 2 of the traits texture on; then a row of where their clothes stop,
// and one of their head's and eyes' shape keys (Key 1, Key 2, Shape1, Shape2 — Shape3 being in row 1)
// ('Skin' starts as the model's own, and is there so a person's can be tinted: see peopleBlood.js)
// ('Blood' is how opaque the splotches drawn over them are — 0 for none — in its fourth number)
// ('Eyes' is what the whites of their eyes are, so they can be tinted: see updatePeople's eye reddening)
export const PERSON_TRAIT_COLORS = ['Top', 'Pants', 'Shoes', 'Hair', 'Hat', 'Skin', 'Blood', 'Eyes', 'Glasses'];
const SKIN_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Skin'), BLOOD_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('Blood');
const BLOOD_SCALE = 1.2; // how many splotches' worth of noise fit in a unit of the figure: bigger for smaller splotches
export const PERSON_CLOTHING_ROW = 2 + PERSON_TRAIT_COLORS.length, PERSON_FACE_ROW = PERSON_CLOTHING_ROW + 1;

/**
 * Work out who can wear a hairstyle, from the end of its name: 'Hair3_GB' girls and boys, 'Hair6_G' only girls.
 * @param {string} name - the style's name
 * @returns {{girls: boolean, boys: boolean}} who can wear it (everyone, with no suffix)
 */
const hairstyleWearers = name => {
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
export const BLINK_DURATION = 0.5; // seconds for the eyes to close and open again
// how far a person turns their head when they glance around: side to side, and up and down
export const LOOK_MAX_TURN = 50*Math.PI/180, LOOK_MAX_TILT = 15*Math.PI/180;
// the middle of a person's face, from where their head meets their neck, in the model's units
export const HEAD_CENTER = new THREE.Vector3(0, 0.3, 0.2);

const PERSON_VERTEX_PARS = `
  uniform sampler2D personBones;
  uniform vec2 personBonesSize;
  uniform sampler2D personMorphs;
  uniform float personMorphsWidth;
  uniform float personMorphsRows;
  uniform sampler2D personTraits;
  uniform float personHeadBone;
  uniform vec3 personHeadPivot;
  uniform float personChestBone;
  uniform vec3 personChestPivot;
  uniform int personHidden; // the person whose head is hidden (-1 for nobody)
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
  // the row's last texel, kept beside the bones and blended between rows and between clips just as a bone is.
  float personClipSpreadAt(float row) {
    vec2 texel = 1.0/personBonesSize;
    return textureLod(personBones, vec2(1.0 - 0.5*texel.x, (row + 0.5)*texel.y), 0.0).x;
  }
  float personClipSpread() {
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
  vec3 personLook(vec3 posed) {
    vec3 looked = posed;
    if (personVertex.x > 0.0 && (instanceLook.x != 0.0 || instanceLook.y != 0.0)) {
      mat4 head = personBone(personHeadBone);
      mat3 headTurn = mat3(head);
      vec3 pivot = (head*vec4(personHeadPivot, 1.0)).xyz, p = inverse(headTurn)*(posed - pivot);
      float ct = cos(instanceLook.x), st = sin(instanceLook.x), cn = cos(instanceLook.y), sn = sin(instanceLook.y);
      p = vec3(p.x, p.y*cn - p.z*sn, p.y*sn + p.z*cn);
      p = vec3(p.x*ct + p.z*st, p.y, p.z*ct - p.x*st);
      looked = mix(posed, pivot + headTurn*p, personVertex.x);
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
    if ((mask & 2) != 0) offset += personMorph(${shapeKey('Blink')})*instanceAnim.w;
    if ((mask & 4) != 0) offset += personMorph(${shapeKey('Talk')})*instanceLook.z + personMorph(${shapeKey('Emotion')})*instanceLook.w;
    if ((mask & 24) != 0) {
      vec4 face = personTrait(${PERSON_FACE_ROW});
      if ((mask & 8) != 0) offset += personMorph(${shapeKey('Key 1')})*face.x + personMorph(${shapeKey('Key 2')})*face.y;
      if ((mask & 16) != 0) offset += personMorph(${shapeKey('Shape1')})*face.z + personMorph(${shapeKey('Shape2')})*face.w + personMorph(${shapeKey('Shape3')})*personTrait(1).z;
    }
    // instanceEyes: how shocked, happy, angry and sad their eyes look
    if ((mask & 32) != 0) offset += personMorph(${shapeKey('Shock')})*instanceEyes.x + personMorph(${shapeKey('Happy')})*instanceEyes.y + personMorph(${shapeKey('Angry')})*instanceEyes.z + personMorph(${shapeKey('Sad')})*instanceEyes.w;
    return offset;
  }
  // Moves the arms out from the sides of a heavy or broad person, so their hands don't swing through their hips.
  //
  // Everything from the shoulder down (personVertex.x, negative) moves out along the way the chest faces, by how far the
  // Weight and Shoulders shape keys widen the body. Applied after posing, since the shape keys and bones leave the arms
  // where a slight person's are. A pose that reaches for something in front of them holds the arms in (personClipSpread),
  // so a wide person's hand lands where a slight one's does.
  vec3 personArms(vec3 posed, float restX) {
    float spread = max(-personVertex.x, 0.0)*personClipSpread()*(personTrait(0).w*${PERSON_ARM_SPREAD.Weight.toFixed(3)} + personTrait(1).w*${PERSON_ARM_SPREAD.Shoulders.toFixed(3)});
    if (spread <= 0.0) return posed;
    vec3 sideways = normalize(mat3(personBone(personChestBone))*vec3(1.0, 0.0, 0.0));
    return posed + sideways*(restX < 0.0 ? -spread : spread);
  }
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

/**
 * Add the posing and shape keys to a material's shaders, and how it colors the figure.
 *
 * `look.femaleOnly` gives the slots only drawn for women; and, unless it's the shadow's depth material, `look.palette`
 * (each slot's own color), `look.traitColors` (the slots taking a color of the person's own instead, as
 * { slot: traits row }), `look.bloodSlots` (the slots blood splotches are drawn over — and, with `look.bloodOnBands`, the bands of clothes where they show skin) and `look.bands` (bands of clothes, which show skin — that person's own — if the person's clothes
 * stop at or before them: { slot, number, cut (which of the clothing row's values says where their clothes stop),
 * colorRow (the traits row of the clothes' color) }).
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
  // (not from the shadow's depth material, so the body still casts one) whoever personHidden names is drawn headless: their head
  // and hair drawn into a point at the middle of their chest, inside their shirt
  const splotched = colored && (look.bloodSlots || []).length > 0;
  const hideHead = colored ? 'if (personIndex() == personHidden && personVertex.x > 0.0) transformed = (personBone(personChestBone)*vec4(personChestPivot, 1.0)).xyz;' : '';
  const bands = (look.bands || []).map(b => `personSlotIndex == ${b.slot} ? (${b.number}.0 >= personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? personTrait(${SKIN_ROW}).rgb : personTrait(${b.colorRow}).rgb) : `).join('');
  // (blood is drawn over the slots it's asked for, and over a band of clothes only where it shows skin)
  const bloodAmount = `personTrait(${BLOOD_ROW}).w`;
  const bloodOver = !splotched ? '' : (look.bloodOnBands ? (look.bands || []).map(b => `personSlotIndex == ${b.slot} ? (${b.number}.0 >= personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? ${bloodAmount} : 0.0) : `).join('') : '')
    + `(${look.bloodSlots.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) ? ${bloodAmount} : 0.0`;
  const color = colored
    ? 'vPersonColor = ' + bands + Object.entries(look.traitColors).map(([slot, row]) => `personSlotIndex == ${slot} ? personTrait(${row}).rgb : `).join('') + 'personPalette[personSlotIndex];' : '';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PERSON_VERTEX_PARS
      + (colored ? `uniform vec3 personPalette[${look.palette.length}];\nvarying vec3 vPersonColor;` : '')
      + (splotched ? '\nvarying vec2 vPersonBlood;\nvarying vec3 vPersonRest;' : ''))
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      ${splotched ? 'vPersonRest = transformed;' : ''}
      transformed = personArms(personLook((personSkinMatrix()*vec4(transformed + personShape(), 1.0)).xyz), transformed.x);
      int personSlotIndex = int(personVertex.y + 0.5);
      // for a man, the parts only drawn for women are folded away to a point
      ${hide}
      ${hideHead}
      ${color}
      ${splotched ? `vPersonBlood = vec2(${bloodOver}, float(personIndex()));` : ''}`);
  if (!colored) return;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPersonColor;' + (splotched ? '\nvarying vec2 vPersonBlood;\nvarying vec3 vPersonRest;\nuniform vec3 personBloodColor;' + BLOOD_GLSL : ''))
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vPersonColor;' + (splotched ? BLOOD_SPLOTCHES : ''));
}

/**
 * Make an instanced mesh of `geometry` drawn with `look` (see injectPersonShader), with shadows that take the pose too.
 * @param {THREE.BufferGeometry} geometry - the posed-figure geometry
 * @param {Object<string, {value: *}>} uniforms - the person uniforms (see buildPersonModel)
 * @param {object} look - what the material draws and how it colors it
 * @param {number} capacity - how many instances to make room for
 * @param {boolean} byAttribute - whether the instances say which person they are (instancePerson) rather than being them in order
 * @returns {THREE.InstancedMesh} the mesh, added to the scene
 */
function makePersonMesh(geometry, uniforms, look, capacity, byAttribute) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide, flatShading: true });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (byAttribute) { material.defines = { PERSON_INDEX_ATTRIBUTE: '' }; depth.defines = { PERSON_INDEX_ATTRIBUTE: '' }; }
  // three.js reuses a compiled shader for materials whose onBeforeCompile reads the same, so a look of its own needs a key of its own
  const key = ['person', byAttribute, look.palette.length, JSON.stringify(look.traitColors), (look.bloodSlots || []).join(','), !!look.bloodOnBands, JSON.stringify(look.bands || []), look.femaleOnly.join(',')].join('|');
  material.onBeforeCompile = shader => injectPersonShader(shader, uniforms, look);
  material.customProgramCacheKey = () => key;
  depth.onBeforeCompile = shader => injectPersonShader(shader, uniforms, { femaleOnly: look.femaleOnly });
  depth.customProgramCacheKey = () => key + '|depth';
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.customDepthMaterial = depth;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(HEADSHOT_LAYER);
  mesh.visible = false;
  mesh.name = 'People';
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
 * Load the people, hair and facial-hair models and build the instanced meshes from them. The body failing leaves people
 * as cuboids; hair or facial hair failing only leaves people without them.
 * @returns {Promise<void>}
 */
export async function loadPersonModel() {
  const [body, hair, facialHair, glasses] = await Promise.allSettled([loadGLB(PERSON_MODEL_URL), loadGLB(HAIR_MODEL_URL), loadGLB(FACIAL_HAIR_MODEL_URL), loadGLB(GLASSES_MODEL_URL)]);
  if (body.status === 'rejected') { console.warn('Blockout: the people model failed to load; people stay cuboids', body.reason); return; }
  if (hair.status === 'rejected') console.warn('Blockout: the hair model failed to load; people go without', hair.reason);
  if (facialHair.status === 'rejected') console.warn('Blockout: the facial hair model failed to load; people go without', facialHair.reason);
  if (glasses.status === 'rejected') console.warn('Blockout: the glasses model failed to load; people go without', glasses.reason);
  const loaded = result => result.status === 'fulfilled' ? result.value : null;
  try {
    setPersonModel(buildPersonModel(body.value, loaded(hair), loaded(facialHair), loaded(glasses)));
    peopleMesh.visible = false;
  } catch (err) {
    console.warn('Blockout: the people model failed to load; people stay cuboids', err);
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
 * @returns {PersonModel} the meshes and everything the shader and the update loop need
 */
function buildPersonModel(gltf, hairGltf, facialHairGltf, glassesGltf) {
  const root = gltf.scene;
  const rigged = [], attached = [];
  root.traverse(o => { if (o.isSkinnedMesh) rigged.push(o); else if (o.isMesh) attached.push(o); });
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

  // ============== BODY POSE ============== 
  // Below defines the body in the rest pose, as one mesh: each part's vertices, the bones moving them, which part they are, and
  // every shape key's offsets.
  //
  // A mesh riding on a bone rather than rigged (the head) moves with that bone alone. A mesh that is only one side of
  // the body (an unapplied Blender Mirror modifier) is mirrored across X onto the other side's bones.
  const positions = [], joints = [], weights = [], headWeights = [], armWeights = [], slots = [], indices = [];
  const offsets = PERSON_SHAPE_KEYS.map(() => []);
  const toModel = new THREE.Matrix4(), toModelLinear = new THREE.Matrix3(), v = new THREE.Vector3();
  const palette = PERSON_SLOTS.map(() => new THREE.Color(0xffffff));
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
        keyTargets.forEach((target, key) => {
          if (target) v.set(target.getX(i)*side, target.getY(i), target.getZ(i)).applyMatrix3(toModelLinear); else v.set(0, 0, 0);
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

  // ---- the shape key texture: a block of rows per shape key, a texel per vertex, holding its offsets
  const morphWidth = Math.min(vertexCount, 1024), morphRows = Math.ceil(vertexCount/morphWidth);
  const morphData = new Float32Array(morphWidth*morphRows*PERSON_SHAPE_KEYS.length*4);
  const morphMask = new Float32Array(vertexCount);
  PERSON_SHAPE_KEYS.forEach((key, k) => {
    const keyOffsets = offsets[k], bit = PERSON_SHAPE_KEY_BITS[k];
    for (let i=0;i<vertexCount;i++) {
      const texel = (k*morphRows*morphWidth + i)*4;
      for (let c=0;c<3;c++) morphData[texel + c] = keyOffsets[i*3 + c];
      if (Math.abs(keyOffsets[i*3]) + Math.abs(keyOffsets[i*3+1]) + Math.abs(keyOffsets[i*3+2]) > 1e-6) morphMask[i] = morphMask[i] | bit;
    }
  });
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
    const source = def.from || def.over || def.name;
    const clip = gltf.animations.find(c => c.name.toLowerCase() === source.toLowerCase());
    if (!clip && !def.from && !def.over) console.warn(`Blockout: the people model has no ${def.name} animation`);
    const sourceFrames = clip ? Math.max(1, Math.round(clip.duration*PERSON_BAKE_FPS)) : 1;
    const frames = def.from ? 1 : sourceFrames*(def.times || 1);
    return { name: def.name, clip, missing: !clip, loop: !!def.loop && frames > 1, pose: !!def.pose, frames, duration: frames/PERSON_BAKE_FPS,
      sourceFrames, repose: clip ? def.repose : null, taps: null, spread: def.spread ?? 1,
      holdAt: def.from ? (sourceFrames - 1)/PERSON_BAKE_FPS : null,
      start: 0, pelvis: new THREE.Vector3(), pelvisX: 0, pelvisZ: 0, top: 0, heightScale: 1, seatY: 0 };
  });
  let boneRows = 0;
  clips.forEach(c => { c.start = boneRows; boneRows += c.frames + 1; });
  const restMatrix = name => new THREE.Matrix4().copy(skeleton.boneInverses[boneByName.get(name) ?? 0]).invert();
  const rig = { bone: name => bones[boneByName.get(name)], update: () => root.updateMatrixWorld(true),
    mouth: () => headBone != null ? bones[headBone].localToWorld(mouthLocal.clone()) : mouthRest.clone(),
    grip: side => gripRest[side].clone(), metre: unitsPerMetre,
    restAt: name => new THREE.Vector3().setFromMatrixPosition(restMatrix(name)),
    restTurn: name => new THREE.Quaternion().setFromRotationMatrix(restMatrix(name)) };
  // three texels a bone for its pose, and one on the end of the row for the clip's arm spread (personClipSpread)
  const boneWidth = bones.length*3 + 1, boneData = new Float32Array(boneWidth*boneRows*4), pose = new THREE.Matrix4();
  // how far a foot travels over the walk, for how far a cycle of it carries a person
  const footBone = bones[boneByName.get('FootL') ?? boneByName.get('FootR') ?? 0], footPosition = new THREE.Vector3();
  let footMinZ = Infinity, footMaxZ = -Infinity;
  clips.forEach(c => {
    mixer.stopAllAction();
    const action = c.clip ? mixer.clipAction(c.clip).play() : null;
    for (let f=0;f<=c.frames;f++) {
      if (action) mixer.setTime(c.holdAt ?? (f % c.sourceFrames)/PERSON_BAKE_FPS); else skeleton.pose();
      root.updateMatrixWorld(true);
      if (c.repose) { c.taps = c.repose(f % c.frames, c.frames, rig); root.updateMatrixWorld(true); }
      bones.forEach((bone, b) => {
        const e = pose.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]).elements;
        for (let r=0;r<3;r++) {
          const o = ((c.start + f)*boneWidth + b*3 + r)*4;
          boneData[o] = e[r]; boneData[o+1] = e[4+r]; boneData[o+2] = e[8+r]; boneData[o+3] = e[12+r];
        }
      });
      boneData[((c.start + f)*boneWidth + bones.length*3)*4] = c.spread;
      if (c.name === 'Walk' && action) { footBone.getWorldPosition(footPosition); footMinZ = Math.min(footMinZ, footPosition.z); footMaxZ = Math.max(footMaxZ, footPosition.z); }
      if (f === 0) pelvisBone.getWorldPosition(c.pelvis);
    }
  });
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
  const standingTop = clips.find(c => c.name === 'Idle').top;
  clips.forEach(c => { c.heightScale = standingTop > 0 ? c.top/standingTop : 1; });
  // half floats, which (unlike full floats, everywhere) the texture can blend between rows
  const boneTexture = new THREE.DataTexture(Uint16Array.from(boneData, x => THREE.DataUtils.toHalfFloat(x)), boneWidth, boneRows, THREE.RGBAFormat, THREE.HalfFloatType);
  boneTexture.magFilter = boneTexture.minFilter = THREE.LinearFilter;
  boneTexture.needsUpdate = true;

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
      const parts = [];
      style.traverse(o => { if (o.isMesh) parts.push(o); });
      if (!parts.length) return;
      const hairParts = parts.filter(part => !isHatMaterial(part.material.name));
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
      styles.push({ name: style.name, ...wearers(style.name), geometry: styleGeometry, mesh: null, anim: null, look: null, members: [] });
    });
    styleGltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return styles;
  };
  // Each layer of what's worn on the head: its styles, and for each person which style they wear (-1 for none) and where
  // they are among its wearers. Women always wear a hairstyle, men can be bald; a layer with a `chance` is worn by that
  // many of those who can, whoever they are. `hair` is whether it's colored as their hair.
  const headLayer = (styles, rng, { chance = null, hair = true } = {}) => ({ styles, rng, chance, hair, of: new Int16Array(PEOPLE_MAX).fill(-1), slot: new Int32Array(PEOPLE_MAX),
    girls: styles.map((style, k) => style.girls ? k : -1).filter(k => k >= 0), boys: styles.map((style, k) => style.boys ? k : -1).filter(k => k >= 0) });
  const hairLayer = headLayer(headStylesFrom(hairGltf, hairstyleWearers), mulberry32(31337));
  const facialHairLayer = headLayer(headStylesFrom(facialHairGltf, () => ({ girls: false, boys: true })), mulberry32(4711));
  const glassesLayer = headLayer(headStylesFrom(glassesGltf, () => ({ girls: true, boys: true })), mulberry32(2020), { chance: GLASSES_CHANCE, hair: false });
  const headLayers = [hairLayer, facialHairLayer, glassesLayer];

  // ============== Body Traits ==============
  // Sex, and which hairstyle and facial hair (if any) someone wears, are fixed to the render slot itself, decided once
  // here — a hairstyle is instanced from a fixed-size buffer of its wearers' slots, built once, so a slot can't switch
  // hairstyle without that buffer being rebuilt. Everything else about how someone looks — body shape, face shape,
  // colors (clothes, hair, skin, eyes, hat), and where their clothes stop — is seeded from their person id instead (see
  // assignAppearance below), so when someone dies and someone new takes their slot (see updatePeople in people.js),
  // the new arrival gets their own build, face and colors rather than a repeat of whoever was there before.
  const traitRows = PERSON_FACE_ROW + 1, traits = new Float32Array(PEOPLE_MAX*traitRows*4);
  const isMan = new Uint8Array(PEOPLE_MAX);
  const NATURAL_COLOUR_CHANCE = 0.85;
  const sexRng = mulberry32(777);
  for (let i=0;i<PEOPLE_MAX;i++) {
    const man = sexRng() < 0.5;
    isMan[i] = man ? 1 : 0;
    headLayers.forEach(layer => {
      const styles = man ? layer.boys : layer.girls;
      if (!styles.length) return;
      const pick = layer.chance != null ? (layer.rng() < layer.chance ? Math.floor(layer.rng()*styles.length) : styles.length)
        : Math.floor(layer.rng()*(man ? styles.length + 1 : styles.length));
      if (pick >= styles.length) return;
      const members = layer.styles[styles[pick]].members;
      layer.of[i] = styles[pick];
      layer.slot[i] = members.length;
      members.push(i);
    });
  }

  /**
   * Where someone's clothes stop (see clothingBand), from their id and sex: a woman's midriff depends on her age,
   * which comes from people.txt, so callers work this out again whenever that loads (see below).
   * @param {number} id - their person id
   * @param {boolean} man - their sex
   * @returns {number[]} one band per entry in PERSON_CLOTHING, for the clothing texel row
   */
  const clothingRowFor = (id, man) => {
    const clothingRng = mulberry32(1990 + id*7919), { age } = profileOf(id, man);
    return PERSON_CLOTHING.map(c => clothingBand(c, clothingRng(), man, age));
  };

  const traitTexture = new THREE.DataTexture(traits, PEOPLE_MAX, traitRows, THREE.RGBAFormat, THREE.FloatType);
  traitTexture.needsUpdate = true;

  /**
   * Write one person's body shape, face shape, colors and clothing into the traits texture, from their id — not their
   * slot, since two different ids taking the same slot one after another should look nothing alike. Their sex and
   * hairstyle are left alone: those are fixed to the slot above. Called whenever someone is born into a slot (see
   * newPerson and updatePeople in people.js).
   * @param {number} i - their place in the crowd: the slot to write into
   * @param {number} id - their person id: what everything here is seeded from
   * @returns {void}
   */
  function assignAppearance(i, id) {
    const man = isMan[i] === 1, ranges = man ? PERSON_BODY_SHAPES.male : PERSON_BODY_SHAPES.female;
    const texel = row => (row*PEOPLE_MAX + i)*4;
    const traitRng = mulberry32(777 + id*7919), faceRng = mulberry32(2718 + id*7919);
    const colorRng = mulberry32(4242 + id*7919), hatRng = mulberry32(8086 + id*7919), glassesRng = mulberry32(6060 + id*7919), color = new THREE.Color();
    const colorFor = {
      Top: () => colorRng() < 0.22 ? color.setHSL(0, 0, [0.1, 0.3, 0.55, 0.88][Math.floor(colorRng()*4)]) : color.setHSL(colorRng(), 0.35 + colorRng()*0.45, 0.35 + colorRng()*0.3),
      Pants: () => colorRng() < 0.8 ? color.set(PANTS_COLORS[Math.floor(colorRng()*PANTS_COLORS.length)]) : color.setHSL(colorRng(), 0.25 + colorRng()*0.3, 0.25 + colorRng()*0.25),
      Shoes: () => colorRng() < 0.7 ? color.set(SHOE_COLORS[Math.floor(colorRng()*SHOE_COLORS.length)]) : color.setHSL(colorRng(), 0.4 + colorRng()*0.45, 0.35 + colorRng()*0.25),
      // three in four have a natural hair color; the rest have dyed it something bright
      Hair: () => colorRng() < NATURAL_COLOUR_CHANCE ? color.set(HAIR_TONES[Math.floor(colorRng()*HAIR_TONES.length)]).multiplyScalar(0.9 + colorRng()*0.2) : color.setHSL(colorRng(), 0.65 + colorRng()*0.3, 0.45 + colorRng()*0.15),
      Skin: () => color.copy(palette[0]),
      Eyes: () => color.copy(palette[PERSON_SLOTS.indexOf('White')]),
      Blood: () => color.setRGB(0, 0, 0), // (only its fourth number, the opacity, is read: see BLOOD_GLSL)
      // its own generator, so adding it didn't change anyone's other colors
      Hat: () => hatRng() < 0.25 ? color.setHSL(0, 0, [0.08, 0.3, 0.6, 0.9][Math.floor(hatRng()*4)]) : color.setHSL(hatRng(), 0.4 + hatRng()*0.5, 0.3 + hatRng()*0.35),
      // mostly black or tortoiseshell brown, some wire-grey, a few loud
      Glasses: () => { const r = glassesRng(); return r < 0.8 ? color.set(GLASSES_COLORS[Math.floor(glassesRng()*GLASSES_COLORS.length)]) : color.setHSL(glassesRng(), 0.6 + glassesRng()*0.3, 0.4 + glassesRng()*0.15); },
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
    traits.set(clothingRowFor(id, man), texel(PERSON_CLOTHING_ROW));
    traitTexture.needsUpdate = true;
  }
  // whoever's already in the crowd when the model finishes loading has been walking round as a cuboid till now: fill
  // in their looks. Everyone born after this just gets them as they arrive (see updatePeople in people.js).
  people.forEach((p, i) => assignAppearance(i, p.id));
  // a woman's clothes depend on her age, which comes from people.txt: whenever that (re)loads, work out everyone's
  // clothing again, without touching the rest of how they look
  onProfilesLoaded(() => {
    people.forEach((p, i) => { traits.set(clothingRowFor(p.id, isMan[i] === 1), (PERSON_CLOTHING_ROW*PEOPLE_MAX + i)*4); });
    traitTexture.needsUpdate = true;
  });

  // ============== Meshes  ============== 
  const uniforms = {
    personBones: { value: boneTexture }, personBonesSize: { value: new THREE.Vector2(boneWidth, boneRows) },
    personMorphs: { value: morphTexture }, personMorphsWidth: { value: morphWidth }, personMorphsRows: { value: morphRows },
    personTraits: { value: traitTexture }, personHidden: { value: -1 }, personBloodColor: { value: new THREE.Color(0.55, 0.05, 0.05) },
    personHeadBone: { value: headBone ?? 0 }, personHeadPivot: { value: headPivot }, personChestBone: { value: chestBone }, personChestPivot: { value: chestPivot },
  };
  const traitRow = part => 2 + PERSON_TRAIT_COLORS.indexOf(part);
  const bodyLook = {
    palette,
    traitColors: Object.fromEntries([['Skin', 'Skin'], ['Top', 'Top'], ['Pants', 'Pants'], ['Shoes', 'Shoes'], ['White', 'Eyes']].map(([slot, part]) => [PERSON_SLOTS.indexOf(slot), traitRow(part)])),
    femaleOnly: PERSON_FEMALE_ONLY.map(part => PERSON_SLOTS.indexOf(part)),
    bloodSlots: [PERSON_SLOTS.indexOf('Skin')], bloodOnBands: true,
    bands: PERSON_CLOTHING.flatMap((c, cut) => Array.from({ length: c.count }, (_, k) =>
      ({ slot: PERSON_SLOTS.indexOf(c.band + (k + 1)), number: k + 1, cut, colorRow: traitRow(c.part) }))),
  };
  const anim = dynamicInstanceAttribute(PEOPLE_MAX, 4), look = dynamicInstanceAttribute(PEOPLE_MAX, 4), eyes = dynamicInstanceAttribute(PEOPLE_MAX, 4);
  geometry.setAttribute('instanceAnim', anim);
  geometry.setAttribute('instanceLook', look);
  geometry.setAttribute('instanceEyes', eyes);
  const mesh = makePersonMesh(geometry, uniforms, bodyLook, PEOPLE_MAX, false);
  const hairLook = { palette: hairPalette, traitColors: { 0: traitRow('Hair'), 1: traitRow('Hat') }, femaleOnly: [] };
  const glassesLook = { palette: hairPalette, traitColors: { 0: traitRow('Glasses') }, femaleOnly: [] };
  headLayers.flatMap(layer => layer.styles.map(style => [style, layer.hair ? hairLook : glassesLook])).forEach(([style, look]) => {
    if (!style.members.length) { style.geometry.dispose(); return; }
    style.geometry.setAttribute('instancePerson', new THREE.InstancedBufferAttribute(Float32Array.from(style.members), 1));
    style.anim = dynamicInstanceAttribute(style.members.length, 4);
    style.look = dynamicInstanceAttribute(style.members.length, 4);
    style.eyes = dynamicInstanceAttribute(style.members.length, 4);
    style.geometry.setAttribute('instanceAnim', style.anim);
    style.geometry.setAttribute('instanceLook', style.look);
    style.geometry.setAttribute('instanceEyes', style.eyes);
    style.mesh = makePersonMesh(style.geometry, uniforms, look, style.members.length, true);
  });
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });

  const box = geometry.boundingBox;
  const footTravel = footMaxZ > footMinZ ? footMaxZ - footMinZ : (box.max.y - box.min.y)*0.3;
  // the model faces along +Z, as people do
  return { mesh, hidden: uniforms.personHidden, anim, look, eyes, hair: headLayers.flatMap(layer => layer.styles).filter(style => style.mesh), headLayers, isMan, boneData, boneWidth, traitData: traits, traitTexture, palette, assignAppearance,
    headBone: headBone ?? 0, headPivot, chestBone, hands, unitsPerMetre,
    height: box.max.y - box.min.y, minY: box.min.y, clips: Object.fromEntries(clips.map(c => [c.name, c])), stride: footTravel*WALK_CYCLE_LENGTH };
}

