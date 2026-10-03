import { App, S, worldNow } from '../../core/shared.js';
import { crowdGrid, mulberry32 } from '../../core/math.js';
import { buildingLabelName } from '../../buildings/building-types.js';
import { isInsideBuilding, roomCovers, roomHolds, roomVisit } from '../../buildings/interior.js';
import * as THREE from 'three';
import { scene, camera } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { blastFx, explode } from '../giblets.js';
import { blasts, PERSON_BLAST_SCALE } from '../traffic/state.js';
import { canRespawn, PERSON_SHAKE, shake } from '../revive.js';
import { throwBodyParts, warmBodyParts } from './peopleGibs.js';
import { babble, nextSyllable, hearDistance } from '../../audio/voices.js';
import { accentFor, accentVoice } from '../../audio/accents.js';
import { sayLine, shoutLine, reactAloud, lineMouth, stopLine, linePause, aaa } from '../../audio/dictionary.js';
import { pickThought, pickReaction } from '../speech-text.js';
import { babbleLine, hasBubble, ownLine, speechBubble } from '../../ui/speech-bubbles.js';
import { footstep } from '../../audio/footsteps.js';
import { ear } from '../../audio/sfx.js';
import { headphoneMusic, stopHeadphoneMusic, HEADPHONE_REACH } from '../../audio/pub-music.js';
import { keyClick } from '../../audio/typing.js';
import { mealCue, snackClip, snackClipName, updateHeld } from './peopleHolding.js';
import { mirrorCrowd } from './peopleMirror.js';
import { controlInput, possession, rushed } from '../possession.js';
import { DEFAULT_TRAITS, profileOf, profilesVersion, registerPreset } from '../profiles.js';
import { presetAt } from './presets.js';
import { SPECTRAL, BALD_BIT, VANISHED_BIT } from './peopleSpirits.js';
import { TWIN_GAP, TWIN_LOOK_ROW, SPIRIT_ANIM_ROW } from './peopleModel.js';
import { updateSpiritChat, twinBubble } from './peopleSpiritChat.js';
import { updateMinis, miniSpot } from './peopleMinis.js';
import { BLINK_DURATION, FADE_POSE, FADE_QUICK, FADE_SNACK, FIDGETS, GOOFY_ROW, HAIR_ROW, SPIRITS_ROW, GRASS_SITS, LOOK_MAX_TILT, LOOK_MAX_TURN, PERSON_BAKE_FPS, SKEPTICAL_ROW, WELLING_ROW, PERSON_FACE_PIXELS, PERSON_TRAIT_COLORS, PERSON_WORN_PIXELS, PUPIL_MAX_X, PUPIL_MAX_Y, personPixels } from './peopleModel.js';
import { navRebuildOnHold } from '../../roads/roads.js';
import { getTrainStations } from '../../trains/trains.js';
import { closestPointOnSegment } from '../../buildings/footprints.js';
import { MELODIES } from '../../audio/melodies.js';
import { favoritePeople, isFavoritePerson } from '../../ui/favorites.js';
import { nextKept, takeKept, takeReset } from './peopleKeep.js';
import { registerHealthKind } from '../../core/health.js';
import { relateFelt, relateSaw, pruneGone } from './peopleRelations.js';
import { logLine, forgetLinesExcept } from './peopleSaid.js';
import { CROSS_SPEED_MULT, ROADSAFETY_RADIUS, buildPeopleNav, joinWalkway, maybeCrossRoad, rebuildPeopleNavDebug, reseatPerson, spawnPerson, updateCrossing, walkAlong, walkwayPoint } from './peoplePathing.js';
import { hidingFromSun, leaveGroup, outOfTime, shelteringFromRain, vanishIndoors } from './peopleActivities.js';
import { PUNCH_CHASE_SPEED, WALK_PACE, awaited, besideLeader, setAwaited, endActivity, goChat, goLieDown, goRideTrain, goSit, knockOver, knockAgain, holdDown, landFall, meetOnWalkways, pickFights, showInhabitants, showPassengers, stationLinks, updateActivity, updateAttack, updateSwat, updateGroups, updateIndoors, updatePunched, updateTrainRider } from './peopleActivities.js';
import { holdDrowned, inWater, turnInWater, updateWater, wouldWade, onWater } from './peopleWater.js';
import { turnCrawling } from './peopleRoad.js';
import { drinking, goBuy, hasStallIn, maybeBuyOnWalkway, updateBuying } from './peopleStalls.js';
import { sway, updateDrunk } from './peopleDrunk.js';
import { avoidSmells, updateFlies } from './peopleSmell.js';
import { keepOutOfWindows } from './peopleWindows.js';
import { updateStatusEffects, restackTraits } from '../statuseffects.js';
import { stockPockets } from '../gifts.js';
import { dropCoins } from '../coins.js';
import { bloodBurst, bloodFear, bloodSpeed, bloodlustSpeed, isBloodlusting, updateArrivingBlood, updateBlood } from './peopleBlood.js';
import { slideOff, stepFall } from './peopleFall.js';
import { updateErratic } from './peopleErratic.js';
import { aimPrayerView, prayerDue, prayerViewing, sweepPrayers, updatePrayer } from './peoplePrayer.js';
import { beginEmotes, updateEmotes } from './peopleEmotes.js';
import { stillLoading } from '../../ui/loading.js';
import { followPersonAt, followPerson, followPersonInside, followedInside, headshotOf, personHeight, pickPerson, placePossessedCamera, possessPerson, punchFromPossession, updatePossessedTarget, useFromPossession, stopFollowingPerson, unpossessPerson, updateSwing, walkPossessed, cancelSwing, showFollowedDoing } from './peopleTracking.js';
export { loadPersonModel } from './peopleModel.js';

// The shapes these modules pass around — Person, NavLine, NavVertex, Hangout, PersonModel, Segment and SegmentHit —
// are declared in peopleTypes.js. That file is deliberately not a module, so its typedefs are global and every file
// in here can name them in JSDoc without importing anything.


export const PEOPLE_MAX = 2000;
export const PERSON_WALK_SPEED = 1.4;   // world units per second at speed 1
/** Moonwalkers (the backwards trait) face the way they're going, the walk played in reverse — or, false, face away and step backwards. */
export const MOONWALK_FACING_FORWARD = true;
/** How far a moonwalker faces round from the way they're going. */
export const moonwalkTurn = p => p.traits.backwards && !MOONWALK_FACING_FORWARD ? Math.PI : 0;
/** Bringing something up to their mouth: a snack, a drink, a cig, or a forkful (see eatingCues), so the head faces front. */
const toMouth = p => p.snack?.up > 0 || !!p.clipA?.taps?.some(t => t.up && (p.idleTime % p.clipA.duration - t.up[0] + p.clipA.duration) % p.clipA.duration < t.up[1] - t.up[0]);
/** How often, at least, the walkways are resampled to a point — for entrances and for re-seating people. */
export const PEOPLE_NAV_SPACING = 4;
S.peopleEnabled = false, S.peopleAmount = 300, S.peopleSpeed = 1, S.peopleSize = 1, S.showRoadsafetyDebug = false, S.showPeopleNavDebug = false, S.peopleFrozen = null;
// Everyone's permanent identity — who they are, not where they're standing. Their place in the crowd (their index in
// `people`) is just whichever render slot they're currently using, and gets reused once they're gone; their id (see
// peopleIdSeq, same convention as roadNodeSeq and the other counters in core/state.js) is what their name, age, traits
// and looks are seeded from instead (see refreshTraits below and assignAppearance in peopleModel.js), so someone new
// moving into a dead person's old slot doesn't raise them from the dead. Kept in the project (see project/save-load.js),
// so ids never collide across a reload.
S.peopleIdSeq = 1;
export let peopleNav = null, peopleNavBuiltAt = -Infinity, peopleNavDebugBuiltAt = -Infinity, lastPeopleTime = null;
export const people = [];
export const peopleRng = mulberry32(90210);
/** The camera layer the people (and the lights) are also on, for the person card's headshot to draw them alone. */
export const HEADSHOT_LAYER = 3;
export let personModel = null; // { mesh, anim, look, hair, wornLayers, isMan, height, minY, clips, stride } once loaded
/**
 * Pick one of `items` at random, weighted.
 * @param {Array<*>} items - what to pick from
 * @param {function(*): number} weightOf - how much each item weighs
 * @returns {number} the index of the one picked
 */
export function pickWeighted(items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let r = peopleRng()*total;
  for (let i=0;i<items.length;i++) { r -= weightOf(items[i]); if (r <= 0) return i; }
  return items.length - 1;
}

/**
 * Work out how far along the straight walk from `from` to (x, z) someone gets while staying in the hangout, and whether
 * that's all the way. Water is no part of a hangout (see buildPeopleNav), and people walk straight at where they're
 * going, so this is what keeps them out of a pond: they stop at the bank and set off again from there.
 * Setting off from off it (strayed down a beach's slope, say), the first BACK_ON_REACH back onto it is walkable.
 * @param {Hangout} area - the hangout they're walking in
 * @param {{x: number, z: number}} from - where they're setting off
 * @param {number} x - where they're heading
 * @param {number} z
 * @returns {{x: number, z: number, d: number, clear: boolean}} as far as they get, how far that is, and whether it's the whole way
 */
/** The hangout's ground for someone: waterwalking/aqua people walk its water too (area.insideWet, see buildPeopleNav). */
export const insideFor = (area, who) => who?.traits && onWater(who) ? area.insideWet : area.inside;

/** How far someone who's strayed off their hangout's ground (down a beach's slope, say) may walk to get back onto it. */
const BACK_ON_REACH = 6;
export function walkableUpTo(area, from, x, z) {
  const inside = insideFor(area, from), dx = x - from.x, dz = z - from.z, len = Math.hypot(dx, dz), steps = Math.max(1, Math.ceil(len/1.5));
  let last = 0, off = !inside(from.x, from.z); // (off it, the first stretch back onto it doesn't count against them: else nowhere is ever clear, and they stand there for good)
  for (let k=1;k<=steps;k++) {
    const frac = k/steps;
    if (inside(from.x + dx*frac, from.z + dz*frac)) { off = false; last = frac; }
    else if (!off || len*frac > BACK_ON_REACH) return { x: from.x + dx*last, z: from.z + dz*last, d: len*last, clear: false };
  }
  return { x, z, d: len, clear: true };
}

/**
 * Work out where someone should actually head for a spot they've picked out in their hangout.
 * @param {Hangout} area - the hangout
 * @param {{x: number, z: number}} from - where they're setting off
 * @param {number} x - the spot they picked
 * @param {number} z
 * @returns {?{x: number, z: number}} the spot itself when the walk there is clear, else as far along the way as they get
 * before the water, or null when that's nowhere at all
 */
export function reachableSpot(area, from, x, z) {
  const reach = walkableUpTo(area, from, x, z);
  return reach.clear || reach.d > 0.5 ? { x: reach.x, z: reach.z } : null;
}

/** How long a swim lasts, seconds (× patience); how many spots are tried for one. */
const SWIM_TIME = [8, 25], SWIM_TRIES = 24, SWIM_WEIGHT = 0.25; // (…; how likely a swim is next, beside the other choices' weights)
/**
 * Waterwalking/aqua people off for a swim: a spot on the water in or off their hangout (area.insideWet but not inside),
 * reached without leaving it. p.swimming 'going' → 'in' on arrival (held SWIM_TIME) → cleared (see updatePeople).
 * @returns {boolean} whether there was one
 */
function goSwim(p, area) {
  const box = area.wetBox;
  for (let k=0;k<SWIM_TRIES;k++) {
    const x = box.minX + peopleRng()*(box.maxX - box.minX), z = box.minZ + peopleRng()*(box.maxZ - box.minZ);
    if (area.inside(x, z) || !area.insideWet(x, z) || !walkableUpTo(area, p, x, z).clear) continue;
    p.tx = x; p.tz = z; p.swimming = 'going';
    return true;
  }
  return false;
}

/**
 * Held at the water's edge: a hangout wanderer picks somewhere else; one mid-activity gives it up after BANK_GIVE_UP
 * seconds. Someone leaving, whose walkway point is fixed, would stand there for good: after BANK_GIVE_UP they go back to
 * wandering their hangout (and leave some other way later), or with nowhere in it to go, are put on the nearest walkway
 * (reseatPerson).
 */
const BANK_GIVE_UP = 2;
function stopAtBank(p, dt) {
  if (p.mode === 'leaving') {
    if (p.follow) return; // (walking with someone: whatever they do, see besideLeader)
    p.bankHeld = (p.bankHeld ?? 0) + dt;
    if (p.bankHeld <= BANK_GIVE_UP) return;
    p.bankHeld = 0;
    const area = p.area >= 0 ? peopleNav.areas[p.area] : null, spot = area && randomSpotIn(area, null, p);
    if (spot && (spot.x !== p.x || spot.z !== p.z)) Object.assign(p, { mode: 'wander', tx: spot.x, tz: spot.z, wait: 0 });
    else reseatPerson(p);
    return;
  }
  if (p.mode !== 'wander') return;
  p.swimming = null;
  if (!p.act) { p.tx = p.x; p.tz = p.z; return; }
  p.bankHeld = (p.bankHeld ?? 0) + dt;
  if (p.bankHeld > BANK_GIVE_UP) { p.bankHeld = 0; endActivity(p); p.tx = p.x; p.tz = p.z; }
}

/**
 * Pick a random spot inside a hangout — near `near` if one can be found there, and one they can walk to from `from`
 * (where they're setting off, `near` by default) without crossing water. Where nothing in reach is clear, the furthest
 * they can get along the way to one — up to the bank — so someone by a pond still works their way round it.
 * @param {Hangout} area - the hangout
 * @param {?{x: number, z: number}} [near] - roughly where to look, or null for anywhere in the hangout
 * @param {{x: number, z: number}} [from] - where they're setting off (near, by default)
 * @returns {{x: number, z: number}} the spot
 */
export function randomSpotIn(area, near, from) {
  const start = from || near, inside = insideFor(area, start), box = inside === area.insideWet ? area.wetBox : area;
  let best = null;
  for (let k=0;k<24;k++) {
    const x = near && k < 12 ? near.x + (peopleRng()-0.5)*24 : box.minX + peopleRng()*(box.maxX-box.minX);
    const z = near && k < 12 ? near.z + (peopleRng()-0.5)*24 : box.minZ + peopleRng()*(box.maxZ-box.minZ);
    if (!inside(x, z)) continue;
    if (!start) return { x, z };
    const reach = walkableUpTo(area, start, x, z);
    if (reach.clear) return { x, z };
    if (reach.d > 0.5 && (!best || reach.d > best.d)) best = reach;
  }
  if (best) return { x: best.x, z: best.z };
  return start ? { x: start.x, z: start.z } : { x: (area.minX+area.maxX)/2, z: (area.minZ+area.maxZ)/2 };
}
/**
 * Count how many of an ascending list come below a limit.
 * @param {number[]} sorted - the values, ascending
 * @param {number} limit - the value to count below
 * @returns {number} how many are below it
 */
export function countBelow(sorted, limit) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < limit) lo = mid + 1; else hi = mid; }
  return lo;
}
/** The conversations going on: { kind: 'chat' (two, standing) or 'circle' (sat on the grass), members, speaker, turnIn, … }. */
export const groups = [];
/**
 * Look up the baked animation of this name.
 * @param {string} name - the animation's name (see PERSON_CLIPS)
 * @returns {?object} the baked animation, or null before the model's loaded
 */
export const clipNamed = name => personModel ? personModel.clips[name] : null;

/**
 * Whether the model has this animation at all.
 * @param {string} name - the animation's name (see PERSON_CLIPS)
 * @returns {boolean} whether it's there and not missing
 */
export const hasClip = name => { const clip = clipNamed(name); return !!clip && !clip.missing; };

/**
 * Pick one of a list at random.
 * @param {Array<*>} list - what to pick from
 * @returns {*} the one picked
 */
export const pickFrom = list => list[Math.floor(peopleRng()*list.length)];

/**
 * Wrap an angle into -π…π.
 * @param {number} a - the angle
 * @returns {number} the same angle, wrapped
 */
const POSSESSED_MAX_TILT = 40*Math.PI/180; // (how far a possessed head nods up or down with the view)
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Which way one point is from another, in radians.
 * @param {{x: number, z: number}} p - the point looking
 * @param {{x: number, z: number}} q - the point looked at
 * @returns {number} the heading
 */
export const headingTo = (p, q) => Math.atan2(q.x - p.x, q.z - p.z);

/**
 * How much the model is scaled to be this person's height.
 * @param {Person} p - the person
 * @returns {number} the scale
 */
export const modelScale = p => 1.7*p.height*S.peopleSize/personModel.height;
/**
 * Where someone's feet are with their pelvis at `at` in a pose (sitting, lying, fallen) — for `feet`, which holds the feet
 * there while they sit, lie or get up, their pelvis moved instead, so the body doesn't slide (see updatePeople).
 * @param {Person} p - the person
 * @param {object} clip - the pose
 * @param {number} [heading] - which way they face
 * @param {{x: number, z: number}} [at] - where their pelvis is
 * @returns {{x: number, z: number}} where their feet are
 */
export function feetOf(p, clip, heading = p.heading, at = p) {
  const s = modelScale(p), offX = clip.pelvisX*s, offZ = clip.pelvisZ*s, sin = Math.sin(heading), cos = Math.cos(heading);
  return { x: at.x - offX*cos - offZ*sin, z: at.z - offZ*cos + offX*sin };
}

/**
 * How much of a person's pose is `clip`, part-way through blending from one animation into the next — counting any version
 * of it (Idle with a coffee in hand is still Idle: see snackClips in peopleModel.js).
 * @param {Person} p - the person
 * @param {object} clip - the animation to weigh
 * @returns {number} from 0 to 1
 */
export const weightOf = (p, clip) => (p.clipA === clip || p.clipA?.base === clip ? p.fade : 0) + (p.clipB === clip || p.clipB?.base === clip ? 1 - p.fade : 0);
/**
 * How far into sitting on a seat someone is: sat back (Sit1), at a keyboard (Typing, TypingPaused) or at their dinner
 * (Eating, EatingPaused), all sat the same way, from 0 to 1.
 * @param {Person} p - the person
 * @returns {number}
 */
const SAT_CLIPS = ['Sit1', 'Typing', 'TypingPaused', 'Eating', 'EatingPaused'];
export const sitWeight = p => personModel ? SAT_CLIPS.reduce((w, name) => w + weightOf(p, personModel.clips[name]), 0) : 0;

/**
 * Work out the row of the bone texture a person's at in an animation: along the walk by how far they've walked, round a
 * looping one by the time, and through one playing once by how long it's played.
 * @param {Person} p - the person
 * @param {object} clip - the animation
 * @returns {number} the row
 */
export function clipRow(p, clip) {
  if ((clip.base ?? clip).name === 'Walk') return clip.start + p.walkCycle*clip.frames;
  if (clip.loop) return clip.start + (p.idleTime*PERSON_BAKE_FPS) % clip.frames;
  return clip.start + Math.min(clip.frames - 1, p.shotTime*PERSON_BAKE_FPS);
}

/**
 * Start a person blending into an animation from the one they're in — or back, if they're still blending out of it.
 * @param {Person} p - the person
 * @param {object} clip - the animation to blend into
 * @returns {void}
 */
export function setClip(p, clip) {
  if (p.clipA === clip) return;
  p.rowB = clipRow(p, p.clipA);
  p.fade = p.clipB === clip ? 1 - p.fade : 0;
  p.fadeTime = clip.anchor || p.clipA.anchor ? FADE_QUICK : clip.pose || p.clipA.pose ? FADE_POSE : clip.base || p.clipA.base ? FADE_SNACK : FADE_QUICK;
  p.clipB = p.clipA;
  p.clipA = clip;
}

// The one-off clips that swing the right hand about, and what someone with a snack in it plays instead: the same with
// the left hand (see `mirror` in PERSON_CLIPS), their right arm still holding it (WaveLeftBeer…) — or, for Idle3, the
// same clip with the right arm still holding it (Idle3Beer…).
const WITH_HAND_FULL = { Idle2: 'Idle2Left', Idle3: 'Idle3', Wave: 'WaveLeft' };
/**
 * Play an animation through once — or hold its single pose, for the poses (see PERSON_CLIPS).
 * @param {Person} p - the person
 * @param {string} name - the animation's name
 * @returns {void}
 */
export function playOnce(p, name) {
  if (p.snack && name in WITH_HAND_FULL) name = WITH_HAND_FULL[name] + snackClipName(p);
  if (!name || !hasClip(name)) return;
  p.oneShot = clipNamed(name);
  p.shotTime = 0;
  p.shotRate = 1; // (how many times faster than normal it plays; set again after this call to speed one up)
}
/** The index in people of whoever the camera's following, or -1. */
export let followed = -1;
/** Someone the camera was following when they got on a train, to follow again when they get off, or -1. */
export let riderFollowed = -1;
/**
 * Whether this person is out of sight — nowhere, dead, shut in a train or in a building.
 * @param {Person} p - the person
 * @returns {boolean} whether they're gone
 */
export const isGone = p => p.mode === 'none' || p.mode === 'dead' || aboard(p)
  || (p.mode === 'indoors' && p.indoors.stage === 'inside');
/**
 * Whether this person is riding in a train carriage — standing in it, and drawn there (see updateTrainRider), though they
 * count as gone for everything else.
 * @param {Person} p - the person
 * @returns {boolean} whether they're aboard
 */
export const aboard = p => p.mode === 'train' && p.train.stage === 'ride';
/**
 * Whether this person is drawn: not gone, or gone only into the room the camera's in (and not out of sight in it, behind
 * a changing room's curtain: see changing in peopleActivities.js) or onto a train.
 * @param {Person} p - the person
 * @returns {boolean} whether they're drawn
 */
// (not someone on the street passing through the room the view's in, which reaches into it: see buildings/interior.js roomClash)
export const isDrawn = p => !p.vanished && (!isGone(p) && (p.mode === 'possessed' || !roomCovers(p.x, p.y + 0.5, p.z))) || (inRoom(p) && !p.inRoom.hidden) || aboard(p);
/**
 * Whether this person is inside the building the camera's gone into, and so drawn in its room (see buildings/interior.js)
 * though they count as gone for everything else.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the room
 */
// Off screen, or too small on it to make out (see personPixels in peopleModel.js), the finer things about someone —
// their pose and place out of view, their glances, blinks and face, what they wear — are only brought up to date every
// FINE_EVERY frames, a share of the crowd each frame, taking in all the time since. How they move, and what they do and
// say, still goes on every frame.
const FINE_EVERY = 4;
// Keeping up with what their traits make of them (skin, hair, nudity, head size) only every THINK_EVERY frames, a share each frame.
const THINK_EVERY = 6;
let peopleFrame = 0;
// And someone off screen or a speck on it (under LAZY_PIXELS), out of earshot and doing nothing that needs every frame,
// isn't updated at all but on their fine turn, taking in all the time since (lazyDt); under HALF_LAZY_PIXELS, every other
// frame. Skipped while in view, they glide on at their last speed (glide).
const LAZY_PIXELS = 30, HALF_LAZY_PIXELS = 60;
const lazyNow = (p, i, carded) => {
  if ((peopleFrame + i) % FINE_EVERY === 0 || i === followed || i === possession.index
    || p.mode === 'none' || p.mode === 'possessed' || p.jc || p.fall || p.push || p.punched || p.attack || p.swat || inWater(p)
    || carded.includes(i) || Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z) <= hearDistance()) return false;
  const px = p.lazyPx = personPixels(p.x, p.y, p.z, 1.7*p.height*S.peopleSize);
  return px < LAZY_PIXELS || (px < HALF_LAZY_PIXELS && (peopleFrame + i) % 2 !== 0);
};
const GLIDE_MAX = 8; // (faster than this, m/s, and it was a jump, not a walk: no glide)
function glide(p, i) {
  const dx = p.glideVX*p.lazyDt, dz = p.glideVZ*p.lazyDt, o = i*16;
  personModel.mesh.instanceMatrix.array[o+12] = p.glideX + dx;
  personModel.mesh.instanceMatrix.array[o+14] = p.glideZ + dz;
  for (const layer of personModel.wornLayers) {
    const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
    if (!style?.mesh) continue;
    const a = style.mesh.instanceMatrix.array, so = layer.slot[i]*16;
    a[so+12] = p.glideX + dx; a[so+14] = p.glideZ + dz;
  }
}
const FOOTFALLS = 0.13, STEPS_PER_CYCLE = 4; // how far through the walk cycle a foot first comes down, and how many times
// one does in a cycle: the Walk clip is two full strides, left, right, left, right, each foot reaching furthest forward there
// Someone's voice (see audio/voices.js), the same every time for the same person: its pitch, lower for a man than a woman
// and for someone taller; its formants, likewise lower, and shifted either way on their own, apart from the pitch, so two
// voices at one pitch can still sound nothing alike; how sharp those formants ring, from breathy to nasal; and the tune
// they talk in (see audio/melodies.js); and their accent.
function voiceOf(p, i) {
  const own = mulberry32(i*7919 + 13), isMan = personModel?.isMan[i] === 1, tall = Math.sqrt(Math.max(0.5, p.height));
  const pitch = Math.max(60, Math.min(600, (isMan ? 150 : 250)/tall*2**(2.8*(own() - 0.5)))); // (±1.4 octaves)
  const formant = (isMan ? 1 : 1.15)/Math.sqrt(tall)*(0.8 + 0.42*own());
  const sharpness = 3 + 9*own();
  const melody = Math.floor(own()*MELODIES.length);
  const vibrato = own() < (p.age - 40)/50 ? 0.01 + 0.03*own() : 0; // (a quaver: likelier the older, from 40; all by 90)
  const accent = accentFor(own()); // (audio/accents.js)
  return accentVoice({ pitch, formant, sharpness, melody, isMan, age: p.age, vibrato, accent, ...presetAt(i)?.voice });
}
/** Someone's voice (see voiceOf), for a sound made outside the frame loop: a cry as they're hit, say. */
export const voiceOfPerson = p => voiceOf(p, people.indexOf(p));
export const inRoom = p => p.mode === 'indoors' && p.indoors.stage === 'inside' && !!p.inRoom
  && p.inRoom.visit === roomVisit() && roomHolds(p.indoors.building.key);
export let indoorsCount = 0;
/**
 * What a building's called on the card of whoever's in it: its own name (a pub's), or else its kind's name and its own number (see building-types.js).
 * @param {object} b - the building (see buildingDoors)
 * @returns {string} the label
 */

export const buildingLabel = b => buildingLabelName(b.kind, b.number, b.height, b.key);


export function setPersonModel(m) { personModel = m; warmBodyParts(m); }
export function setPeopleNav(nav) { peopleNav = nav; }
export function setPeopleNavBuiltAt(t) { peopleNavBuiltAt = t; }
export function setPeopleNavDebugBuiltAt(t) { peopleNavDebugBuiltAt = t; }
export function setLastPeopleTime(t) { lastPeopleTime = t; }
export function setFollowed(i) { followed = i; }
export function setRiderFollowed(i) { riderFollowed = i; }
export function setIndoorsCount(n) { indoorsCount = n; }

/**
 * Whether this is a hangout people sit and lie down on the ground in, rather than on benches.
 * @param {Hangout} area - the hangout
 * @returns {boolean} whether it's open ground
 */
export const isOpenGround = area => area.kind === 'park' || area.kind === 'beach';

// ============================================== PEOPLE ==============================================
// People are cuboids in random colors, drawn as one instanced mesh — replaced by the models in "the people model" below
// once they load.
//
// Most walk the walkways (the sidewalks either side of sidewalk roads, and paths), through junctions, turning off at
// links and back at dead ends. A walker passing a plaza, park or beach sometimes wanders in, drifts between spots (often
// to someone already there), waits, then leaves by the nearest walkway.
//
// The walkways are rebuilt when the roads or zones change (see buildPeopleNav), and anyone on a moved walkway is
// re-seated on the nearest one.
export const peopleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8 }), PEOPLE_MAX);
peopleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
{
  const color = new THREE.Color();
  for (let i=0;i<PEOPLE_MAX;i++) peopleMesh.setColorAt(i, color.setHSL(peopleRng(), 0.45 + peopleRng()*0.4, 0.42 + peopleRng()*0.25));
}
peopleMesh.count = 0;
peopleMesh.frustumCulled = false;
peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
peopleMesh.visible = false;
peopleMesh.name = 'People';
scene.add(peopleMesh);

// Debug wireframes (World → Peds → Roadsafety radius (debug)): a sphere around each person showing how far they check for
// traffic before crossing (see ROADSAFETY_RADIUS below), and a box around them showing the hitbox a car's run-over check
// uses (see runOverPeople in life/traffic/collisions.js) — off by default, and only kept up to date while the toggle's on.
export const roadsafetyDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3ddc97, wireframe: true, transparent: true, opacity: 0.35 }), PEOPLE_MAX);
roadsafetyDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyDebugMesh.count = 0;
roadsafetyDebugMesh.frustumCulled = false;
roadsafetyDebugMesh.visible = false;
roadsafetyDebugMesh.name = 'RoadsafetyDebug';
scene.add(roadsafetyDebugMesh);
// (the half-sphere for someone waiting in the road)
export const roadsafetyHalfDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 12, 0, Math.PI), roadsafetyDebugMesh.material, PEOPLE_MAX);
roadsafetyHalfDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyHalfDebugMesh.count = 0;
roadsafetyHalfDebugMesh.frustumCulled = false;
roadsafetyHalfDebugMesh.visible = false;
roadsafetyHalfDebugMesh.name = 'RoadsafetyHalfDebug';
scene.add(roadsafetyHalfDebugMesh);
export const pedHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), PEOPLE_MAX);
pedHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pedHitboxDebugMesh.count = 0;
pedHitboxDebugMesh.frustumCulled = false;
pedHitboxDebugMesh.visible = false;
pedHitboxDebugMesh.name = 'PedHitboxDebug';
scene.add(pedHitboxDebugMesh);
// The walkway lines, rebuilt whenever the nav is: cyan along each ring and path, red where a path crosses a road (and
// nobody walks there), yellow across a zebra crossing, white joining a path to the sidewalk it meets.
export const peopleNavDebugMesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
peopleNavDebugMesh.frustumCulled = false;
peopleNavDebugMesh.visible = false;
peopleNavDebugMesh.renderOrder = 999;
peopleNavDebugMesh.name = 'PeopleNavDebug';
scene.add(peopleNavDebugMesh);
/**
 * Push the people settings into the World panel's controls and their value readouts.
 * @returns {void}
 */
export function syncPeopleUI() {
  document.getElementById('s-people').classList.toggle('on', S.peopleEnabled);
  document.getElementById('people-settings').style.display = S.peopleEnabled ? 'block' : 'none';
  document.getElementById('s-roadsafety-debug').classList.toggle('on', S.showRoadsafetyDebug);
  document.getElementById('s-peoplenav-debug').classList.toggle('on', S.showPeopleNavDebug);
  document.getElementById('s-peopleamount').value = S.peopleAmount;
  document.getElementById('dv-peopleamount').textContent = String(Math.round(S.peopleAmount));
  document.getElementById('s-peoplespeed').value = S.peopleSpeed;
  document.getElementById('dv-peoplespeed').textContent = S.peopleSpeed.toFixed(1);
  document.getElementById('s-peoplesize').value = S.peopleSize;
  document.getElementById('dv-peoplesize').textContent = S.peopleSize.toFixed(1);
  document.getElementById('s-traffic').value = S.trafficAmount;
  document.getElementById('dv-traffic').textContent = String(Math.round(S.trafficAmount));
}

// (see the end of newPerson)
const PERSON_LATER_FIELDS = Object.fromEntries([
  // who they are (refreshTraits), how they look (updatePeople)
  'remote', // (a multiplayer guest's controls, while one possesses them: see possessRemote in peopleTracking.js)
  'health', 'walletSet', 'moodNow', 'keptAt', 'age', 'name', 'loves', 'hates', 'lovedWords', 'hatedWords', 'isMan', 'spectralKey', 'groomKey', 'showsBald', 'showsBeard', 'vanished', 'vanishUntil', 'shyCount', 'shyArmed', 'shyPhase', 'shyAt', 'chattingWithTwin', 'defaultHair', 'eyeBase', 'skinBase', 'skinKey', 'nudeDressed', 'nudeSeenIn', 'headDrawn', 'faceDt', 'placedOut',
  // what they say and think
  'lusting', 'shouting', 'phrase', 'saying', 'babbleLine', 'thought', 'thoughtUntil', 'fidgetThought', 'nextThoughtAt', 'loggedLine',
  'greetTo', 'closing', 'leftBadly', 'seen', 'felt', 'noticed', 'shotRate', 'feet',
  // fleeing, fighting, blood
  'sunRun', 'fleeArea', 'fleeInArea', 'fleeStarts', 'fledTalkAt', 'fleeTalkUntil', 'pray', 'attackQueue', 'push', 'revived', 'medbot',
  'blood', 'bloodBase', 'bloodFrom', 'bloodTimer', 'huntIn', 'roadWaryUntil', 'benched', 'bankHeld',
  // water, drink, smell
  'water', 'waterHere', 'swimming', 'floatDrop', 'floatPhase', 'floatBobPhase', 'floatWasWet', 'slopeDrop', 'waterSeenIn',
  'pints', 'feltDrunk', 'swayAmp', 'swayDist', 'likesStout', 'holding', 'umbrella', 'smellCheck',
  // walked about by hand (peopleTracking.js)
  'footing', 'onRoad', 'shove', 'fall', 'fellOff', 'swat', 'touching', 'near', 'walkingSpeed', 'chatWith',
].map(key => [key, undefined]));
/**
 * Make a person with their traits and state at their starting values.
 * @param {number} [id] - their person id: a specific one to revive (someone hearted and saved, whose slot a reload
 *   hasn't reached yet — see updatePeople), or left out for a fresh one
 * @returns {Person} the person
 */
export function newPerson(id = S.peopleIdSeq++) {
  const baseHeight = 0.85 + peopleRng()*0.27; // (their height, before their size trait)
  const wallet = Math.floor(Math.random()*10) + 5*Math.floor(Math.random()*6) + 10*Math.floor(Math.random()*6) + 20*Math.floor(Math.random()*6);
  return { id, x:0, y:0, z:0, heading: peopleRng()*Math.PI*2, stride: 0.8 + peopleRng()*0.4, baseHeight, height: baseHeight, phase: peopleRng()*10,
    mode: 'none', li: 0, u: 0, dir: 1, seg: 0, lat: 0, area: -1, tx: 0, tz: 0, wait: 0, exit: null, moving: false, stepped: 0,
    // the model's animation: how far through the walk (in whole cycles) and the looping ones (in seconds) they are; the
    // animation they're in (clipA) and the one they're blending out of (clipB, held at row rowB), how far they've blended and
    // how long it takes; the pose they're in when they're not walking, and one playing through once (and for how long it has);
    // how tall their pose leaves them; the time to their next blink and since their last;
    //
    // which way they're looking (their head turned and tilted, the way it's turning to, and the time until they glance
    // somewhere else); and how long they've stood about, and how long until they fidget
    walkCycle: peopleRng(), idleTime: peopleRng()*10, clipA: null, clipB: null, rowB: 0, fade: 1, fadeTime: FADE_QUICK,
    pose: 'Idle', oneShot: null, shotTime: 0, heightScale: 1, blinkIn: peopleRng()*6, blinkAge: BLINK_DURATION,
    lookTurn: 0, lookTilt: 0, lookTurnTo: 0, lookTiltTo: 0, lookIn: peopleRng()*4, stillFor: 0, fidgetAfter: 2 + peopleRng()*5,
    // what they're doing besides walking about (see "what people get up to"): act 'chat', 'walk', 'bench', 'circle' or 'lie', how
    // far along it they are (stage) and for how long (timer); where they're sitting or lying (spot, seat, the pose — sitClip
    // or lieClip — and circleAngle round a circle); the group they're talking in; the way they should face and who they're
    // looking at; how far up onto a bench seat they sit; walking with someone, who they keep beside (follow), on which side
    // (walkSide), and whether they turned round to (walkBack);
    //
    // and their mouth — how open it's going to (talkTo, until talkIn; a syllable picked ahead, talkNext, once talkIn's down
    // to talkNextAt) and their expression (emotionTo, until emotionIn)
    act: null, stage: '', timer: 0, spot: null, seat: null, sitClip: null, lieClip: null, circleAngle: 0, group: null,
    faceTo: null, lookAt: null, seatLift: 0, follow: null, walkSide: 1, walkBack: false, chatCheckIn: peopleRng(), chatCooldown: peopleRng()*20,
    talk: 0, talkTo: 0, talkIn: 0, talkNext: -1, talkNextAt: 0, emotion: 0, emotionTo: 0, emotionIn: 0,
    // and their eyes: how shocked, happy, angry and sad they look
    eyes: [0, 0, 0, 0],
    // and where their pupils have wandered to (left/right, up/down), where they're darting to next and when
    pupil: [0, 0], pupilTo: [0, 0], pupilIn: peopleRng()*2,
    // their traits, from what they were picked in people/*.txt (see refreshTraits)
    traits: DEFAULT_TRAITS, traitsKey: '',
    // how they're taking someone blowing up nearby, if they are (see frightenBystanders)
    fright: null,
    stun: null,
    please: null,
    // crossing a road (see updateCrossing): where they are on it (null if they aren't), the way over, how long until they
    // next consider crossing mid-block, and linkCooldown, which stops them turning off at another junction straight after one
    crossStage: null, jc: null, crossCheckIn: peopleRng()*5, linkCooldown: 0,
    // riding the trains (see "riding the trains"): where they are in it (null if they aren't), and how long until they
    // consider riding again
    // their wallet (£; dropped as coins when they die: see life/coins.js), before and after their capital trait (refreshTraits)
    walletBase: wallet, wallet,
    train: null, trainCooldown: 20 + peopleRng()*40, snack: null, buy: null, snackCooldown: peopleRng()*30,
    // going into a building (see "going indoors"): where they are in it (null if they aren't), and how long until they
    // consider going into one again
    indoors: null, inRoom: null, indoorsCooldown: 10 + peopleRng()*30,
    // punching (see "punching"): who they're going for, how far along it they are, how long until they consider it again,
    // and being punched themselves
    attack: null, punchCooldown: 10 + peopleRng()*30, punched: null,
    // and everything else anyone comes to have, there from the start (undefined until it's set, just as if it weren't
    // there): with everyone's fields the same and in the same order, the browser keeps one shape for all of them, and
    // reading anything off a person stays quick. Anything newly set on a person belongs here too.
    ...PERSON_LATER_FIELDS };
}

// someone saved (see peopleKeep.js) back as themselves, or someone new
function bornPerson(kp) {
  const p = newPerson(kp?.id);
  if (kp?.moodNow != null) p.moodNow = kp.moodNow;
  if (Array.isArray(kp?.at) && kp.at.length === 4 && kp.at.every(Number.isFinite)) p.keptAt = kp.at;
  return p;
}
// Someone saved (see peopleKeep.js) put back where they were, once spawned: in the hangout that spot's in, else on the
// nearest walkway to it (reseatPerson), else wherever spawnPerson put them.
function placeKept(p) {
  const at = p.keptAt;
  if (!at || p.mode === 'none') return; // (not spawned yet: kept till they are)
  p.keptAt = undefined;
  [p.x, p.y, p.z, p.heading] = at;
  p.mode = p.y > 1 ? 'line' : 'wander'; // (the hangout first, or a raised walkway: see reseatPerson)
  reseatPerson(p);
}

/**
 * Work out a person's traits, from the entries picked for them in people/*.txt (see profiles.js) by their id — who they
 * are, not where they're standing (see the note on peopleIdSeq above). Worked out again whenever people/*.txt loads,
 * and once the model's loaded and says whether they're a man (from their id too: see sexOf in profiles.js).
 * @param {Person} p - the person
 * @param {number} i - their place in the crowd, just to look up their slot's sex
 * @returns {void}
 */
// (the key refreshTraits keeps on a person, made once for each profiles version rather than for every person every frame)
let traitKeys = { version: null };
function traitsKeyOf(isMan) {
  const version = profilesVersion();
  if (traitKeys.version !== version) traitKeys = { version, true: version + ':true', false: version + ':false', null: version + ':null' };
  return traitKeys[isMan];
}
export function refreshTraits(p, i) {
  const isMan = personModel ? personModel.isMan[i] === 1 : null, key = traitsKeyOf(isMan);
  if (p.traitsKey === key) return;
  p.traitsKey = key;
  const preset = presetAt(i);
  if (preset) registerPreset(p.id, preset); // (whoever's in a preset's slot is them: see presets.js)
  const profile = profileOf(p.id, isMan, p.moodNow); // (a piper's mini's is theirs: see registerMini in profiles.js)
  // (who they are, with what's in their pockets and what they're under stacked over it: see life/statuseffects.js)
  p.baseTraits = profile.traits;
  restackTraits(p);
  // (their starting money times their capital, kept up with their traits until they've spent any)
  if (p.walletSet === undefined || p.wallet === p.walletSet) p.wallet = p.walletSet = Math.round(p.walletBase*p.baseTraits.capital);
  p.height = preset?.height ?? (profile.height ?? p.baseHeight)*p.traits.size; // (a Ped Builder one's own: profiles.js customs)
  p.age = profile.age;
  p.name = profile.name; // (for their card, and for naming them in the morality notices when they die)
  p.loves = profile.lovesSaid; p.hates = profile.hatesSaid; // (for what they say: see life/speech-text.js)
  p.lovedWords = profile.lovedWords; p.hatedWords = profile.hatedWords; p.limits = profile.limits;
  p.isMan = isMan; // (null for the cuboid people; for {man} in what they say)
  tintSkin(p, i); // (the skin those traits give them: see tintSkin)
}

const PLAZA_CHAT = 0.7; // plazas are busy: going over to talk to someone there is this much as likely as elsewhere
export const FRIGHT_RADIUS = 14, FLEE_SPEED = 2.3;
// The whites of the eyes of vampires move this share of the way to yellow to start with, and again for each 100 years of age;
// the blazed trait moves them BLAZED_EYE_RED of the way to red. (Bloodlust's eyes are in peopleBlood.js.)
const VAMPIRE_EYE_TINT = 0.2, VAMPIRE_EYE_COLOR = new THREE.Color(0xffc40c),
   BLAZED_EYE_RED = 0.05, EYE_RED_COLOR = new THREE.Color(0xff0000);
// Vampires' skin moves 10% of the way to the colour for every 100 years of age, counting from the first (so it starts out 10% grey).
const VAMPIRE_SKIN_COLOR = new THREE.Color(0xd3d3d3), VAMPIRE_PALE_PER_CENTURY = 0.1;
// The sick and zombie traits (the 🤢 and 🧟 moods in people/moods.txt give each of them) take the skin MOOD_SKIN_BLEND of
// the way to a colour of its own: a sickly green, and a dead blue-grey (see tintSkin).
const SICK_SKIN_COLOR = new THREE.Color(0x72bb4d), ZOMBIE_SKIN_COLOR = new THREE.Color(0x609dc2), MOOD_SKIN_BLEND = 1;
// The fuming trait (the 😠 mood) takes it up to FUMING_SKIN_BLEND of the way to red (huffing, 😤, counts HUFFING_RED as
// much), freezing (🥶) up to FREEZING_SKIN_BLEND of the way to blue, and blushing pinks the cheeks (drawn by the person
// shader from the Skin row's fourth number: see BLUSH_GLSL in peopleModel.js).
const FUMING_SKIN_COLOR = new THREE.Color(0xe0442c), FUMING_SKIN_BLEND = 0.45, HUFFING_RED = 0.7;
const FREEZING_SKIN_COLOR = new THREE.Color(0x7fb2e8), FREEZING_SKIN_BLEND = 0.5;
const redOf = p => Math.min(1, p.traits.fuming + HUFFING_RED*p.traits.huffing);
// The traits that have a say in the skin, as one number, for telling when one of them has changed (see tintSkin).
const skinKeyOf = p => (p.traits.sick ? 1 : 0) + (p.traits.zombie ? 2 : 0) + (p.traits.vampire ? 4 : 0)
  + 8*Math.round(redOf(p)*100) + 808*Math.round(p.traits.blushing*100) + 81608*Math.round(p.traits.freezing*100) + 8242408*(p.traits.upsidedown ? 1 : 0)
  + 16484816*Math.round(p.traits.skeptical*100) + 1664966416*Math.round(p.traits.goofy*100) + 17e12*Math.round(p.traits.welling*100);
const spectralOf = p => Object.entries(SPECTRAL).reduce((bits, [trait, bit]) => bits | (p.traits[trait] ? bit : 0), 0) | (p.traits.bald > 0.5 ? BALD_BIT : 0) | (p.vanished ? VANISHED_BIT : 0);
/**
 * Write the skin someone's traits give them to the person model: the colour they came with, moved towards the grey a
 * vampire's age pales it to and, all the way, the colour of the sick and zombie traits (see SICK_SKIN_COLOR) or, part way, the
 * fuming trait's red or the freezing trait's blue; how much they blush (see FUMING_SKIN_COLOR); and whether their head's upside down. Their own is
 * kept on p.skinBase the first time, so the skin they came with comes back when the trait goes — a mood cheered up out of
 * the 🤢 or 🧟 one, a keepsake handed back.
 *
 * Called when one of those traits changes rather than every frame: from refreshTraits, and from updatePeople for a
 * keepsake or a status that's just moved one (see skinKeyOf). While they've blood on them the skin row is peopleBlood.js's,
 * which stains from p.bloodBase — so that's what's moved instead, to be stained from.
 * @param {Person} p - the person
 * @param {number} i - their index in people
 * @returns {void}
 */
function tintSkin(p, i) {
  p.skinKey = skinKeyOf(p); p.spectralKey = spectralOf(p); // (even without the model: its coming is a traits change of its own, which tints them for real)
  if (!personModel) return;
  const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Skin'))*PEOPLE_MAX + i)*4, data = personModel.traitData;
  p.skinBase ??= [data[o], data[o + 1], data[o + 2]];
  const skin = new THREE.Color().setRGB(p.skinBase[0], p.skinBase[1], p.skinBase[2]);
  if (p.traits.vampire) skin.lerp(VAMPIRE_SKIN_COLOR, Math.min(1, VAMPIRE_PALE_PER_CENTURY*(1 + p.age/100)));
  const moodSkin = p.traits.zombie ? ZOMBIE_SKIN_COLOR : p.traits.sick ? SICK_SKIN_COLOR : null;
  if (moodSkin) skin.lerp(moodSkin, MOOD_SKIN_BLEND);
  else {
    if (redOf(p)) skin.lerp(FUMING_SKIN_COLOR, FUMING_SKIN_BLEND*redOf(p));
    if (p.traits.freezing) skin.lerp(FREEZING_SKIN_COLOR, FREEZING_SKIN_BLEND*p.traits.freezing);
  }
  data[o + 3] = p.traits.blushing; // (not stained by blood, so set either way)
  // (and whether their head's upside down, 🙃, in the Eyes row's fourth number, which nothing else has: see personLook)
  data[((2 + PERSON_TRAIT_COLORS.indexOf('Eyes'))*PEOPLE_MAX + i)*4 + 3] = p.traits.upsidedown ? 1 : 0;
  data[(SKEPTICAL_ROW*PEOPLE_MAX + i)*4 + 3] = p.traits.skeptical; // (and their face pulled, 🤔 🥴: see FACE_PULLS)
  data[(GOOFY_ROW*PEOPLE_MAX + i)*4 + 3] = p.traits.goofy;
  data[(WELLING_ROW*PEOPLE_MAX + i)*4 + 3] = p.traits.welling; // (and the glint in their eyes, 🥺: see GLINT_GLSL)
  data[(SPIRITS_ROW*PEOPLE_MAX + i)*4 + 3] = spectralOf(p); // (spirits, ghost, bodiless, twins: see peopleSpirits.js)
  personModel.traitTexture.needsUpdate = true;
  if (p.blood && p.bloodBase) { p.bloodBase.Skin = [skin.r, skin.g, skin.b]; return; } // (blood's to stain from: see peopleBlood.js)
  data[o] = skin.r; data[o + 1] = skin.g; data[o + 2] = skin.b;
  personModel.traitTexture.needsUpdate = true;
}
const LOOK_BEHIND = 0.8*Math.PI; // how far round (radians either side of ahead) someone they're looking at counts as right behind them
const BUBBLE_HEIGHT = 2; // how high over their feet (× height, × people size) a speech bubble's tail points (see ui/speech-bubbles.js)
const BUBBLE_CHAIR_DROP = 0.5, BUBBLE_GROUND_DROP = 0.8; // how much lower (same units) sat on a seat, and sat on the ground
// Someone on their own may think something (thoughts.txt: see life/speech-text.js) as they fidget with one of
// THINK_FIDGETS — THINK_CHANCE of the time (× chat speed), and no sooner than THINK_REST after their last (a rest of their
// own, started at random, so people don't all think together) — shown in a bubble for THOUGHT_TIME, only within
// Options > Speech > Bubble distance of the camera. (What they've just seen or felt, they react to aloud: see reactAloud.)
// Returns the thought while it shows.
const THINK_FIDGETS = FIDGETS, THINK_CHANCE = 0.35, THOUGHT_TIME = 4, THINK_REST = [20, 60];
function thoughtOf(p, now) {
  if (p.thought && now < p.thoughtUntil) return p.thought;
  p.thought = null;
  const near = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z) <= (S.bubbleDistance ?? 35);
  const show = text => { p.thought = { text, thought: true }; p.thoughtUntil = now + THOUGHT_TIME; return p.thought; };
  const fidgeted = p.fidgetThought;
  p.fidgetThought = false;
  p.nextThoughtAt ??= now + THINK_REST[0] + peopleRng()*(THINK_REST[1] - THINK_REST[0]);
  if (!fidgeted || now < p.nextThoughtAt || !near || peopleRng() >= THINK_CHANCE*(S.chatSpeed ?? 1)) return null;
  p.nextThoughtAt = now + (THINK_REST[0] + peopleRng()*(THINK_REST[1] - THINK_REST[0]))/(S.chatSpeed ?? 1);
  const thought = pickThought(p);
  return thought ? show(thought.text) : null;
}
// where someone's speech bubble points: over their head, lower as they sit (on a seat, raised by seatLift, or on the ground)
function bubbleAt(p) {
  const chair = sitWeight(p), ground = personModel ? GRASS_SITS.reduce((w, name) => w + weightOf(p, personModel.clips[name]), 0) : 0;
  const up = (BUBBLE_HEIGHT - chair*BUBBLE_CHAIR_DROP - ground*BUBBLE_GROUND_DROP)*p.height*S.peopleSize + p.seatLift*chair;
  return { x: p.x, y: p.y + up, z: p.z };
}
const LYING_CLEARANCE = 1; // how near (at people size 1) anyone walks to someone lying on the ground
/**
 * Have everyone around someone blowing up notice it: the nearer they are, the sooner, and they run off for a while.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function frightenBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.fright = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/**
 * Have everyone around someone blowing up notice it and stand dazed, rather than running off.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function stunBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.stun = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/**
 * Have everyone around someone blowing up notice it and beam, rather than running off.
 * @param {Person} victim - whoever it is
 * @returns {void}
 */
function pleaseBystanders(victim, source = null) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = source ?? { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - victim.x, p.z - victim.z);
    if (d <= reach) p.please = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}

/** How evil someone has to be to count as guilty rather than innocent, and as villainous rather than guilty. */
const EVIL_GUILTY_ABOVE = 0.05, EVIL_VILLAINOUS_ABOVE = 0.35;
/**
 * What someone counts as, by how evil they are: an innocent, a bad sort, or a villain. The thresholds the crowd's
 * reaction and the morality meter both go by, so the two always agree.
 * @param {Person} p - the person
 * @returns {'innocent'|'guilty'|'villainous'} what they count as
 */
export function standingOf(p) {
  // the traits they're actually going about with, which are picked for their own sex (see refreshTraits); an evil
  // score they somehow never got counts as innocent
  const evil = p.traits.evil ?? 0;
  return evil > EVIL_VILLAINOUS_ABOVE ? 'villainous' : evil > EVIL_GUILTY_ABOVE ? 'guilty' : 'innocent';
}
// ---------------------------------------------------------- what people see and feel, for what they say
// (see {seen} and {felt} in assets/text/speech/about.txt, and life/speech-text.js). p.seen is the last thing someone saw
// happen to someone else, p.felt the last thing that happened to them; each is kept SEEN_TIME, and said or thought
// about once, straight away. A lesser sight doesn't replace a greater one still fresh (SEEN_RANK); the same sight of the
// same person isn't seen again while it's fresh, so something that goes on (walking on water, a smell) counts once.
const WITNESS_RADIUS = 20; // how near (× people size) someone has to be to see something happen
const SEEN_RANK = { killedbycar: 3, crashedinto: 3, fell: 3, punchedfence: 3, planecrash: 3, beeattack: 1, beatentodeath: 3, smited: 3, orbsmited: 3, orbhunt: 2, drowned: 3, exploded: 3, resurrected: 2, punch: 1, knockedbycar: 1, healed: 0, waterwalking: 0, smelly: 0, nude: 0 };
const NUDE_SEEN_EVERY = 4; // seconds between someone nude being noticed by whoever's near
const NOTICED_FOR = 60; // seconds a sight stays fresh (as SEEN_TIME in life/speech-text.js)
const MAX_WITNESSES = 5;  // how many of the nearest see something happen (not a whole park at once)
const REACT_SPREAD = 2.5; // seconds over which those who saw it get round to reacting, each at a random moment
const insideOf = q => q.mode === 'indoors' && q.indoors.stage === 'inside' ? q.indoors.building : null;
/**
 * One person taking in something that happened to someone else.
 * @param {Person} q - who saw it
 * @param {Person} who - who it happened to
 * @param {string} what - what (a key of SEEN_RANK)
 * @param {?Person} [by] - who did it, if a person
 * @returns {void}
 */
export function notice(q, who, what, by = null) {
  if (by) relateSaw(q, what, by);
  const at = worldNow(), old = q.seen, fresh = old && at - old.at < NOTICED_FOR;
  if (fresh && (SEEN_RANK[old.what] > SEEN_RANK[what] || (old.what === what && old.who === who))) return;
  // (no more than MAX_WITNESSES notice the same thing about the same person while it's fresh — a smell, walking on water)
  const tally = who.noticed?.what === what && at - who.noticed.since < NOTICED_FOR ? who.noticed : (who.noticed = { what, since: at, count: 0 });
  if (tally.count >= MAX_WITNESSES && !who.event) return; // (an event's own witness count: see witnessAt)
  tally.count++;
  q.seen = { what, at, who, by, after: at + Math.random()*REACT_SPREAD };
}
/**
 * The MAX_WITNESSES nearest, on the same side of any walls (or anywhere in the same building), see something happen.
 * @param {Person} who - who it happened to
 * @param {string} what - what (a key of SEEN_RANK)
 * @param {?Person} [by] - who did it, if a person (who doesn't count as seeing it)
 * @returns {void}
 */
export function witness(who, what, by = null, { reachScale = 1, most = MAX_WITNESSES } = {}) {
  const reach = WITNESS_RADIUS*S.peopleSize*reachScale, building = insideOf(who), near = [];
  people.forEach(q => {
    if (q === who || q === by || q.mode === 'dead' || q.mode === 'drowning' || q.mode === 'none' || aboard(q)) return;
    if (insideOf(q) !== building) return;
    const d = Math.hypot(q.x - who.x, q.z - who.z);
    if (building || d <= reach) near.push({ q, d });
  });
  near.sort((a, b) => a.d - b.d).slice(0, most).forEach(({ q }) => notice(q, who, what, by));
  App.chronicle?.(who, what, by); // (the newspaper: life/chronicle.js)
}
const EVENT_REACH = 4, EVENT_WITNESSES = 15; // (how many times further off than WITNESS_RADIUS, and how many, see something happen at a place)
/**
 * Something happening at a place rather than to someone (an aircraft blowing up: see crashAircraft in zones/airport.js),
 * seen from further off, by more.
 * @param {{x: number, z: number}} at
 * @param {string} what - a key of SEEN_RANK
 * @returns {void}
 */
export function witnessAt(at, what) { witness({ x: at.x, z: at.z, name: null, noticed: null, event: true }, what, null, { reachScale: EVENT_REACH, most: EVENT_WITNESSES }); }
/**
 * Something happening to someone: punched, hitbycar, or revenge (they punched back whoever last punched them).
 * @param {Person} p
 * @param {string} what
 * @param {?Person} [by] - who did it (for revenge, who they got back at)
 * @returns {void}
 */
export function feel(p, what, by = null) { p.felt = { what, at: worldNow(), by }; if (by) relateFelt(p, what, by); }
/**
 * How the people around someone take their death: an innocent's leaves them horrified, a bad sort's stops them in
 * their tracks, and a villain's delights them. Called for every death, whoever caused it — the Smite button, or a car
 * running them over (see runOverPeople in life/traffic/collisions.js) — so any way an NPC dies is reacted to the same.
 * @param {Person} victim - whoever was killed
 * @param {?{x: number, z: number}} [source] - what killed them, which they look at and run from (a car), else the victim
 * @returns {void}
 */
function bystandersReactToDeath(victim, source = null) {
  // (measured from the victim; looked at and run from the source)
  const standing = standingOf(victim), from = source ? { x: source.x, z: source.z } : null;
  if (standing === 'villainous') pleaseBystanders(victim, from);
  else if (standing === 'guilty') stunBystanders(victim, from);
  else frightenBystanders(victim, from);
}

/**
 * Move one of someone's reactions to a blast on a stage: noticing turns them to look at it, looking hands over to
 * whatever that reaction does about it, and anything else lets them go.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @param {'fright'|'stun'|'please'} key - which reaction, on the person
 * @param {function(Person, object): void} onResolve - what to do once they've looked
 * @returns {void}
 */
function updateEffect(p, dt, key, onResolve) {
  const state = p[key];
  state.timer -= dt;
  if (state.timer > 0) return;
  if (state.stage === 'notice') {
    endActivity(p);
    p.oneShot = null; p.wait = 0;
    p.faceTo = headingTo(p, state.from);
    p.lookAt = state.from;
    state.stage = 'look';
    state.timer = 0.5 + peopleRng()*0.7;
  } else if (state.stage === 'look') {
    onResolve(p, state);
  } else {
    p[key] = null;
  }
}

/**
 * Run someone's fright, each frame: gazing in shock, then running off more than twice as fast.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateFright(p, dt) {
  updateEffect(p, dt, 'fright', (p, fright) => beginFleeing(p, fright.from));
}

/** How long, in seconds, someone runs off from whatever frightened them. */
const FLEE_TIME = 10;
// Someone in a hangout who's fled FLEE_REPEAT_COUNT times within FLEE_REPEAT_WINDOW seconds, or for FLEE_AREA_TIME seconds
// in all while in it, makes for its exit furthest from the danger instead of running about inside it (see wantsOut).
const FLEE_REPEAT_COUNT = 3, FLEE_REPEAT_WINDOW = 60, FLEE_AREA_TIME = 15;
/** Whether someone fleeing in a hangout has had enough of it and should leave. */
const wantsOut = p => (p.fleeStarts?.length ?? 0) >= FLEE_REPEAT_COUNT || (p.fleeInArea ?? 0) >= FLEE_AREA_TIME;
/**
 * Set someone running off, more than twice as fast as they walk, away from `from` ({ x, z }) for FLEE_TIME seconds.
 * @param {Person} p - the person
 * @param {{x: number, z: number}} from - what they're running from
 * @returns {void}
 */
// (babble's next syllable is picked this many seconds ahead and scheduled then, so a stalled frame doesn't gap it)
const SAY_AHEAD = 0.1;
const FLEE_TALK_AGAIN = 12, FLEE_TALK_WITHIN = 2; // seconds before someone who's fled calls out again as they start another
// flight, and how long after bolting they'll still call out (waiting for a turn to speak: see shoutLine)
export function beginFleeing(p, from) {
  if (p.traits.ghost) return;
  p.fright = { stage: 'flee', timer: FLEE_TIME, from };
  // (something called out as they bolt, from fleeing.txt — not every time, for those who keep running: see the talk below)
  const fleeNow = worldNow();
  if (!(fleeNow - (p.fledTalkAt ?? -Infinity) < FLEE_TALK_AGAIN)) { p.fledTalkAt = fleeNow; p.fleeTalkUntil = fleeNow + FLEE_TALK_WITHIN; }
  const now = lastPeopleTime ?? 0;
  p.fleeStarts = (p.fleeStarts ?? []).filter(t => now - t < FLEE_REPEAT_WINDOW);
  p.fleeStarts.push(now);
  p.faceTo = null; p.lookAt = null;
  // away from whatever frightened them: turn round, if they're on a walkway
  if (p.mode === 'line') {
    const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1];
    if (((b.x - a.x)*(from.x - p.x) + (b.z - a.z)*(from.z - p.z))*p.dir > 0) p.dir = -p.dir;
  } else if (p.mode === 'wander') {
    const area = peopleNav.areas[p.area];
    if (!(wantsOut(p) && leaveArea(p, area, from))) fleeWithin(p, area);
  }
}
/**
 * A vampire out while the sun's up (see hidingFromSun): running scared, SUN_RUN_BOOST faster still, for the nearest door
 * along their walkway — out of a hangout first, and onto other walkways at every turning if theirs has no door
 * (walkAlong) — and in at the first door they reach. Still out at 6:30, they vanish into the nearest building
 * (vanishIndoors). Once inside, calm.
 * Checked every frame: anything else they're doing is dropped; a fight, being knocked down or a road crossing is
 * waited out, then the run (or vanishing) starts again. Only a flee marked `sun` counts as already running for cover.
 * @param {Person} p - the vampire
 * @returns {void}
 */
function hideFromSun(p) {
  if (p.mode === 'indoors') {
    if (p.indoors.stage === 'inside' && p.sunRun) { p.sunRun = false; p.fright = null; }
    return;
  }
  const knockedDown = p.punched && p.punched.stage !== 'marked'; // ('marked': only someone coming for them)
  if (knockedDown || inWater(p) || !(p.mode === 'line' || p.mode === 'wander' || p.mode === 'leaving')) return;
  if (outOfTime(p) && vanishIndoors(p)) return;
  if (p.attack || p.jc) return;
  if (p.act) endActivity(p);
  p.sunRun = true;
  if (p.mode === 'wander') { leaveArea(p, peopleNav.areas[p.area]); return; }
  if (p.fright?.stage === 'flee' && p.fright.sun) return;
  // (on a walkway: towards its nearest door, if it has one, running from just behind them)
  if (p.mode === 'line') {
    const nav = peopleNav.lines[p.li];
    let nearest = null;
    nav.vertices.forEach((vertex, vi) => {
      if (vertex.building && (nearest == null || Math.abs(nav.cum[vi] - p.u) < Math.abs(nearest - p.u))) nearest = nav.cum[vi];
    });
    if (nearest != null && Math.abs(nearest - p.u) > 0.01) p.dir = Math.sign(nearest - p.u);
    const k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1], len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    beginFleeing(p, { x: p.x - (b.x - a.x)/len*p.dir, z: p.z - (b.z - a.z)/len*p.dir });
  } else {
    beginFleeing(p, { x: p.x - Math.sin(p.heading), z: p.z - Math.cos(p.heading) });
  }
  if (p.fright) p.fright.sun = true; // (not for a ghost: see beginFleeing)
}
/** How much faster than fleeing a vampire runs for cover from the sun. */
const SUN_RUN_BOOST = 1.5;
/** How much faster someone caught in the rain without an umbrella walks (see shelteringFromRain). */
const RAIN_HURRY = 1.35;
/** Hangouts the rain doesn't reach. */
const isUnderCover = area => area.kind === 'foodcourt';
/**
 * Send someone in a hangout out of it: onto the walkway at one of its entrances — the nearest of a few, or, running from
 * `from`, whichever takes them furthest from it — as mode 'leaving'. Entrances reached over dry ground come first.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @param {?{x: number, z: number}} [from] - what they're running from, if anything
 * @returns {boolean} whether it has an entrance to leave by
 */
function leaveArea(p, area, from = null) {
  if (!area.exits.length) return false;
  const candidates = from ? area.exits : Array.from({ length: 6 }, () => area.exits[Math.floor(peopleRng()*area.exits.length)]);
  let exit = null;
  for (const e of candidates) {
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    // (fleeing: far from the danger, less how far off it is; otherwise just near)
    const score = from ? Math.hypot(e.x - from.x, e.z - from.z) - d : -d;
    // Uses the entrance's own position, not the walkway point: a walkway lies outside the hangout, so a walk to
    // that point never reads as clear ground.
    const dry = walkableUpTo(area, p, e.x, e.z).clear;
    if (!exit || (dry !== exit.dry ? dry : score > exit.score)) exit = { ...e, score, dry };
  }
  // Joins the walkway at the point where it passes the entrance.
  joinWalkway(p, exit.li, peopleNav.lines[exit.li].cum[exit.vi], peopleRng() < 0.5 ? -1 : 1);
  p.exit = walkwayPoint(p);
  p.mode = 'leaving'; p.wait = 0;
  p.fleeInArea = 0; p.swimming = null;
  return true;
}

/**
 * Run someone's stun, each frame: gazing in shock, then standing dazed.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateStun(p, dt) {
  updateEffect(p, dt, 'stun', (p, stun) => {
    // 'held' is the stage updatePeople freezes them on: dazed where they stand, looking, and not fleeing
    stun.stage = 'held';
    stun.timer = stun.hold ?? 3 + peopleRng()*2; // (`hold`, where whatever stunned them says how long)
  });
}

/**
 * Run someone's delight, each frame: gazing at whatever pleased them, then holding still and beaming.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updatePlease(p, dt) {
  updateEffect(p, dt, 'please', (p, please) => {
    // the same hold as stun, but beaming: see pleased in updatePeople
    please.stage = 'held';
    please.timer = 2 + peopleRng()*2;
    if (hasClip('Wave') && !please.medbot) playOnce(p, 'Wave'); // a wave at whatever pleased them (not the MedBot: held still)
  });
}
/**
 * Pick somewhere in a plaza or park to run to, as far as can be found from whatever frightened them.
 * @param {Person} p - the person
 * @param {Hangout} area - the hangout they're in
 * @returns {void}
 */
export function fleeWithin(p, area) {
  let best = null;
  for (let k=0;k<12;k++) {
    const spot = randomSpotIn(area, null, p), d = Math.hypot(spot.x - p.fright.from.x, spot.z - p.fright.from.z);
    if (!best || d > best.d) best = { x: spot.x, z: spot.z, d };
  }
  p.tx = best.x; p.tz = best.z; p.wait = 0; p.swimming = null;
}
/**
 * Kill someone: explode them into giblets in their own colors, and mark them dead - gone from the crowd, with whoever
 * they were talking to carrying on without them. Whoever isn't hearted stays dead only until the crowd next wants
 * their spot: then someone new, with their own name and face, takes it (see updatePeople) - they don't come back.
 * The people around them take it according to how evil they were (see bystandersReactToDeath), the same however they
 * died. The explosive go up too, killing whoever's near. Someone with a respawn left lies shaking instead (reviveInstead).
 * @param {number} i - their index in people
 * @param {'player'|'car'} [by] - who did it, for the morality meter: the Smite button, or a car that ran them over
 * @param {?{x: number, y: number, z: number}} [momentum] - the velocity of whatever hit them, which their giblets keep
 * @param {number} [throwScale] - how much further than `momentum` alone their giblets are thrown (the blood splashed on others goes by `momentum`)
 * @param {?{x: number, z: number}} [source] - what killed them (a car), for the people around to run from
 * @returns {void}
 */
// `source` for damage (core/health.js) may carry killPerson's own: { by, momentum, throwScale, from }
registerHealthKind('person', {
  max: 100,
  die: (p, source) => killPerson(people.indexOf(p), source?.by ?? 'player', source?.momentum ?? null, source?.throwScale ?? 1, source?.from ?? null,
    source?.cause ?? (people.includes(source?.from) ? 'beatentodeath' : 'smited')),
  alive: p => p.mode !== 'dead' && p.mode !== 'none' && p.mode !== 'drowning', // (hearted, revived, or aboard a train)
});
/**
 * The colour of someone's hair (a salon's clippings: see haircutFx in life/giblets.js), or null if they've none.
 * @param {Person} p
 * @returns {?THREE.Color}
 */
export function hairColorOf(p) {
  const i = people.indexOf(p);
  if (!personModel || i < 0 || !personModel.wornLayers.some(layer => layer.look === 'hair' && layer.of[i] >= 0)) return null;
  const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Hair'))*PEOPLE_MAX + i)*4, data = personModel.traitData;
  return new THREE.Color(data[o], data[o+1], data[o+2]);
}
function killPerson(i, by = 'player', momentum = null, throwScale = 1, source = null, cause = 'smited') {
  const p = people[i];
  if (!p || (isGone(p) && !inRoom(p)) || isFavoritePerson(p.id) || p.traits.ghost || p.punched?.revive) return; // (the hearted and ghosts can't be killed: see ui/favorites.js; nor can the shaking, see below)
  if (canRespawn(p) && reviveInstead(p, source ?? (momentum ? { x: p.x - momentum.x, z: p.z - momentum.z } : null))) return;
  // one of six events: what the victim counted as, and which of the two ways they died (see morality.txt)
  App.recordMoralityEvent?.(`${standingOf(p)} peds killed by ${by === 'car' ? 'cars' : 'player'}`, p.name);
  if (by === 'player' && standingOf(p) === 'villainous') App.addEnergy?.(1); // (killing the evil gives energy: see ui/energy.js)
  App.questEvent?.('kill', { p, by }); // (ui/quests.js)
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  endActivity(p);
  p.crossStage = null; // don't leave a car yielding forever for someone who can no longer finish crossing
  p.jc = null;
  // their own body parts, where the model's loaded and they're near enough to see it, else chunks in all their colors
  const thrown = momentum && throwScale !== 1 ? { x: momentum.x*throwScale, y: momentum.y*throwScale, z: momentum.z*throwScale } : momentum;
  const at = { x: p.x, y: p.y, z: p.z }, parts = throwBodyParts(personModel, i, at, thrown);
  const colors = { skin: new THREE.Color(0xf2d33c), top: new THREE.Color(), pants: new THREE.Color(), shoes: new THREE.Color(0x222226), hair: null, eyes: !parts };
  const colorFrom = (part, color) => {
    const o = ((2 + PERSON_TRAIT_COLORS.indexOf(part))*PEOPLE_MAX + i)*4, data = personModel.traitData;
    return color.setRGB(data[o], data[o+1], data[o+2]);
  };
  if (personModel) colorFrom('Skin', colors.skin);
  if (parts) colors.skin = colors.top = colors.pants = colors.shoes = null;
  else if (personModel) {
    colorFrom('Top', colors.top); colorFrom('Pants', colors.pants); colorFrom('Shoes', colors.shoes);
    if (personModel.wornLayers.some(layer => layer.look === 'hair' && layer.of[i] >= 0)) colors.hair = colorFrom('Hair', new THREE.Color());
  } else {
    peopleMesh.getColorAt(i, colors.top);
    colors.pants.copy(colors.top);
  }
  Object.values(colors).forEach(color => color?.isColor && color.lerp(new THREE.Color(0x550000), 0.4)); //make gibs darker, less saturated
  explode(at, 1.7*p.height*S.peopleSize, colors, thrown);
  if (p.wallet > 0) { dropCoins(at, p.wallet); p.wallet = 0; }
  bystandersReactToDeath(p, source);
  witness(p, cause);
  p.mode = 'dead';
  App.crowdChanged?.(); // (saved soon: see project/autosave.js)
  if (p.traits.explosive) { // (a blast killing whoever's around, on the next traffic update: see blasts in life/traffic/state.js)
    blastFx(at, 1.7*p.height*S.peopleSize, 1.5);
    blasts.push({ ...at, scale: PERSON_BLAST_SCALE });
  }
  p.train = null;
  p.indoors = null;
  p.moving = false;
  bloodBurst(p, momentum); // (whoever's near, or in the way of what killed them, is splashed)
}
/**
 * Someone with a respawn left, killed: knocked flat instead (or held there, if they're already down), marked `revive`,
 * so they lie shaking for REVIVE_SHAKE_TIME until lightning strikes them and they get up unharmed (see updatePunched).
 * @param {Person} p - the person
 * @param {?{x: number, z: number}} from - what killed them, to fall away from
 * @returns {boolean} false where they can't be laid down (no model yet, indoors, on a train): they die after all
 */
function reviveInstead(p, from) {
  if (!hasClip('Fall')) return false;
  const k = p.punched;
  if (k && k.stage !== 'marked' && k.stage !== 'brace') { // (already down: fallen, lying, crawling or getting up)
    if (k.stage !== 'fall') holdDown(p);
  } else if (!knockOver(p, from ?? { x: p.x + Math.sin(p.heading), z: p.z + Math.cos(p.heading) })) return false;
  p.revived = true;
  p.punched.revive = true;
  return true;
}
/**
 * Count someone who's drowned (see peopleWater.js) once their body has sunk away: the morality notice, the people around
 * taking it as they would any death, and gone from the crowd — as killPerson, without the blood or giblets.
 * @param {number} i - their index in people
 * @returns {void}
 */
export function drownedPerson(i) {
  const p = people[i];
  App.recordMoralityEvent?.(`${standingOf(p)} peds killed by player`, p.name);
  if (standingOf(p) === 'villainous') App.addEnergy?.(1);
  App.questEvent?.('kill', { p, by: 'player' });
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  bystandersReactToDeath(p);
  witness(p, 'drowned');
  p.water = null;
  p.mode = 'dead';
  App.crowdChanged?.();
  p.train = null;
  p.indoors = null;
  p.moving = false;
}
/**
 * Take someone out of the crowd without killing them, for a crowd thinned past them that has to reach further on for
 * someone hearted: out of sight, as the dead are (so everything that passes over the dead passes over them), until the
 * crowd grows back over them and they're spawned again (see updatePeople).
 * @param {number} i - their index in people
 * @returns {void}
 */
export function benchPerson(i) {
  const p = people[i];
  if (followed === i) stopFollowingPerson();
  if (awaited === i) setAwaited(-1);
  if (riderFollowed === i) setRiderFollowed(-1);
  endActivity(p);
  p.crossStage = null; p.jc = null;
  p.mode = 'dead';
  p.benched = true;
  p.train = null;
  p.indoors = null;
  p.moving = false;
}
/**
 * Someone new (person `id`, wearing their pinned look) born into the crowd near `at` ([x, y, z, heading]): in a dead
 * stranger's slot, else the furthest stranger's from the camera (benched first). For the Ped Builder (ui/ped-builder.js).
 * @returns {number} their slot, or -1
 */
export function addPerson(id, at) {
  const free = i => { const p = people[i]; return !isFavoritePerson(p.id) && !p.miniOf && !presetAt(i) && i !== followed && i !== possession.index && p.mode !== 'possessed'; };
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  let j = -1, far = -1;
  for (let i = 0; i < Math.min(wanted, people.length); i++) {
    if (!free(i)) continue;
    if (people[i].mode === 'dead') { j = i; break; }
    const d = Math.hypot(people[i].x - at[0], people[i].z - at[2]);
    if (d > far) { far = d; j = i; }
  }
  if (j < 0) return -1;
  if (people[j].mode !== 'dead') benchPerson(j);
  endActivity(people[j]);
  const p = newPerson(id);
  p.keptAt = at;
  people[j] = p;
  personModel?.assignAppearance(j, id);
  return j;
}
/**
 * Whether this person is walking over a road (see updateCrossing) — treated like someone standing in the middle of it
 * ('mid') by checkYield in life/traffic/lanes.js: out on the live lanes, not on a sidewalk.
 * @param {Person} p - the person
 * @returns {boolean} whether they're in the road
 */
/**
 * A twin's copy's head (TWIN_LOOK_ROW): at the other while they talk to each other (p.twinGaze: see peopleSpiritChat.js),
 * where the person looks while they're talking to anyone else, else glancing about on its own, as people do.
 * @param {Person} p
 * @param {number} i
 * @param {number} dt
 * @param {boolean} possessed
 * @returns {void}
 */
function lookTwin(p, i, dt, possessed) {
  if (p.twinGaze != null) { p.twinTurnTo = p.twinGaze; p.twinTiltTo = 0; }
  else if (p.lookAt || possessed || p.spiritGaze != null) { p.twinTurnTo = p.lookTurnTo; p.twinTiltTo = p.lookTiltTo; }
  else if ((p.twinLookIn = (p.twinLookIn ?? 0) - dt) <= 0) {
    const { nosy } = p.traits, ahead = peopleRng() < 0.35/nosy, reach = (p.moving ? 0.6 : 1)*Math.min(1.5, Math.sqrt(nosy));
    p.twinLookIn = (1.5 + peopleRng()*4)/nosy;
    p.twinTurnTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TURN*reach;
    p.twinTiltTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TILT;
  }
  const ease = Math.min(1, dt*4), o = (TWIN_LOOK_ROW*PEOPLE_MAX + i)*4, data = personModel.traitData;
  p.twinTurn = (p.twinTurn ?? 0) + ((p.twinTurnTo ?? 0) - (p.twinTurn ?? 0))*ease;
  p.twinTilt = (p.twinTilt ?? 0) + ((p.twinTiltTo ?? 0) - (p.twinTilt ?? 0))*ease;
  if (Math.abs(data[o] - p.twinTurn) + Math.abs(data[o + 1] - p.twinTilt) > 0.005) { data[o] = p.twinTurn; data[o + 1] = p.twinTilt; personModel.traitTexture.needsUpdate = true; }
}
// A ghost is shy: the first SHY_TIMES you come within SHY_NEAR (× people size) — as whoever you're possessing, else the
// camera; or, clicked on, once the camera's done swooping over — they vanish for SHY_FOR seconds (VANISHED_BIT: not drawn, not picked, their card closed), and won't again
// till you've been SHY_NEAR*1.5 off. Not a hearted one (ui/favorites.js).
const SHY_NEAR = 16, SHY_TIMES = 3, SHY_FOR = 60;
// (fading out over SHY_FADE seconds first, and back in after: shyPhase 'out', 'gone', 'in'; how faded, TWIN_LOOK_ROW .w)
const SHY_FADE = 3;
function shyGhost(p, i, possessed) {
  const now = worldNow();
  if (!p.traits.ghost) Object.assign(p, { vanished: false, shyPhase: null });
  else if (p.shyPhase === 'out' && now - p.shyAt >= SHY_FADE) Object.assign(p, { vanished: true, shyPhase: 'gone', vanishUntil: now + SHY_FOR });
  else if (p.shyPhase === 'gone' && now >= p.vanishUntil) Object.assign(p, { vanished: false, shyPhase: 'in', shyAt: now });
  else if (p.shyPhase === 'in' && now - p.shyAt >= SHY_FADE) p.shyPhase = null;
  const fade = p.shyPhase === 'out' ? (now - p.shyAt)/SHY_FADE : p.shyPhase === 'gone' ? 1 : p.shyPhase === 'in' ? 1 - (now - p.shyAt)/SHY_FADE : 0;
  if (personModel) {
    const o = (TWIN_LOOK_ROW*PEOPLE_MAX + i)*4 + 3, data = personModel.traitData, f = Math.max(0, Math.min(1, fade));
    if (data[o] !== f) { data[o] = f; personModel.traitTexture.needsUpdate = true; }
  }
  if (p.shyPhase || possessed || !p.traits.ghost || (p.shyCount ?? 0) >= SHY_TIMES || isFavoritePerson(p.id)) return;
  const you = possession.index >= 0 ? people[possession.index] : camera.position;
  const d = Math.hypot(you.x - p.x, you.y - p.y, you.z - p.z), near = SHY_NEAR*S.peopleSize;
  if (d > near*1.5) p.shyArmed = true;
  // (followed: as soon as the camera's got to them — not on its way)
  const arrived = Math.abs(controls.radius - controls.goalRadius) < 0.02*controls.goalRadius && controls.target.distanceTo(controls.goalTarget) < 0.3*S.peopleSize;
  if (followed === i && possession.index < 0 ? !arrived : d >= near || p.shyArmed === false) return;
  Object.assign(p, { shyPhase: 'out', shyAt: now, shyCount: (p.shyCount ?? 0) + 1, shyArmed: false });
  if (followed === i) stopFollowingPerson();
}
/** How much further someone's reached standing: a twin's other half, beside them (see TWIN_GAP), else 0. World units. */
export const twinReach = p => p.traits?.twins ? 2*TWIN_GAP*1.7*p.height*S.peopleSize : 0;
export function isPedInDanger(p) {
  return p.crossStage === 'jcross' || p.crossStage === 'half1' || p.crossStage === 'half2' || (p.mode === 'possessed' && p.onRoad);
}
const PUSH_DECAY = 6; // per second: how fast a push slows, so it covers its distance in about half a second
/**
 * Shove someone `distance` along (dirX, dirZ): they're sent off fast, easing to a stop, rather than jumping. A wanderer's
 * destination moves with them.
 * @param {Person} p - the person
 * @param {number} dirX - direction, not necessarily unit length
 * @param {number} dirZ
 * @param {number} distance - how far they end up moved, in world units
 * @returns {void}
 */
function pushPerson(p, dirX, dirZ, distance) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || distance <= 0 || p.traits.ghost) return; // (nothing shoves a ghost)
  const speed = distance*PUSH_DECAY/len; // (the distance covered is the starting speed over the decay rate)
  p.push = { x: (p.push?.x ?? 0) + dirX*speed, z: (p.push?.z ?? 0) + dirZ*speed };
}
const PUSH_BOUNCE = 0.5; // (the share of speed into a wall or car someone knocked flat bounces back with)
function stepPush(p, dt) {
  const to = { x: p.x + p.push.x*dt, z: p.z + p.push.z*dt };
  const lying = p.punched && p.punched.stage !== 'marked' && p.punched.stage !== 'brace'; // (see isLying in traffic/collisions.js)
  const hit = lying ? App.bouncePerson?.(p, to, Math.hypot(p.push.x, p.push.z)) : null;
  const x0 = p.x, z0 = p.z;
  p.x = to.x; p.z = to.z;
  if (lying) slideOff(p, x0, z0); // (over a fence, or off a raised edge: see peopleFall.js)
  if (hit) {
    const { n, depth } = hit, into = p.push.x*n.x + p.push.z*n.z;
    if (into < 0) { p.push.x -= (1 + PUSH_BOUNCE)*into*n.x; p.push.z -= (1 + PUSH_BOUNCE)*into*n.z; }
    p.x += n.x*depth; p.z += n.z*depth; // (back out of it)
  }
  const slowing = Math.exp(-PUSH_DECAY*dt);
  p.push.x *= slowing; p.push.z *= slowing;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
  if (Math.hypot(p.push.x, p.push.z) < 0.05) p.push = p.bounced = null;
}

/**
 * What the people module hands the rest of the app: the World panel's controls, picking and following someone, possessing
 * them, swinging a punch and killing them — and, for poking at from the browser console, the crowd and its conversations.
 */
Object.assign(App, { twinReach, witnessPerson: witness, witnessAt, feelPerson: feel, pushPerson, syncPeopleUI, pickPerson, followPersonAt, followPerson, followPersonInside, stopFollowingPerson, possessPerson, unpossessPerson, punchFromPossession, useFromPossession, killPerson, knockOverPerson: knockOver, knockAgainPerson: knockAgain, personHeight, people, peopleGroups: groups, followedPerson: () => followed, peopleClock: () => lastPeopleTime });

/**
 * Run the crowd for one frame: keep the numbers right, rebuild the walkways when the map has changed, and move everyone
 * — walking, crossing, talking, sitting, punching, riding the trains, going indoors, being possessed — then write it all
 * out to the instanced meshes and the shader's attributes, and put the camera where it's following.
 *
 * The dt is clamped, so a tab left in the background doesn't teleport everyone across the map on the frame it comes back.
 * @param {number} t - the time now, in seconds
 * @returns {void}
 */
export function updatePeople(t) {
  const dt = lastPeopleTime == null ? 0 : Math.min(0.1, Math.max(0, t - lastPeopleTime));
  setLastPeopleTime(t);
  if (followed >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingPerson();
  if (followedInside && !App.isInsideBuilding()) stopFollowingPerson(); // (picked in a room since left)
  peopleMesh.visible = S.peopleEnabled && !personModel;
  // (shown under the loading screen too, so their shaders are compiled there rather than on first switching peds on)
  const shown = S.peopleEnabled || stillLoading();
  if (personModel) { [personModel, ...personModel.hair].forEach(part => { part.mesh.visible = shown; }); personModel.censor.visible = shown; [...personModel.spirits, ...personModel.spiritWorn].forEach(m => { m.visible = shown; }); personModel.time.value = worldNow(); }
  peopleNavDebugMesh.visible = S.peopleEnabled && S.showPeopleNavDebug;
  if (!S.peopleEnabled) { showPassengers(); showInhabitants(); updateFlies(0); return; }
  pruneGone(people, t, forgetLinesExcept); // (relations and recent lines of the gone)
  // (everyone held still where they are while the held-items debug window poses someone: see ui/held-debug.js)
  if (S.peopleFrozen) { S.peopleFrozen(); return; }
  if (S.netGuest) { mirrorCrowd(); return; } // (multiplayer: the host's crowd, as sent — see peopleMirror.js)
  if (!peopleNav || (S.peopleNavDirty && t - peopleNavBuiltAt > 0.25 && !navRebuildOnHold())) {
    S.peopleNavDirty = false;
    setPeopleNavBuiltAt(t);
    // whatever anyone was doing stops, as the benches and grass they were using may have gone
    groups.length = 0;
    people.forEach(p => { p.group = null; p.crossStage = null; p.jc = null; p.faceTo = null; endActivity(p); });
    setPeopleNav(buildPeopleNav());
    people.forEach(reseatPerson);
  }
  if (S.showPeopleNavDebug && peopleNavDebugBuiltAt !== peopleNavBuiltAt) { setPeopleNavDebugBuiltAt(peopleNavBuiltAt); rebuildPeopleNavDebug(); }
  // (the hearted are never let go of: the crowd reaches at least as far as the last of them, and anyone past `wanted`
  // who isn't hearted is benched — out of sight, as the dead are, until the crowd grows back over them. See
  // ui/favorites.js. Anyone killed and not hearted is out for good: once their spot is wanted again, someone new is
  // born into it below — a fresh id, so they don't come back as themselves. See newPerson, and assignAppearance in
  // peopleModel.js. A hearted id missing from the crowd altogether — a reload hasn't reached their spot yet — is
  // revived into a new spot with their own saved id, rather than waiting to be spawned like anyone else.)
  // (a saved crowd come in — see peopleKeep.js — replaces this one: its people are born below, in their saved order)
  if (takeReset()) { stopFollowingPerson(); setRiderFollowed(-1); while (people.length) endActivity(people.pop()); }
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  const presentIds = new Set(people.map(p => p.id));
  const missingFavoriteIds = favoritePeople().filter(id => !presentIds.has(id));
  let highestFavoriteSlot = -1;
  for (let i = 0; i < people.length; i++) if (isFavoritePerson(people[i].id)) highestFavoriteSlot = i;
  const kept = Math.min(PEOPLE_MAX, Math.max(wanted, highestFavoriteSlot + 1, people.length + missingFavoriteIds.length));
  while (people.length < kept) {
    // (someone saved, in order, while the crowd's short of `wanted`; past it, a hearted id waiting to be found again;
    // else a fresh one)
    let kp = people.length < wanted || !missingFavoriteIds.length ? nextKept(presentIds) : null;
    if (kp) { const at = missingFavoriteIds.indexOf(kp.id); if (at >= 0) missingFavoriteIds.splice(at, 1); }
    else if (missingFavoriteIds.length) kp = takeKept(missingFavoriteIds.shift());
    const p = bornPerson(kp);
    presentIds.add(p.id);
    personModel?.assignAppearance(people.length, p.id);
    spawnPerson(p);
    placeKept(p);
    people.push(p);
  }
  while (people.length > kept) endActivity(people.pop());
  for (let i = wanted; i < people.length; i++) if (!people[i].benched && !isFavoritePerson(people[i].id) && !people[i].miniOf) benchPerson(i); // (minis live past the crowd's count: see peopleMinis.js)
  for (let i = 0; i < Math.min(wanted, people.length); i++) {
    const p = people[i];
    if (p.benched) { p.benched = false; p.mode = 'none'; } // (the same person, off the bench: spawned again below)
    else if (p.mode === 'dead' && !isFavoritePerson(p.id)) { people[i] = bornPerson(nextKept(presentIds)); presentIds.add(people[i].id); personModel?.assignAppearance(i, people[i].id); } // (someone new, spawned again below)
  }
  if (followed >= people.length) stopFollowingPerson();
  if (riderFollowed >= people.length) setRiderFollowed(-1);
  peopleMesh.count = people.length;
  roadsafetyDebugMesh.visible = roadsafetyHalfDebugMesh.visible = pedHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) roadsafetyDebugMesh.count = roadsafetyHalfDebugMesh.count = pedHitboxDebugMesh.count = people.length;
  setIndoorsCount(people.reduce((n, p) => n + (p.mode === 'indoors' ? 1 : 0), 0));
  if (personModel) {
    personModel.mesh.count = personModel.censor.count = people.length;
    personModel.hair.forEach(style => { style.mesh.count = countBelow(style.members, people.length); });
    updateGroups(dt);
    meetOnWalkways(dt);
    pickFights(dt);
  }
  avoidSmells(dt); // (everyone keeps clear of anyone who smells: see peopleSmell.js)
  keepOutOfWindows(); // (nor walks through the windows of the room the view's in: see peopleWindows.js)
  updateFlies(dt);
  // whoever's been knocked down and is still on the ground (or getting up): nobody walks into them
  updateArrivingBlood(dt);
  // whatever status effects have run out come off here, and those people's traits go back as they were, before anything
  // below reads a trait they were moving (see life/statuseffects.js: a coffee's pick-me-up, and whatever else a source
  // hands out)
  if (people.some(p => p.status?.length)) updateStatusEffects(people, t);
  const lyingDown = people.filter(q => q.punched && q.punched.stage !== 'marked' && q.punched.stage !== 'brace');
  // (with more than a few down, each step looks only at those it could come near; with a few, it looks at them all)
  const lyingNear = lyingDown.length > 8 ? crowdGrid(lyingDown) : null;
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  peopleFrame++;
  const carded = App.cardedPeople?.() ?? []; // (anyone with a card open: posed in full, as its headshot's close up)
  beginEmotes();
  sweepPrayers();
  updateMinis(dt, wanted); // (pipers' minis: made, followed, avenged — see peopleMinis.js)
  const frameDt = dt;
  let phones = null, phonesNear = HEADPHONE_REACH; // (the nearest headphones heard: see pub-music.js)
  people.forEach((p, i) => {
    if (lazyNow(p, i, carded)) { p.lazyDt = (p.lazyDt ?? 0) + frameDt; if (personModel && p.lazyPx > 0 && p.glideVX != null) glide(p, i); return; }
    const dt = frameDt + (p.lazyDt ?? 0);
    p.lazyDt = 0;
    const wasX = p.x, wasZ = p.z; // (for how fast they were going, should they walk into the water: see updateWater)
    if (p.mode === 'none' && (peopleNav.lines.length || peopleNav.areas.length)) { spawnPerson(p); placeKept(p); }
    // (what their traits make of them, checked every THINK_EVERY frames: see THINK_EVERY)
    const thinks = (peopleFrame + i) % THINK_EVERY === 0 || p.traitsKey == null || p.groomKey == null || i === followed || i === possession.index || carded.includes(i);
    if (thinks) refreshTraits(p, i);
    if (thinks && (p.skinKey !== skinKeyOf(p) || p.spectralKey !== spectralOf(p))) tintSkin(p, i); // (a keepsake or status that's just moved the skin's traits: see tintSkin)
    if (p.traits.ghost || p.shyPhase) shyGhost(p, i, p.mode === 'possessed'); // (gone when you come near, the first few times)
    // (the bald and beard traits: their hair and facial hair as they say — see groom in peopleModel.js; and what shows, for speech)
    if (thinks && personModel) {
      const bald = Math.sign(Math.round(p.traits.bald)), beard = Math.sign(Math.round(p.traits.beard)), groomKey = p.id*9 + (bald + 1)*3 + beard + 1;
      if (p.groomKey !== groomKey) { p.groomKey = groomKey; personModel.groom(i, p.id, bald, beard); }
      const head = personModel.headOf(i); p.showsBald = head.bald; p.showsBeard = head.bearded;
    }
    if (thinks && personModel && (p.traits.singing > 0) !== !!p.headphones) { p.headphones = p.traits.singing > 0; personModel.setHeadphones(i, p.headphones); } // (the 🎵 mood)
    if (p.headphones && !isGone(p)) { const d = Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z); if (d < phonesNear) { phonesNear = d; phones = p; } }
    if (thinks && personModel && !!p.traits.nude !== !!p.nudeDressed) { p.nudeDressed = !!p.traits.nude; personModel.setNude(i, p.id, p.nudeDressed); } // (see peopleCensor.js)
    if (thinks && personModel && p.headDrawn !== p.traits.headsize) { p.headDrawn = p.traits.headsize; personModel.traitData[(HAIR_ROW*PEOPLE_MAX + i)*4 + 3] = p.headDrawn; personModel.traitTexture.needsUpdate = true; } // (see personLook)
    if (p.traits.nude && (p.mode === 'line' || p.mode === 'wander') && (p.nudeSeenIn = (p.nudeSeenIn ?? 0) - dt) <= 0) { witness(p, 'nude'); p.nudeSeenIn = NUDE_SEEN_EVERY; }
    if (personModel && p.traits.bodiless) { // (a bodiless head hops while they move: see personBodiless in peopleModel.js)
      const o = (TWIN_LOOK_ROW*PEOPLE_MAX + i)*4 + 2, data = personModel.traitData;
      p.headHop = p.hop?.h > 0 ? 0 : (p.headHop ?? 0) + ((p.moving && !p.punched && !isGone(p) ? 1 : 0) - (p.headHop ?? 0))*Math.min(1, dt*6); // (not knocked down or dead either) // (not mid-jump, possessed: a double jump)
      const hop = p.headHop < 0.02 ? 0 : p.headHop;
      if (Math.abs(data[o] - hop) > 0.02 || (!hop && data[o])) { data[o] = hop; personModel.traitTexture.needsUpdate = true; }
    }
    if (thinks && !p.pocketsStocked) stockPockets(p, i); // (the sunglasses they came in: see life/gifts.js)
    if (p.blood) updateBlood(p, dt, i);
    if (p.traits.erratic > 0 || p.erraticShift) updateErratic(p, dt);
    p.trainCooldown -= dt;
    p.snackCooldown -= dt;
    p.indoorsCooldown -= dt;
    const possessed = p.mode === 'possessed';
    if (possessed && !p.remote) possession.alwaysForward = rushed(p); // (W and Shift held for good)
    if (p.push) stepPush(p, dt);
    if (possessed) p.fright = p.stun = p.please = null;
    else if (p.traits.ghost) p.fright = p.stun = null; // (nothing frightens or stuns a ghost)
    if (p.fright) updateFright(p, dt);
    // terrified: never stop fleeing — each flee ended starts another, from just behind them, so they carry on the way they were going
    if (p.traits.terrified && (p.mode === 'line' || p.mode === 'wander') && !p.fright && !p.punched && !inWater(p)) beginFleeing(p, { x: p.x - Math.sin(p.heading), z: p.z - Math.cos(p.heading) });
    if (!possessed && hidingFromSun(p)) hideFromSun(p);
    else if (p.sunRun) p.sunRun = false;
    if (!possessed && p.mode === 'wander' && !p.punched && !p.fright && !p.attack && !inWater(p) && shelteringFromRain(p) && !isUnderCover(peopleNav.areas[p.area])) { if (p.act) endActivity(p); leaveArea(p, peopleNav.areas[p.area]); }
    //attempting to give additional reactions to npc death depending on how evil they are
    if (p.stun) updateStun(p, dt); //Should freeze bystanders and turn them to face, currently interrupts their actions without freezing or turning
    if (p.please) updatePlease(p, dt); // (the same hold as stun, read as delight: see pleased below)
    if (p.punched) updatePunched(p, dt);
    if (p.fellOff && !p.punched && !p.fall) { p.fellOff = undefined; reseatPerson(p); } // (up again below where they fell from)
    updatePrayer(p, i, dt, possessed); // (standing still, glowing: see peoplePrayer.js)
    const prays = !!p.pray;
    // frozen in place: fright's 'look' stage, or stun/please's 'held' stage. only fright ever flees.
    const frozen = (!!p.fright && p.fright.stage === 'look')
                || (!!p.stun && p.stun.stage === 'held')
                || (!!p.please && p.please.stage === 'held')
                || (!!p.punched && p.punched.stage !== 'marked') // (braced for a punch, knocked down, or getting up)
                || inWater(p) // (going into the water, or drowned: see peopleWater.js)
                || prays;
    const fleeing = !!p.fright && p.fright.stage === 'flee';
    // pleased: looking at it and then held still, beaming. The same 'look' and 'held' stages as stun — the ones
    // updatePeople freezes them on — read as delight rather than shock, below.
    const pleased = !!p.please && (p.please.stage === 'look' || p.please.stage === 'held');
    let speed = PERSON_WALK_SPEED*S.peopleSpeed*p.stride*(p.traits.speed + bloodSpeed(p))*bloodlustSpeed(p)*(fleeing || p.traits.terrified ? FLEE_SPEED*p.traits.boost : 1) // (terrified: always at a run)
      *(fleeing && p.sunRun ? SUN_RUN_BOOST : 1)*(!fleeing && shelteringFromRain(p) ? RAIN_HURRY : 1);
    let goal = null;
    //Updating hair colour depending on age
    //set default hair colour once
    if ((p.defaultHair === undefined) && personModel) {
      const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Hair'))*PEOPLE_MAX + i)*4, data = personModel.traitData;
      const hairColor = new THREE.Color().setRGB(data[o], data[o+1], data[o+2]);
      p.defaultHair = hairColor;
      //TO DO: If birthdays added, break this block into two; below repeated after check for newBirthday boolean
      //Saving default hair future proofs against hair collapsing to white, but as is this should only run once anyways.
      const greyAmount = p.traits.bleach ? 2 :
        p.traits.ageless ? 0 : 
          Math.max(0, Math.min(1, (p.age - 30) / (100))); // tweak range to taste
      const newHair =  p.defaultHair.clone().lerp(new THREE.Color(0xffffff), greyAmount);
      data[o] = newHair.r; data[o+1] = newHair.g; data[o+2] = newHair.b;
      // the whites of the eyes yellow for vampires (more with age) and redden for the blazed; the black of them is left alone
      const e = ((2 + PERSON_TRAIT_COLORS.indexOf('Eyes'))*PEOPLE_MAX + i)*4;
      const eyes = new THREE.Color().setRGB(data[e], data[e+1], data[e+2]);
      if (p.traits.vampire) eyes.lerp(VAMPIRE_EYE_COLOR, Math.min(1, VAMPIRE_EYE_TINT*(1 + p.age/100)));
      if (p.traits.blazed) eyes.lerp(EYE_RED_COLOR, BLAZED_EYE_RED);
      data[e] = eyes.r; data[e+1] = eyes.g; data[e+2] = eyes.b;
      p.eyeBase = [eyes.r, eyes.g, eyes.b]; // (what bloodlust's eyes go back to: see stain in peopleBlood.js)
      // (the skin their traits give them is written by tintSkin, above)
    }
    // (on an escalator, they stand and are carried at its pace: see roads/mall.js)
    const onLine = p.mode === 'line' && !possessed && !p.jc && (!p.act || (p.act === 'walk' && !p.follow)) && peopleNav.lines[p.li];
    const riding = onLine?.escalator && p.seg < onLine.beltEnd ? onLine.escalator : 0; // (off its foot, they walk on)
    if (riding) speed = riding*S.peopleSpeed;
    // (stopped to talk, or frozen in shock, someone on a walkway stays put; walking with someone, they keep beside them: below)
    if (p.mode === 'line' && p.act !== 'chat' && !p.follow && !frozen && !p.attack && !p.swat) {
      if (!p.jc && !p.act) maybeBuyOnWalkway(p, dt); // (stepping off to a hot dog or coffee stall: see peopleStalls.js)
      if (!p.jc && !p.act) maybeCrossRoad(p, peopleNav.lines[p.li], dt);
      if (p.act === 'buy') {
        goal = updateBuying(p, dt, walkwayPoint(p).y);
      } else if (p.jc) {
        goal = updateCrossing(p, dt, speed); // (null while waiting for a gap in traffic)
        if (isPedInDanger(p)) speed *= CROSS_SPEED_MULT; // an increased pace, crossing
      } else {
        walkAlong(p, (riding ? riding*S.peopleSpeed : speed*(p.act === 'walk' ? WALK_PACE : 1))*dt);
        if (p.mode === 'line') goal = walkwayPoint(p);
      }
    }
    if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      if (p.act && p.act !== 'walk') {
        goal = updateActivity(p, area, dt);
      } else if (p.follow) {
        // (walking with someone: beside them, below)
      } else if (p.fright || p.stun || p.please || p.attack || p.swat || frozen) {
        // Frightened, stunned or pleased. Fright runs off further each time they reach where they were running to;
        // stun and please hold position through the `frozen` guard below, with no movement of their own.
        if (fleeing) {
          p.fleeInArea = (p.fleeArea === p.area ? p.fleeInArea ?? 0 : 0) + dt;
          p.fleeArea = p.area;
          if (wantsOut(p) && leaveArea(p, area, p.fright.from)) { /* heading out */ }
          else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.5) fleeWithin(p, area);
        }
      } else if (p.wait > 0 || p.oneShot) {
        p.wait -= dt;
      } else if (p.swimming === 'going' && Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.swimming = 'in'; p.wait = (SWIM_TIME[0] + peopleRng()*(SWIM_TIME[1] - SWIM_TIME[0]))*p.traits.patience;
      } else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.swimming = null;
        p.wait = (1 + peopleRng()*9)*p.traits.patience;
        // What next, weighted by their traits: leaving, sitting down, lying down, going over to talk to someone, going
        // over to someone else, somewhere else in the same hangout, a train, or something from a stall.
        const { lounging, chatty } = p.traits;
        const stations = p.trainCooldown <= 0 ? stationLinks().byArea.get(p.area) : null;
        const stalls = !p.snack && p.snackCooldown <= 0 && hasStallIn(area);
        // (someone drinking where there's a beer stall stays for another rather than moving on: see peopleStalls.js)
        const round = drinking(p) && hasStallIn(area, 'beer');
        // (walking and talking with someone, only about the place or out of it: free = 0)
        const free = p.act ? 0 : 1;
        const next = ['leave', 'sit', 'lie', 'chat', 'friend', 'roam', 'train', 'buy', 'swim'][pickWeighted([area.exits.length ? (round ? 0.03 : 0.2) : 0, 0.16*lounging*free, 0.08*lounging*free, 0.18*chatty*free*(area.kind === 'plaza' ? PLAZA_CHAT : 1), 0.13, 0.25, stations && !round ? 0.12*free : 0, stalls ? (round ? 0.6 : 0.15)*free : 0, onWater(p) ? SWIM_WEIGHT*free : 0], w => w)];
        if (next === 'swim' && goSwim(p, area)) {
          // off for a swim (waterwalking/aqua)
        } else if (next === 'buy' && goBuy(p, area)) {
          // over to a hot dog, coffee or beer stall (see peopleStalls.js)
        } else if (next === 'train' && stations) {
          // over to a train station standing in here
          const node = stations[Math.floor(peopleRng()*stations.length)], st = getTrainStations().get(node);
          goRideTrain(p, node, { x: st.x, y: area.y, z: st.z });
        } else if (next === 'leave' && leaveArea(p, area)) {
          // off to the nearest of a few of the hangout's entrances
        } else if (next === 'sit' && goSit(p, area)) {
          // off to a bench, or to sit on the grass
        } else if (next === 'lie' && goLieDown(p, area)) {
          // off to lie down on the grass
        } else if (next === 'chat' && goChat(p, area)) {
          // over to talk to someone
        } else if (next === 'friend') {
          // over to someone else hanging out here
          let friend = null;
          for (let k=0;k<8 && !friend;k++) { const q = people[Math.floor(peopleRng()*people.length)]; if (q !== p && q.mode === 'wander' && q.area === p.area) friend = q; }
          const over = friend ? { x: friend.tx + (peopleRng()-0.5)*3, z: friend.tz + (peopleRng()-0.5)*3 } : null;
          const spot = over && insideFor(area, p)(over.x, over.z) ? reachableSpot(area, p, over.x, over.z) : null;
          if (spot) { p.tx = spot.x; p.tz = spot.z; } else { const s = randomSpotIn(area, p); p.tx = s.x; p.tz = s.z; }
        } else {
          const s = randomSpotIn(area, null, p); p.tx = s.x; p.tz = s.z;
        }
      }
      if (p.mode === 'wander' && (!p.act || p.act === 'walk') && !frozen && !p.attack) goal = { x: p.tx, y: area.y, z: p.tz };
    }
    if (p.mode === 'train') {
      goal = updateTrainRider(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.mode === 'indoors') {
      goal = updateIndoors(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.swat && !p.attack) goal = frozen || p.punched ? null : updateSwat(p, dt); // (after a bee: see peopleActivities.js)
    if (p.attack) {
      goal = updateAttack(p, dt);
      if (p.attack?.stage === 'chase') speed *= PUNCH_CHASE_SPEED;
    }
    if (possessed) {
      if (frozen) cancelSwing(); // (knocked down: no walking, no punching)
      else { goal = walkPossessed(p, dt); if (!p.remote) updateSwing(p, dt); } // (p.remote: a multiplayer guest's, see possessRemote)
    }
    if (p.mode === 'leaving') {
      // already placed on their walkway by joinWalkway; once they've reached it they carry on along it
      goal = frozen ? null : p.exit;
      if (Math.hypot(p.exit.x - p.x, p.exit.z - p.z) < 0.5) p.mode = 'line';
    }
    // walking with someone: beside them, going where they go (see "walking together" in peopleActivities.js)
    if (p.follow) goal = frozen ? null : p.miniOf ? miniSpot(p) : besideLeader(p); // (a piper's mini: in formation, see peopleMinis.js)
    if (p.fetch && !possessed && !p.attack && !p.swat) goal = frozen ? null : p.fetch; // (back for something they dropped: see peopleHolding.js)
    // in a plaza, walk around its fountain rather than through the pool: while the straight line to where they're going
    // passes over it, head instead for the point on its rim nearest that line — which moves round as they do
    const hangout = (p.mode === 'wander' || p.mode === 'leaving') && p.area >= 0 ? peopleNav.areas[p.area] : null;
    if (goal && hangout && hangout.fountain) {
      const f = hangout.fountain, clearance = f.r + 1.2;
      const c = closestPointOnSegment(f, p, goal);
      let dx = c.x - f.x, dz = c.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < clearance) {
        if (d < 1e-3) { dx = -(goal.z - p.z); dz = goal.x - p.x; }
        const len = Math.hypot(dx, dz) || 1;
        goal = { x: f.x + dx/len*(clearance + 0.3), y: goal.y, z: f.z + dz/len*(clearance + 0.3) };
      }
    }
    if (inWater(p)) goal = null; // (the water has them: see peopleWater.js)
    // walk towards where they should be — faster if they've fallen behind (cutting across at a junction, say)
    p.moving = false;
    p.stepped = 0;
    if (goal) {
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
      const keepingUp = p.follow || (p.mode === 'line' && !p.crossStage && !p.attack && (!p.act || p.act === 'walk'));
      const step = possessed ? d : speed*dt*(keepingUp ? 1 + Math.min(2, d*0.5) : 1);
      const k = d > 1e-4 ? Math.min(1, step/d) : 0, mx = dx*k, mz = dz*k;
      // (anyone just walking waits where they are until whoever it is is up: a step that would take them nearer, inside LYING_CLEARANCE, isn't taken — but not someone going after someone, or running from them)
      const blocked = !possessed && !p.attack && !fleeing && lyingDown.length > 0 && (lyingNear ? lyingNear.near(p.x + mx, p.z + mz, LYING_CLEARANCE*S.peopleSize).map(k => lyingDown[k]) : lyingDown).some(q => {
        if (q === p) return false;
        const after = Math.hypot(q.x - (p.x + mx), q.z - (p.z + mz));
        return after < LYING_CLEARANCE*S.peopleSize && after < Math.hypot(q.x - p.x, q.z - p.z);
      });
      // (nobody walks into the water of their own accord: along the bank if they can, else they stop and think again)
      let sx = mx, sz = mz;
      if (!blocked && !possessed && d > 1e-4 && wouldWade(p, sx, sz)) {
        if (!wouldWade(p, sx, 0)) sz = 0;
        else if (!wouldWade(p, 0, sz)) sx = 0;
        else { sx = sz = 0; stopAtBank(p, dt); }
      }
      if (d > 1e-4 && !blocked && (sx || sz)) {
        const mx = sx, mz = sz;
        p.x += mx; p.z += mz;
        // which way they face, and whether they're walking, go by how far they actually moved this frame — someone
        // keeping pace with their walkway is always right on top of the point they're heading for
        if (Math.hypot(mx, mz) > (possessed ? 1e-3 : speed*dt*0.25)) {
          const facing = Math.atan2(mx, mz) + moonwalkTurn(p); // (or away from it, walking backwards)
          if (!possessed) p.heading += Math.atan2(Math.sin(facing - p.heading), Math.cos(facing - p.heading))*Math.min(1, dt*8);
          p.moving = true;
          p.stepped = riding ? 0 : Math.hypot(mx, mz); // (carried, they take no steps)
        }
      }
      p.y += (goal.y - p.y)*Math.min(1, dt*6);
      if (possessed && p.hop?.h > 0) p.y = goal.y + p.hop.h; // (jumping: see walkPossessed)
    }
    if (p.fall) stepFall(p, dt); // (see peopleFall.js)
    updateWater(p, i, dt, wasX, wasZ, goal ? goal.y : null); // (over open water, they go in — or waterwalking/aqua, stand or swim on it: see peopleWater.js)
    updateDrunk(p, dt, wasX, wasZ); // (weaving, and now and then falling over: see peopleDrunk.js)
    // possessed, the body goes the way the keys walk them (backing off, still facing ahead: the walk played backwards);
    // the head turns to the view, as far as it goes, the body coming round after it past that
    if (possessed && !frozen) {
      const { forward, right } = p.remote ?? controlInput(), yaw = p.remote?.yaw ?? possession.yaw, back = forward < 0 ? -1 : 1;
      if (p.moving && (forward || right)) {
        const want = yaw + Math.atan2(-right*back, forward*back) + moonwalkTurn(p);
        p.heading += wrapAngle(want - p.heading)*Math.min(1, dt*8);
      }
      const off = wrapAngle(yaw - p.heading);
      if (Math.abs(off) > LOOK_MAX_TURN) p.heading = yaw - Math.sign(off)*LOOK_MAX_TURN;
      if (p.moving && back < 0 !== !!moonwalkTurn(p)) p.stepped = -p.stepped;
    }
    // standing still for something (talking, sitting down), they turn to face the way it wants
    if (!p.moving && p.faceTo != null) p.heading += wrapAngle(p.faceTo - p.heading)*Math.min(1, dt*5);
    if (personModel) {
      const clipSet = personModel.clips, s = isDrawn(p) ? modelScale(p) : 0;
      // a cycle of the walk for every stride's worth of ground covered, as big as they are (played in reverse, backwards)
      if (s > 0) {
        const was = p.walkCycle;
        p.walkCycle = (p.walkCycle + (p.traits.backwards ? -1 : 1)*p.stepped/(personModel.stride*s) + 1) % 1;
        // a foot comes down STEPS_PER_CYCLE times a cycle, from FOOTFALLS on: each is heard (see audio/footsteps.js)
        const step = c => Math.floor(((c - FOOTFALLS + 1) % 1)*STEPS_PER_CYCLE); // (wrapped, so the cycle coming round isn't a step of its own)
        if (p.moving && step(was) !== step(p.walkCycle)) footstep({ x: p.x, y: p.y, z: p.z }, p.traits.weight);
      }
      p.idleTime += dt;
      // standing about with nothing to do for a while, now and then a scratch or a think
      if (p.moving) {
        p.stillFor = 0;
      } else if (!p.act && !p.oneShot && !p.fright && p.pose === 'Idle') {
        p.stillFor += dt;
        if (p.traits.fidgety > 0 && p.stillFor > p.fidgetAfter/p.traits.fidgety) { const fidget = pickFrom(FIDGETS); playOnce(p, fidget); p.fidgetThought = THINK_FIDGETS.includes(fidget); p.stillFor = 0; p.fidgetAfter = 3 + peopleRng()*8; }
      }
      // the animation: one playing through once, else walking, else the pose they're in — blending into it from the last
      if (p.oneShot) {
        p.shotTime += dt*(p.shotRate ?? 1);
        if (p.shotTime >= (p.oneShot.frames - 1)/PERSON_BAKE_FPS) {
          if (p.oneShot.name === 'Fall' && p.punched?.stage === 'fall') landFall(p);
          p.oneShot = null;
        }
      }
      if (!p.clipA) { p.clipA = p.clipB = clipSet.Idle; p.fade = 1; }
      // (and with a hot dog or a coffee in hand, a version of it holding that: see peopleHolding.js)
      if (p.oneShot && p.snack && (p.punched || p.mode === 'dead')) snackClip(p, clipSet.Idle, 0); // (knocked from their hand at once, mid-fall)
      setClip(p, p.oneShot || snackClip(p, p.moving && !riding ? clipSet.Walk : clipSet[p.pose] || clipSet.Idle, dt));
      p.fade = Math.min(1, p.fade + dt/p.fadeTime);
      // whatever the clip has happening as it comes round: a key struck (see audio/typing.js), or a moment of a meal
      // (see peopleHolding.js)
      if (p.clipA.taps && p.fade > 0.9) {
        const loop = p.clipA.duration, was = (p.idleTime - dt) % loop, now = p.idleTime % loop;
        for (const tap of p.clipA.taps) {
          if (!(now >= was ? tap.time > was && tap.time <= now : tap.time > was || tap.time <= now)) continue;
          if (tap.cue) mealCue(p, tap.cue);
          else keyClick({ x: p.x + Math.sin(p.heading)*0.4, y: p.y + 0.75, z: p.z + Math.cos(p.heading)*0.4 }, tap.space);
        }
      }
      const blend = key => p.clipA[key]*p.fade + p.clipB[key]*(1 - p.fade);
      // (feet planted while they sit, lie or get up: see feetOf)
      if (p.feet && (p.moving || (!p.oneShot && p.fade >= 1 && !p.clipA.pose && !p.clipA.anchor))) p.feet = null;
      if (p.feet) {
        const ms = modelScale(p), offX = blend('pelvisX')*ms, offZ = blend('pelvisZ')*ms, sin = Math.sin(p.heading), cos = Math.cos(p.heading);
        p.x = p.feet.x + offX*cos + offZ*sin; p.z = p.feet.z + offZ*cos - offX*sin;
      }
      p.heightScale = blend('heightScale');
      // how much of them there is to see (see FINE_EVERY): the one followed or controlled always in full, and anyone not
      // drawn at all as out of view. Out of view, they're left where they were last put — so long as that was out of view too.
      const pixels = i === followed || i === possession.index || carded.includes(i) ? Infinity : s <= 0 ? -1 : personPixels(p.x, p.y, p.z, 1.7*p.height*S.peopleSize);
      const fineTurn = (peopleFrame + i) % FINE_EVERY === 0, out = pixels < 0;
      const placed = !(out && p.placedOut && !fineTurn), faced = fineTurn || pixels >= PERSON_FACE_PIXELS, worn = placed && (fineTurn || pixels >= PERSON_WORN_PIXELS);
      p.faceDt = (p.faceDt ?? 0) + dt;
      const fdt = faced ? p.faceDt : 0;
      if (faced) p.faceDt = 0;
      if (placed) {
        p.placedOut = out;
        // the model, scaled to the same height as a cuboid person — set back by however far their pose puts their pelvis from
        // their feet, and sat on a bench, up on its seat
        const offX = blend('pelvisX')*s, offZ = blend('pelvisZ')*s, sin = Math.sin(p.heading), cos = Math.cos(p.heading);
        rotation.setFromAxisAngle(up, p.heading);
        const faceDown = turnInWater(p, rotation), crawlLift = turnCrawling(p, rotation); // (tipped, rocked or face down in the water: see peopleWater.js; face down crawling: see peopleRoad.js)
        position.set(p.x - offX*cos - offZ*sin, faceDown ? p.y : crawlLift != null ? p.y + crawlLift : p.y + p.seatLift*sitWeight(p) - personModel.minY*s, p.z + offX*sin - offZ*cos);
        if (p.punched?.revive && p.punched.stage === 'down') shake(position, rotation, PERSON_SHAKE*S.peopleSize); // (dead, before the bolt: see reviveInstead)
        sway(p, position, rotation);
        matrix.compose(position, rotation, scale.set(s, s, s));
        personModel.mesh.setMatrixAt(i, matrix);
        const vx = (p.x - wasX)/dt, vz = (p.z - wasZ)/dt, fast = !(dt > 0) || Math.hypot(vx, vz) > GLIDE_MAX*S.peopleSpeed; // (for glide)
        p.glideX = matrix.elements[12]; p.glideZ = matrix.elements[14]; p.glideVX = fast ? 0 : vx; p.glideVZ = fast ? 0 : vz;
      }
      if (faced) {
        // a blink every few seconds, the eyes closing and opening again over BLINK_DURATION
        p.blinkIn -= fdt;
        p.blinkAge += fdt;
        if (p.blinkIn <= 0 && p.traits.blinks > 0) { p.blinkAge = 0; p.blinkIn = BLINK_DURATION + (1.5 + peopleRng()*5)/p.traits.blinks; }
        p.lookIn -= fdt;
        if (p.lookAt) {
          // talking: at whoever they're talking to, or whoever's talking
          // (only as far round as a head goes; with them right behind, it stays turned the side it was rather than
          // swinging across as they cross from one shoulder to the other)
          let turn = wrapAngle(headingTo(p, p.lookAt) - p.heading);
          if (Math.abs(turn) > LOOK_BEHIND && turn*p.lookTurn < 0) turn = -turn;
          p.lookTurnTo = Math.max(-LOOK_MAX_TURN, Math.min(LOOK_MAX_TURN, turn));
          p.lookTiltTo = 0;
        } else if (p.lookIn <= 0) {
          // every so often a glance somewhere else — not so far while walking — or back ahead, the head easing round to it
          // (the nosier they are, the more often, the less often back ahead, and the further round)
          const { nosy } = p.traits;
          p.lookIn = (1.5 + peopleRng()*4)/nosy;
          const ahead = peopleRng() < 0.35/nosy, reach = (p.moving ? 0.6 : 1)*Math.min(1.5, Math.sqrt(nosy));
          p.lookTurnTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TURN*reach;
          p.lookTiltTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TILT;
        }
        if (!p.lookAt && p.spiritGaze != null) { p.lookTurnTo = p.spiritGaze; p.lookTiltTo = 0; } // (to the spirit talking: see peopleSpiritChat.js)
        if (toMouth(p)) { p.lookTurnTo = 0; p.lookTiltTo = 0; }
        else if (possessed) { p.lookTurnTo = wrapAngle((p.remote?.yaw ?? possession.yaw) - p.heading); p.lookTiltTo = Math.max(-POSSESSED_MAX_TILT, Math.min(POSSESSED_MAX_TILT, -(p.remote?.pitch ?? possession.pitch))); }
        p.lookTurn += (p.lookTurnTo - p.lookTurn)*Math.min(1, fdt*4);
        p.lookTilt += (p.lookTiltTo - p.lookTilt)*Math.min(1, fdt*4);
        if (p.traits.twins) lookTwin(p, i, fdt, possessed);
        // their pupils dart somewhere else every second or so, often back to the middle, snapping there quickly
        p.pupilIn -= fdt;
        if (p.pupilIn <= 0) {
          p.pupilIn = 0.4 + peopleRng()*2.5;
          const middle = peopleRng() < 0.3;
          p.pupilTo[0] = middle ? 0 : (peopleRng()*2 - 1)*PUPIL_MAX_X;
          p.pupilTo[1] = middle ? 0 : (peopleRng()*2 - 1)*PUPIL_MAX_Y;
        }
        // (talking, they hold whoever they're talking to's eye)
        if (possessed || p.lookAt) { p.pupilTo[0] = 0; p.pupilTo[1] = 0; }
        const dart = Math.min(1, fdt*25);
        p.pupil[0] += (p.pupilTo[0] - p.pupil[0])*dart;
        p.pupil[1] += (p.pupilTo[1] - p.pupil[1])*dart;
      }
      const fear = bloodFear(p); // (how much blood they're wearing, for how scared they look)
      const scaredByBlood = !!p.blood && !p.traits.bloodlust, lusting = isBloodlusting(p);
      if (lusting && !p.lusting) feel(p, 'bloodlust'); // (for what they say: see life/speech-text.js, {is = bloodlusting})
      p.lusting = lusting;
      const delighted = pleased && !scaredByBlood; // (blood wins over any other face: whatever they're doing, they look scared — unless they like it)
      // talking, their mouth moves; listening, their expression changes every now and then
      const group = p.group, talking = !!group && group.speaker === p, listening = !!group && !!group.speaker && !talking && p.lookAt === group.speaker;
      // (just bolted: calling something out, outside any conversation — see beginFleeing and shoutLine)
      // (on their own, reacting to what they've just seen or felt: aloud, or as a thought — see reactAloud)
      const aaaing = possessed ? rushed(p) : !!p.traits.terrified; // (says nothing but a rant: see aaa in audio/dictionary.js)
      if (!group && !possessed && !aaaing && !p.saying && isDrawn(p) && (p.seen || p.felt)) {
        const head = { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, reaction = reactAloud(head, voiceOf(p, i), i, p);
        if (reaction?.thought) { p.thought = reaction; p.thoughtUntil = worldNow() + THOUGHT_TIME; }
        else if (reaction) { p.saying = reaction; p.shouting = true; }
      }
      if (aaaing && p.group) leaveGroup(p);
      if (p.fleeTalkUntil && !p.saying && !aaaing) {
        if (worldNow() > p.fleeTalkUntil || !isDrawn(p)) p.fleeTalkUntil = 0;
        else if ((p.saying = shoutLine({ x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, voiceOf(p, i), i, p, 'fleeing'))) { p.shouting = true; p.fleeTalkUntil = 0; }
      }
      // (praying, watched: the prayer — see peoplePrayer.js)
      if (prayerDue(p) && !p.saying && !aaaing && (p.saying = shoutLine({ x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, voiceOf(p, i), i, p, 'prayers', true))) { p.shouting = true; p.pray.said = true; }
      if (!(talking || p.shouting) || aaaing || (p.saying && !isDrawn(p))) {
        p.shouting = false;
        p.talkTo = 0;
        p.talkNext = -1;
        p.phrase = null;
        stopLine(p.saying);
        p.saying = null;
      } else if (p.saying) {
        p.talkNext = -1;
        // saying a real line (see audio/dictionary.js): the mouth opening as wide as it's loud, and a breath once it's done
        const mouth = lineMouth(p.saying);
        if (mouth < 0) { p.saying = null; p.shouting = false; p.talkTo = 0; p.talkIn = 0.3 + peopleRng()*0.3; }
        else p.talkTo = mouth;
      } else if ((p.talkIn -= dt) <= SAY_AHEAD) {
        const early = Math.max(0, p.talkIn), head = { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, heard = isDrawn(p);
        // at the start of a phrase, now and then something real instead
        const phraseStart = !p.phrase || p.phrase.said >= p.phrase.length;
        const far = Math.hypot(head.x - ear.x, head.y - ear.y, head.z - ear.z); // (from where you hear: see ear in audio/sfx.js)
        // (with Options > Speech > Babble only as fallback, anyone out of hearing keeps quiet: nothing real to say there)
        if (early > 0 && phraseStart) { /* (a phrase's start waits its time: it may be a real line) */ }
        else if (S.babbleFallbackOnly && far > hearDistance()) { p.talkTo = 0; p.talkIn = 0.5; p.phrase = null; }
        else if (heard && phraseStart && !group?.babble && (p.saying = sayLine(head, voiceOf(p, i), i, p))) p.phrase = null;
        else if (heard && phraseStart && !group?.babble && linePause(p)) { p.talkTo = 0; p.talkIn = 0.25; } // (waiting quietly for the next line)
        else {
          // in phrases, with a breath between (see nextSyllable in audio/voices.js)
          const { open, length, intonation } = nextSyllable(p, peopleRng);
          if (early > 0) { p.talkNext = open; p.talkNextAt = length; } else p.talkTo = open;
          p.talkIn = early + length;
          // and each syllable they say is heard, from when the last ends
          if (open > 0 && heard) babble(head, voiceOf(p, i), length, open, p.traits.mood, intonation, early);
          if (open > 0 && S.babbleBubbles && far <= (S.bubbleDistance ?? 35) && p.babbleLine?.phrase !== p.phrase) p.babbleLine = babbleLine(p.phrase);
        }
      }
      if (p.talkNext >= 0 && p.talkIn <= p.talkNextAt) { p.talkTo = p.talkNext; p.talkNext = -1; }
      if (aaaing) p.talkTo = !possessed && (!isDrawn(p) || Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z) > hearDistance()) ? 0 : aaa(p, { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, voiceOf(p, i), i, !!p.traits.hatespossessed);
      // a bubble with what they're saying, kept up a little after (see ui/speech-bubbles.js); only for those on the camera's
      // side of a building's walls — in the room with it, or outdoors with it — else gone
      const bubbleSide = isInsideBuilding() ? inRoom(p) : isDrawn(p) && !inRoom(p);
      const babbling = S.babbleBubbles && p.phrase && p.babbleLine?.phrase === p.phrase && p.phrase.said < p.phrase.length ? p.babbleLine : null;
      const logged = p.saying ?? p.thought; // (for the card's Social tab: see peopleSaid.js)
      if (logged && logged !== p.loggedLine) { p.loggedLine = logged; logLine(p, logged); }
      const thinking = bubbleSide && !group && !possessed ? thoughtOf(p, t) : (p.fidgetThought = false, p.thought = null);
      // (possessed: not a bubble but a box low on screen, listing any replies to pick from with Options > Game > Dialogue
      // Choices — see ui/speech-bubbles.js ownLine and audio/dictionary.js sayLine)
      if (p.choosing && (!possessed || !S.dialogueChoices || p.group?.talk !== p.choosing.talk)) p.choosing = null;
      if (possessed && !p.remote) ownLine(p, p.saying ?? babbling, p.choosing);
      else if (bubbleSide && (p.saying || babbling || thinking || hasBubble(p))) speechBubble(p, twinBubble(p, bubbleAt(p)), p.saying ?? babbling ?? thinking);
      // (on their own with spirits or a twin: talking with them — see peopleSpiritChat.js)
      if (p.traits.spirits || p.traits.twins || p.spiritChat?.on) updateSpiritChat(p, i, dt, { free: !group && !possessed && !aaaing && !fleeing && !frozen && !p.fleeTalkUntil && isDrawn(p),
        voice: voiceOf(p, i), head: { x: p.x, y: p.y + 1.6*p.height*S.peopleSize, z: p.z }, bubble: bubbleSide && !possessed ? bubbleAt(p) : null, mouths: personModel?.spiritTalk.array });
      // (shocked, a gasp — agape while they stare)
      if (delighted) p.talkTo = 0.45;                      // smiling, not agape
      else if ((frozen && !prays) || fleeing || scaredByBlood) p.talkTo = frozen && !prays ? 1 : scaredByBlood ? 0.3 + 0.7*fear : 0.55; // (blood, the more of it the wider)
      if (faced) {
        p.talk += (p.talkTo - p.talk)*Math.min(1, fdt*20);
        if (listening) {
          if ((p.emotionIn -= fdt) <= 0) { p.emotionTo = Math.max(-1, Math.min(1, peopleRng()*2 - 1 + p.traits.mood)); p.emotionIn = 1.5 + peopleRng()*3; }
        } else if (!group) {
          p.emotionTo = p.traits.mood; // (their resting face)
        }
        if (delighted) p.emotionTo = 1;                      // beaming, where fright and stun go flat
        else if ((frozen && !prays) || fleeing || scaredByBlood) p.emotionTo = -1;
        p.emotion += (p.emotionTo - p.emotion)*Math.min(1, fdt*5);
        // their eyes: the look their traits give them (from their mood, say), brighter or sadder as their expression swings
        // above or below where it rests, and wide with shock when frightened
        const { happy, sad, angry, shock } = p.traits, swing = p.emotion - p.traits.mood, shocked = ((frozen && !prays) || fleeing || scaredByBlood) && !delighted; // (they look scared for as long as they've blood on them)
        const eyesTo = [shocked ? (scaredByBlood ? 0.4 + 0.6*fear : 1) : shock, delighted ? 1 : shocked ? 0 : happy + Math.max(0, swing)*0.8, scaredByBlood ? 0 : p.attack || lusting ? 1 : angry, sad + Math.max(0, -swing)*0.8];
        for (let k=0;k<4;k++) p.eyes[k] += (Math.min(1, eyesTo[k]) - p.eyes[k])*Math.min(1, fdt*6);
      }
      if (placed) {
        // instanceAnim (see the shader): the rows they're at in the two animations, how far they've blended, and their blink
        const o = i*4, animArray = personModel.anim.array, lookArray = personModel.look.array;
        animArray[o] = clipRow(p, p.clipA);
        animArray[o+1] = p.clipB === p.clipA ? animArray[o] : p.rowB;
        animArray[o+2] = p.fade;
        // (the drowsy, 😴, hold their eyes that far shut between blinks; a punch that leaves them reeling, Hit, shuts them)
        animArray[o+3] = Math.max(p.traits.drowsy, p.pray && !p.saying ? 0.85 : 0, p.oneShot?.name === 'Hit' ? 1 : 0, p.blinkAge < BLINK_DURATION ? Math.sin(Math.PI*p.blinkAge/BLINK_DURATION) : 0);
        lookArray[o] = p.lookTurn; lookArray[o+1] = p.lookTilt; lookArray[o+2] = p.talk; lookArray[o+3] = p.emotion;
        if (p.water?.drowned) holdDrowned(o, animArray, lookArray); // (still, face down: see peopleWater.js)
        // (their shoulder spirits' pose: theirs — sitting, falling, lying — but the Idle loop wherever they walk: see peopleSpirits.js)
        if (p.traits.spirits) {
          const walks = clip => !!clip && (clip.base ?? clip).name === 'Walk', idle = personModel.clips.Idle;
          const idleRow = idle ? idle.start + (t*PERSON_BAKE_FPS + i*7) % idle.frames : animArray[o];
          const a = walks(p.clipA) ? idleRow : animArray[o], b = p.clipB === p.clipA ? a : walks(p.clipB) ? idleRow : animArray[o+1];
          personModel.traitData.set([a, b, animArray[o+2]], (SPIRIT_ANIM_ROW*PEOPLE_MAX + i)*4);
          personModel.traitTexture.needsUpdate = true;
        }
        const eyesArray = personModel.eyes.array;
        for (let k=0;k<4;k++) eyesArray[o + k] = p.eyes[k];
        const pupilArray = personModel.pupil.array;
        pupilArray[i*2] = p.pupil[0]; pupilArray[i*2 + 1] = p.pupil[1];
        // the copies everything they wear (hair, glasses, a skirt) keeps of where they are, how they're posed and which way they're looking
        if (worn) for (const layer of personModel.wornLayers) {
          const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
          if (!style || !style.mesh) continue;
          const slot = layer.slot[i];
          matrix.toArray(style.mesh.instanceMatrix.array, slot*16);
          for (let k=0;k<4;k++) { style.anim.array[slot*4 + k] = animArray[o + k]; style.look.array[slot*4 + k] = lookArray[o + k]; style.eyes.array[slot*4 + k] = eyesArray[o + k]; }
          style.pupil.array[slot*2] = p.pupil[0]; style.pupil.array[slot*2 + 1] = p.pupil[1];
        }
      }
      // tears, love hearts, smoke: what their mood shows, if they're near enough to see it (see peopleEmotes.js)
      if (placed && bubbleSide && pixels >= PERSON_FACE_PIXELS) updateEmotes(p, i, dt, t);
    } else {
      if (p.moving && !riding) p.phase += dt*speed*Math.PI/S.peopleSize;
      const bob = p.moving && !riding ? Math.abs(Math.sin(p.phase))*0.08*S.peopleSize : 0;
      rotation.setFromAxisAngle(up, p.heading);
      turnInWater(p, rotation); turnCrawling(p, rotation);
      if (!isDrawn(p)) scale.set(0, 0, 0); else scale.set(0.5*S.peopleSize, 1.7*p.height*S.peopleSize, 0.34*S.peopleSize);
      position.set(p.x, p.y + bob, p.z);
      if (p.punched?.revive && p.punched.stage === 'down') shake(position, rotation, PERSON_SHAKE*S.peopleSize);
      sway(p, position, rotation);
      matrix.compose(position, rotation, scale);
      peopleMesh.setMatrixAt(i, matrix);
    }
    if (S.showRoadsafetyDebug) {
      const dead = isGone(p), radius = dead ? 0 : ROADSAFETY_RADIUS*p.traits.roadsafety;
      const half = p.crossStage === 'mid' && p.jc && !p.jc.junction;
      rotation.identity();
      scale.setScalar(half ? 0 : radius);
      matrix.compose(position.set(p.x, p.y + 0.9, p.z), rotation, scale);
      roadsafetyDebugMesh.setMatrixAt(i, matrix);
      const across = half && p.jc.route[p.jc.i];
      rotation.setFromAxisAngle(up, across ? Math.atan2(across.x - p.x, across.z - p.z) : 0);
      scale.setScalar(half ? radius : 0);
      matrix.compose(position, rotation, scale);
      roadsafetyHalfDebugMesh.setMatrixAt(i, matrix);
      rotation.setFromAxisAngle(up, p.heading);
      scale.set(dead ? 0 : 0.5*S.peopleSize, dead ? 0 : 1.7*p.height*S.peopleSize, dead ? 0 : 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y, p.z), rotation, scale);
      pedHitboxDebugMesh.setMatrixAt(i, matrix);
    }
  });
  if (phones) headphoneMusic(phones.id, { x: phones.x, y: phones.y + 1.6*phones.height*S.peopleSize, z: phones.z }); else stopHeadphoneMusic();

  if (personModel) {
    [personModel, ...personModel.hair].forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; part.anim.needsUpdate = true; part.look.needsUpdate = true; part.eyes.needsUpdate = true; part.pupil.needsUpdate = true; });
    personModel.spiritTalk.needsUpdate = true;
    App.posePedBuilder?.(); // (the Ped Builder's ped, past the crowd: ui/ped-builder.js)
    personModel.updateCopies(people.length, [followed, possession.index, ...carded, ...(App.pedBuilderSlots?.() ?? [])]); // (who's drawn: see compactOf in peopleModel.js)
    updateHeld(); // (whatever anyone's holding, from where their hands ended up)
  } else {
    peopleMesh.instanceMatrix.needsUpdate = true;
  }
  if (S.showRoadsafetyDebug) {
    roadsafetyDebugMesh.instanceMatrix.needsUpdate = true;
    roadsafetyHalfDebugMesh.instanceMatrix.needsUpdate = true;
    pedHitboxDebugMesh.instanceMatrix.needsUpdate = true;
  }
  showPassengers();
  showInhabitants();
  showFollowedDoing();
  App.refreshCardStatuses(); // (the status column on any open person card: see life/person-card.js)
  // the camera onto whoever it's following, at about their shoulders — or, while they're indoors, onto the building
  // (but not someone picked in the room it's in, which holds it: see buildings/interior.js)
  const inside = followed >= 0 && isGone(people[followed]) && people[followed].indoors?.building;
  if (followedInside) { /* (the room's camera) */ }
  else if (inside) controls.goalTarget.set(inside.x, inside.y + inside.height*0.5, inside.z);
  else if (prayerViewing(followed)) aimPrayerView(people[followed]);
  else if (followed >= 0) { const p = people[followed]; controls.goalTarget.set(p.x, p.y + personHeight(p)*0.8, p.z); }
  // and the card's headshot of them (kept as it was while they can't be seen), which draws them whole
  if (personModel?.hidden) personModel.hidden.value = -1;
  // (them alone: everyone else is folded away while it draws)
  if (followed >= 0 && personModel && (!isGone(people[followed]) || inRoom(people[followed]))) {
    personModel.only.value = followed;
    App.drawPersonHeadshot(headshotOf(followed), followed);
    personModel.only.value = -1;
  }
  App.drawPedBuilder?.(); // (and the Ped Builder's picture of its ped)
  // (and a second person card's, now and then: see otherHeadshotIndex in person-card.js)
  const other = App.otherHeadshotIndex?.() ?? -1;
  if (other >= 0 && other !== followed && personModel && people[other] && (!isGone(people[other]) || inRoom(people[other]))) {
    personModel.only.value = other;
    App.drawPersonHeadshot(headshotOf(other), other);
    personModel.only.value = -1;
  }
  // while controlling someone, their own head and hair are hidden (if S.hideOwnHead)
  if (personModel?.hidden && S.hideOwnHead && possession.index >= 0 && !(possession.distance > 0)) personModel.hidden.value = possession.index;
  // or, possessing them, the view from their eyes
  if (possession.index >= 0 && possession.index === followed && people[followed].mode === 'possessed') placePossessedCamera(followed);
  updatePossessedTarget(); // (and what E would do from there, labelled: see peopleTracking.js)
}

